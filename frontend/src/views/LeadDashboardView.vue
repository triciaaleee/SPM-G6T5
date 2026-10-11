<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { fetchMyEvents, fetchUnassignedQueue, type EventSummary } from "../lib/eventsApi";
import { formatEventDate, statusBadgeClass, statusLabel } from "../lib/eventStatus";

type ViewMode = "queue" | "assignments";

/** Closed events (§3) are no longer under the Lead's supervision. */
const CLOSED_STATUSES = new Set(["Rejected", "Cancelled", "Completed"]);

const viewMode = ref<ViewMode>("queue");
const queue = ref<EventSummary[]>([]);
const allEvents = ref<EventSummary[]>([]);
const loading = ref(true);
const errorMessage = ref<string | null>(null);

function eventName(event: EventSummary): string {
  const name = (event.submitted_details as Record<string, unknown>)?.name;
  return typeof name === "string" && name ? name : `Event #${event.id}`;
}

function eventDate(event: EventSummary): string | null {
  const date = (event.submitted_details as Record<string, unknown>)?.proposedDate;
  return typeof date === "string" && date ? date : null;
}

interface CoordinatorGroup {
  key: string;
  label: string;
  events: EventSummary[];
}

/**
 * Week 7 change 5: every coordinator assignment and active event, grouped
 * by coordinator (alphabetical) and ordered by event date within a group.
 * Opening an event is how the Lead reassigns it (E2-12).
 */
const coordinatorGroups = computed<CoordinatorGroup[]>(() => {
  const groups = new Map<string, CoordinatorGroup>();
  for (const event of allEvents.value) {
    if (CLOSED_STATUSES.has(event.status) || !event.coordinator_id) continue;
    const key = event.coordinator_id;
    if (!groups.has(key)) groups.set(key, { key, label: event.coordinator?.name ?? key, events: [] });
    groups.get(key)!.events.push(event);
  }
  for (const group of groups.values()) {
    group.events.sort((a, b) => (eventDate(a) ?? "").localeCompare(eventDate(b) ?? ""));
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label));
});

const activeAssignmentCount = computed(() =>
  coordinatorGroups.value.reduce((total, group) => total + group.events.length, 0),
);

