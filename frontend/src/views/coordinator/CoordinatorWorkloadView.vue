<script setup lang="ts">
import UnderlineTabs from "../../components/ui/UnderlineTabs.vue";
import StatusBadge from "../../components/ui/StatusBadge.vue";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  CheckCircleIcon,
  CheckIcon,
  ChevronDownIcon,
  ClockIcon,
  ExclamationTriangleIcon,
  InformationCircleIcon,
} from "@heroicons/vue/16/solid";
import DataTable from "../../components/ui/DataTable.vue";
import PaginationBar from "../../components/ui/PaginationBar.vue";
import { fetchMyEvents, getCurrentUser, type EventSummary } from "../../lib/eventsApi";
import { statusBadgeClass } from "../../lib/eventStatus";
import { formatCardDate, formatCardTimeRange } from "../../lib/attendeeEvents";
import { hasEventEnded } from "../../lib/eventTiming";
import { GROUP_DEFS } from "../../lib/eventGroups";

/**
 * One list for two pages: "mine" is a coordinator's own workload (/coordinator),
 * "all" is every event in the system (/all-events, for coordinators and the
 * Event Coordinator Lead). The route picks which.
 */
const props = withDefaults(defineProps<{ scope?: "mine" | "all" }>(), { scope: "mine" });

const events = ref<EventSummary[]>([]);
const loading = ref(true);
const errorMessage = ref<string | null>(null);
const userId = ref<string>("");
const viewMode = computed(() => props.scope);

const TABLE_COLUMN_WIDTHS = "minmax(0, 3fr) minmax(0, 2fr) minmax(0, 1.5fr) minmax(0, 1.5fr) minmax(0, 1.5fr) 24px";

/** Completed only happens after the event ends (AGENTS.md), but a Rejected/Cancelled
 * request is dead on arrival — it belongs in Past even with a future event date. */
function isClosedStatus(status: string): boolean {
  return status === "Completed" || status === "Rejected" || status === "Cancelled";
}

// GROUP_DEFS (lib/eventGroups.ts) is the who-acts-next grouping used on the Upcoming tab, on both pages.

interface StatusOption {
  key: string;
  label: string;
  statuses: string[];
}

// "Unassigned" isn't a coordinator's to act on — the Lead assigns it (E2-13).
const STATUS_OPTIONS: StatusOption[] = [
  { key: "awaiting-review", label: "Awaiting Review", statuses: ["Requested"] },
  { key: "unassigned", label: "Unassigned", statuses: ["Unassigned"] },
  { key: "clarification", label: "Clarification Requested", statuses: ["Clarification Requested"] },
  { key: "planning", label: "Planning", statuses: ["Planning"] },
  { key: "safety-review", label: "Safety Review", statuses: ["Safety Review"] },
  { key: "confirmed", label: "Confirmed", statuses: ["Confirmed"] },
  { key: "needs-review", label: "Needs Review", statuses: ["Needs Review"] },
  { key: "completed", label: "Completed", statuses: ["Completed"] },
  { key: "rejected", label: "Rejected", statuses: ["Rejected"] },
  { key: "cancelled", label: "Cancelled", statuses: ["Cancelled"] },
];

function eventDetails(event: EventSummary): Record<string, unknown> {
  return event.submitted_details as Record<string, unknown>;
}

function eventProposedDate(event: EventSummary): string {
  return (eventDetails(event)?.proposedDate as string) ?? event.created_at;
}

function eventName(event: EventSummary): string {
  const details = eventDetails(event);
  return (details?.name as string) || `Event #${event.id}`;
}

function eventDateLabel(event: EventSummary): string {
  return formatCardDate(eventDetails(event)?.proposedDate as string | undefined);
}

function eventTimeLabel(event: EventSummary): string {
  const details = eventDetails(event);
  return formatCardTimeRange(details?.startTime as string | undefined, details?.endTime as string | undefined);
}

function personName(event: EventSummary): string {
  if (viewMode.value === "all") return event.coordinator?.name ?? "Unassigned";
  return event.organiser?.name ?? "Unknown";
}

// Date and time, and the organiser/coordinator, are their own columns — the person
// column's header follows which name it holds (organiser for "mine", coordinator for "all").
const TABLE_COLUMNS = computed(() => [
  { key: "event", label: "Event" },
  { key: "person", label: viewMode.value === "all" ? "Coordinator" : "Requested by" },
  { key: "date", label: "Date" },
  { key: "time", label: "Time" },
  { key: "status", label: "Status" },
  { key: "chevron", label: "" },
]);

