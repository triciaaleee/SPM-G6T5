<script setup lang="ts">
import AppPanel from "../../components/ui/AppPanel.vue";
import BackLink from "../../components/ui/BackLink.vue";
import StatusBadge from "../../components/ui/StatusBadge.vue";
/**
 * E5-1 AC1/AC2: Technical Support open one event's equipment requests. They
 * see the requested equipment, quantities and the organiser's technical
 * requirements, plus the event's name, date, time and venue, and nothing
 * else about the event. An event with no equipment request is refused by
 * the backend, and this page then shows only a no-access message.
 *
 * E5-3: each request's status is updated here as arrangements are made (AC1),
 * with what remains outstanding worked out from current stock for a partial
 * fulfilment (AC2). E5-4: each item's availability is checked against the
 * event's own date and time before a decision is made.
 */
import { ChevronDownIcon, ExclamationTriangleIcon, XMarkIcon } from "@heroicons/vue/16/solid";
import AppButton from "../../components/ui/AppButton.vue";
import DataTable from "../../components/ui/DataTable.vue";
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { getStoredUser, landingRouteForRole } from "../../lib/auth";
import {
  CANCELLED_REQUEST_STATUS,
  EquipmentAccessDeniedError,
  EquipmentRequestError,
  EquipmentValidationError,
  fetchEquipmentCatalog,
  fetchEquipmentRequestsForSupport,
  itemFulfilmentBadgeClass,
  itemFulfilmentState,
  previewUnitsForItem,
  updateEquipmentRequestStatus,
  type EquipmentCatalogItem,
  type EquipmentItem,
  type EquipmentRequest,
  type EquipmentRequestStatus,
  type EquipmentRequestWithRequester,
  type EventEquipmentView,
  type UnitLabel,
  type UnitPreview,
} from "../../lib/equipmentApi";

const route = useRoute();
const router = useRouter();
const eventId = String(route.params.eventId);

/** While editing: pick how many of each item is being arranged — status is a read-out, not a choice. */
const EDIT_COLUMNS = [
  { key: "equipment", label: "Item" },
  { key: "qty", label: "Needed" },
  { key: "stock", label: "Free stock" },
  { key: "arranging", label: "Arranging now" },
  { key: "status", label: "Status" },
];
/** Shared by both states, so a row's columns line up whether or not it's expanded (sized for the edit
 * state's wider "Arranging now" cell — the stepper, "of N" and "Arrange all"). */
const COLUMN_WIDTHS = "minmax(12rem, 1fr) 6rem 8rem 22rem 11rem";

/** Collapsed/read-only: what was actually arranged, nothing editable. */
const VIEW_COLUMNS = [
  { key: "equipment", label: "Item" },
  { key: "qty", label: "Needed" },
  { key: "stock", label: "Available on event day" },
  { key: "arranged", label: "Arranged" },
  { key: "status", label: "Status" },
];

/** Back to wherever the user came from; a direct link has no history, so it falls back to the role's home page. */
function goBack(): void {
  if (window.history.state?.back) {
    router.back();
  } else {
    router.push({ name: landingRouteForRole(getStoredUser()?.role) });
  }
}

const view = ref<EventEquipmentView | null>(null);
const catalog = ref<EquipmentCatalogItem[]>([]);
const loading = ref(true);
const accessDenied = ref(false);
const errorMessage = ref<string | null>(null);

const requests = computed<EquipmentRequestWithRequester[]>(() => view.value?.equipmentRequests ?? []);

/** "· Requested by Priya Shah", falling back to the id if the name couldn't be resolved. Omitted if neither is known. */
function requesterLabel(r: EquipmentRequestWithRequester): string {
  if (!r.requestedBy) return "";
  return ` · Requested by ${r.requestedBy.name ?? r.requestedBy.id}`;
}

/** Live requests keep the full table card; cancelled ones are history, tucked into one collapsible list. */
const activeRequests = computed(() => requests.value.filter((r) => r.status !== CANCELLED_REQUEST_STATUS));
const cancelledRequests = computed(() => requests.value.filter((r) => r.status === CANCELLED_REQUEST_STATUS));
const showCancelled = ref(false);

/** "Request 2": the request's place in the order it was raised, whichever list it is shown in. */
function requestNumber(r: EquipmentRequest): number {
  return requests.value.findIndex((candidate) => candidate.id === r.id) + 1;
}

interface EditState {
  expanded: boolean;
  /** How many of each item (by item id) Technical Support is arranging — status is derived from this, never picked. */
  quantities: Record<number, number>;
  saving: boolean;
  error: string | null;
  notice: { text: string; warning: boolean } | null;
}

const edits = reactive<Record<number, EditState>>({});

function editFor(r: EquipmentRequest): EditState {
  if (!edits[r.id]) {
    edits[r.id] = {
      expanded: false,
      quantities: {},
      saving: false,
      error: null,
      notice: null,
    };
  }
  return edits[r.id];
}

/** Opens the editor, starting each item's stepper at what it already has — the truth, not a guess. */
function openEditor(r: EquipmentRequest): void {
  const edit = editFor(r);
  edit.quantities = Object.fromEntries(r.items.map((item) => [item.id, item.quantityFulfilled]));
  edit.error = null;
  edit.expanded = true;
  // An immediate read, not debounced, so the panel has something to show as soon as the editor opens.
  for (const item of r.items) void runLivePreview(item, chosenQuantity(r, item));
}

