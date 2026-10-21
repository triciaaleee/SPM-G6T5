<script setup lang="ts">
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
import AppButton from "../components/ui/AppButton.vue";
import { computed, onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { getStoredUser, landingRouteForRole } from "../lib/auth";
import {
  EQUIPMENT_REQUEST_STATUSES,
  EquipmentAccessDeniedError,
  EquipmentRequestError,
  EquipmentValidationError,
  checkEquipmentAvailability,
  fetchEquipmentCatalog,
  fetchEquipmentRequestsForSupport,
  updateEquipmentRequestStatus,
  type EquipmentAvailability,
  type EquipmentCatalogItem,
  type EquipmentItem,
  type EquipmentRequest,
  type EquipmentRequestStatus,
  type EventEquipmentView,
} from "../lib/equipmentApi";

const route = useRoute();
const router = useRouter();
const eventId = String(route.params.eventId);

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

const requests = computed<EquipmentRequest[]>(() => view.value?.equipmentRequests ?? []);

interface EditState {
  expanded: boolean;
  status: EquipmentRequestStatus;
  saving: boolean;
  error: string | null;
  notice: { text: string; warning: boolean } | null;
}

const edits = reactive<Record<number, EditState>>({});

function editFor(r: EquipmentRequest): EditState {
  if (!edits[r.id]) {
    edits[r.id] = {
      expanded: false,
      status: (r.status as EquipmentRequestStatus) || "Requested",
      saving: false,
      error: null,
      notice: null,
    };
  }
  return edits[r.id];
}

/** Opens the editor, resynced to the request's current status — discards any stale pick from last time. */
function openEditor(r: EquipmentRequest): void {
  const edit = editFor(r);
  edit.status = (r.status as EquipmentRequestStatus) || "Requested";
  edit.error = null;
  edit.expanded = true;
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

interface AvailabilityCheckState {
  loading: boolean;
  error: string | null;
  result: EquipmentAvailability | null;
}

const availabilityChecks = reactive<Record<number, AvailabilityCheckState>>({});

function availabilityFor(item: EquipmentItem): AvailabilityCheckState {
  if (!availabilityChecks[item.id]) {
    availabilityChecks[item.id] = { loading: false, error: null, result: null };
  }
  return availabilityChecks[item.id];
}

async function checkAvailability(r: EquipmentRequest, item: EquipmentItem): Promise<void> {
  const state = availabilityFor(item);
  state.loading = true;
  state.error = null;
  try {
    state.result = await checkEquipmentAvailability(r.eventId, item.equipmentType, item.quantity);
  } catch (err) {
    state.error = err instanceof EquipmentRequestError ? err.message : "Couldn't check availability.";
  } finally {
    state.loading = false;
  }
}

/** Only meaningful before a decision: once Arranged or Partially Fulfilled, the check no longer applies. */
async function checkAllAvailability(targets: EquipmentRequest[]): Promise<void> {
  const requested = targets.filter((r) => r.status === "Requested");
  await Promise.all(requested.flatMap((r) => r.items.map((item) => checkAvailability(r, item))));
}

/** Fulfilled = however much is free right now (the catalog's availableStock), capped at what was requested. */
function fulfilledQuantityFor(item: EquipmentItem): number {
  const available = catalog.value.find((c) => c.name === item.equipmentType)?.availableStock ?? 0;
  return Math.min(item.quantity, Math.max(0, available));
}

function outstandingSummary(r: EquipmentRequest): string {
  const parts = r.items
    .map((item) => {
      const remaining = item.quantity - fulfilledQuantityFor(item);
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
    const fulfillments =
      edit.status === "Partially Fulfilled"
        ? r.items.map((item) => ({ itemId: item.id, fulfilledQuantity: fulfilledQuantityFor(item) }))
        : undefined;
    const note = edit.status === "Partially Fulfilled" ? outstandingSummary(r) : undefined;
    const { equipmentRequest, notified } = await updateEquipmentRequestStatus(r.id, edit.status, note, fulfillments);
    Object.assign(r, equipmentRequest);
    edit.expanded = false;
    edit.notice = notified
      ? { text: "Status updated. The coordinator has been notified.", warning: false }
      : { text: "Status updated, but we couldn't notify the coordinator — please follow up directly.", warning: true };
    // The save may have moved stock, so refresh it before the next outstanding preview.
    await refreshCatalog();
    if (r.status === "Requested") {
      void checkAllAvailability([r]);
    } else {
      for (const item of r.items) {
        const state = availabilityFor(item);
        state.loading = false;
        state.error = null;
        state.result = null;
      }
    }
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

/** Same colour convention as the requests list. */
function statusBadgeClass(status: string): string {
  if (status === "Arranged") return "status-success";
  if (status === "Partially Fulfilled") return "status-warning";
  return "status-open"; // Requested
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
    void checkAllAvailability(loaded.equipmentRequests);
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
      <button type="button" class="back-link" @click="goBack">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
        Back
      </button>
    </div>

    <p v-if="loading" class="full body-default muted">Loading equipment request…</p>

    <section v-else-if="accessDenied" class="full denied" role="alert">
      <h1 class="h3">You don't have access to this event</h1>
      <p class="body-default muted">No equipment has been requested for it.</p>
    </section>

    <p v-else-if="errorMessage || !view" class="full body-default error-text" role="alert">
      {{ errorMessage ?? "We couldn't load this equipment request. Please try again." }}
    </p>

    <template v-else>
      <div class="title-row">
        <h1 class="h2">{{ view.event.name || `Event #${view.event.id}` }}</h1>
      </div>

      <section class="details" aria-label="When and where">
        <h2 class="h4">When and where</h2>

        <div class="detail-row">
          <svg class="detail-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5" /></svg>
          <div class="detail-text">
            <span class="detail-label">Date</span>
            <span class="detail-value">{{ formatLongDate(view.event.proposedDate) }}</span>
          </div>
        </div>
        <hr class="divider" />

        <div class="detail-row">
          <svg class="detail-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>
          <div class="detail-text">
            <span class="detail-label">Time</span>
            <span class="detail-value">{{ formatTimeRange(view.event.startTime, view.event.endTime) }}</span>
          </div>
        </div>
        <hr class="divider" />

        <div class="detail-row">
          <svg class="detail-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" /><path d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z" /></svg>
          <div class="detail-text">
            <span class="detail-label">Venue</span>
            <span class="detail-value">{{ view.event.venue || "Venue to be confirmed" }}</span>
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

        <ul class="request-list">
          <li v-for="r in requests" :key="r.id" class="request-card">
            <div class="request-card__header">
              <span class="badge" :class="statusBadgeClass(r.status)">{{ r.status }}</span>
              <p class="body-small muted">Submitted {{ formatSubmitted(r.createdAt) }}</p>
            </div>

            <ul class="item-list">
              <li v-for="item in r.items" :key="item.id" class="body-default item-row">
                <strong>
                  <template v-if="r.status === 'Partially Fulfilled'">{{ item.quantityFulfilled }} of {{ item.quantity }}</template>
                  <template v-else>{{ item.quantity }}&times;</template>
                  {{ item.equipmentType }}
                </strong>

                <!-- E5-5 / E5-6 AC3: a reserved unit that is now unusable for the event needs re-arranging. -->
                <p v-if="item.reservationFlag?.flagged" class="body-small flag-note" data-testid="reservation-flag" role="alert">
                  {{ item.reservationFlag.reason }}
                </p>

                <!-- E5-4: checked automatically against the event's own date and time. -->
                <template v-if="r.status === 'Requested'">
                  <p v-if="availabilityFor(item).loading" class="body-small muted">Checking availability…</p>
                  <p v-else-if="availabilityFor(item).error" class="body-small error-text">{{ availabilityFor(item).error }}</p>
                  <p v-else-if="availabilityFor(item).result" class="body-small availability-result"
                    :class="{ 'availability-result--short': availabilityFor(item).result!.shortfall > 0 }">
                    <template v-if="availabilityFor(item).result!.shortfall > 0">
                      Unavailable — need {{ availabilityFor(item).result!.shortfall }} more
                    </template>
                    <template v-else>Available</template>
                  </p>
                </template>
              </li>
            </ul>

            <p v-if="r.fulfillmentNote" class="body-small request-card__note">Outstanding: {{ r.fulfillmentNote }}</p>

            <!-- E5-3: update this request's status as arrangements are made. -->
            <div class="status-editor">
              <AppButton variant="outline" v-if="!editFor(r).expanded" type="button" @click="openEditor(r)">
                Update status
              </AppButton>

              <div v-else class="status-form">
                <div class="status-pills" role="radiogroup" aria-label="Status">
                  <button
                    v-for="option in EQUIPMENT_REQUEST_STATUSES"
                    :key="option"
                    type="button"
                    role="radio"
                    :aria-checked="editFor(r).status === option"
                    class="status-pill"
                    :class="{ 'status-pill--active': editFor(r).status === option }"
                    @click="editFor(r).status = option"
                  >
                    {{ option }}
                  </button>
                </div>

                <div v-if="editFor(r).status === 'Partially Fulfilled'" class="outstanding-box">
                  <p class="body-small muted">Outstanding</p>
                  <p class="body-small outstanding-preview">{{ outstandingSummary(r) }}</p>
                </div>

                <p v-if="editFor(r).error" class="body-small error-text" role="alert">{{ editFor(r).error }}</p>

                <div class="status-form-actions">
                  <AppButton variant="primary" type="button" :disabled="editFor(r).saving" @click="saveStatus(r)">
                    {{ editFor(r).saving ? "Saving…" : "Save" }}
                  </AppButton>
                  <AppButton variant="outline" type="button" :disabled="editFor(r).saving" @click="cancelEdit(r)">
                    Cancel
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
          </li>
        </ul>
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

.requirements,
.requests {
  grid-column: 1 / 9;
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

.back-link {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-8);
  min-height: 44px;
  padding: 0;
  border: none;
  background: none;
  color: var(--color-purple-600);
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  cursor: pointer;
}

.back-link:hover {
  text-decoration: underline;
}

.back-link:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

.h2 {
  font-size: 2.25rem;
  font-weight: 700;
  line-height: 2.625rem;
  color: var(--color-grey-900);
  margin: 0;
}

.h3 {
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
  margin: 0 0 var(--spacing-8);
}

.h4 {
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
  margin: 0;
}

.body-default {
  font-size: 1rem;
  line-height: 1.25rem;
  margin: 0;
  color: var(--color-grey-700);
}

.body-small {
  font-size: 0.875rem;
  line-height: 1.125rem;
  margin: 0;
}

.muted {
  color: var(--color-grey-500);
}

.error-text {
  color: var(--color-error-600);
}

.denied {
  padding: var(--spacing-40) var(--spacing-24);
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
}

/* "When and where": the one card of event information Technical Support get. */
.details,
.requirements,
.request-card {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-16);
  padding: var(--spacing-24);
  box-sizing: border-box;
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
}

.requests {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-16);
}

.detail-row {
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-12);
}

.detail-icon {
  flex: none;
  color: var(--color-grey-500);
  margin-top: var(--spacing-2);
}

.detail-text {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-2);
}

.detail-label {
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  color: var(--color-grey-500);
}

.detail-value {
  font-size: 1rem;
  line-height: 1.25rem;
  color: var(--color-grey-900);
}

.divider {
  margin: 0;
  border: none;
  border-top: 1px solid var(--color-grey-100);
}

.request-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-16);
  list-style: none;
  margin: 0;
  padding: 0;
}

