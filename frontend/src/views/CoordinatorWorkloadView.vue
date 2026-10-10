<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { fetchMyEvents, getCurrentUser, type EventSummary } from "../lib/eventsApi";
import { statusBadgeClass, statusLabel } from "../lib/eventStatus";

type ViewMode = "mine" | "all";

const events = ref<EventSummary[]>([]);
const loading = ref(true);
const errorMessage = ref<string | null>(null);
const userId = ref<string>("");
const viewMode = ref<ViewMode>("mine");

interface StatusGroup {
  key: string;
  label: string;
  statuses: string[];
}

const STATUS_GROUPS: StatusGroup[] = [
  { key: "needs-review",  label: "Needs Review",            statuses: ["Requested", "Unassigned"] },
  { key: "clarification", label: "Clarification Requested", statuses: ["Clarification Requested"] },
  { key: "planning",      label: "Planning",                statuses: ["Planning"] },
  { key: "confirmed",     label: "Confirmed",               statuses: ["Confirmed"] },
  { key: "completed",     label: "Completed",               statuses: ["Completed"] },
  { key: "rejected",      label: "Rejected",                statuses: ["Rejected"] },
];

// Statuses that wait on the coordinator (Requested, Unassigned): flagged with an accent bar.
const NEEDS_ACTION_STATUSES = ["Requested", "Unassigned"];

function needsAction(event: EventSummary): boolean {
  return NEEDS_ACTION_STATUSES.includes(event.status);
}

function eventProposedDate(event: EventSummary): string {
  return ((event.submitted_details as Record<string, unknown>)?.proposedDate as string) ?? event.created_at;
}

