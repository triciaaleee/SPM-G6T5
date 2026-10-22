<script setup lang="ts">
/**
 * E5-1 AC1: Technical Support Staff's queue of equipment requests, grouped by
 * event. Each event is a section (with its date, time and venue, and a link
 * to its full request) listing the equipment types it still needs, soonest
 * event first. The tabs split the queue by status; the two filters narrow it
 * by date range and by equipment. Opening a section's link (E5-1 AC1/AC2)
 * shows the full request, which is also where the status is updated (E5-3).
 *
 * A last tab, Cancelled / Past, keeps what is no longer to arrange so it can be
 * looked back at: events whose requests were all cancelled (by the coordinator,
 * or because the event was cancelled), and arranged or partly arranged events
 * whose date has passed, newest first. An unarranged event that has passed stays
 * under Requested, as overdue. History rows are read-only.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { ChevronDownIcon } from "@heroicons/vue/16/solid";
import AppButton from "../components/ui/AppButton.vue";
import DataTable from "../components/ui/DataTable.vue";
import {
  EQUIPMENT_REQUEST_STATUSES,
  fetchAllEquipmentRequests,
  fetchEquipmentCatalog,
  updateEquipmentRequestStatus,
  type EquipmentCatalogItem,
  type EquipmentRequestStatus,
  type EquipmentRequestWithEvent,
} from "../lib/equipmentApi";

/** The quick status menu only offers a bare flip — no extra data needed. Partially
 * Fulfilled needs per-item fulfilled quantities (EquipmentRequestDetailView.vue's
 * fulfilledQuantityFor/outstandingSummary), so it stays on the full request page. */
const QUICK_STATUS_OPTIONS: EquipmentRequestStatus[] = ["Requested", "Arranged"];

const TABLE_COLUMNS = [
  { key: "equipment", label: "Equipment" },
  { key: "qty", label: "Qty needed" },
  { key: "stock", label: "In stock" },
  { key: "status", label: "Status" },
  { key: "action", label: "" },
];
const TABLE_COLUMN_WIDTHS = "10rem 8rem 6rem 9rem 10rem";

/** A request's status as the queue sees it: the three working statuses, or Cancelled. */
type RowStatus = EquipmentRequestStatus | "Cancelled";

/** The last tab: cancelled events and finished arrangements for events that have passed. */
const HISTORY_TAB = "Cancelled / Past";
type TabKey = EquipmentRequestStatus | typeof HISTORY_TAB;
const TABS: TabKey[] = [...EQUIPMENT_REQUEST_STATUSES, HISTORY_TAB];

/** One line of the queue: a single item of a request, with its event's timing. */
interface QueueRow {
  key: string;
  eventId: number;
  requestId: number;
  status: RowStatus;
  date: string | null;
  startTime: string | null;
  endTime: string | null;
  eventName: string;
  venue: string | null;
  equipmentType: string;
  quantity: number;
  quantityFulfilled: number;
}

type RangeKey = "7" | "30" | "90" | "all";

const RANGES: { key: RangeKey; label: string; empty: string }[] = [
  { key: "7", label: "Next 7 days", empty: "in the next 7 days" },
  { key: "30", label: "Next 30 days", empty: "in the next 30 days" },
  { key: "90", label: "Next 90 days", empty: "in the next 90 days" },
  { key: "all", label: "All dates", empty: "" },
];

const ALL_EQUIPMENT = "";

const requests = ref<EquipmentRequestWithEvent[]>([]);
const catalog = ref<EquipmentCatalogItem[]>([]);
const loading = ref(true);
const errorMessage = ref<string | null>(null);

const activeTab = ref<TabKey>("Requested");
const range = ref<RangeKey>("30");
const equipment = ref<string>(ALL_EQUIPMENT);

function statusOf(r: EquipmentRequestWithEvent): RowStatus {
  if (r.status === "Cancelled") return "Cancelled";
  return (EQUIPMENT_REQUEST_STATUSES as readonly string[]).includes(r.status)
    ? (r.status as EquipmentRequestStatus)
    : "Requested";
}

const rows = computed<QueueRow[]>(() =>
  requests.value.flatMap((r) =>
    r.items.map((item) => ({
      key: `${r.id}-${item.id}`,
      eventId: r.eventId,
      requestId: r.id,
      status: statusOf(r),
      date: r.event?.proposedDate ?? null,
      startTime: r.event?.startTime ?? null,
      endTime: r.event?.endTime ?? null,
      eventName: r.event?.name || `Event #${r.eventId}`,
      venue: r.event?.venue ?? null,
      equipmentType: item.equipmentType,
      quantity: item.quantity,
      quantityFulfilled: item.quantityFulfilled,
    })),
  ),
);