/** E1-8 AC4: "My events" is only what's assigned to this coordinator. */
const visibleEvents = computed(() => {
  if (viewMode.value === "mine") {
    return events.value.filter((e) => e.coordinator_id === userId.value);
  }
  return events.value;
});

// Upcoming / To Complete / Past tabs, mainly by the event's own date. For "mine" only, a dead
// request (Rejected/Cancelled) also counts as Past even before its event date.
const timingTab = ref<"upcoming" | "complete" | "past">("upcoming");

/** A Confirmed event that has already run: the assigned coordinator still has to mark it Completed
 * (AGENTS.md §3), so it is work to do, not history. */
function isToComplete(event: EventSummary): boolean {
  return event.status === "Confirmed" && hasEventEnded(eventDetails(event));
}

function isPast(event: EventSummary): boolean {
  if (isToComplete(event)) return false;
  if (hasEventEnded(eventDetails(event))) return true;
  return viewMode.value === "mine" && isClosedStatus(event.status);
}

const upcomingEvents = computed(() => visibleEvents.value.filter((e) => !isPast(e) && !isToComplete(e)));
const completeEvents = computed(() => visibleEvents.value.filter(isToComplete));
const pastEvents = computed(() => visibleEvents.value.filter((e) => isPast(e)));

const timingTabs = computed(() => [
  { key: "upcoming" as const, label: "Upcoming", count: upcomingEvents.value.length },
  { key: "complete" as const, label: "To Complete", count: completeEvents.value.length },
  { key: "past" as const, label: "Past", count: pastEvents.value.length },
]);

const COMPLETE_HINT: Record<"mine" | "all", string> = {
  mine: "Confirmed events whose date has passed. Open one to mark it completed.",
  all: "Confirmed events whose date has passed, waiting for their coordinator to mark them completed.",
};

// Status dropdown: narrows whichever timing tab is active. "All statuses" (empty key) clears it.
const ALL_STATUSES_KEY = "";
const statusFilter = ref<string>(ALL_STATUSES_KEY);

// Quick-filter chips: narrows by who-acts-next group instead of one status. "" = the "All" chip.
// Only one of chip/dropdown narrows at a time — picking one resets the other, so they never contradict.
const ALL_GROUPS_KEY = "";
const groupFilter = ref<string>(ALL_GROUPS_KEY);

function selectStatusFilter(key: string): void {
  statusFilter.value = key;
  groupFilter.value = ALL_GROUPS_KEY;
}

function selectGroupFilter(key: string): void {
  groupFilter.value = key;
  statusFilter.value = ALL_STATUSES_KEY;
}

// Status popover: counts always reflect the whole active tab (like the chips), and an
// option with no events in it is left out, same as "All statuses" never changes.
const statusOptionCounts = computed(() =>
  STATUS_OPTIONS.map((option) => ({
    ...option,
    count: timingFilteredEvents.value.filter((e) => option.statuses.includes(e.status)).length,
  })).filter((option) => option.count > 0),
);

const STATUS_GROUP_ICONS: Record<string, typeof ExclamationTriangleIcon> = {
  action: ExclamationTriangleIcon,
  wait: ClockIcon,
  ontrack: CheckCircleIcon,
  other: InformationCircleIcon,
};

/** Grouped sections (with icons) only where the chips/inline headers already group by
 * who-acts-next; otherwise one flat list, same options just without section labels. */
const groupedStatusSections = computed(() => {
  if (timingTab.value !== "upcoming") return null;
  return GROUP_DEFS.map((group) => ({
    key: group.key,
    label: group.label,
    icon: STATUS_GROUP_ICONS[group.key],
    options: statusOptionCounts.value.filter((o) => group.statuses.includes(o.statuses[0])),
  })).filter((section) => section.options.length > 0);
});

const statusDropdownOpen = ref(false);
const statusFilterRoot = ref<HTMLElement | null>(null);

const statusFilterTriggerLabel = computed(() => {
  if (statusFilter.value === ALL_STATUSES_KEY) return "All statuses";
  const option = statusOptionCounts.value.find((o) => o.key === statusFilter.value);
  return option ? option.label : "All statuses";
});

function chooseStatus(key: string): void {
  selectStatusFilter(key);
  statusDropdownOpen.value = false;
}

