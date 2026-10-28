<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { fetchMyEvents, fetchUnassignedQueue, type EventSummary } from "../../lib/eventsApi";
import { fetchCoordinators, type CoordinatorOption } from "../../lib/usersApi";
import { activeEventsLabel, groupByCoordinator, initials } from "../../lib/leadAssignments";
import LeadEventList from "../../components/LeadEventList.vue";

/**
 * The Event Coordinator Lead's landing page (Week 7 change 5): every
 * coordinator with their active events, busiest first, including anyone
 * with nothing assigned. Opening an event is how the Lead reassigns it
 * (E2-12); "Assign event" opens the unassigned queue (E1-8, E2-13).
 */

/** Events shown per card; the rest are on the coordinator's own page. */
const EVENTS_PER_CARD = 3;

const coordinators = ref<CoordinatorOption[]>([]);
const events = ref<EventSummary[]>([]);
const unassignedCount = ref(0);
const loading = ref(true);
const errorMessage = ref<string | null>(null);

const groups = computed(() => groupByCoordinator(coordinators.value, events.value));

const activeEventCount = computed(() => groups.value.reduce((total, group) => total + group.events.length, 0));

const summary = computed(() => {
  const people = groups.value.length;
  return `${people} ${people === 1 ? "coordinator" : "coordinators"}, ${activeEventsLabel(activeEventCount.value)}.`;
});

onMounted(async () => {
  try {
    const [coordinatorData, eventData, queueData] = await Promise.all([
      fetchCoordinators(),
      fetchMyEvents(),
      fetchUnassignedQueue(),
    ]);
    coordinators.value = coordinatorData;
    events.value = eventData;
    unassignedCount.value = queueData.length;
  } catch {
    errorMessage.value = "We couldn't load the assignments. Please try again.";
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <!--
    Column mapping — Event Coordinator Lead assignment overview
    Desktop (12-col): outer container col 1-12, grid-desktop-margin 80px; header (title left, Assign event right) col 1-12.
    Tablet (6-col):   content col 1-6, full width, grid-tablet-margin 32px.
    Mobile (4-col):   content col 1-4, full width, grid-mobile-margin 6px; header stacks, Assign event full width.
    Nested grid: coordinator cards use a local 12-col grid (desktop, cards span 6 — 2 per row),
    6-col (tablet, span 6 — 1 per row), 4-col (mobile, span 4).
  -->
  <div class="page">
    <div class="content">
      <div class="page-header">
        <div>
          <h1 class="h2">Assignment overview</h1>
          <p class="subheading">
            Active events grouped by coordinator, across the whole system.
            <template v-if="!loading && !errorMessage">{{ summary }}</template>
          </p>
        </div>

        <RouterLink :to="{ name: 'lead-unassigned' }" class="btn-primary">
          Assign event<template v-if="unassignedCount > 0"> ({{ unassignedCount }})</template>
        </RouterLink>
      </div>

      <p v-if="loading" class="body-default muted">Loading assignments…</p>
      <p v-else-if="errorMessage" class="body-default error-text" role="alert">{{ errorMessage }}</p>
      <p v-else-if="groups.length === 0" class="body-default muted">No coordinators yet.</p>

      <div v-else class="card-grid">
        <section
          v-for="group in groups"
          :key="group.id"
          class="coordinator-card"
          :aria-labelledby="`coordinator-${group.id}`"
        >
          <div class="coordinator-head">
            <span class="avatar" aria-hidden="true">{{ initials(group.name) }}</span>
            <div class="coordinator-head__text">
              <h2 :id="`coordinator-${group.id}`" class="coordinator-name">{{ group.name }}</h2>
              <p class="body-small muted">{{ activeEventsLabel(group.events.length) }}</p>
            </div>
          </div>

          <p v-if="group.events.length === 0" class="empty-text">
            No active events assigned. Available for new work.
          </p>
          <LeadEventList v-else :events="group.events.slice(0, EVENTS_PER_CARD)" />

          <RouterLink
            v-if="group.events.length > EVENTS_PER_CARD"
            :to="{ name: 'lead-coordinator', params: { id: group.id } }"
            class="view-all"
          >
            View all {{ group.events.length }} events
          </RouterLink>
        </section>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: var(--grid-desktop-gutter);
  padding: var(--spacing-40) var(--grid-desktop-margin) var(--spacing-80);
  align-content: start;
}

.content {
  grid-column: 1 / 13;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-40);
}

@media (max-width: 1024px) {
  .page {
    grid-template-columns: repeat(6, 1fr);
    padding: var(--spacing-32) var(--grid-tablet-margin) var(--spacing-80);
  }

  .content {
    grid-column: 1 / 7;
  }
}

@media (max-width: 640px) {
  .page {
    grid-template-columns: repeat(4, 1fr);
    padding: var(--spacing-24) var(--grid-mobile-margin) var(--spacing-48);
  }

  .content {
    grid-column: 1 / 5;
    gap: var(--spacing-24);
  }
}

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--spacing-24);
}

@media (max-width: 640px) {
  .page-header {
    flex-direction: column;
    align-items: stretch;
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
  color: var(--color-grey-600);
  margin: var(--spacing-8) 0 0;
}

/* Primary button (Style.md 3.4): the page's one solid action. */
.btn-primary {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  padding: 0 var(--spacing-24);
  border-radius: var(--radius-xs);
  background: var(--color-purple-600);
  color: var(--color-base-white);
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  text-decoration: none;
}

.btn-primary:hover {
  background: var(--color-purple-500);
}

.btn-primary:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

/* Body Default / Body Small */
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

.muted {
  color: var(--color-grey-500);
}

.error-text {
  color: var(--color-error-600);
}

/* Coordinator cards: 2 per row on desktop, 1 per row below. */
.card-grid {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: var(--grid-desktop-gutter);
  align-items: start;
}

.coordinator-card {
  grid-column: span 6;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-24);
  min-width: 0;
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
  padding: var(--spacing-24);
}

@media (max-width: 1024px) {
  .card-grid {
    grid-template-columns: repeat(6, 1fr);
    gap: var(--grid-tablet-gutter);
  }
}

@media (max-width: 640px) {
  .card-grid {
    grid-template-columns: repeat(4, 1fr);
    gap: var(--grid-mobile-gutter);
  }

  .coordinator-card {
    grid-column: span 4;
  }
}

.coordinator-head {
  display: flex;
  align-items: center;
  gap: var(--spacing-16);
  min-width: 0;
}

/* Initials avatar: Purple Primary 100 tint behind Purple Primary 600 text (Style.md 2.6). */
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

.coordinator-head__text {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-2);
  min-width: 0;
}

/* H5 */
.coordinator-name {
  margin: 0;
  font-size: 1.5rem;
  font-weight: 700;
  line-height: 2rem;
  color: var(--color-grey-900);
  overflow-wrap: anywhere;
}

.empty-text {
  margin: 0;
  padding: var(--spacing-16) var(--spacing-20);
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-sm);
  font-size: 1rem;
  line-height: 1.25rem;
  color: var(--color-grey-600);
}

/* Text link: Purple Primary 600 (Style.md text links). */
.view-all {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  color: var(--color-purple-600);
  font-size: 1rem;
  font-weight: 700;
  line-height: 1.25rem;
  text-decoration: none;
}

.view-all:hover {
  color: var(--color-purple-700);
  text-decoration: underline;
}

.view-all:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}
</style>