// Dates -------------------------------------------------------------------------

/** Whole days from today to a "YYYY-MM-DD" date: negative once it has passed. */
function daysUntil(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((new Date(y, m - 1, d).getTime() - today.getTime()) / 86_400_000);
}

function formatDate(dateKey: string | null): string {
  if (!dateKey) return "Date not set";
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

function formatTime(start: string | null, end: string | null): string {
  return start && end ? `${start} to ${end}` : "Time not set";
}

/** Soonest first: by date, then start time; undated rows/groups last. */
function compareRows(a: { date: string | null; startTime: string | null }, b: { date: string | null; startTime: string | null }): number {
  const byDate = (a.date ?? "9999-12-31").localeCompare(b.date ?? "9999-12-31");
  return byDate !== 0 ? byDate : (a.startTime ?? "").localeCompare(b.startTime ?? "");
}

/**
 * Everything up to the end of the chosen range, including events that have
 * already passed: an unarranged request for a past event is overdue, not gone.
 */
function inRange(row: QueueRow): boolean {
  if (range.value === "all" || !row.date) return true;
  return daysUntil(row.date) <= Number(range.value);
}

// Filtering and grouping --------------------------------------------------------

// Date range is a per-event concern (every row of one event shares the same date).
// It looks ahead, so it does not apply to the history tab, which shows everything
// (see `eventAggregates`). The equipment-type filter must never change which tab an
// event belongs to, only narrow what's displayed once an event is already there
// (see `groups` below).

const equipmentOptions = computed(() => [...new Set(rows.value.map((row) => row.equipmentType))].sort());

interface Group {
  eventId: number;
  eventName: string;
  date: string | null;
  startTime: string | null;
  endTime: string | null;
  venue: string | null;
  rows: QueueRow[];
  aggregateStatus: TabKey;
}

/**
 * One event can have several equipment requests (supabase/migrations/0020's own
 * comment: "an event may accumulate more than one", same as venue_bookings). Its
 * equipment is always ONE table, never split across tabs by each request's own
 * status — so the event's tab is decided by all of its requests together:
 * Arranged only once every request is Arranged; Requested only while every
 * request is still untouched; anything in between (a mix, or a request that's
 * itself Partially Fulfilled) is Partially Fulfilled.
 */
function aggregateStatus(eventRows: QueueRow[]): TabKey {
  // Cancelled requests don't count towards the event's status. An event with
  // nothing live left is history; so is a finished (arranged or partly arranged)
  // event whose date has passed. An unarranged one that has passed is overdue and
  // stays under Requested.
  const live = eventRows.filter((row) => row.status !== "Cancelled");
  if (live.length === 0) return HISTORY_TAB;

  const statuses = new Set(live.map((row) => row.status));
  let status: EquipmentRequestStatus = "Partially Fulfilled";
  if (statuses.size === 1 && statuses.has("Arranged")) status = "Arranged";
  else if (statuses.size === 1 && statuses.has("Requested")) status = "Requested";

  const [first] = live;
  if (status !== "Requested" && first.date && daysUntil(first.date) < 0) return HISTORY_TAB;
  return status;
}

/** Stock on hand for one equipment type, looked up per row now that a group spans several types. */
function stockFor(equipmentType: string): number | null {
  return catalog.value.find((item) => item.name === equipmentType)?.availableStock ?? null;
}

/** Every event (date-range filtered), each with ALL of its rows and its aggregate status — the
 * single source both the tab counts and the per-tab table list are built from. */
const eventAggregates = computed<Group[]>(() => {
  const byEvent = new Map<number, QueueRow[]>();
  for (const row of rows.value) {
    byEvent.set(row.eventId, [...(byEvent.get(row.eventId) ?? []), row]);
  }
  const aggregates = [...byEvent.entries()].map(([eventId, eventRows]) => {
    const sorted = [...eventRows].sort((a, b) => a.equipmentType.localeCompare(b.equipmentType));
    const [first] = eventRows;
    return {
      eventId,
      eventName: first.eventName,
      date: first.date,
      startTime: first.startTime,
      endTime: first.endTime,
      venue: first.venue,
      rows: sorted,
      aggregateStatus: aggregateStatus(eventRows),
    };
  });
  return aggregates.filter((event) => event.aggregateStatus === HISTORY_TAB || inRange(event.rows[0]));
});

const tabCounts = computed(() => {
  const counts: Record<TabKey, number> = { Requested: 0, Arranged: 0, "Partially Fulfilled": 0, [HISTORY_TAB]: 0 };
  for (const event of eventAggregates.value) counts[event.aggregateStatus]++;
  return counts;
});

const groups = computed<Group[]>(() =>
  eventAggregates.value
    .filter((event) => event.aggregateStatus === activeTab.value)
    .map((event) => ({
      ...event,
      // Outside the history tab, requests that were cancelled are left out of the table.
      rows: event.rows
        .filter((row) => activeTab.value === HISTORY_TAB || row.status !== "Cancelled")
        .filter((row) => equipment.value === ALL_EQUIPMENT || row.equipmentType === equipment.value),
    }))
    .filter((event) => event.rows.length > 0)
    // History reads newest first; the working tabs, soonest first.
    .sort((a, b) => (activeTab.value === HISTORY_TAB ? compareRows(b, a) : compareRows(a, b))),
);

/** In the history tab a section says why it is there: cancelled, or an event that has passed. */
function historyLabel(group: Group): string {
  return group.rows.every((row) => row.status === "Cancelled") ? "Cancelled" : "Past event";
}

function quantityLabel(row: QueueRow): string {
  return row.status === "Partially Fulfilled" ? `${row.quantityFulfilled} of ${row.quantity}` : `${row.quantity}×`;
}

/** Same colour convention as EquipmentRequestDetailView.vue's statusBadgeClass. */
function rowStatusBadgeClass(status: RowStatus): string {
  if (status === "Arranged") return "status-success";
  if (status === "Partially Fulfilled") return "status-warning";
  if (status === "Cancelled") return "status-cancelled";
  return "status-open";
}

const emptyMessage = computed(() => {
  if (activeTab.value === HISTORY_TAB) return "No cancelled or past requests.";
  const what = activeTab.value === "Requested" ? "to arrange" : activeTab.value.toLowerCase();
  const suffix = RANGES.find((r) => r.key === range.value)?.empty ?? "";
  return `Nothing ${what}${suffix ? ` ${suffix}` : ""}.`;
});

// Quick status menu: one per ROW (a table can now mix rows from different requests
// in different states), flips Requested <-> Arranged with a single API call.
// Partially Fulfilled needs per-item fulfilled quantities, so it stays on the full
// request page (EquipmentRequestDetailView.vue), not duplicated here. Keyed by the
// row's own key, not its requestId — two rows can share a request but still open independently.
const statusMenuOpenFor = ref<string | null>(null);
const statusUpdating = ref<number | null>(null);
const statusUpdateError = ref<string | null>(null);

function toggleStatusMenu(rowKey: string): void {
  if (statusMenuOpenFor.value === rowKey) {
    statusMenuOpenFor.value = null;
    return;
  }
  statusUpdateError.value = null;
  statusMenuOpenFor.value = rowKey;
}

function closeStatusMenu(returnFocus = false): void {
  const openRowKey = statusMenuOpenFor.value;
  statusMenuOpenFor.value = null;
  if (returnFocus && openRowKey !== null) {
    document.querySelector<HTMLElement>(`[data-status-trigger="${openRowKey}"]`)?.focus();
  }
}

// Click anywhere outside every status menu (not just the open one — v-for means there's
// one .status-menu per row) closes whichever is open.
function onStatusMenuPointerDown(e: PointerEvent): void {
  if (!(e.target as HTMLElement).closest(".status-menu")) closeStatusMenu();
}

function onStatusMenuKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.stopPropagation();
    closeStatusMenu(true);
  }
}

