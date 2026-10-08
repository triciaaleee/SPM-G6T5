<script setup lang="ts">
/**
 * E5-1 AC1: Technical Support Staff's view of every equipment request
 * Event Coordinators have recorded, newest first.
 */
import { onMounted, ref } from "vue";
import { fetchAllEquipmentRequests, type EquipmentRequestWithEvent } from "../lib/equipmentApi";

const requests = ref<EquipmentRequestWithEvent[]>([]);
const loading = ref(true);
const errorMessage = ref<string | null>(null);

onMounted(async () => {
  try {
    requests.value = await fetchAllEquipmentRequests();
  } catch {
    errorMessage.value = "We couldn't load equipment requests. Please try again.";
  } finally {
    loading.value = false;
  }
});

function formatDate(value: string | null): string {
  if (!value) return "Date not set";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

function formatTimeRange(start: string | null, end: string | null): string {
  return start && end ? `${start} – ${end}` : "Time not specified";
}

function formatSubmitted(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}
</script>

<template>
  <div class="page">
    <div class="page-header">
      <h1 class="h2">Equipment requests</h1>
      <p class="subheading">Requests Event Coordinators have recorded, newest first</p>
    </div>

    <p v-if="loading" class="body-default muted full-row">Loading equipment requests…</p>
    <p v-else-if="errorMessage" class="body-default error-text full-row">{{ errorMessage }}</p>

    <div v-else-if="requests.length === 0" class="empty-state full-row">
      <p class="empty-state__title">Nothing here yet</p>
      <p class="body-default muted">No equipment requests have been recorded.</p>
    </div>

    <ul v-else class="request-list full-row">
      <li v-for="r in requests" :key="r.id" class="request-card">
        <div class="request-card__header">
          <!-- Not a link: events-service's full event detail is organiser/coordinator-only,
               same as venue_staff's schedule (VenueStaff.vue) — technical_support can't open it. -->
          <p class="card-title">{{ r.event?.name || `Event #${r.eventId}` }}</p>
          <span class="badge badge-neutral">{{ r.status }}</span>
        </div>
        <p class="body-small muted">
          {{ formatDate(r.event?.proposedDate ?? null) }} · {{ formatTimeRange(r.event?.startTime ?? null, r.event?.endTime ?? null) }}
        </p>
        <p class="body-small muted request-card__submitted">Submitted {{ formatSubmitted(r.createdAt) }}</p>

        <ul class="item-list">
          <li v-for="item in r.items" :key="item.id" class="body-default item-row">
            <strong>{{ item.quantity }}&times; {{ item.equipmentType }}</strong>
            <span v-if="item.technicalRequirements" class="muted"> — {{ item.technicalRequirements }}</span>
          </li>
        </ul>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.page {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: var(--spacing-24) var(--grid-desktop-gutter);
  padding: var(--spacing-40) var(--grid-desktop-margin);
  align-content: start;
}

.page-header,
.full-row {
  grid-column: 1 / 13;
}

@media (max-width: 1024px) {
  .page {
    grid-template-columns: repeat(6, 1fr);
    padding: var(--spacing-32) var(--grid-tablet-margin);
  }

  .page-header,
  .full-row {
    grid-column: 1 / 7;
  }
}

@media (max-width: 640px) {
  .page {
    grid-template-columns: repeat(4, 1fr);
    padding: var(--spacing-24) var(--grid-mobile-margin);
  }

  .page-header,
  .full-row {
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
  margin: var(--spacing-8) 0 0;
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

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: var(--spacing-40) var(--spacing-24);
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-sm);
}

.empty-state__title {
  margin: 0 0 var(--spacing-8);
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
}

.request-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-16);
  list-style: none;
  margin: 0;
  padding: 0;
}

.request-card {
  padding: var(--spacing-24);
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-sm);
}

.request-card__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-12);
}

.card-title {
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
  margin: 0;
}

.request-card__submitted {
  margin-bottom: var(--spacing-12);
}

.badge {
  display: inline-block;
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  padding: var(--spacing-4) var(--spacing-8);
  border-radius: var(--radius-xs);
  flex-shrink: 0;
}

.badge-neutral {
  background: var(--color-purple-100);
  color: var(--color-purple-800);
}

.item-list {
  margin: 0;
  padding-top: var(--spacing-12);
  border-top: 1px solid var(--color-grey-100);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-4);
  list-style: none;
}

.item-row {
  color: var(--color-grey-900);
}
</style>