function closeStatusDropdown(returnFocus = false): void {
  statusDropdownOpen.value = false;
  if (returnFocus) (statusFilterRoot.value?.querySelector(".status-filter__trigger") as HTMLElement | null)?.focus();
}

function onStatusFilterPointerDown(e: PointerEvent): void {
  if (statusFilterRoot.value && !statusFilterRoot.value.contains(e.target as Node)) closeStatusDropdown();
}

function onStatusFilterKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.stopPropagation();
    closeStatusDropdown(true);
  }
}

watch(statusDropdownOpen, (isOpen) => {
  if (isOpen) {
    document.addEventListener("pointerdown", onStatusFilterPointerDown);
  } else {
    document.removeEventListener("pointerdown", onStatusFilterPointerDown);
  }
});

onBeforeUnmount(() => document.removeEventListener("pointerdown", onStatusFilterPointerDown));

// Chip counts always reflect the whole Upcoming tab, so they don't shift as a chip/status is picked.
const chipOptions = computed(() => [
  { key: ALL_GROUPS_KEY, label: "All", count: upcomingEvents.value.length },
  ...GROUP_DEFS.map((group) => ({
    key: group.key,
    label: group.label,
    count: upcomingEvents.value.filter((e) => group.statuses.includes(e.status)).length,
  })).filter((chip) => chip.key !== "other" || chip.count > 0),
]);

const showChips = computed(() => timingTab.value === "upcoming");

const timingFilteredEvents = computed(() => {
  if (timingTab.value === "upcoming") return upcomingEvents.value;
  if (timingTab.value === "complete") return completeEvents.value;
  return pastEvents.value;
});

const shownEvents = computed(() => {
  // Upcoming and To Complete read oldest first (the most overdue to complete on top); Past, newest first.
  const sorted = [...timingFilteredEvents.value].sort((a, b) => {
    const da = eventProposedDate(a);
    const db = eventProposedDate(b);
    return timingTab.value !== "past" ? (da < db ? -1 : da > db ? 1 : 0) : (da > db ? -1 : da < db ? 1 : 0);
  });

  const group = GROUP_DEFS.find((g) => g.key === groupFilter.value);
  if (group) return sorted.filter((e) => group.statuses.includes(e.status));

  const option = STATUS_OPTIONS.find((o) => o.key === statusFilter.value);
  if (option) return sorted.filter((e) => option.statuses.includes(e.status));

  return sorted;
});

/** Grouped by who-acts-next only for the Upcoming list (on both pages) with
 * neither narrowing applied — any narrower view already shares one status/meaning. */
const showGroups = computed(
  () =>
    timingTab.value === "upcoming" &&
    statusFilter.value === ALL_STATUSES_KEY &&
    groupFilter.value === ALL_GROUPS_KEY,
);

const groupedShownEvents = computed(() =>
  GROUP_DEFS.map((group) => ({
    ...group,
    events: shownEvents.value.filter((e) => group.statuses.includes(e.status)),
  })).filter((g) => g.events.length > 0),
);

// Grouped: events reordered group-by-group (each already date-sorted) so DataTable's
// rowGroup can tell where one group ends and the next begins. Ungrouped: unchanged order.
const tableRows = computed(() => (showGroups.value ? groupedShownEvents.value.flatMap((g) => g.events) : shownEvents.value));

// Client-side paging: counts, chips and groups above use the full list; only the rows drawn are sliced.
const PAGE_SIZE = 20;
const page = ref(1);
const totalPages = computed(() => Math.max(1, Math.ceil(tableRows.value.length / PAGE_SIZE)));
const currentPage = computed(() => Math.min(page.value, totalPages.value));
const pagedRows = computed(() =>
  tableRows.value.slice((currentPage.value - 1) * PAGE_SIZE, currentPage.value * PAGE_SIZE),
);
watch([timingTab, statusFilter, groupFilter], () => {
  page.value = 1;
});

const panelRoot = ref<HTMLElement | null>(null);
function changePage(next: number) {
  page.value = next;
  panelRoot.value?.scrollIntoView?.({ block: "start" });
}

function groupInfoFor(event: EventSummary) {
  if (!showGroups.value) return null;
  const group = groupedShownEvents.value.find((g) => g.statuses.includes(event.status));
  return group ? { key: group.key, label: group.label, count: group.events.length } : null;
}

function rowClass(event: EventSummary) {
  return { "row--needs-review": event.status === "Needs Review" };
}