.request-card__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-12);
}

.badge {
  display: inline-flex;
  align-items: center;
  height: var(--spacing-24);
  padding: 0 var(--spacing-12);
  border-radius: var(--radius-full);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
}

.status-open {
  background: var(--color-blue-200);
  color: var(--color-blue-800);
}

.status-success {
  background: var(--color-success-200);
  color: var(--color-success-700);
}

.status-warning {
  background: var(--color-warning-100);
  color: var(--color-warning-900);
}

.item-list {
  margin: 0;
  padding: var(--spacing-12) 0 0;
  border-top: 1px solid var(--color-grey-100);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
  list-style: none;
}

.item-row {
  color: var(--color-grey-900);
}

.availability-result {
  margin: var(--spacing-4) 0 0;
  color: var(--color-success-700);
}

.availability-result--short {
  color: var(--color-error-600);
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
  flex-direction: column;
  align-items: flex-start;
  gap: var(--spacing-8);
  padding-top: var(--spacing-12);
  border-top: 1px solid var(--color-grey-100);
}

.status-form {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-12);
  width: 100%;
}

.status-pills {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-8);
}

.status-pill {
  min-height: 44px;
  padding: 0 var(--spacing-16);
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-full);
  background: var(--color-base-white);
  color: var(--color-grey-700);
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  font-weight: 700;
  cursor: pointer;
}

.status-pill:hover {
  border-color: var(--color-purple-300);
}

.status-pill--active {
  background: var(--color-purple-600);
  border-color: var(--color-purple-600);
  color: var(--color-base-white);
}

.status-pill:focus-visible{
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

.outstanding-box {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
  padding: var(--spacing-12);
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-xs);
}

.outstanding-preview {
  color: var(--color-grey-900);
}

.status-form-actions {
  display: flex;
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