function cancelEdit(r: EquipmentRequest): void {
  editFor(r).expanded = false;
}

async function refreshCatalog(): Promise<void> {
  try {
    catalog.value = await fetchEquipmentCatalog();
  } catch {
    // Non-fatal: the outstanding preview just keeps using the last known stock.
  }
}

interface PreviewState {
  loading: boolean;
  error: string | null;
  result: UnitPreview | null;
}

function emptyPreviewState(): PreviewState {
  return { loading: false, error: null, result: null };
}

/** Nothing more to claim once every unit asked for is already fulfilled. */
function isFullyArranged(item: EquipmentItem): boolean {
  return item.quantityFulfilled >= item.quantity;
}

/**
 * Two independent preview tracks, both backed by the same read-only
 * endpoint (nothing is ever reserved by either one):
 * - `availabilityPreviews` is the static "Available" column — always
 *   checked against the item's full requested quantity, refreshed on load
 *   and after a save, untouched while editing.
 * - `livePreviews` is the editor's live banner and "would also reserve"
 *   tags — checked against whatever is currently picked, re-run (debounced)
 *   every time a pill or the quantity changes.
 */
const availabilityPreviews = reactive<Record<number, PreviewState>>({});
function availabilityFor(item: EquipmentItem): PreviewState {
  if (!availabilityPreviews[item.id]) availabilityPreviews[item.id] = emptyPreviewState();
  return availabilityPreviews[item.id];
}

async function refreshAvailability(item: EquipmentItem): Promise<void> {
  if (isFullyArranged(item)) return; // nothing more to claim, so nothing to check
  const state = availabilityFor(item);
  state.loading = true;
  try {
    state.result = await previewUnitsForItem(item.id, item.quantity);
    state.error = null;
  } catch (err) {
    state.error = err instanceof EquipmentRequestError ? err.message : "Couldn't check availability.";
  } finally {
    state.loading = false;
  }
}

function refreshAllAvailability(targets: EquipmentRequest[]): void {
  for (const r of targets) {
    if (r.status === "Cancelled") continue;
    for (const item of r.items) void refreshAvailability(item);
  }
}

const livePreviews = reactive<Record<number, PreviewState>>({});
function liveFor(item: EquipmentItem): PreviewState {
  if (!livePreviews[item.id]) livePreviews[item.id] = emptyPreviewState();
  return livePreviews[item.id];
}

async function runLivePreview(item: EquipmentItem, quantity: number): Promise<void> {
  const state = liveFor(item);
  state.loading = true;
  try {
    state.result = await previewUnitsForItem(item.id, quantity);
    state.error = null;
  } catch (err) {
    state.error = err instanceof EquipmentRequestError ? err.message : "Couldn't check availability.";
  } finally {
    state.loading = false;
  }
}

const liveTimers: Partial<Record<number, ReturnType<typeof setTimeout>>> = {};

/** Debounced so rapid pill clicks or typing don't fire a request per change. */
function scheduleLivePreview(item: EquipmentItem, quantity: number): void {
  const timer = liveTimers[item.id];
  if (timer) clearTimeout(timer);
  liveFor(item).loading = true;
  liveTimers[item.id] = setTimeout(() => {
    void runLivePreview(item, quantity);
  }, 400);
}

onBeforeUnmount(() => {
  for (const timer of Object.values(liveTimers)) {
    if (timer) clearTimeout(timer);
  }
});

/** Sets an item's arranging-now quantity (clamped to what's actually needed) and re-checks availability. */
function setQty(r: EquipmentRequest, item: EquipmentItem, value: number): void {
  const clamped = Math.min(item.quantity, Math.max(0, value));
  editFor(r).quantities[item.id] = clamped;
  scheduleLivePreview(item, clamped);
}

function decQty(r: EquipmentRequest, item: EquipmentItem): void {
  setQty(r, item, chosenQuantity(r, item) - 1);
}

function incQty(r: EquipmentRequest, item: EquipmentItem): void {
  setQty(r, item, chosenQuantity(r, item) + 1);
}

function setAllQty(r: EquipmentRequest, item: EquipmentItem): void {
  setQty(r, item, item.quantity);
}

/** The shortfall fix button: drop straight to however many are actually free. */
function setToFree(r: EquipmentRequest, item: EquipmentItem): void {
  setQty(r, item, liveFor(item).result?.availableCount ?? 0);
}

/** How many short the live check against the current pick came back, if any. */
function itemShortfall(item: EquipmentItem): number {
  return liveFor(item).result?.shortfall ?? 0;
}

/** The quantity to judge an item's displayed status by: live while editing, committed otherwise. */
function displayedQuantity(r: EquipmentRequest, item: EquipmentItem): number {
  return editFor(r).expanded ? chosenQuantity(r, item) : item.quantityFulfilled;
}

/** "Needs fixing" is a purely client-side pre-save state — never sent to the backend — so a shortfall is
 * caught here instead of only surfacing as a 409 after Save. */