onMounted(async () => {
  try {
    const [queueData, eventsData] = await Promise.all([fetchUnassignedQueue(), fetchMyEvents()]);
    queue.value = queueData;
    allEvents.value = eventsData;
  } catch {
    errorMessage.value = "We couldn't load the events. Please try again.";
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <!--
    Column mapping — Event Coordinator Lead dashboard
    Desktop (12-col): outer container col 1-12, grid-desktop-margin 80px; content col 1-12, full width.
    Tablet (6-col):   content col 1-6, full width, grid-tablet-margin 32px.
    Mobile (4-col):   content col 1-4, full width, grid-mobile-margin 6px.
    Nested grid: card list uses a local 12-col grid (desktop, cards span 4), 6-col (tablet, span 3),
    4-col (mobile, span 4).
  -->
  <div class="page">
    <div class="content">
      <div class="page-header">
        <div>
          <h1 class="h2">{{ viewMode === "queue" ? "Unassigned queue" : "Active events" }}</h1>
          <p class="subheading">
            {{
              viewMode === "queue"
                ? "Requests waiting for a coordinator, longest-waiting first."
                : "Every active event, grouped by its assigned coordinator."
            }}
          </p>
        </div>

        <div class="view-toggle" role="group" aria-label="Lead view">
          <button
            type="button"
            class="toggle-btn"
            :class="{ 'toggle-btn--active': viewMode === 'queue' }"
            :aria-pressed="viewMode === 'queue'"
            @click="viewMode = 'queue'"
          >
            Unassigned ({{ queue.length }})
          </button>
          <button
            type="button"
            class="toggle-btn"
            :class="{ 'toggle-btn--active': viewMode === 'assignments' }"
            :aria-pressed="viewMode === 'assignments'"
            @click="viewMode = 'assignments'"
          >
            Active events ({{ activeAssignmentCount }})
          </button>
        </div>
      </div>

      <p v-if="loading" class="body-default muted state-text">Loading events…</p>
      <p v-else-if="errorMessage" class="body-default error-text state-text">{{ errorMessage }}</p>

      <!-- E1-8 AC1: event name, event date and submission date for each request -->
      <template v-else-if="viewMode === 'queue'">
        <p v-if="queue.length === 0" class="body-default muted state-text">
          No requests are waiting for a coordinator.
        </p>
        <div v-else class="card-grid queue-list">
          <RouterLink
            v-for="event in queue"
            :key="event.id"
            :to="{ name: 'event-detail', params: { id: event.id } }"
            class="event-card"
          >
            <span class="badge" :class="statusBadgeClass(event.status)">{{ statusLabel(event.status) }}</span>
            <p class="card-title">{{ eventName(event) }}</p>
            <dl class="card-facts">
              <div>
                <dt class="small-text muted">Event date</dt>
                <dd class="body-small">{{ formatEventDate(eventDate(event)) }}</dd>
              </div>
              <div>
                <dt class="small-text muted">Submitted</dt>
                <dd class="body-small">{{ formatEventDate(event.created_at) }}</dd>
              </div>
            </dl>
            <hr class="card-divider" />
            <p class="body-small muted">Requested by: {{ event.organiser?.name ?? "Unknown" }}</p>
          </RouterLink>
        </div>
      </template>

      <template v-else>
        <p v-if="coordinatorGroups.length === 0" class="body-default muted state-text">
          No active events have a coordinator yet.
        </p>
        <section v-for="group in coordinatorGroups" :key="group.key" class="coordinator-group">
          <div class="group-header">
            <h2 class="group-label">{{ group.label }}</h2>
            <span class="group-count">{{ group.events.length }}</span>
          </div>
          <div class="card-grid">
            <RouterLink
              v-for="event in group.events"
              :key="event.id"
              :to="{ name: 'event-detail', params: { id: event.id } }"
              class="event-card"
            >
              <span class="badge" :class="statusBadgeClass(event.status)">{{ statusLabel(event.status) }}</span>
              <p class="card-title">{{ eventName(event) }}</p>
              <p class="body-small muted">Event date: {{ formatEventDate(eventDate(event)) }}</p>
            </RouterLink>
          </div>
        </section>
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

/* H2 */
.h2 {
  font-size: 2.25rem;
  font-weight: 700;
  line-height: 2.625rem;
  color: var(--color-grey-900);
  margin: 0;
}

/* Subheading */
.subheading {
  font-size: 1.125rem;
  font-weight: 400;
  line-height: 1.375rem;
  color: var(--color-grey-500);
  margin: var(--spacing-8) 0 0;
}

/* Body Default / Body Small / Small Text */
.body-default {
  font-size: 1rem;
  line-height: 1.25rem;
}

.body-small {
  font-size: 0.875rem;
  line-height: 1.125rem;
  margin: 0;
}

.small-text {
  font-size: 0.75rem;
  line-height: 1rem;
}

.muted {
  color: var(--color-grey-500);
}

.error-text {
  color: var(--color-error-600);
}

.state-text {
  margin-top: var(--spacing-32);
}

/* Segmented toggle — Style.md 3.1 Selected uses Purple Primary 600 for the active segment. */
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
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  color: var(--color-grey-600);
}

.toggle-btn:last-child {
  border-right: none;
}

.toggle-btn:hover:not(.toggle-btn--active) {
  background: var(--color-grey-75);
  color: var(--color-grey-800);
}

.toggle-btn:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

.toggle-btn--active {
  background: var(--color-purple-600);
  color: var(--color-base-white);
}

/* Cards */
.card-grid {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: var(--grid-desktop-gutter);
  align-content: start;
}

.queue-list {
  margin-top: var(--spacing-32);
}

@media (max-width: 1024px) {
  .card-grid {
    grid-template-columns: repeat(6, 1fr);
  }
}

@media (max-width: 640px) {
  .card-grid {
    grid-template-columns: repeat(4, 1fr);
    gap: var(--grid-mobile-gutter);
  }
}

.event-card {
  grid-column: span 4;
  display: block;
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
  padding: var(--spacing-24);
  color: inherit;
  text-decoration: none;
}

@media (max-width: 1024px) {
  .event-card {
    grid-column: span 3;
  }
}

@media (max-width: 640px) {
  .event-card {
    grid-column: span 4;
  }
}

.event-card:hover {
  background: var(--color-grey-75);
  border-color: var(--color-grey-200);
}

.event-card:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

/* H6 */
.card-title {
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
  margin: var(--spacing-12) 0 var(--spacing-8);
}

.card-facts {
  display: flex;
  gap: var(--spacing-24);
  margin: 0;
}

.card-facts dd {
  margin: var(--spacing-4) 0 0;
  color: var(--color-grey-700);
}

.card-divider {
  border: none;
  border-top: 1px solid var(--color-grey-100);
  margin: var(--spacing-16) 0;
}

/* Small Text / Tag */
.badge {
  display: inline-block;
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  padding: var(--spacing-4) var(--spacing-8);
  border-radius: var(--radius-full);
}

.status-success {
  background: var(--color-success-200);
  color: var(--color-success-700);
}

.status-warning {
  background: var(--color-warning-200);
  color: var(--color-warning-900);
}

.status-error {
  background: var(--color-error-200);
  color: var(--color-error-600);
}

.status-info {
  background: var(--color-warning-100);
  color: var(--color-warning-800);
}

/* Coordinator groups */
.coordinator-group {
  margin-top: var(--spacing-40);
}

.group-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-8);
  margin-bottom: var(--spacing-16);
  border-bottom: 1px solid var(--color-grey-100);
  padding-bottom: var(--spacing-12);
}

/* H6 */
.group-label {
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
  margin: 0;
}

.group-count {
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  background: var(--color-grey-100);
  color: var(--color-grey-600);
  padding: var(--spacing-2) var(--spacing-6);
  border-radius: var(--radius-full);
}
</style>