onMounted(async () => {
  try {
    const [eventsData, user] = await Promise.all([
      fetchMyEvents({ assignedToMe: props.scope === "mine" }),
      getCurrentUser(),
    ]);
    events.value = eventsData;
    userId.value = user.id;
  } catch {
    errorMessage.value = "We couldn't load your events. Please try again.";
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <!--
    Column mapping — Coordinator Workload / All Events View
    Desktop (12-col): outer container col 1-12, grid-desktop-margin 80px; content col 1-12, full width.
    Tablet (6-col):   content col 1-6, full width, grid-tablet-margin 32px.
    Mobile (4-col):   content col 1-4, full width, grid-mobile-margin 6px.
    Timing tabs span the full content width; the status dropdown sits beside them.
  -->
  <div class="page">
    <div class="content">

      <div class="page-header">
        <div>
          <h1 class="h2">{{ viewMode === "mine" ? "My events" : "All events" }}</h1>
          <p class="subheading">
            {{ viewMode === "mine" ? "Your assigned events. Use the tabs and filter to narrow the list." : "Every event in the system." }}
          </p>
        </div>
      </div>

      <p v-if="loading" class="body-default muted">Loading events…</p>
      <p v-else-if="errorMessage" class="body-default error-text">{{ errorMessage }}</p>
      <p v-else-if="visibleEvents.length === 0" class="body-default muted">
        {{ viewMode === "mine" ? "No events are assigned to you yet." : "No events in the system yet." }}
      </p>

      <template v-else>
        <div class="toolbar">
          <UnderlineTabs v-model="timingTab" class="tabs" :tabs="timingTabs" aria-label="Filter events by timing"
            id-prefix="coordinator-tab" panel-id="coordinator-panel" />

          <div ref="statusFilterRoot" class="status-filter" @keydown="onStatusFilterKeydown">
            <span id="status-filter-label" class="status-filter__label">Status</span>
            <button
              id="status-filter"
              type="button"
              class="status-filter__trigger"
              :class="{ 'status-filter__trigger--open': statusDropdownOpen }"
              aria-haspopup="listbox"
              :aria-expanded="statusDropdownOpen"
              aria-labelledby="status-filter-label"
              @click="statusDropdownOpen = !statusDropdownOpen"
            >
              <span>{{ statusFilterTriggerLabel }}</span>
              <ChevronDownIcon class="status-filter__chevron" aria-hidden="true" />
            </button>

            <div v-if="statusDropdownOpen" class="status-filter__popover" role="listbox" aria-label="Status">
              <button
                type="button"
                role="option"
                class="status-filter__option"
                :class="{ 'status-filter__option--selected': statusFilter === ALL_STATUSES_KEY }"
                :aria-selected="statusFilter === ALL_STATUSES_KEY"
                @click="chooseStatus(ALL_STATUSES_KEY)"
              >
                <span class="status-filter__option-label">
                  <CheckIcon v-if="statusFilter === ALL_STATUSES_KEY" class="status-filter__check" aria-hidden="true" />
                  All statuses
                </span>
              </button>

              <template v-if="groupedStatusSections">
                <template v-for="section in groupedStatusSections" :key="section.key">
                  <div class="status-filter__section-label" :class="`status-filter__section-label--${section.key}`">
                    <component :is="section.icon" class="status-filter__section-icon" aria-hidden="true" />
                    {{ section.label.toUpperCase() }}
                  </div>
                  <button
                    v-for="option in section.options"
                    :key="option.key"
                    type="button"
                    role="option"
                    class="status-filter__option status-filter__option--indented"
                    :class="{ 'status-filter__option--selected': statusFilter === option.key }"
                    :aria-selected="statusFilter === option.key"
                    @click="chooseStatus(option.key)"
                  >
                    <span>{{ option.label }}</span>
                  </button>
                </template>
              </template>
              <template v-else>
                <button
                  v-for="option in statusOptionCounts"
                  :key="option.key"
                  type="button"
                  role="option"
                  class="status-filter__option"
                  :class="{ 'status-filter__option--selected': statusFilter === option.key }"
                  :aria-selected="statusFilter === option.key"
                  @click="chooseStatus(option.key)"
                >
                  <span>{{ option.label }}</span>
                </button>
              </template>
            </div>
          </div>
        </div>

        <p v-if="timingTab === 'complete'" class="body-default muted complete-hint" data-testid="complete-hint">
          {{ COMPLETE_HINT[viewMode] }}
        </p>

        <div v-if="showChips" role="group" aria-label="Quick filter" class="chips">
          <button
            v-for="chip in chipOptions"
            :key="chip.key"
            type="button"
            class="chip"
            :class="{ 'chip--active': groupFilter === chip.key }"
            :aria-pressed="groupFilter === chip.key"
            @click="selectGroupFilter(chip.key)"
          >
            {{ chip.label }}
            <span class="chip__count">{{ chip.count }}</span>
          </button>
        </div>

        <div id="coordinator-panel" ref="panelRoot" role="tabpanel" :aria-labelledby="`coordinator-tab-${timingTab}`">
          <p v-if="shownEvents.length === 0" class="body-default muted">
            {{
              timingTab === "complete" && statusFilter === ALL_STATUSES_KEY && groupFilter === ALL_GROUPS_KEY
                ? "Nothing is waiting to be completed."
                : "No events match this tab and filter."
            }}
          </p>

          <DataTable
            v-else
            class="events-table"
            :columns="TABLE_COLUMNS"
            :column-widths="TABLE_COLUMN_WIDTHS"
            :rows="pagedRows"
            :row-key="(event: EventSummary) => event.id"
            :row-to="(event: EventSummary) => ({ name: 'event-detail', params: { id: event.id } })"
            :row-class="rowClass"
            :row-group="groupInfoFor"
          >
            <template #cell-event="{ row: event }">
              <div class="cell-event__title">{{ eventName(event) }}</div>
            </template>
            <template #cell-person="{ row: event }">
              <span class="cell-person">{{ personName(event) }}</span>
            </template>
            <template #cell-date="{ row: event }">
              <span class="cell-date">{{ eventDateLabel(event) }}</span>
            </template>
            <template #cell-time="{ row: event }">
              <span class="cell-time">{{ eventTimeLabel(event) }}</span>
            </template>
            <template #cell-status="{ row: event }">
              <StatusBadge :status-class="statusBadgeClass(event.status)">{{ event.status }}</StatusBadge>
            </template>
            <template #cell-chevron>
              <svg class="row-chevron" aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none"
                stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M6 3.5L10.5 8 6 12.5" />
              </svg>
            </template>
            <template #group-header="{ group }">
              <div class="group-header" :class="`group-header--${group.key}`">
                <span class="group-header__title">{{ group.label }}</span>
                <span class="group-header__badge">{{ group.count }}</span>
              </div>
            </template>
          </DataTable>

          <PaginationBar :page="currentPage" :page-size="PAGE_SIZE" :total="tableRows.length"
            @update:page="changePage" />
        </div>
      </template>

    </div>
  </div>
</template>

<style scoped>
.page {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: var(--grid-desktop-gutter);
  padding: var(--spacing-40) var(--grid-desktop-margin);
  align-content: start;
}

.content {
  grid-column: 1 / 13;
}

@media (max-width: 1024px) {
  .page {
    grid-template-columns: repeat(6, 1fr);
    padding: var(--spacing-32) var(--grid-tablet-margin);
  }

  .content {
    grid-column: 1 / 7;
  }
}

@media (max-width: 640px) {
  .page {
    grid-template-columns: repeat(4, 1fr);
    padding: var(--spacing-24) var(--grid-mobile-margin);
  }

  .content {
    grid-column: 1 / 5;
  }
}

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--spacing-16);
  flex-wrap: wrap;
}

.h2 {
  margin: 0;
}

.subheading {
  color: var(--color-grey-600);
  margin: var(--spacing-8) 0 0;
}

.body-default {
  margin-top: var(--spacing-32);
}

.muted {
  color: var(--color-grey-600);
}

.error-text {
  color: var(--color-error-600);
}

/* Toolbar: timing tabs on the left, status dropdown on the right */

.toolbar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--spacing-16);
  margin-top: var(--spacing-32);
  flex-wrap: wrap;
}