function itemStatusLabel(r: EquipmentRequest, item: EquipmentItem): string {
  if (editFor(r).expanded && itemShortfall(item) > 0) return "Needs fixing";
  return itemFulfilmentState(displayedQuantity(r, item), item.quantity);
}

function itemStatusClass(r: EquipmentRequest, item: EquipmentItem): string {
  if (editFor(r).expanded && itemShortfall(item) > 0) return "status-danger";
  return itemFulfilmentBadgeClass(displayedQuantity(r, item), item.quantity);
}

/** Whether any item currently picked would come up short — gates the banner, the row tint and Reserve stock. */
function hasAnyShortfall(r: EquipmentRequest): boolean {
  return r.items.some((item) => chosenQuantity(r, item) > 0 && itemShortfall(item) > 0);
}

function shortfallCount(r: EquipmentRequest): number {
  return r.items.filter((item) => chosenQuantity(r, item) > 0 && itemShortfall(item) > 0).length;
}

/** "N of M items fully arranged" — the header summary, read in both the editing and read-only views. */
function summaryText(r: EquipmentRequest): string {
  const total = r.items.length;
  const full = r.items.filter((item) => displayedQuantity(r, item) >= item.quantity).length;
  return `${full} of ${total} item${total === 1 ? "" : "s"} fully arranged`;
}

/** Reserved units, defaulting to none for a response that didn't carry the field. */
function reservedUnitsOf(item: EquipmentItem): UnitLabel[] {
  return item.reservedUnits ?? [];
}

/** Which items to expand and show reserved/would-reserve units for. */
const expandedItems = reactive<Record<number, boolean>>({});
function toggleExpand(itemId: number): void {
  expandedItems[itemId] = !expandedItems[itemId];
}

/** The Needed column: just the raw ask, now that Arranged/Arranging now carry the fulfilled-so-far figure. */
function itemQuantityLabel(item: EquipmentItem): string {
  return `${item.quantity}×`;
}

/** The read-only "Arranged" column. */
function arrangedLabel(item: EquipmentItem): string {
  return `${item.quantityFulfilled} of ${item.quantity}`;
}

/** Same catalog lookup as the Technical Support homepage's queue table. */
function stockFor(equipmentType: string): number | null {
  return catalog.value.find((c) => c.name === equipmentType)?.availableStock ?? null;
}

/** How many of an item is currently picked, clamped to what was requested. */
function chosenQuantity(r: EquipmentRequest, item: EquipmentItem): number {
  const value = Math.floor(Number(editFor(r).quantities[item.id]));
  return Number.isFinite(value) ? Math.min(item.quantity, Math.max(0, value)) : 0;
}

/** The request's status follows its items: everything in is Arranged, nothing in is Requested, else Partially Fulfilled. */
function derivedStatus(r: EquipmentRequest): EquipmentRequestStatus {
  const chosen = r.items.map((item) => chosenQuantity(r, item));
  if (chosen.every((n, i) => n >= r.items[i].quantity)) return "Arranged";
  if (chosen.every((n) => n === 0)) return "Requested";
  return "Partially Fulfilled";
}

function outstandingSummary(r: EquipmentRequest): string {
  const parts = r.items
    .map((item) => {
      const remaining = item.quantity - chosenQuantity(r, item);
      return remaining > 0 ? `${remaining} ${item.equipmentType}` : null;
    })
    .filter((part): part is string => part !== null);
  return parts.length > 0 ? `${parts.join(", ")} outstanding` : "All requested items have been fulfilled";
}

async function saveStatus(r: EquipmentRequest): Promise<void> {
  const edit = editFor(r);
  edit.saving = true;
  edit.error = null;
  edit.notice = null;
  try {
    const status = derivedStatus(r);
    const fulfillments =
      status === "Partially Fulfilled"
        ? r.items.map((item) => ({ itemId: item.id, fulfilledQuantity: chosenQuantity(r, item) }))
        : undefined;
    const note = status === "Partially Fulfilled" ? outstandingSummary(r) : undefined;
    const { equipmentRequest, notified } = await updateEquipmentRequestStatus(r.id, status, note, fulfillments);
    Object.assign(r, equipmentRequest);
    edit.expanded = false;
    edit.notice = notified
      ? { text: "Status updated. The coordinator has been notified.", warning: false }
      : { text: "Status updated, but we couldn't notify the coordinator — please follow up directly.", warning: true };
    // The save may have moved stock and changed what's reserved, so refresh both.
    await refreshCatalog();
    for (const item of r.items) void refreshAvailability(item);
  } catch (err) {
    if (err instanceof EquipmentValidationError) {
      edit.error = err.fields.note ?? err.fields.status ?? "Check the status and try again.";
    } else if (err instanceof EquipmentRequestError) {
      edit.error = err.message;
    } else {
      edit.error = "We couldn't update this request. Please try again.";
    }
  } finally {
    edit.saving = false;
  }
}

