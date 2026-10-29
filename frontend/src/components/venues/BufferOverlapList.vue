<script setup lang="ts">
import EmptyState from "../ui/EmptyState.vue";
/**
 * E4-13 AC2/AC3: the persistent review list of setup/turnaround overlap
 * pairs flagged for one venue — distinct from VenueFormPanel.vue's one-shot
 * warning shown while editing a venue (that stays as-is). This surface is
 * reachable any time, reconciles itself server-side, and has nothing to
 * dismiss: a pair leaves the list only when it stops overlapping.
 */
import type { BufferOverlapRecord } from "../../lib/venuesApi";
import { ExclamationTriangleIcon } from "@heroicons/vue/20/solid";

defineProps<{ overlaps: BufferOverlapRecord[]; loading?: boolean; loadError?: string | null }>();
</script>

<template>
  <section class="overlap-review" aria-live="polite">
    <h2 class="h5 overlap-review__heading">Flagged booking pairs</h2>
    <p class="small-text muted overlap-review__intro">
      Bookings whose setup or turnaround time now make their occupied windows overlap. Nothing here is removed
      automatically — a pair drops off this list once it no longer overlaps.
    </p>

    <p v-if="loadError" class="small-text error-text">{{ loadError }}</p>
    <p v-else-if="loading" class="small-text muted">Checking flagged bookings…</p>

    <EmptyState v-else-if="overlaps.length === 0">
      <p class="empty-state__title">No flagged pairs</p>
      <p class="small-text muted">Nothing at this venue currently overlaps.</p>
    </EmptyState>

    <ul v-else class="overlap-list">
      <li v-for="pair in overlaps" :key="pair.id" class="overlap-card">
        <ExclamationTriangleIcon class="overlap-card__icon" aria-hidden="true" />
        <div class="overlap-card__body">
          <div class="overlap-card__event">
            <span class="overlap-card__name">{{ pair.first.eventName || "Untitled event" }}</span>
            <span class="small-text muted">{{ pair.first.window }}</span>
          </div>
          <span class="overlap-card__and">and</span>
          <div class="overlap-card__event">
            <span class="overlap-card__name">{{ pair.second.eventName || "Untitled event" }}</span>
            <span class="small-text muted">{{ pair.second.window }}</span>
          </div>
        </div>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.overlap-review {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
}

.h5 {
  margin: 0;
}

.muted {
  color: var(--color-grey-600);
}

.error-text {
  color: var(--color-error-600);
}

.empty-state__title {
  margin: 0 0 var(--spacing-8);
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
}

.overlap-review__heading {
  margin: 0;
}

.overlap-review__intro {
  margin: 0 0 var(--spacing-8) 0;
}

.overlap-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-12);
  margin: 0;
  padding: 0;
  list-style: none;
}

.overlap-card {
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-12);
  padding: var(--spacing-16);
  border: 1px solid var(--color-warning-300);
  border-radius: var(--radius-xs);
  background: var(--color-warning-100);
}

.overlap-card__icon {
  flex-shrink: 0;
  width: var(--spacing-24);
  height: var(--spacing-24);
  color: var(--color-warning-800);
}

.overlap-card__body {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-4);
  min-width: 0;
}

.overlap-card__event {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: var(--spacing-8);
}

.overlap-card__name {
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  color: var(--color-warning-900);
}

.overlap-card__and {
  font-size: 0.75rem;
  line-height: 1rem;
  color: var(--color-grey-700);
}
</style>