watch(statusMenuOpenFor, (openRowKey) => {
  if (openRowKey !== null) {
    document.addEventListener("pointerdown", onStatusMenuPointerDown);
  } else {
    document.removeEventListener("pointerdown", onStatusMenuPointerDown);
  }
});

onBeforeUnmount(() => document.removeEventListener("pointerdown", onStatusMenuPointerDown));

async function quickUpdateStatus(requestId: number, status: EquipmentRequestStatus): Promise<void> {
  const current = requests.value.find((r) => r.id === requestId);
  if (!current || statusOf(current) === status) {
    closeStatusMenu();
    return;
  }

  statusUpdating.value = requestId;
  statusUpdateError.value = null;
  try {
    await updateEquipmentRequestStatus(requestId, status);
    current.status = status;
    closeStatusMenu();
  } catch {
    statusUpdateError.value = "Couldn't update the status. Please try again.";
  } finally {
    statusUpdating.value = null;
  }
}

onMounted(async () => {
  try {
    const [loadedRequests, loadedCatalog] = await Promise.all([
      fetchAllEquipmentRequests(),
      fetchEquipmentCatalog().catch(() => [] as EquipmentCatalogItem[]),
    ]);
    requests.value = loadedRequests;
    catalog.value = loadedCatalog;
    // Open on the first tab that has anything in it.
    const first = EQUIPMENT_REQUEST_STATUSES.find((status) => tabCounts.value[status] > 0);
    activeTab.value = first ?? "Requested";
  } catch {
    errorMessage.value = "We couldn't load equipment requests. Please try again.";
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <!--
    Column mapping — Equipment requests (Technical Support)
    Desktop (12-col, grid-desktop-margin 80px): header, tabs, filters and every equipment section col 1-12.
      Nested grid: each section's rows are a 7-column table (date, time, event, venue, quantity, urgency, link) filling the row.
    Tablet (6-col, grid-tablet-margin 32px): everything col 1-6; each row folds into date + time + urgency on one line, then event, venue + quantity, and the link.
    Mobile (4-col, grid-mobile-margin 6px): everything col 1-4; same folded rows.
  -->
  <div class="page">
    <div class="page-header">
      <h1 class="h2">Equipment requests</h1>
      <p class="subheading">Everything still to arrange, soonest event first</p>
    </div>

    <p v-if="loading" class="body-default muted full">Loading equipment requests…</p>
    <p v-else-if="errorMessage" class="body-default error-text full" role="alert">{{ errorMessage }}</p>

    <template v-else>
      <div class="toolbar">
        <div class="tabs" role="tablist" aria-label="Request status">
          <button v-for="tabStatus in TABS" :id="`tab-${tabStatus}`" :key="tabStatus"
            type="button" role="tab" :aria-selected="activeTab === tabStatus" aria-controls="requests-panel" class="tab"
            :class="{ 'tab--active': activeTab === tabStatus }" @click="activeTab = tabStatus">
            {{ tabStatus }}
            <span class="tab-count">{{ tabCounts[tabStatus] }}</span>
          </button>
        </div>

        <div class="filters">
          <div class="select">
            <select v-model="range" class="select__input" aria-label="Date range">
              <option v-for="option in RANGES" :key="option.key" :value="option.key">{{ option.label }}</option>
            </select>
            <ChevronDownIcon class="select__icon" aria-hidden="true" />
          </div>
          <div class="select">
            <select v-model="equipment" class="select__input" aria-label="Equipment">
              <option :value="ALL_EQUIPMENT">All equipment</option>
              <option v-for="type in equipmentOptions" :key="type" :value="type">{{ type }}</option>
            </select>
            <ChevronDownIcon class="select__icon" aria-hidden="true" />
          </div>
        </div>
      </div>

      <div id="requests-panel" role="tabpanel" :aria-labelledby="`tab-${activeTab}`" class="panel">
        <div v-if="groups.length === 0" class="empty-state">
          <p class="empty-state__title">Nothing here</p>
          <p class="body-default muted">{{ emptyMessage }}</p>
        </div>

        <section v-for="group in groups" :key="group.eventId" class="group" :aria-labelledby="`group-${group.eventId}`">
          <div class="group-header">
            <div class="group-header__title">
              <RouterLink :to="{ name: 'equipment-request-detail', params: { eventId: group.eventId } }"
                class="group-title-link">
                <h2 :id="`group-${group.eventId}`" class="h4">{{ group.eventName }}</h2>
                <svg class="group-title-link__chevron" width="14" height="14" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"
                  aria-hidden="true">
                  <path d="m8.25 4.5 7.5 7.5-7.5 7.5" />
                </svg>
              </RouterLink>
            </div>
            <div class="group-header__row">
              <div class="group-header__meta">
                <span class="meta-item">
                  <svg class="meta-item__icon" width="16" height="16" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
                    aria-hidden="true">
                    <path
                      d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5" />
                  </svg>
                  {{ formatDate(group.date) }} · {{ formatTime(group.startTime, group.endTime) }}
                </span>
                <span class="meta-item">
                  <svg class="meta-item__icon" width="16" height="16" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
                    aria-hidden="true">
                    <path d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                    <path d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z" />
                  </svg>
                  <span :class="{ 'cell-venue--empty': !group.venue }">{{ group.venue || "Venue not set" }}</span>
                </span>
              </div>
              <div v-if="activeTab === HISTORY_TAB" class="group-header__badges">
                <span class="count-badge" data-testid="history-label">{{ historyLabel(group) }}</span>
              </div>
            </div>
          </div>

          <DataTable
            :columns="TABLE_COLUMNS"
            :column-widths="TABLE_COLUMN_WIDTHS"
            :rows="group.rows"
            :row-key="(row) => row.key"
          >
            <template #cell-equipment="{ row }">
              <span class="cell-equipment">{{ row.equipmentType }}</span>
            </template>
            <template #cell-qty="{ row }">
              <span class="cell-qty">{{ quantityLabel(row) }}</span>
            </template>
            <template #cell-stock="{ row }">
              <span class="cell-stock">{{ stockFor(row.equipmentType) ?? "—" }}</span>
            </template>
            <template #cell-status="{ row }">
              <span class="badge" :class="rowStatusBadgeClass(row.status)">{{ row.status }}</span>
            </template>
            <template #cell-action="{ row }">
              <!-- History is read-only: a cancelled or past request can't be updated from here. -->
              <div v-if="activeTab !== HISTORY_TAB && row.status !== 'Cancelled'" class="status-menu" @keydown="onStatusMenuKeydown">
                <AppButton
                  :data-status-trigger="row.key"
                  variant="outline"
                  size="sm"
                  type="button"
                  aria-haspopup="menu"
                  :aria-expanded="statusMenuOpenFor === row.key"
                  :disabled="statusUpdating === row.requestId"
                  @click="toggleStatusMenu(row.key)"
                >
                  Update status
                  <ChevronDownIcon class="status-menu__chevron" aria-hidden="true" />
                </AppButton>

                <div v-if="statusMenuOpenFor === row.key" class="status-menu__popover" role="menu" aria-label="Update status">
                  <button
                    v-for="option in QUICK_STATUS_OPTIONS"
                    :key="option"
                    type="button"
                    role="menuitemradio"
                    class="status-menu__option"
                    :aria-checked="row.status === option"
                    :disabled="statusUpdating === row.requestId"
                    @click="quickUpdateStatus(row.requestId, option)"
                  >
                    {{ option }}
                  </button>
                  <p v-if="statusUpdateError" class="status-menu__error" role="alert">{{ statusUpdateError }}</p>
                </div>
              </div>
            </template>
          </DataTable>
        </section>
      </div>
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
}

.page-header,
.full,
.toolbar,
.panel {
  grid-column: 1 / 13;
}

@media (max-width: 1024px) {
  .page {
    grid-template-columns: repeat(6, 1fr);
    gap: var(--spacing-24) var(--grid-tablet-gutter);
    padding: var(--spacing-32) var(--grid-tablet-margin) var(--spacing-48);
  }

  .page-header,
  .full,
  .toolbar,
  .panel {
    grid-column: 1 / 7;
  }
}

@media (max-width: 640px) {
  .page {
    grid-template-columns: repeat(4, 1fr);
    gap: var(--spacing-24) var(--grid-mobile-gutter);
    padding: var(--spacing-24) var(--grid-mobile-margin) var(--spacing-48);
  }

  .page-header,
  .full,
  .toolbar,
  .panel {
    grid-column: 1 / 5;
  }
}

.h2 {
  font-size: 2.25rem;
  font-weight: 700;
  line-height: 2.625rem;
  color: var(--color-grey-900);
  margin: 0;
}

.h4 {
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
  margin: 0;
}

.subheading {
  font-size: 1rem;
  font-weight: 400;
  line-height: 1.25rem;
  color: var(--color-grey-600);
  margin: var(--spacing-8) 0 0;
}

.body-default {
  font-size: 1rem;
  line-height: 1.25rem;
  margin: 0;
}

.muted {
  color: var(--color-grey-500);
}

.error-text {
  color: var(--color-error-600);
}

/* Toolbar: tabs and filters share one row, filters pushed to the right. */
.toolbar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--spacing-16);
}