function formatLongDate(value: string | null): string {
  if (!value) return "Date not set";
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

function formatTimeRange(start: string | null, end: string | null): string {
  return start && end ? `${start} – ${end}` : "Time not specified";
}

function formatSubmitted(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("en-GB");
}

/** "21 Oct 2026" for the compact cancelled rows. */
function formatSubmittedLong(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

const paragraphs = computed(() =>
  (view.value?.technicalRequirements ?? "")
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean),
);

onMounted(async () => {
  try {
    const [loaded, loadedCatalog] = await Promise.all([
      fetchEquipmentRequestsForSupport(eventId),
      fetchEquipmentCatalog().catch(() => [] as EquipmentCatalogItem[]),
    ]);
    view.value = loaded;
    catalog.value = loadedCatalog;
    refreshAllAvailability(loaded.equipmentRequests);
  } catch (err) {
    if (err instanceof EquipmentAccessDeniedError) accessDenied.value = true;
    else errorMessage.value = "We couldn't load this equipment request. Please try again.";
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <!--
    Column mapping — Equipment request detail
    Desktop (12-col): outer container col 1-12 (grid-desktop-margin 80px); back button, title and "When and where" card col 1-12; requirements and request cards col 1-8.
    Tablet (6-col): everything col 1-6 full width, grid-tablet-margin 32px.
    Mobile (4-col): everything col 1-4 full width, grid-mobile-margin 6px.
  -->
  <div class="page">
    <div class="back">
      <BackLink @click="goBack">Back</BackLink>
    </div>

    <p v-if="loading" class="full body-default muted">Loading equipment request…</p>

    <AppPanel as="section" size="md" class="full denied" v-else-if="accessDenied" role="alert">
      <h1 class="h6">You don't have access to this event</h1>
      <p class="body-default muted">No equipment has been requested for it.</p>
    </AppPanel>

    <p v-else-if="errorMessage || !view" class="full body-default error-text" role="alert">
      {{ errorMessage ?? "We couldn't load this equipment request. Please try again." }}
    </p>

    <template v-else>
      <div class="title-row">
        <h1 class="h2">{{ view.event.name || `Event #${view.event.id}` }}</h1>
      </div>

      <section class="details" aria-label="When and where">
        <div class="details-row">
          <div class="detail-item">
            <span class="detail-icon-chip">
              <svg class="detail-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5" /></svg>
            </span>
            <div class="detail-text">
              <span class="detail-label">Date</span>
              <span class="detail-value">{{ formatLongDate(view.event.proposedDate) }}</span>
            </div>
          </div>

          <div class="detail-item">
            <span class="detail-icon-chip">
              <svg class="detail-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>
            </span>
            <div class="detail-text">
              <span class="detail-label">Time</span>
              <span class="detail-value">{{ formatTimeRange(view.event.startTime, view.event.endTime) }}</span>
            </div>
          </div>

          <div class="detail-item">
            <span class="detail-icon-chip">
              <svg class="detail-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" /><path d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z" /></svg>
            </span>
            <div class="detail-text">
              <span class="detail-label">Venue</span>
              <span class="detail-value">{{ view.event.venue || "Venue to be confirmed" }}</span>
            </div>
          </div>
        </div>
      </section>

      <section class="requirements" aria-label="Technical requirements">
        <h2 class="h4">Technical requirements</h2>
        <template v-if="paragraphs.length > 0">
          <p v-for="(paragraph, index) in paragraphs" :key="index" class="body-default">{{ paragraph }}</p>
        </template>
        <p v-else class="body-default muted">The organiser didn't add any technical requirements.</p>
      </section>

      <section class="requests" aria-label="Equipment requested">
        <h2 class="h4">Equipment requested</h2>

        <div v-if="activeRequests.length === 0 && requests.length > 0" class="requests-empty" data-testid="no-active-requests">
          <p class="body-default requests-empty__title">No active equipment requests</p>
          <p class="body-small muted">
            {{ requests.length === 1 ? "The request was" : `All ${requests.length} requests were` }} cancelled, either by the
            coordinator or because the event was cancelled. {{ requests.length === 1 ? "It stays" : "They stay" }} here for
            reference.
          </p>
        </div>

        <ul class="request-list">
          <AppPanel as="li" size="md" class="request-card" v-for="r in activeRequests" :key="r.id">
            <div class="request-card__header">
              <div class="request-card__heading">
                <h3 class="h5">Request {{ requestNumber(r) }}</h3>
                <p class="body-small muted">Submitted {{ formatSubmitted(r.createdAt) }}{{ requesterLabel(r) }}</p>
              </div>
              <div class="request-card__header-right">
                <span class="body-small muted" data-testid="request-summary">{{ summaryText(r) }}</span>
                <AppButton v-if="!editFor(r).expanded" variant="outline" type="button" data-testid="edit-arrangement" @click="openEditor(r)">
                  Edit arrangement
                </AppButton>
              </div>
            </div>

            <div v-if="editFor(r).expanded && hasAnyShortfall(r)" class="shortfall-banner" role="alert" data-testid="shortfall-banner">
              <ExclamationTriangleIcon class="shortfall-banner__icon" aria-hidden="true" />
              <span>Not enough stock for {{ shortfallCount(r) }} item{{ shortfallCount(r) === 1 ? "" : "s" }}. Fix it to reserve.</span>
            </div>

            <div class="table-wrap">
              <DataTable
                :columns="editFor(r).expanded ? EDIT_COLUMNS : VIEW_COLUMNS"
                :column-widths="COLUMN_WIDTHS"
                column-gap="var(--spacing-24)"
                :rows="r.items"
                :row-key="(item) => item.id"
                :row-class="(item) => ({ 'item-row': true, 'item-row--danger': editFor(r).expanded && chosenQuantity(r, item) > 0 && itemShortfall(item) > 0 })"
              >
              <template #cell-equipment="{ row: item }">
                <div class="equipment-cell">
                  <div class="equipment-cell__name-row">
                    <span class="item-name">{{ item.equipmentType }}</span>
                    <button
                      type="button"
                      class="expand-toggle"
                      :aria-expanded="!!expandedItems[item.id]"
                      :aria-label="expandedItems[item.id] ? 'Hide reserved units' : 'Show reserved units'"
                      data-testid="expand-toggle"
                      @click="toggleExpand(item.id)"
                    >
                      <ChevronDownIcon class="expand-toggle__icon" :class="{ 'expand-toggle__icon--open': expandedItems[item.id] }" aria-hidden="true" />
                    </button>
                  </div>

                  <!-- E5-5 / E5-6 AC3: a reserved unit that is now unusable for the event needs re-arranging. -->
                  <p v-if="item.reservationFlag?.flagged" class="body-small flag-note" data-testid="reservation-flag" role="alert">
                    {{ item.reservationFlag.reason }}
                  </p>

                  <!-- Which physical units are already reserved, and (while editing) which more would be. -->
                  <div v-if="expandedItems[item.id]" class="unit-panel" data-testid="unit-panel">
                    <template v-if="reservedUnitsOf(item).length > 0">
                      <span class="unit-panel__label">Reserved units</span>
                      <div class="unit-tags">
                        <span v-for="unit in reservedUnitsOf(item)" :key="`r${unit.id}`" class="unit-tag unit-tag--reserved">
                          {{ unit.label ?? `Unit #${unit.id}` }}
                        </span>
                      </div>
                    </template>
                    <template v-if="editFor(r).expanded && (liveFor(item).result?.units.length ?? 0) > 0">
                      <span class="unit-panel__label">Would also reserve</span>
                      <div class="unit-tags">
                        <span v-for="unit in liveFor(item).result!.units" :key="`p${unit.id}`" class="unit-tag unit-tag--preview">
                          {{ unit.label ?? `Unit #${unit.id}` }}
                        </span>
                      </div>
                    </template>
                    <span v-if="editFor(r).expanded && (liveFor(item).result?.shortfall ?? 0) > 0" class="unit-tag unit-tag--short">
                      {{ liveFor(item).result!.shortfall }} short
                    </span>
                    <p
                      v-if="reservedUnitsOf(item).length === 0 && !(editFor(r).expanded && (liveFor(item).result?.units.length ?? 0) > 0)"
                      class="body-small muted"
                    >
                      No units reserved yet.
                    </p>
                  </div>
                </div>
              </template>

              <template #cell-qty="{ row: item }">
                <span class="item-qty">{{ itemQuantityLabel(item) }}</span>
              </template>

              <template #cell-arranged="{ row: item }">
                <span class="item-qty">{{ arrangedLabel(item) }}</span>
              </template>

              <template #cell-stock="{ row: item }">
                <div class="item-available">
                  <span v-if="isFullyArranged(item)" class="item-available__count">Fully arranged</span>
                  <template v-else>
                    <span v-if="availabilityFor(item).loading && !availabilityFor(item).result" class="item-available__count muted">Checking…</span>
                    <span v-else-if="availabilityFor(item).error" class="item-available__count error-text">{{ availabilityFor(item).error }}</span>
                    <span
                      v-else-if="availabilityFor(item).result"
                      class="item-available__count"
                      :class="{ 'item-available__count--short': availabilityFor(item).result!.shortfall > 0 }"
                    >{{ availabilityFor(item).result!.availableCount }} more free</span>
                    <span v-else class="item-available__count muted">—</span>
                  </template>
                  <span class="item-available__today">in stock today: {{ stockFor(item.equipmentType) ?? "—" }}</span>
                </div>
              </template>

              <template #cell-arranging="{ row: item }">
                <div class="arranging-cell">
                  <div class="qty-stepper-row">
                    <div class="qty-stepper" :class="{ 'qty-stepper--danger': chosenQuantity(r, item) > 0 && itemShortfall(item) > 0 }">
                      <button
                        type="button"
                        class="qty-stepper__btn"
                        data-testid="qty-dec"
                        :disabled="chosenQuantity(r, item) <= 0"
                        :aria-label="`Arrange one fewer ${item.equipmentType}`"
                        @click="decQty(r, item)"
                      >
                        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 8h10" /></svg>
                      </button>
                      <span class="qty-stepper__value" aria-live="polite" data-testid="qty-value">{{ chosenQuantity(r, item) }}</span>
                      <button
                        type="button"
                        class="qty-stepper__btn"
                        data-testid="qty-inc"
                        :disabled="chosenQuantity(r, item) >= item.quantity"
                        :aria-label="`Arrange one more ${item.equipmentType}`"
                        @click="incQty(r, item)"
                      >
                        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 8h10M8 3v10" /></svg>
                      </button>
                    </div>
                    <span class="body-small muted">of {{ item.quantity }}</span>
                    <AppButton
                      variant="ghost"
                      size="sm"
                      type="button"
                      data-testid="qty-all"
                      :disabled="chosenQuantity(r, item) >= item.quantity"
                      @click="setAllQty(r, item)"
                    >
                      Arrange all
                    </AppButton>
                  </div>
                  <template v-if="chosenQuantity(r, item) > 0 && itemShortfall(item) > 0">
                    <p class="qty-stepper__warning" data-testid="qty-warning">
                      Only {{ liveFor(item).result?.availableCount ?? 0 }} free. Arrange {{ liveFor(item).result?.availableCount ?? 0 }} or fewer.
                    </p>
                    <AppButton variant="outline" size="sm" type="button" data-testid="qty-set-to-free" @click="setToFree(r, item)">
                      Set to {{ liveFor(item).result?.availableCount ?? 0 }}
                    </AppButton>
                  </template>
                </div>
              </template>

              <template #cell-status="{ row: item }">
                <StatusBadge :status-class="itemStatusClass(r, item)" data-testid="item-status">{{ itemStatusLabel(r, item) }}</StatusBadge>
              </template>
            </DataTable>
            </div>

            <div class="request-card__footer">
              <p v-if="r.fulfillmentNote && !editFor(r).expanded" class="body-small request-card__note">Outstanding: {{ r.fulfillmentNote }}</p>

              <div v-if="editFor(r).expanded" class="reserve-panels">
                <div class="reserve-panel">
                  <h4 class="reserve-panel__title">Still outstanding</h4>
                  <p class="body-default" data-testid="outstanding-text">{{ outstandingSummary(r) }}</p>
                  <p class="body-small muted">The organiser sees this after you save.</p>
                </div>
              </div>

              <p v-if="editFor(r).error" class="body-small error-text" role="alert">{{ editFor(r).error }}</p>

              <!-- Picking a quantity above is what actually reserves stock — Save/Cancel only commits or discards it. -->
              <div v-if="editFor(r).expanded" class="status-editor">
                <p class="body-small muted status-editor__hint">
                  {{ hasAnyShortfall(r) ? "Reserve stock is off until every item is within free stock." : "Stock is checked as you type and only reserved when you click Reserve stock." }}
                </p>
                <div class="status-form-actions">
                  <AppButton variant="outline" type="button" data-testid="cancel-arrangement" :disabled="editFor(r).saving" @click="cancelEdit(r)">
                    Cancel
                  </AppButton>
                  <AppButton
                    variant="primary"
                    type="button"
                    data-testid="reserve-stock"
                    :disabled="editFor(r).saving || hasAnyShortfall(r)"
                    @click="saveStatus(r)"
                  >
                    {{ editFor(r).saving ? "Reserving…" : "Reserve stock" }}
                  </AppButton>
                </div>
              </div>

              <p
                v-if="editFor(r).notice"
                class="body-small status-notice"
                :class="{ 'status-notice--warning': editFor(r).notice?.warning }"
                role="status"
              >
                {{ editFor(r).notice?.text }}
              </p>
            </div>
          </AppPanel>
        </ul>

        <div v-if="cancelledRequests.length > 0" class="cancelled-section">
          <AppButton variant="link" class="cancelled-toggle" :aria-expanded="showCancelled" aria-controls="cancelled-requests"
      data-testid="cancelled-toggle" @click="showCancelled = !showCancelled">
            <ChevronDownIcon class="cancelled-toggle__icon" :class="{ 'cancelled-toggle__icon--open': showCancelled }"
              aria-hidden="true" />
            Cancelled requests ({{ cancelledRequests.length }})
          </AppButton>

          <ul v-if="showCancelled" id="cancelled-requests" class="cancelled-list" data-testid="cancelled-list">
            <li v-for="r in cancelledRequests" :key="r.id" class="cancelled-row">
              <div class="cancelled-row__who">
                <p class="body-default cancelled-row__name">Request {{ requestNumber(r) }}</p>
                <p class="body-small muted">Submitted {{ formatSubmittedLong(r.createdAt) }}{{ requesterLabel(r) }}</p>
              </div>
              <ul class="cancelled-row__items">
                <li v-for="item in r.items" :key="item.id" class="body-default">
                  <strong>{{ item.quantity }}×</strong> {{ item.equipmentType }}
                </li>
              </ul>
              <span class="cancelled-pill"><XMarkIcon class="cancelled-pill__icon" aria-hidden="true" />Cancelled</span>
            </li>
          </ul>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.page {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: var(--spacing-24) var(--grid-desktop-gutter);
  padding: var(--spacing-40) var(--grid-desktop-margin) var(--spacing-80);
  align-content: start;
  min-height: 100vh;
}

.back,
.full,
.title-row,
.details {
  grid-column: 1 / 13;
}

.requirements {
  grid-column: 1 / 9;
}

/* The equipment tables run the full width of the page. */
.requests {
  grid-column: 1 / 13;
}

@media (max-width: 1024px) {
  .page {
    grid-template-columns: repeat(6, 1fr);
    gap: var(--spacing-24) var(--grid-tablet-gutter);
    padding: var(--spacing-32) var(--grid-tablet-margin) var(--spacing-48);
  }

  .back,
  .full,
  .title-row,
  .details,
  .requirements,
  .requests {
    grid-column: 1 / 7;
  }
}

@media (max-width: 640px) {
  .page {
    grid-template-columns: repeat(4, 1fr);
    gap: var(--spacing-24) var(--grid-mobile-gutter);
    padding: var(--spacing-24) var(--grid-mobile-margin) var(--spacing-48);
  }

  .back,
  .full,
  .title-row,
  .details,
  .requirements,
  .requests {
    grid-column: 1 / 5;
  }
}

.h2 {
  margin: 0;
}

.h6 {
  margin: 0 0 var(--spacing-8);
}

.h4 {
  margin: 0;
}

/* Style.md Composite Text Styles — H5: section divider title. */
.h5 {
  margin: 0;
}

.body-default {
  margin: 0;
  color: var(--color-grey-700);
}

.body-small {
  margin: 0;
}

.muted {
  color: var(--color-grey-600);
}

.error-text {
  color: var(--color-error-600);
}

/* "When and where": a flat strip between two rules, matching AttendeeEventDetailView's pattern. */
.details {
  border-top: 1px solid var(--color-grey-100);
  border-bottom: 1px solid var(--color-grey-100);
}

.requirements {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-16);
}

.requests {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-16);
}

.details-row {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-start;
  gap: var(--spacing-16) 200px;
  padding: var(--spacing-24) var(--spacing-24);
}

.detail-item {
  display: flex;
  align-items: center;
  gap: var(--spacing-12);
  min-width: 0;
}

/* Tinted icon chip: Style.md 2.6/2.9 — Purple Primary/100 tinted background behind Purple Primary/600 icons. */
.detail-icon-chip {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: var(--spacing-40);
  height: var(--spacing-40);
  border-radius: var(--radius-sm);
  background: var(--color-purple-100);
}

.detail-icon {
  flex: none;
  color: var(--color-purple-600);
}

.detail-text {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-2);
  min-width: 0;
}

.detail-label {
  font-size: 0.75rem;
  font-weight: 400;
  line-height: 1rem;
  color: var(--color-grey-700);
}

.detail-value {
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
}

@media (max-width: 640px) {
  .details-row {
    flex-direction: column;
    align-items: stretch;
    gap: var(--spacing-16);
    padding: var(--spacing-16);
  }
}

.request-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-16);
  list-style: none;
  margin: 0;
  padding: 0;
}

