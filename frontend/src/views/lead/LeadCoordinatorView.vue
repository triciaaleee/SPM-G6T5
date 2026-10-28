<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { fetchMyEvents, type EventSummary } from "../lib/eventsApi";
import { fetchCoordinators, type CoordinatorOption } from "../lib/usersApi";
import { activeEventsLabel, groupByCoordinator, initials } from "../lib/leadAssignments";
import LeadEventTable from "../components/LeadEventTable.vue";

/**
 * Every active event of one coordinator, for the Event Coordinator Lead —
 * where "View all N events" on the Assignment overview leads. Opening an
 * event is how the Lead reassigns it (E2-12).
 */
const route = useRoute();
const coordinatorId = String(route.params.id);

const coordinators = ref<CoordinatorOption[]>([]);
const events = ref<EventSummary[]>([]);
const loading = ref(true);
const errorMessage = ref<string | null>(null);

const group = computed(
  () => groupByCoordinator(coordinators.value, events.value).find((g) => g.id === coordinatorId) ?? null,
);

onMounted(async () => {
  try {
    const [coordinatorData, eventData] = await Promise.all([fetchCoordinators(), fetchMyEvents()]);
    coordinators.value = coordinatorData;
    events.value = eventData;
  } catch {
    errorMessage.value = "We couldn't load this coordinator's events. Please try again.";
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <!--
    Column mapping — Event Coordinator Lead, one coordinator's events
    Desktop (12-col): outer container col 1-12, grid-desktop-margin 80px; back link, heading and event table col 1-12.
    Tablet (6-col):   content col 1-6, full width, grid-tablet-margin 32px; event list col 1-6.
    Mobile (4-col):   content col 1-4, full width, grid-mobile-margin 6px; event list col 1-4.
  -->
  <div class="page">
    <RouterLink :to="{ name: 'lead-dashboard' }" class="back-link">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M15.75 19.5 8.25 12l7.5-7.5" />
      </svg>
      Back to overview
    </RouterLink>

    <p v-if="loading" class="full body-default muted">Loading events…</p>
    <p v-else-if="errorMessage" class="full body-default error-text" role="alert">{{ errorMessage }}</p>
    <p v-else-if="!group" class="full body-default muted" role="alert">Coordinator not found.</p>

    <template v-else>
      <div class="full coordinator-head">
        <span class="avatar" aria-hidden="true">{{ initials(group.name) }}</span>
        <div>
          <h1 class="h2">{{ group.name }}</h1>
          <p class="subheading">{{ activeEventsLabel(group.events.length) }}, soonest first.</p>
        </div>
      </div>

      <p v-if="group.events.length === 0" class="list body-default muted">
        No active events assigned. Available for new work.
      </p>
      <LeadEventTable v-else class="list" :events="group.events" />
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

.back-link,
.full {
  grid-column: 1 / 13;
}

.list {
  grid-column: 1 / 13;
}

@media (max-width: 1024px) {
  .page {
    grid-template-columns: repeat(6, 1fr);
    gap: var(--spacing-24) var(--grid-tablet-gutter);
    padding: var(--spacing-32) var(--grid-tablet-margin) var(--spacing-80);
  }

  .back-link,
  .full,
  .list {
    grid-column: 1 / 7;
  }
}

@media (max-width: 640px) {
  .page {
    grid-template-columns: repeat(4, 1fr);
    gap: var(--spacing-24) var(--grid-mobile-gutter);
    padding: var(--spacing-24) var(--grid-mobile-margin) var(--spacing-48);
  }

  .back-link,
  .full,
  .list {
    grid-column: 1 / 5;
  }
}

.back-link {
  justify-self: start;
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

.coordinator-head {
  display: flex;
  align-items: center;
  gap: var(--spacing-16);
  min-width: 0;
}

/* Initials avatar: same as the overview's cards. */
.avatar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--spacing-48);
  height: var(--spacing-48);
  border-radius: var(--radius-full);
  background: var(--color-purple-100);
  color: var(--color-purple-600);
  font-size: 1rem;
  font-weight: 700;
  line-height: 1.25rem;
}

/* H2 */
.h2 {
  font-size: 2.25rem;
  font-weight: 700;
  line-height: 2.625rem;
  color: var(--color-grey-900);
  margin: 0;
  overflow-wrap: anywhere;
}

/* Subheading */
.subheading {
  font-size: 1.125rem;
  font-weight: 400;
  line-height: 1.375rem;
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
</style>