function eventName(event: EventSummary): string {
  const details = event.submitted_details as Record<string, unknown>;
  return (details?.name as string) || `Event #${event.id}`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  const day   = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${date.getFullYear()}`;
}

function coordinatorInitial(event: EventSummary): string {
  return event.coordinator?.name?.charAt(0).toUpperCase() ?? "";
}

const visibleEvents = computed(() => {
  if (viewMode.value === "mine") {
    return events.value.filter(
      (e) => e.coordinator_id === userId.value || e.status === "Unassigned",
    );
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

// Status tabs: "all" shows every event in one flat list (status-priority order, then date);
// a group key shows only that bucket.
// A tab whose bucket empties (e.g. after switching My/All) falls back to "all".
const activeTab = ref<string>("all");

const tabs = computed(() => [
  { key: "all", label: "All", count: visibleEvents.value.length },
  ...groupedEvents.value.map((g) => ({ key: g.key, label: g.label, count: g.events.length })),
]);

const currentTab = computed(() =>
  tabs.value.some((t) => t.key === activeTab.value) ? activeTab.value : "all",
);

const shownEvents = computed(() =>
  groupedEvents.value
    .filter((g) => currentTab.value === "all" || g.key === currentTab.value)
    .flatMap((g) => g.events),
);

onMounted(async () => {
  try {
    const [eventsData, user] = await Promise.all([fetchMyEvents(), getCurrentUser()]);
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
    Column mapping — Coordinator Workload View
    Desktop (12-col): outer container col 1-12, grid-desktop-margin 80px; content col 1-12, full width.
    Tablet (6-col):   content col 1-6, full width, grid-tablet-margin 32px.
    Mobile (4-col):   content col 1-4, full width, grid-mobile-margin 6px.
    Status tabs: tab row spans the full content width (12 / 6 / 4 cols) and wraps onto a second line on small screens.
    Nested grid: card list uses a local 8-col grid (desktop), 6-col (tablet), 4-col (mobile).
  -->
  <div class="page">
    <div class="content">

      <div class="page-header">
        <div>
          <h1 class="h2">{{ viewMode === "mine" ? "My workload" : "All events" }}</h1>
          <p class="subheading">
            {{ viewMode === "mine" ? "Your assigned events. Use the tabs to filter by status." : "Every event in the system." }}
          </p>
        </div>

        <div class="view-toggle" role="group" aria-label="Event view">
          <button
            type="button"
            class="toggle-btn"
            :class="{ 'toggle-btn--active': viewMode === 'mine' }"
            @click="viewMode = 'mine'"
          >
            My events
          </button>
          <button
            type="button"
            class="toggle-btn"
            :class="{ 'toggle-btn--active': viewMode === 'all' }"
            @click="viewMode = 'all'"
          >
            All events
          </button>
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
          <div class="card-grid">
            <RouterLink
              v-for="event in shownEvents"
              :key="event.id"
              :to="{ name: 'event-detail', params: { id: event.id } }"
              class="event-card"
              :class="{ 'event-card--needs-action': needsAction(event) }"
            >
              <div class="card-header">
                <span class="badge badge-dot" :class="statusBadgeClass(event.status)">
                  <span class="badge__dot" />
                  {{ statusLabel(event.status) }}
                </span>
              </div>

              <p class="card-title">{{ eventName(event) }}</p>
              <p class="body-small muted">Event date: {{ formatDate(eventProposedDate(event)) }}</p>

              <hr class="card-divider" />

              <div class="card-footer">
                <div class="card-footer__person">
                  <span v-if="viewMode === 'all' && event.coordinator?.name" class="person-avatar">
                    {{ coordinatorInitial(event) }}
                  </span>
                  <span class="body-small muted">
                    <template v-if="viewMode === 'all'">
                      Coordinator: {{ event.coordinator?.name ?? "Unassigned" }}
                    </template>
                    <template v-else>
                      Requested by: {{ event.organiser?.name ?? "Unknown" }}
                    </template>
                  </span>
                </div>
                <svg class="card-chevron" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path fill-rule="evenodd"
                    d="M7.21 14.77a.75.75 0 0 1 .02-1.06L11.168 10 7.23 6.29a.75.75 0 1 1 1.04-1.08l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 0 1-1.06-.02Z"
                    clip-rule="evenodd"
                  />
                </svg>
              </div>
            </RouterLink>
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

.view-toggle {
  display: flex;
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-xs);
  overflow: hidden;
  flex-shrink: 0;
}

.toggle-btn {
  appearance: none;
  background: var(--color-base-white);
  border: none;
  border-right: 1px solid var(--color-grey-200);
  cursor: pointer;
  padding: var(--spacing-8) var(--spacing-16);
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--color-grey-600);
  transition: background 0.1s, color 0.1s;
}

.toggle-btn:last-child {
  border-right: none;
}

.toggle-btn:hover:not(.toggle-btn--active) {
  background: var(--color-grey-50);
  color: var(--color-grey-900);
}

.toggle-btn--active {
  background: var(--color-purple-600);
  color: var(--color-base-white);
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
  grid-template-columns: repeat(8, 1fr);
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

.event-card {
  position: relative;
  grid-column: span 4;
  display: block;
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
  padding: var(--spacing-24);
  color: inherit;
  text-decoration: none;
}

.event-card:hover {
  background: var(--color-grey-75);
  border-color: var(--color-grey-200);
}

/* Needs the coordinator's action: same card, plus a flat warning strip along the left edge, clipped to the rounded corners. */
.event-card--needs-action {
  overflow: hidden; /* clips the strip to the card's rounded corners */
}

.event-card--needs-action::before {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: var(--spacing-4);
  background: var(--color-warning-300);
}

@media (max-width: 640px) {
  .event-card {
    grid-column: span 4;
  }
}

.card-header {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--spacing-8);
}

.card-title {
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
  margin: var(--spacing-12) 0 var(--spacing-4);
}

.badge {
  display: inline-block;
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  padding: var(--spacing-4) var(--spacing-8);
  border-radius: var(--radius-full);
}

.badge-dot {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-4);
}

.badge__dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  background: currentColor;
  flex-shrink: 0;
}

/* These status colours match EventsListView.vue */
.status-success {
  background: var(--color-success-200);
  color: var(--color-success-700);
}

.status-warning {
  background: var(--color-warning-200);
  border: 1px solid var(--color-warning-300);
  color: var(--color-warning-900);
}

.status-error {
  background: var(--color-error-200);
  color: var(--color-error-600);
}

.status-info {
  background: var(--color-blue-200);
  border: 1px solid var(--color-blue-300);
  color: var(--color-blue-800);
}

.card-divider {
  border: none;
  border-top: 1px solid var(--color-grey-100);
  margin: var(--spacing-40) 0 var(--spacing-16);
}

.card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-8);
}

.card-footer__person {
  display: flex;
  align-items: center;
  gap: var(--spacing-8);
  min-width: 0;
}

.person-avatar {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--color-purple-200);
  color: var(--color-purple-600);
  font-size: 0.75rem;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}

.card-chevron {
  width: 20px;
  height: 20px;
  color: var(--color-grey-400);
  flex-shrink: 0;
}
</style>