/* Each request sits on its own card (Style.md 3.3 surfaces), like the page's other cards. */
.request-card {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-16);
}

.requests-empty {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-4);
  padding: var(--spacing-24);
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
}

.requests-empty__title {
  margin: 0;
  font-weight: 700;
  color: var(--color-grey-900);
}

.cancelled-section {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-16);
}

.cancelled-toggle__icon {
  width: 1rem;
  height: 1rem;
  transform: rotate(-90deg);
  transition: transform 0.15s ease;
}

.cancelled-toggle__icon--open {
  transform: none;
}

.cancelled-list {
  list-style: none;
  margin: 0;
  padding: 0;
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
}

.cancelled-row {
  display: grid;
  grid-template-columns: 12rem 1fr auto;
  align-items: center;
  gap: var(--spacing-16);
  padding: var(--spacing-16) var(--spacing-24);
}

.cancelled-row + .cancelled-row {
  border-top: 1px solid var(--color-grey-100);
}

.cancelled-row__who p {
  margin: 0;
}

.cancelled-row__name {
  font-weight: 700;
  color: var(--color-grey-900);
}

.cancelled-row__items {
  list-style: none;
  margin: 0;
  padding: 0;
  color: var(--color-grey-900);
}

.cancelled-pill {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-4);
  padding: var(--spacing-4) var(--spacing-12);
  border-radius: var(--radius-xs);
  background: var(--color-grey-100);
  color: var(--color-grey-700);
  font-size: 0.875rem;
  line-height: 1.125rem;
}

