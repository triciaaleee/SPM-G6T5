<script setup lang="ts">
import { computed } from "vue";
import { LockClosedIcon } from "@heroicons/vue/16/solid";
import type { UnavailabilityPeriod } from "../../lib/unavailabilityApi";

/**
 * E4-3: one block-out period on the venue schedule's day list, striped
 * (Style.md 3.5 pattern-unavailable) so it reads as "closed" at a glance
 * next to the booking cards.
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
    <div class="block-card__main">
      <span class="block-card__badge">
        <LockClosedIcon class="block-card__icon" aria-hidden="true" />
        {{ hours }}
      </span>
      <p class="block-card__reason">{{ period.reason }}</p>
      <p v-if="range" class="block-card__range">{{ range }}</p>
    </div>
    <div class="block-card__actions">
      <button type="button" class="btn-ghost" :disabled="removing" @click="$emit('edit')">Edit</button>
      <button type="button" class="btn-ghost" :disabled="removing" @click="$emit('remove')">
        {{ removing ? "Removing…" : "Remove" }}
      </button>
    </div>
  </div>
</template>

<style scoped>
/* Style.md 3.5: pattern-unavailable. */
.block-card {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--spacing-16);
  padding: var(--spacing-24);
  border: 1px solid var(--color-grey-300);
  border-radius: var(--radius-sm);
  background: repeating-linear-gradient(135deg,
      var(--color-grey-200) 0 var(--spacing-4),
      var(--color-grey-50) var(--spacing-4) var(--spacing-8));
}

.block-card__main {
  min-width: 0;
}

.block-card__badge {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-4);
  padding: var(--spacing-2) var(--spacing-8);
  border: 1px solid var(--color-grey-300);
  border-radius: var(--radius-full);
  background: var(--color-base-white);
  color: var(--color-grey-900);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
}

.block-card__icon {
  width: var(--spacing-12);
  height: var(--spacing-12);
  color: var(--color-grey-700);
}

.block-card__reason {
  display: inline-block;
  margin: var(--spacing-8) 0 0;
  padding: 0 var(--spacing-4);
  border-radius: var(--radius-xs);
  background: var(--color-base-white);
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
}

.block-card__range {
  display: table;
  margin: var(--spacing-4) 0 0;
  padding: 0 var(--spacing-4);
  border-radius: var(--radius-xs);
  background: var(--color-base-white);
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-700);
}

.block-card__actions {
  display: flex;
  flex-shrink: 0;
  gap: var(--spacing-8);
}

.btn-ghost {
  padding: var(--spacing-4) var(--spacing-12);
  border: none;
  border-radius: var(--radius-xs);
  background: var(--color-base-white);
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

.btn-ghost:disabled {
  cursor: default;
  color: var(--color-grey-300);
}

.btn-ghost:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}
</style>
