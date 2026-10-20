<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import EventCard, { type CardFact } from "../components/ui/EventCard.vue";
import { fetchMyEvents, getCurrentUser, type EventSummary } from "../lib/eventsApi";
import { statusBadgeClass, statusLabel } from "../lib/eventStatus";
import { eventThumbnail, formatCardDate, formatCardTimeRange } from "../lib/attendeeEvents";

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
const role = ref<string>("");
const viewMode = computed(() => props.scope);

interface StatusGroup {
  key: string;
  label: string;
  statuses: string[];
}

// "Unassigned" isn't a coordinator's to act on — the Lead assigns it
// (E2-13) — so it's its own group, seen only under "All events".
const STATUS_GROUPS: StatusGroup[] = [
  { key: "needs-review",  label: "Needs Review",            statuses: ["Requested"] },
  { key: "unassigned",    label: "Unassigned",              statuses: ["Unassigned"] },
  { key: "clarification", label: "Clarification Requested", statuses: ["Clarification Requested"] },
  { key: "planning",      label: "Planning",                statuses: ["Planning"] },
  { key: "safety-review", label: "Safety Review",           statuses: ["Safety Review"] },
  { key: "confirmed",     label: "Confirmed",               statuses: ["Confirmed"] },
  { key: "completed",     label: "Completed",               statuses: ["Completed"] },
  { key: "rejected",      label: "Rejected",                statuses: ["Rejected"] },
  { key: "cancelled",     label: "Cancelled",               statuses: ["Cancelled"] },
];

/**
 * E3-5 AC1: end states (AGENTS.md §3) leave the coordinator's active list.
 * They stay under "All" and their own status tab, so the record isn't lost.
 */
const CLOSED_STATUSES = new Set(["Completed", "Rejected", "Cancelled"]);

// Statuses that wait on the coordinator: flagged with a yellow border. Unassigned is the Lead's to act on.
const NEEDS_ACTION_STATUSES = ["Requested"];

/** Only the assigned coordinator is waited on, so the Lead and other coordinators' events get no flag. */
function needsAction(event: EventSummary): boolean {
  return (
    role.value === "coordinator" && event.coordinator_id === userId.value && NEEDS_ACTION_STATUSES.includes(event.status)
  );
}

function eventProposedDate(event: EventSummary): string {
  return ((event.submitted_details as Record<string, unknown>)?.proposedDate as string) ?? event.created_at;
}

function eventName(event: EventSummary): string {
  const details = event.submitted_details as Record<string, unknown>;
  return (details?.name as string) || `Event #${event.id}`;
}

/** Date and time each get their own line on the card, as on the organiser's list. */
function cardFacts(event: EventSummary): CardFact[] {
  const details = event.submitted_details as Record<string, string | undefined>;
  return [
    { icon: "calendar", text: formatCardDate(details?.proposedDate) },
    { icon: "clock", text: formatCardTimeRange(details?.startTime, details?.endTime) },
  ];
}

/** E1-8 AC4: "My events" is only what's assigned to this coordinator. */
const visibleEvents = computed(() => {
  if (viewMode.value === "mine") {
    return events.value.filter((e) => e.coordinator_id === userId.value);
  }
  return events.value;
});

const groupedEvents = computed(() =>
  STATUS_GROUPS.map((group) => ({
    ...group,
    events: visibleEvents.value
      .filter((e) => group.statuses.includes(e.status))
      .sort((a, b) => {
        const da = eventProposedDate(a);
        const db = eventProposedDate(b);
        return da < db ? -1 : da > db ? 1 : 0;
      }),
  })).filter((g) => g.events.length > 0),
);

// Status tabs: "active" (the default) shows every event that isn't closed, "all" shows
// every event, both in one flat list (status-priority order, then date); a group key
// shows only that bucket. A tab whose bucket empties (e.g. after switching My/All)
// falls back to "active".
const activeTab = ref<string>("active");

function isClosedGroup(group: StatusGroup): boolean {
  return group.statuses.every((status) => CLOSED_STATUSES.has(status));
}

const activeEventCount = computed(
  () => visibleEvents.value.filter((e) => !CLOSED_STATUSES.has(e.status)).length,
);

const tabs = computed(() => [
  { key: "active", label: "Active", count: activeEventCount.value },
  { key: "all", label: "All", count: visibleEvents.value.length },
  ...groupedEvents.value.map((g) => ({ key: g.key, label: g.label, count: g.events.length })),
]);

const currentTab = computed(() =>
  tabs.value.some((t) => t.key === activeTab.value) ? activeTab.value : "active",
);

const shownEvents = computed(() =>
  groupedEvents.value
    .filter((g) => {
      if (currentTab.value === "all") return true;
      if (currentTab.value === "active") return !isClosedGroup(g);
      return g.key === currentTab.value;
    })
    .flatMap((g) => g.events),
);

