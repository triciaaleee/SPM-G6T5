<script setup lang="ts">
import { onMounted, ref } from "vue";
import { fetchUnassignedQueue, type EventSummary } from "../lib/eventsApi";
import { formatEventDate, statusBadgeClass, statusLabel } from "../lib/eventStatus";
import { eventName } from "../lib/leadAssignments";

/**
 * E1-8: the Event Coordinator Lead's unassigned queue — every submitted
 * request still waiting for a coordinator, longest-waiting first (the
 * backend's order). Opening one is how the Lead assigns it (E2-13).
 */
const queue = ref<EventSummary[]>([]);
const loading = ref(true);
const errorMessage = ref<string | null>(null);

function eventDate(event: EventSummary): string | null {
  const date = (event.submitted_details as Record<string, unknown>)?.proposedDate;
  return typeof date === "string" && date ? date : null;
}

onMounted(async () => {
  try {
    queue.value = await fetchUnassignedQueue();
  } catch {
    errorMessage.value = "We couldn't load the events. Please try again.";
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <!--
    Column mapping — Event Coordinator Lead unassigned queue
    Desktop (12-col): outer container col 1-12, grid-desktop-margin 80px; back link, heading and card list col 1-12.
    Tablet (6-col):   content col 1-6, full width, grid-tablet-margin 32px.
    Mobile (4-col):   content col 1-4, full width, grid-mobile-margin 6px.
    Nested grid: card list uses a local 12-col grid (desktop, cards span 4), 6-col (tablet, span 3),
    4-col (mobile, span 4).
  -->
  <div class="page">
    <div class="content">
      <RouterLink :to="{ name: 'lead-dashboard' }" class="back-link">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M15.75 19.5 8.25 12l7.5-7.5" />
        </svg>
        Back to overview
      </RouterLink>

      <div>
        <h1 class="h2">Unassigned queue</h1>
        <p class="subheading">Requests waiting for a coordinator, longest-waiting first. Open one to assign it.</p>
      </div>

      <p v-if="loading" class="body-default muted">Loading events…</p>
      <p v-else-if="errorMessage" class="body-default error-text" role="alert">{{ errorMessage }}</p>
      <p v-else-if="queue.length === 0" class="body-default muted">No requests are waiting for a coordinator.</p>

      <!-- E1-8 AC1: event name, event date and submission date for each request -->
      <div v-else class="card-grid">
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
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--spacing-24);
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

.back-link {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-8);
  min-height: 44px;
  color: var(--color-purple-600);
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  text-decoration: none;
}

.back-link:hover {
  color: var(--color-purple-700);
}

.back-link:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
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
  margin: 0;
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

/* Cards */
.card-grid {
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
</style>