.tabs {
  flex: 1 1 auto;
  flex-wrap: wrap;
}

.status-filter {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-4);
}

.status-filter__label {
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  color: var(--color-grey-600);
}

.status-filter__trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-8);
  min-width: 220px;
  min-height: 44px;
  padding: 0 var(--spacing-12);
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-xs);
  background: var(--color-base-white);
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-700);
  cursor: pointer;
}

.status-filter__trigger--open {
  border-color: var(--ring-brand);
  box-shadow: 0 0 0 4px var(--ring-light);
}

.status-filter__trigger:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

.status-filter__chevron {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  color: var(--color-grey-700);
}

.status-filter__popover {
  position: absolute;
  top: calc(100% + var(--spacing-8));
  right: 0;
  z-index: 20;
  width: 340px;
  box-sizing: border-box;
  padding: var(--spacing-8);
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-popover);
}

.status-filter__option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  box-sizing: border-box;
  min-height: 44px;
  padding: 0 var(--spacing-12);
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-900);
  cursor: pointer;
  text-align: left;
}

.status-filter__option:hover {
  background: var(--color-grey-50);
}

.status-filter__option--indented {
  padding-left: var(--spacing-32);
  color: var(--color-grey-900);
}

.status-filter__option--selected {
  background: var(--color-purple-100);
  color: var(--color-purple-800);
  font-weight: 700;
}

