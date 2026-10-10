<script setup lang="ts">
import { computed } from "vue";
import VenueIcon from "./VenueIcon.vue";
import type { UnavailabilityPeriod } from "../../lib/unavailabilityApi";

/**
 * E4-3: one block-out period on the venue schedule's day list. A white card
 * with an orange outline and a lock, so it reads as "closed" next to the
 * solid booking cards without stripes or a semantic colour.
 */
const props = defineProps<{ period: UnavailabilityPeriod; removing?: boolean }>();
defineEmits<{ edit: []; remove: [] }>();

function formatDay(key: string, withYear = false): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
  });
}

const hours = computed(() =>
  props.period.allDay ? "Unavailable all day" : `Unavailable ${props.period.startTime} – ${props.period.endTime}`,
);

const range = computed(() => {
  const { startDate, endDate, allDay } = props.period;
  if (startDate === endDate) return null;
  return `${allDay ? "Blocked" : "Same hours"} ${formatDay(startDate)} – ${formatDay(endDate, true)}`;
});
</script>

<template>
  <div class="block-card">
    <VenueIcon name="lock" :size="24" class="block-card__icon" />
    <div class="block-card__main">
      <div class="block-card__title-row">
        <h3 class="block-card__reason">{{ period.reason }}</h3>
        <span class="block-card__badge">{{ hours }}</span>
      </div>
      <p v-if="range" class="block-card__range">{{ range }}</p>
    </div>
    <div class="block-card__actions">
      <button type="button" class="btn-ghost" :disabled="removing" @click="$emit('edit')">Edit</button>
      <button type="button" class="btn-ghost btn-ghost--danger" :disabled="removing" @click="$emit('remove')">
        {{ removing ? "Removing…" : "Remove" }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.block-card {
  display: flex;
  align-items: center;
  gap: var(--spacing-16);
  padding: var(--spacing-20) var(--spacing-24);
  border: 1px solid var(--color-warning-400);
  border-radius: var(--radius-lg);
  background: var(--color-base-white);
}

.block-card__icon {
  flex-shrink: 0;
  color: var(--color-grey-700);
}

.block-card__main {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-4);
}

.block-card__title-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--spacing-12);
}

.block-card__reason {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
}

.block-card__badge {
  display: inline-flex;
  align-items: center;
  height: var(--spacing-24);
  padding: 0 var(--spacing-12);
  border-radius: var(--radius-full);
  background: var(--color-warning-200);
  color: var(--color-warning-900);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
}

.block-card__range {
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-500);
}

.block-card__actions {
  display: flex;
  flex-shrink: 0;
  gap: var(--spacing-8);
}

.btn-ghost {
  min-height: var(--spacing-48);
  padding: var(--spacing-4) var(--spacing-16);
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--color-purple-600);
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  cursor: pointer;
}

.btn-ghost:hover:not(:disabled) {
  background: var(--color-purple-100);
}

.btn-ghost--danger {
  color: var(--color-error-600);
}

.btn-ghost--danger:hover:not(:disabled) {
  background: var(--color-grey-50);
}

.btn-ghost:disabled {
  cursor: default;
  color: var(--color-grey-300);
}

.btn-ghost:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

@media (max-width: 640px) {
  .block-card {
    flex-wrap: wrap;
  }

  .block-card__actions {
    width: 100%;
    justify-content: flex-end;
  }
}
</style>