/* Tabs --------------------------------------------------------------------- */

.tabs {
  display: flex;
  flex: 0 1 75%;
  flex-wrap: wrap;
  gap: var(--spacing-24);
  border-bottom: 1.5px solid var(--color-grey-100);
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-8);
  min-height: 44px;
  padding: 0 var(--spacing-8);
  border: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  background: none;
  color: var(--color-grey-600);
  font-family: var(--font-family-lato);
  font-size: 1rem;
  font-weight: 700;
  line-height: 1.25rem;
  cursor: pointer;
}

.tab:hover {
  color: var(--color-grey-900);
}

.tab:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

.tab--active,
.tab--active:hover {
  color: var(--color-blue-600);
  border-bottom-color: var(--color-blue-600);
}

.tab-count {
  min-width: var(--spacing-20);
  padding: 0 var(--spacing-6);
  border-radius: var(--radius-full);
  background: var(--color-grey-100);
  color: var(--color-grey-600);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1.25rem;
  text-align: center;
}

.tab--active .tab-count {
  background: var(--color-blue-100);
  color: var(--color-blue-800);
}

/* Filters ------------------------------------------------------------------ */

.filters {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-12);
}

.select {
  position: relative;
  display: flex;
  align-items: center;
}

.select__input {
  appearance: none;
  min-height: 44px;
  padding: 0 var(--spacing-40) 0 var(--spacing-16);
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-xs);
  background: var(--color-base-white);
  color: var(--color-grey-900);
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  cursor: pointer;
}