.cancelled-pill__icon {
  width: 0.875rem;
  height: 0.875rem;
}

@media (max-width: 640px) {
  .cancelled-row {
    grid-template-columns: 1fr auto;
  }

  .cancelled-row__items {
    grid-column: 1 / -1;
  }
}

.request-card__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--spacing-12);
}

.request-card__heading {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-4);
}

.request-card .table-wrap {
  overflow-x: auto;
}

.equipment-cell {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
  width: 100%;
}

.equipment-cell__name-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-8);
}

.item-name {
  display: block;
  font-size: 1.125rem;
  line-height: 1.375rem;
  color: var(--color-grey-900);
}

.item-qty {
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-600);
}

.expand-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: var(--spacing-24);
  height: var(--spacing-24);
  padding: 0;
  border: none;
  background: none;
  color: var(--color-grey-600);
  cursor: pointer;
}

.expand-toggle__icon {
  width: var(--spacing-16);
  height: var(--spacing-16);
  transition: transform 0.15s ease;
}

.expand-toggle__icon--open {
  transform: rotate(180deg);
}

/* Which physical units are reserved (solid) or would also be reserved (dashed preview). */
.unit-panel {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
  padding: var(--spacing-8) var(--spacing-12);
  background: var(--color-grey-50);
  border-radius: var(--radius-xs);
}

