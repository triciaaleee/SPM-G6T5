<script setup lang="ts">
/**
 * E5-1 AC1: Technical Support Staff's queue of equipment requests, grouped by
 * event. Each event is a section (with its date, time and venue, and a link
 * to its full request) listing the equipment types it still needs, soonest
 * event first. The tabs split the queue by status; the two filters narrow it
 * by date range and by equipment. Opening a section's link (E5-1 AC1/AC2)
 * shows the full request, which is also where the status is updated (E5-3).
 */
import { computed, onMounted, ref } from "vue";
import { ChevronDownIcon } from "@heroicons/vue/16/solid";
import {
  EQUIPMENT_REQUEST_STATUSES,
  fetchAllEquipmentRequests,
  fetchEquipmentCatalog,
  type EquipmentCatalogItem,
  type EquipmentRequestStatus,
  type EquipmentRequestWithEvent,
} from "../lib/equipmentApi";

/** One line of the queue: a single item of a request, with its event's timing. */
interface QueueRow {
  key: string;
  eventId: number;
  status: EquipmentRequestStatus;
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

/** How close an unarranged event has to be before its row gets an urgency badge. */
const URGENT_WITHIN_DAYS = 3;

const requests = ref<EquipmentRequestWithEvent[]>([]);
const catalog = ref<EquipmentCatalogItem[]>([]);
const loading = ref(true);
const errorMessage = ref<string | null>(null);

const activeTab = ref<EquipmentRequestStatus>("Requested");
const range = ref<RangeKey>("30");
const equipment = ref<string>(ALL_EQUIPMENT);

function statusOf(r: EquipmentRequestWithEvent): EquipmentRequestStatus {
  return (EQUIPMENT_REQUEST_STATUSES as readonly string[]).includes(r.status)
    ? (r.status as EquipmentRequestStatus)
    : "Requested";
}

const rows = computed<QueueRow[]>(() =>
  requests.value.flatMap((r) =>
    r.items.map((item) => ({
      key: `${r.id}-${item.id}`,
      eventId: r.eventId,
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

const filteredRows = computed(() =>
  rows.value.filter(
    (row) => inRange(row) && (equipment.value === ALL_EQUIPMENT || row.equipmentType === equipment.value),
  ),
);

const rowsByTab = computed(() => {
  const groups: Record<EquipmentRequestStatus, QueueRow[]> = { Requested: [], Arranged: [], "Partially Fulfilled": [] };
  for (const row of filteredRows.value) groups[row.status].push(row);
  return groups;
});

const equipmentOptions = computed(() => [...new Set(rows.value.map((row) => row.equipmentType))].sort());

interface Group {
  eventId: number;
  eventName: string;
  date: string | null;
  startTime: string | null;
  endTime: string | null;
  venue: string | null;
  rows: QueueRow[];
  total: number;
}

/** What the group's badge counts: what is still needed for a partial fulfilment, otherwise the quantity. */
function groupTotal(groupRows: QueueRow[]): number {
  return groupRows.reduce(
    (sum, row) => sum + (row.status === "Partially Fulfilled" ? row.quantity - row.quantityFulfilled : row.quantity),
    0,
  );
}

/** Stock on hand for one equipment type, looked up per row now that a group spans several types. */
function stockFor(equipmentType: string): number | null {
  return catalog.value.find((item) => item.name === equipmentType)?.availableStock ?? null;
}

const groups = computed<Group[]>(() => {
  const byEvent = new Map<number, QueueRow[]>();
  for (const row of rowsByTab.value[activeTab.value]) {
    byEvent.set(row.eventId, [...(byEvent.get(row.eventId) ?? []), row]);
  }
  return [...byEvent.entries()]
    .map(([eventId, groupRows]) => {
      const sorted = [...groupRows].sort((a, b) => a.equipmentType.localeCompare(b.equipmentType));
      const [first] = groupRows;
      return {
        eventId,
        eventName: first.eventName,
        date: first.date,
        startTime: first.startTime,
        endTime: first.endTime,
        venue: first.venue,
        rows: sorted,
        total: groupTotal(sorted),
      };
    })
    .sort(compareRows);
});

const badgeLabel = computed(() => {
  if (activeTab.value === "Arranged") return "arranged";
  if (activeTab.value === "Partially Fulfilled") return "still needed";
  return "needed";
});

function quantityLabel(row: QueueRow): string {
  return row.status === "Partially Fulfilled" ? `${row.quantityFulfilled} of ${row.quantity}` : `${row.quantity}×`;
}

/** A red badge for an unarranged event that is close or already past. */
function urgencyLabel(row: QueueRow): string | null {
  if (row.status !== "Requested" || !row.date) return null;
  const days = daysUntil(row.date);
  if (days < 0) return "Overdue";
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return days <= URGENT_WITHIN_DAYS ? `In ${days} days` : null;
}

const emptyMessage = computed(() => {
  const what = activeTab.value === "Requested" ? "to arrange" : activeTab.value.toLowerCase();
  const suffix = RANGES.find((r) => r.key === range.value)?.empty ?? "";
  return `Nothing ${what}${suffix ? ` ${suffix}` : ""}.`;
});

onMounted(async () => {
  try {
    const [loadedRequests, loadedCatalog] = await Promise.all([
      fetchAllEquipmentRequests(),
      fetchEquipmentCatalog().catch(() => [] as EquipmentCatalogItem[]),
    ]);
    requests.value = loadedRequests;
    catalog.value = loadedCatalog;
    // Open on the first tab that has anything in it.
    const first = EQUIPMENT_REQUEST_STATUSES.find((status) => rowsByTab.value[status].length > 0);
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
          <button
            v-for="tabStatus in EQUIPMENT_REQUEST_STATUSES"
            :id="`tab-${tabStatus}`"
            :key="tabStatus"
            type="button"
            role="tab"
            :aria-selected="activeTab === tabStatus"
            aria-controls="requests-panel"
            class="tab"
            :class="{ 'tab--active': activeTab === tabStatus }"
            @click="activeTab = tabStatus"
          >
            {{ tabStatus }}
            <span class="tab-count">{{ rowsByTab[tabStatus].length }}</span>
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

        <section
          v-for="group in groups"
          :key="group.eventId"
          class="group"
          :aria-labelledby="`group-${group.eventId}`"
        >
          <div class="group-header">
            <div class="group-header__title">
              <RouterLink
                :to="{ name: 'equipment-request-detail', params: { eventId: group.eventId } }"
                class="group-title-link"
              >
                <h2 :id="`group-${group.eventId}`" class="h4">{{ group.eventName }}</h2>
                <svg class="group-title-link__chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m8.25 4.5 7.5 7.5-7.5 7.5" /></svg>
              </RouterLink>
              <span v-if="urgencyLabel(group.rows[0])" class="urgency">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>
                {{ urgencyLabel(group.rows[0]) }}
              </span>
            </div>
            <div class="group-header__meta">
              <span class="meta-item">
                <svg class="meta-item__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5" /></svg>
                {{ formatDate(group.date) }} · {{ formatTime(group.startTime, group.endTime) }}
              </span>
              <span class="meta-item">
                <svg class="meta-item__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" /><path d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z" /></svg>
                <span :class="{ 'cell-venue--empty': !group.venue }">{{ group.venue || "Venue not set" }}</span>
              </span>
            </div>
            <span class="count-badge">{{ group.total }} {{ badgeLabel }}</span>
          </div>

          <ul class="rows">
            <li class="row row--header" aria-hidden="true">
              <span class="cell-header">Equipment</span>
              <span class="cell-header">Qty needed</span>
              <span class="cell-header">In stock</span>
            </li>
            <li v-for="row in group.rows" :key="row.key" class="row">
              <span class="cell cell-equipment">{{ row.equipmentType }}</span>
              <span class="cell cell-qty">{{ quantityLabel(row) }}</span>
              <span class="cell cell-stock">{{ stockFor(row.equipmentType) ?? "—" }}</span>
            </li>
          </ul>
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
  flex: 0 1 66.6667%;
  flex-wrap: wrap;
  gap: var(--spacing-24);
  border-bottom: 1px solid var(--color-grey-100);
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
  color: var(--color-purple-600);
  border-bottom-color: var(--color-purple-600);
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
  background: var(--color-purple-100);
  color: var(--color-purple-800);
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
  gap: var(--spacing-32);
}

.group {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-12);
}

.group-header {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--spacing-12);
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
  gap: var(--spacing-4);
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
  color: var(--color-grey-400);
}

.count-badge {
  display: inline-flex;
  align-items: center;
  height: var(--spacing-24);
  padding: 0 var(--spacing-12);
  border-radius: var(--radius-full);
  background: var(--color-blue-200);
  color: var(--color-blue-800);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  margin-left: auto;
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

/* Rows: one bordered list per event, a 3-column table (equipment, qty, stock). */
.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-sm);
}

/* Fixed-width columns (not max-content) so Qty/Stock line up at the same
   x-position across every event's independent table, not just within one. */
.row {
  display: grid;
  grid-template-columns: 12rem 6rem 6rem;
  justify-content: start;
  column-gap: var(--spacing-32);
  align-items: center;
  padding: var(--spacing-16) var(--spacing-20);
  border-bottom: 1px solid var(--color-grey-100);
}

.row:last-child {
  border-bottom: none;
}

/* Column header row: same grid as the data rows, so labels line up. */
.row--header {
  background: var(--color-grey-50);
  padding-top: var(--spacing-12);
  padding-bottom: var(--spacing-12);
}

.cell-header {
  min-width: 0;
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  color: var(--color-grey-500);
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.cell {
  min-width: 0;
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-600);
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

.urgency {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-4);
  height: var(--spacing-24);
  padding: 0 var(--spacing-8);
  border-radius: var(--radius-full);
  background: var(--color-error-200);
  color: var(--color-error-600);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  white-space: nowrap;
}

@media (max-width: 640px) {
  .count-badge {
    margin-left: 0;
  }
}
</style>