.status-filter__option-label {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-8);
}

.status-filter__check {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  color: var(--color-purple-800);
}

.status-filter__section-label {
  display: flex;
  align-items: center;
  gap: var(--spacing-8);
  padding: var(--spacing-12) var(--spacing-12) var(--spacing-4);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
}

.status-filter__section-icon {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
}

.status-filter__section-label--action {
  color: var(--color-warning-900);
}

.status-filter__section-label--wait {
  color: var(--color-grey-700);
}

.status-filter__section-label--ontrack {
  color: var(--color-success-700);
}

.status-filter__section-label--other {
  color: var(--color-grey-600);
}

/* Quick-filter chips: Upcoming tab only, both pages. Same "Selected" treatment as
   components/venues/FilterChip.vue's active state. */

.complete-hint {
  margin: var(--spacing-16) 0 0;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--spacing-8);
  margin-top: var(--spacing-16);
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-8);
  min-height: 40px;
  padding: 0 var(--spacing-16);
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-full);
  background: var(--color-base-white);
  color: var(--color-grey-700);
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  line-height: 1.125rem;
  font-weight: 700;
  cursor: pointer;
}

.chip:hover {
  background: var(--color-grey-75);
  color: var(--color-grey-800);
}

.chip:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

.chip--active,
.chip--active:hover {
  background: var(--color-purple-100);
  border-color: var(--color-purple-300);
  color: var(--color-purple-800);
}

.chip__count {
  padding: 2px var(--spacing-6);
  border-radius: var(--radius-full);
  background: var(--color-grey-100);
  color: var(--color-grey-600);
  font-size: 0.75rem;
  line-height: 1rem;
  min-width: 20px;
  text-align: center;
}

.chip--active .chip__count {
  background: var(--color-base-white);
  color: var(--color-purple-800);
}

/* Group dividers: "who acts next", Upcoming tab only, both pages, no status
   narrowed — rendered inline inside the table (DataTable's group-header slot),
   below the shared Event/Date/Status column header, not a box of their own. */

.group-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-12);
  padding: var(--spacing-12) var(--spacing-20);
}

.group-header__title {
  margin: 0;
  font-size: 1rem;
  line-height: 1.25rem;
  font-weight: 700;
  color: var(--color-grey-900);
}

.group-header__badge {
  padding: 2px var(--spacing-8);
  border-radius: var(--radius-full);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
}

.group-header--action {
  background: var(--color-warning-100);
}
.group-header--action .group-header__badge {
  background: var(--color-warning-900);
  color: var(--color-base-white);
}

.group-header--wait {
  background: var(--color-grey-50);
}
.group-header--wait .group-header__badge {
  background: var(--color-grey-700);
  color: var(--color-base-white);
}

.group-header--ontrack {
  background: var(--color-success-100);
}
.group-header--ontrack .group-header__badge {
  background: var(--color-success-700);
  color: var(--color-base-white);
}

.group-header--other {
  background: var(--color-grey-50);
}
.group-header--other .group-header__badge {
  background: var(--color-grey-500);
  color: var(--color-base-white);
}

/* Table */

.events-table {
  margin-top: var(--spacing-32);
  width: 100%;
}

.row-chevron {
  color: var(--color-grey-600);
}

.cell-event__title {
  font-size: 18px;
  line-height: 1.375rem;
  font-weight: 700;
  color: var(--color-grey-900);
}

/* Needs Review: yellow highlight, so the row stands out at a glance */
:deep(.row--needs-review) {
  background: var(--color-warning-100);
  border-left: 3px solid var(--color-warning-300);
}

:deep(.row--needs-review:hover) {
  background: var(--color-warning-100);
}
</style>
