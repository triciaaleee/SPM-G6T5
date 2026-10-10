<script setup lang="ts">
import { onMounted, ref } from "vue";
import { fetchSafetyQueue, type SafetyQueueEvent } from "../lib/eventsApi";
import { formatEventDate } from "../lib/eventStatus";

const events = ref<SafetyQueueEvent[]>([]);
const loading = ref(true);
const errorMessage = ref<string | null>(null);

function detail(event: SafetyQueueEvent, key: string): string | null {
  const value = (event.submitted_details as Record<string, unknown>)?.[key];
  if (typeof value === "number") return String(value);
  return typeof value === "string" && value ? value : null;
}

function eventName(event: SafetyQueueEvent): string {
  return detail(event, "name") ?? `Event #${event.id}`;
}

function eventTime(event: SafetyQueueEvent): string {
  const start = detail(event, "startTime");
  const end = detail(event, "endTime");
  return start && end ? `${start}–${end}` : start ?? "Time not given";
}

onMounted(async () => {
  try {
    events.value = await fetchSafetyQueue();
  } catch {
    errorMessage.value = "We couldn't load your review queue. Please try again.";
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <!--
    Column mapping — Safety Officer review queue
    Desktop (12-col): outer container col 1-12, grid-desktop-margin 80px; content col 1-12, full width.
    Tablet (6-col):   content col 1-6, full width, grid-tablet-margin 32px.
    Mobile (4-col):   content col 1-4, full width, grid-mobile-margin 6px.
    Nested grid: card list uses a local 12-col grid (desktop, cards span 4), 6-col (tablet, span 3),
    4-col (mobile, span 4).
  -->
  <div class="page">
    <div class="content">
      <h1 class="h2">Safety review queue</h1>
      <p class="subheading">Events awaiting your Operational Safety Check, soonest event first.</p>

      <p v-if="loading" class="body-default muted state-text">Loading events…</p>
      <p v-else-if="errorMessage" class="body-default error-text state-text">{{ errorMessage }}</p>
      <p v-else-if="events.length === 0" class="body-default muted state-text">
        No events are awaiting a safety check.
      </p>

      <!-- E1-10 AC1: every event in Safety Review, and only those (AC3) -->
      <div v-else class="card-grid">
        <RouterLink
          v-for="event in events"
          :key="event.id"
          :to="{ name: 'safety-check', params: { id: event.id } }"
          class="event-card"
        >
          <span class="badge">Safety Review</span>
          <p class="card-title">{{ eventName(event) }}</p>
          <dl class="card-facts">
            <div>
              <dt class="small-text muted">Event date</dt>
              <dd class="body-small">{{ formatEventDate(detail(event, "proposedDate")) }}</dd>
            </div>
            <div>
              <dt class="small-text muted">Time</dt>
              <dd class="body-small">{{ eventTime(event) }}</dd>
            </div>
            <div>
              <dt class="small-text muted">Expected attendance</dt>
              <dd class="body-small">{{ detail(event, "expectedAttendance") ?? "Not given" }}</dd>
            </div>
          </dl>
          <hr class="card-divider" />
          <p class="body-small muted">Coordinator: {{ event.coordinator?.name ?? "Not assigned" }}</p>
          <p v-if="event.safety_submitted_at" class="body-small muted">
            Submitted for review {{ formatEventDate(event.safety_submitted_at) }}
          </p>
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

.card-grid {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: var(--grid-desktop-gutter);
  align-content: start;
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
  display: flex;
  flex-direction: column;
  gap: var(--spacing-4);
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
  margin: var(--spacing-8) 0 var(--spacing-4);
}

.card-facts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-16) var(--spacing-24);
  margin: 0;
}

.card-facts dd {
  margin: var(--spacing-4) 0 0;
  color: var(--color-grey-700);
}

.card-divider {
  border: none;
  border-top: 1px solid var(--color-grey-100);
  margin: var(--spacing-12) 0;
  width: 100%;
}

/* Small Text / Tag — Style.md 2.6: Safety Review awaits action, so the Warning set. */
.badge {
  align-self: flex-start;
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  padding: var(--spacing-4) var(--spacing-8);
  border-radius: var(--radius-full);
  background: var(--color-warning-200);
  color: var(--color-warning-900);
}
</style>