.unit-panel__label {
  font-size: 0.6875rem;
  line-height: 0.875rem;
  font-weight: 700;
  color: var(--color-grey-600);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.unit-tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-8);
}

.unit-tag {
  display: inline-flex;
  align-items: center;
  height: var(--spacing-24);
  width: fit-content;
  padding: 0 var(--spacing-12);
  border-radius: var(--radius-xs);
  font-size: 0.75rem;
  line-height: 1rem;
  font-weight: 700;
}

.unit-tag--reserved {
  background: var(--color-purple-100);
  color: var(--color-purple-800);
}

.unit-tag--preview {
  background: var(--color-base-white);
  border: 1px dashed var(--color-purple-300);
  color: var(--color-purple-600);
}

.unit-tag--short {
  background: var(--color-error-200);
  color: var(--color-error-600);
}

/* "Available" column: the event-date-aware count, with today's stock as a secondary line. */
.item-available {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-2);
}

.item-available__count {
  font-size: 0.875rem;
  line-height: 1.125rem;
  font-weight: 700;
  color: var(--color-grey-900);
}

.item-available__count--short {
  color: var(--color-warning-900);
}

.item-available__today {
  font-size: 0.6875rem;
  line-height: 0.875rem;
  color: var(--color-grey-600);
}

/* The grey strip under the table that holds the actions (and what is outstanding). */
.request-card__footer {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-12);
}