onMounted(async () => {
  try {
    const [eventsData, user] = await Promise.all([fetchMyEvents(), getCurrentUser()]);
    events.value = eventsData;
    userId.value = user.id;
    role.value = user.role;
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
    Status tabs: tab row spans the full content width (12 / 6 / 4 cols) and wraps onto a second line on small screens.
    Nested grid: card list uses a local 12-col grid (desktop, 3 cards per row), 6-col (tablet), 4-col (mobile).
  -->
  <div class="page">
    <div class="content">

      <div class="page-header">
        <div>
          <h1 class="h2">{{ viewMode === "mine" ? "My events" : "All events" }}</h1>
          <p class="subheading">
            {{ viewMode === "mine" ? "Your assigned events. Use the tabs to filter by status." : "Every event in the system." }}
          </p>
        </div>
      </div>

      <p v-if="loading" class="body-default muted">Loading events…</p>
      <p v-else-if="errorMessage" class="body-default error-text">{{ errorMessage }}</p>
      <p v-else-if="visibleEvents.length === 0" class="body-default muted">
        {{ viewMode === "mine" ? "No events are assigned to you yet." : "No events in the system yet." }}
      </p>

      <template v-else>
        <div class="tabs" role="tablist" aria-label="Filter events by status">
          <button
            v-for="tab in tabs"
            :id="`coordinator-tab-${tab.key}`"
            :key="tab.key"
            type="button"
            role="tab"
            class="tab"
            :class="{ 'tab--active': currentTab === tab.key }"
            :aria-selected="currentTab === tab.key"
            aria-controls="coordinator-panel"
            @click="activeTab = tab.key"
          >
            {{ tab.label }}
            <span class="tab__count">{{ tab.count }}</span>
          </button>
        </div>

        <div id="coordinator-panel" role="tabpanel" :aria-labelledby="`coordinator-tab-${currentTab}`">
          <p v-if="shownEvents.length === 0" class="body-default muted">
            No active events. Completed, rejected and cancelled events are under All.
          </p>
          <div v-else class="card-grid">
            <div v-for="event in shownEvents" :key="event.id" class="card-cell">
              <EventCard
                :to="{ name: 'event-detail', params: { id: event.id } }"
                :thumbnail="eventThumbnail(event.id)"
                :title="eventName(event)"
                :status-label="statusLabel(event.status)"
                :status-class="statusBadgeClass(event.status)"
                :facts="cardFacts(event)"
                :person-label="viewMode === 'all' ? 'Coordinator' : 'Requested by'"
                :person-name="viewMode === 'all' ? event.coordinator?.name : event.organiser?.name"
                :person-empty="viewMode === 'all' ? 'Unassigned' : 'Unknown'"
                :class="{ 'event-card--needs-action': needsAction(event) }"
              />
            </div>
          </div>
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
  font-size: 2.25rem;
  font-weight: 700;
  line-height: 2.625rem;
  color: var(--color-grey-900);
  margin: 0;
}

.subheading {
  font-size: 1.125rem;
  font-weight: 400;
  line-height: 1.375rem;
  color: var(--color-grey-500);
  margin: var(--spacing-8) 0 0;
}

.body-default {
  font-size: 1rem;
  line-height: 1.25rem;
  margin-top: var(--spacing-32);
}

.body-small {
  font-size: 0.875rem;
  line-height: 1.125rem;
}

.muted {
  color: var(--color-grey-500);
}

.error-text {
  color: var(--color-error-600);
}

/* Status tabs (same pattern as AttendeeEventsView) */

.tabs {
  display: flex;
  gap: var(--spacing-32);
  margin-top: var(--spacing-32);
  border-bottom: 1px solid var(--color-grey-100);
  flex-wrap: wrap;
}

.tab {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-8);
  flex-shrink: 0;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  padding: var(--spacing-12) var(--spacing-4);
  font-family: var(--font-family-lato);
  font-size: 1rem;
  font-weight: 700;
  color: var(--color-grey-600);
  cursor: pointer;
}

.tab:hover {
  color: var(--color-grey-900);
}

.tab:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

.tab--active {
  color: var(--color-purple-600);
  border-bottom-color: var(--color-purple-600);
}

.tab__count {
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  background: var(--color-grey-100);
  color: var(--color-grey-600);
  padding: 2px var(--spacing-6);
  border-radius: var(--radius-full);
  min-width: 20px;
  text-align: center;
}

/* Card grid */

.card-grid {
  margin-top: var(--spacing-32);
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: var(--grid-desktop-gutter);
  align-content: start;
}

@media (max-width: 1024px) {
  .card-grid {
    grid-template-columns: repeat(6, 1fr);
  }
}

@media (max-width: 640px) {
  .card-grid {
    grid-template-columns: repeat(4, 1fr);
  }
}

/* Each card sits in a cell that carries the 12/6/4-column spans: 3 per row on desktop, 2 on tablet, 1 on mobile. */
.card-cell {
  grid-column: span 4;
}

@media (max-width: 1024px) {
  .card-cell {
    grid-column: span 3;
  }
}

@media (max-width: 640px) {
  .card-cell {
    grid-column: span 4;
  }
}

/* Needs the coordinator's action: the shared card with a thick warning-coloured border (kept on hover too). */
.event-card.event-card--needs-action,
.event-card.event-card--needs-action:hover {
  border-width: var(--spacing-4);
  border-color: var(--color-warning-300);
}
</style>
