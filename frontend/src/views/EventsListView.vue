<script setup lang="ts">
import { onMounted, ref } from "vue";
import { fetchMyEvents, getCurrentUser, type EventSummary } from "../lib/eventsApi";

const events = ref<EventSummary[]>([]);
const loading = ref(true);
const errorMessage = ref<string | null>(null);
const isCoordinator = ref(false);

onMounted(async () => {
  try {
    const [eventsData, user] = await Promise.all([fetchMyEvents(), getCurrentUser()]);
    events.value = eventsData;
    isCoordinator.value = user.role === "coordinator";
  } catch (err) {
    errorMessage.value = "We couldn't load your events. Please try again.";
  } finally {
    loading.value = false;
  }
});

function statusClass(status: string): string {
  if (status === "approved") return "status-success";
  if (status === "rejected") return "status-error";
  return "status-warning";
}
</script>

<template>
  <!--
    Column mapping — Events List
    Desktop (12-col): outer container col 1-12 (grid-desktop-margin 80px); content col 3-10, centred.
    Tablet (6-col): content col 1-6, full width, grid-tablet-margin 32px.
    Mobile (4-col): content col 1-4, full width, grid-mobile-margin 6px.
    Nested grid: card list uses a local grid matching the content area's column count (8 desktop / 6 tablet / 4 mobile).
  -->
  <div class="page">
    <div class="content">
      <div class="flex items-start justify-between gap-4">
        <div>
          <h1 class="h2">{{ isCoordinator ? "All events" : "My events" }}</h1>
          <p class="subheading">
            {{ isCoordinator ? "All events in the pipeline." : "Only events you created appear here." }}
          </p>
        </div>
        <RouterLink
          v-if="!isCoordinator"
          :to="{ name: 'new-event-request' }"
          class="shrink-0 rounded-xs bg-purple-600 px-6 py-3 text-sm font-bold text-base-white hover:bg-purple-700"
        >
          New event request
        </RouterLink>
      </div>

      <p v-if="loading" class="body-default muted">Loading events…</p>
      <p v-else-if="errorMessage" class="body-default error-text">{{ errorMessage }}</p>
      <p v-else-if="events.length === 0" class="body-default muted">
        {{ isCoordinator ? "No events in the system yet." : "You haven't submitted any events yet." }}
      </p>

      <div v-else class="card-grid">
        <RouterLink
          v-for="event in events"
          :key="event.id"
          :to="{ name: 'event-detail', params: { id: event.id } }"
          class="event-card"
        >
          <span class="badge" :class="statusClass(event.status)">{{ event.status }}</span>
          <p class="card-title">Event #{{ event.id }}</p>
          <p class="body-small muted">Created {{ new Date(event.created_at).toLocaleDateString() }}</p>
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
  grid-column: 3 / 11;
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
  margin: var(--spacing-8) 0 var(--spacing-32);
}

.body-default {
  font-size: 1rem;
  line-height: 1.25rem;
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

.card-grid {
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
  grid-column: span 4;
  display: block;
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
  padding: var(--spacing-24);
  color: inherit;
}

.event-card:hover {
  background: var(--color-grey-75);
  border-color: var(--color-grey-200);
}

@media (max-width: 640px) {
  .event-card {
    grid-column: span 4;
  }
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
  border-radius: var(--radius-xs);
}

.status-success {
  background: #F3F9F3;
  color: var(--color-success-600);
}

.status-warning {
  background: #FEF5E7;
  color: var(--color-warning-600);
}

.status-error {
  background: var(--color-error-200);
  color: var(--color-error-600);
}
</style>