/* A shortfall is caught here, before Save — the error set's role, same tokens as .unit-tag--short. */
.status-danger {
  background: var(--color-error-200);
  color: var(--color-error-600);
}

.item-row {
  color: var(--color-grey-900);
}

/* An item whose current pick comes up short: a light error tint on the whole row.
   :deep() — the row element lives in DataTable.vue's own template, not this one. */
:deep(.item-row--danger) {
  background: var(--color-error-200);
}

/* A reserved unit that no longer holds (E5-5): the Warning set's "needs attention" role. */
.flag-note {
  margin: var(--spacing-4) 0 0;
  padding: var(--spacing-4) var(--spacing-8);
  border-radius: var(--radius-xs);
  background: var(--color-warning-100);
  color: var(--color-warning-900);
}

.request-card__note {
  padding: var(--spacing-8) var(--spacing-12);
  border-radius: var(--radius-xs);
  background: var(--color-warning-100);
  color: var(--color-warning-900);
}

.status-editor {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-16);
}

.status-editor__hint {
  margin: 0;
}

.request-card__header-right {
  display: flex;
  align-items: center;
  gap: var(--spacing-12);
}

/* "Not enough stock for N items. Fix it to reserve." — above the table while editing. */
.shortfall-banner {
  display: flex;
  align-items: center;
  gap: var(--spacing-12);
  padding: var(--spacing-12) var(--spacing-16);
  background: var(--color-error-200);
  border: 1px solid var(--color-error-600);
  border-radius: var(--radius-xs);
  color: var(--color-error-600);
  font-size: 1rem;
  line-height: 1.25rem;
  font-weight: 700;
}

.shortfall-banner__icon {
  flex: none;
  width: var(--spacing-20);
  height: var(--spacing-20);
}

/* The arranging-now cell: stepper row, plus a shortfall fix message/button when it comes up short. */
.arranging-cell {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
}

.qty-stepper-row {
  display: flex;
  align-items: center;
  gap: var(--spacing-12);
}

.qty-stepper {
  display: flex;
  align-items: center;
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-xs);
  overflow: hidden;
}

.qty-stepper--danger {
  border: 2px solid var(--color-error-600);
}

.qty-stepper__btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border: none;
  background: var(--color-base-white);
  color: var(--color-purple-600);
  cursor: pointer;
}

.qty-stepper__btn:disabled {
  background: var(--color-grey-50);
  color: var(--color-grey-300);
  cursor: not-allowed;
}

.qty-stepper__btn:not(:disabled):hover {
  background: var(--color-purple-100);
}

.qty-stepper__btn:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: -2px;
}

.qty-stepper__value {
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--spacing-48);
  height: 44px;
  border-left: 1px solid var(--color-grey-200);
  border-right: 1px solid var(--color-grey-200);
  font-size: 1rem;
  line-height: 1.25rem;
  font-weight: 700;
  color: var(--color-grey-900);
}

.qty-stepper__warning {
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.125rem;
  font-weight: 700;
  color: var(--color-error-600);
}

/* "Still outstanding", shown while editing. */
.reserve-panels {
  padding: var(--spacing-16);
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-xs);
}

.reserve-panel {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
}

.reserve-panel__title {
  margin: 0;
  font-size: 1rem;
  line-height: 1.25rem;
  font-weight: 700;
  color: var(--color-grey-900);
}

.status-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--spacing-8);
}

/* Style.md 3.4: Save is the one solid button; Update status and Cancel are outline. */

.status-notice {
  padding: var(--spacing-8) var(--spacing-12);
  border-radius: var(--radius-xs);
  background: var(--color-grey-75);
  color: var(--color-grey-900);
}

.status-notice--warning {
  background: var(--color-warning-100);
  color: var(--color-warning-900);
}
</style>