.select__input:hover {
  border-color: var(--color-grey-300);
}

.select__input:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

.select__icon {
  position: absolute;
  right: var(--spacing-12);
  width: var(--spacing-16);
  height: var(--spacing-16);
  color: var(--color-grey-700);
  pointer-events: none;
}

/* Equipment sections ------------------------------------------------------- */

.panel {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-40);
}

.group {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-12);
}

.group:last-child {
  padding-bottom: 0;
  border-bottom: none;
}

.group-header {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  /* gap: var(--spacing-8); */
  flex-direction: column;
}

.group-header__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--spacing-12);
  align-self: stretch;
}

.group-header__title {
  display: flex;
  align-items: center;
  gap: var(--spacing-12);
}

.group-header__meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--spacing-24);
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-600);
}

.meta-item {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-6);
}

.meta-item__icon {
  flex-shrink: 0;
  color: var(--color-grey-500);
}

.group-title-link {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-6);
  color: inherit;
  text-decoration: none;
  cursor: pointer;
}

.group-title-link:hover .h4,
.group-title-link:hover .group-title-link__chevron {
  color: var(--color-purple-600);
}

.group-title-link:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
  border-radius: var(--radius-xs);
}

.group-title-link__chevron {
  flex-shrink: 0;
  color: var(--color-grey-600);
}


