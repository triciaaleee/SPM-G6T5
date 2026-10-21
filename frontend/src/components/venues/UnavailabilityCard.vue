<script setup lang="ts">
import AppButton from "../ui/AppButton.vue";
import { computed } from "vue";
import VenueIcon from "./VenueIcon.vue";
import type { UnavailabilityPeriod } from "../../lib/unavailabilityApi";

/**
 * E4-3: one block-out period on the venue schedule's day list. A white card
 * with an orange outline and a lock, so it reads as "closed" next to the
 * solid booking cards without stripes or a semantic colour.
 */
const props = defineProps<{ period: UnavailabilityPeriod; removing?: boolean; venueName?: string; compact?: boolean }>();
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

/** The compact card always says when: one day, or the span of days. */
const when = computed(() => {
  const { startDate, endDate } = props.period;
  return startDate === endDate ? formatDay(startDate, true) : `${formatDay(startDate)} – ${formatDay(endDate, true)}`;
});

const range = computed(() => {
  const { startDate, endDate, allDay } = props.period;
  if (startDate === endDate) return null;
  return `${allDay ? "Blocked" : "Same hours"} ${formatDay(startDate)} – ${formatDay(endDate, true)}`;
});
</script>

<template>
  <!-- Compact: a note on the schedule's bulletin. Full: the wide card. -->
  <div v-if="compact" class="note">
    <div class="note__head">
      <VenueIcon name="lock" :size="16" class="note__icon" />
      <h4 class="note__reason">{{ period.reason }}</h4>
    </div>
    <p v-if="venueName" class="note__venue">{{ venueName }}</p>
    <p class="note__when">{{ when }}</p>
    <span class="note__badge">{{ hours }}</span>
    <div class="note__actions">
      <button type="button" class="note__action" :disabled="removing" @click="$emit('edit')">Edit</button>
      <button type="button" class="note__action note__action--danger" :disabled="removing" @click="$emit('remove')">
        {{ removing ? "Removing…" : "Remove" }}
      </button>
    </div>
  </div>
  <div v-else class="block-card">
    <VenueIcon name="lock" :size="24" class="block-card__icon" />
    <div class="block-card__main">
      <div class="block-card__title-row">
        <h3 class="block-card__reason">{{ period.reason }}</h3>
        <span class="block-card__badge">{{ hours }}</span>
      </div>
      <p v-if="venueName || range" class="block-card__range">{{ [venueName, range].filter(Boolean).join(" · ") }}</p>
    </div>
    <div class="block-card__actions">
      <AppButton variant="ghost" type="button" :disabled="removing" @click="$emit('edit')">Edit</AppButton>
      <AppButton variant="danger" type="button" :disabled="removing" @click="$emit('remove')">
        {{ removing ? "Removing…" : "Remove" }}
      </AppButton>
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

/* Compact note, for the schedule's side bulletin. */
.note {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--spacing-4);
  padding: var(--spacing-12) var(--spacing-16);
  border: 1px solid var(--color-warning-300);
  border-left: var(--spacing-4) solid var(--color-warning-400);
  border-radius: var(--radius-sm);
  background: var(--color-base-white);
}

.note__head {
  display: flex;
  align-items: center;
  gap: var(--spacing-8);
  min-width: 0;
  max-width: 100%;
}

.note__icon {
  flex-shrink: 0;
  color: var(--color-grey-700);
}

.note__reason {
  margin: 0;
  overflow: hidden;
  font-size: 1rem;
  font-weight: 700;
  line-height: 1.25rem;
  color: var(--color-grey-900);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.note__venue {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  color: var(--color-grey-700);
}

.note__when {
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-500);
}

.note__badge {
  display: inline-flex;
  align-items: center;
  height: var(--spacing-24);
  margin-top: var(--spacing-4);
  padding: 0 var(--spacing-12);
  border-radius: var(--radius-full);
  background: var(--color-warning-200);
  color: var(--color-warning-900);
  font-size: 0.75rem;
  font-weight: 700;
}

.note__actions {
  display: flex;
  gap: var(--spacing-16);
  width: 100%;
  margin-top: var(--spacing-8);
  padding-top: var(--spacing-8);
  border-top: 1px solid var(--color-grey-100);
}

.note__action {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-purple-600);
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  font-weight: 700;
  cursor: pointer;
}

.note__action--danger {
  color: var(--color-error-600);
}

.note__action:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.note__action:focus-visible {
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