.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: var(--spacing-40) var(--spacing-24);
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
}

.empty-state__title {
  margin: 0 0 var(--spacing-8);
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
}

.cell-equipment {
  font-size: 1rem;
  font-weight: 700;
  line-height: 1.25rem;
  color: var(--color-grey-900);
}

.cell-venue--empty {
  color: var(--color-grey-500);
}

.cell-qty {
  font-weight: 700;
  color: var(--color-grey-900);
}

/* Per-row status badge (same colour convention as EquipmentRequestDetailView.vue). */

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

/* Cancelled: neutral grey, like a finished event's badge. */
.status-cancelled {
  background: var(--color-grey-100);
  color: var(--color-grey-700);
}

/* Why an event is in the Cancelled / Past tab. */
.group-header__badges {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--spacing-12);
}

.count-badge {
  display: inline-flex;
  align-items: center;
  height: var(--spacing-24);
  padding: 0 var(--spacing-12);
  border-radius: var(--radius-full);
  background: var(--color-grey-100);
  color: var(--color-grey-700);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
}

/* Update status: a ghost button that opens a small menu of the two bare-flip statuses. */

.status-menu {
  position: relative;
}

.status-menu__chevron {
  width: var(--spacing-16);
  height: var(--spacing-16);
}

.status-menu__popover {
  position: absolute;
  top: calc(100% + var(--spacing-8));
  right: 0;
  z-index: 20;
  width: 200px;
  box-sizing: border-box;
  padding: var(--spacing-8);
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-popover);
}

.status-menu__option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  box-sizing: border-box;
  min-height: 40px;
  padding: 0 var(--spacing-12);
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  font-weight: 700;
  color: var(--color-grey-900);
  cursor: pointer;
  text-align: left;
}

.status-menu__option:hover:not(:disabled) {
  background: var(--color-grey-50);
}

.status-menu__option:disabled {
  color: var(--color-grey-300);
  cursor: not-allowed;
}

.status-menu__option[aria-checked="true"] {
  background: var(--color-purple-100);
  color: var(--color-purple-800);
}

.status-menu__error {
  margin: var(--spacing-8) var(--spacing-4) 0;
  font-size: 0.75rem;
  color: var(--color-error-600);
}
</style>
