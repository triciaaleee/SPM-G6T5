<script setup lang="ts">
import { computed, ref, watch } from "vue";
import VenueIcon from "./VenueIcon.vue";

/**
 * Month-grid date picker. Values are local-calendar "YYYY-MM-DD" strings —
 * the same shape events store proposedDate in — built from date parts
 * rather than toISOString(), which would shift a day in UTC+ timezones.
 * Past days are disabled by default: availability for a date that's gone
 * is moot. `allowPast` lifts that for views that look back (the venue
 * schedule). `markedDates` puts a dot under days that have something on.
 */
const props = defineProps<{ modelValue: string | null; allowPast?: boolean; markedDates?: string[] }>();
const emit = defineEmits<{
  "update:modelValue": [value: string];
  /** The visible month changed; `month` is 0-based, like Date#getMonth. */
  "month-change": [value: { year: number; month: number }];
}>();

const marked = computed(() => new Set(props.markedDates ?? []));

function toKey(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${m}-${d}`;
}

function fromKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

const todayKey = toKey(new Date());

const initial = props.modelValue ? fromKey(props.modelValue) : new Date();
const viewYear = ref(initial.getFullYear());
const viewMonth = ref(initial.getMonth());

watch(
  () => props.modelValue,
  (value) => {
    if (!value) return;
    const date = fromKey(value);
    viewYear.value = date.getFullYear();
    viewMonth.value = date.getMonth();
  },
);

const monthLabel = computed(() =>
  new Date(viewYear.value, viewMonth.value, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" }),
);

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

/** Monday-first grid, padded with null cells before the 1st. */
const cells = computed(() => {
  const first = new Date(viewYear.value, viewMonth.value, 1);
  const lead = (first.getDay() + 6) % 7;
  const days = new Date(viewYear.value, viewMonth.value + 1, 0).getDate();
  const out: ({ key: string; day: number } | null)[] = Array.from({ length: lead }, () => null);
  for (let day = 1; day <= days; day++) {
    out.push({ key: toKey(new Date(viewYear.value, viewMonth.value, day)), day });
  }
  return out;
});

watch([viewYear, viewMonth], ([year, month]) => emit("month-change", { year, month }));

const canGoBack = computed(() => {
  if (props.allowPast) return true;
  const now = new Date();
  return viewYear.value > now.getFullYear() || (viewYear.value === now.getFullYear() && viewMonth.value > now.getMonth());
});

function shiftMonth(delta: number): void {
  const next = new Date(viewYear.value, viewMonth.value + delta, 1);
  viewYear.value = next.getFullYear();
  viewMonth.value = next.getMonth();
}
</script>

<template>
  <div class="calendar">
    <div class="calendar__header">
      <button type="button" class="calendar__nav" :disabled="!canGoBack" aria-label="Previous month"
        @click="shiftMonth(-1)">
        <VenueIcon name="chevron-left" :size="16" />
      </button>
      <span class="calendar__month" aria-live="polite">{{ monthLabel }}</span>
      <button type="button" class="calendar__nav" aria-label="Next month" @click="shiftMonth(1)">
        <VenueIcon name="chevron-right" :size="16" />
      </button>
    </div>

    <div class="calendar__grid" role="grid">
      <span v-for="weekday in WEEKDAYS" :key="weekday" class="calendar__weekday">{{ weekday }}</span>
      <template v-for="(cell, i) in cells" :key="cell?.key ?? `pad-${i}`">
        <span v-if="!cell" />
        <button v-else type="button" class="calendar__day" :class="{
          'calendar__day--today': cell.key === todayKey,
          'calendar__day--selected': cell.key === modelValue,
        }" :disabled="!allowPast && cell.key < todayKey && cell.key !== modelValue"
          :aria-pressed="cell.key === modelValue"
          :aria-label="fromKey(cell.key).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + (marked.has(cell.key) ? ', has bookings' : '')"
          @click="emit('update:modelValue', cell.key)">
          {{ cell.day }}
          <span v-if="marked.has(cell.key)" class="calendar__dot" aria-hidden="true" />
        </button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.calendar__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--spacing-8);
}

.calendar__month {
  font-size: 1rem;
  font-weight: 700;
  line-height: 1.25rem;
  color: var(--color-grey-900);
}

.calendar__nav {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-purple-600);
  cursor: pointer;
}

.calendar__nav:hover:not(:disabled) {
  background: var(--color-purple-100);
}

.calendar__nav:disabled {
  color: var(--color-grey-300);
  cursor: default;
}

.calendar__grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  grid-auto-rows: 36px;
  align-content: start;
  gap: var(--spacing-2);
}

.calendar__weekday {
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  color: var(--color-grey-500);
}

.calendar__day {
  position: relative;
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-700);
  cursor: pointer;
}

.calendar__day:hover:not(:disabled) {
  background: var(--color-purple-100);
  color: var(--color-purple-800);
}

.calendar__day--today {
  font-weight: 700;
  color: var(--color-purple-600);
  box-shadow: inset 0 0 0 1px var(--color-purple-300);
}

.calendar__day--selected,
.calendar__day--selected:hover:not(:disabled) {
  background: var(--color-purple-600);
  color: var(--color-base-white);
  font-weight: 700;
  box-shadow: none;
}

.calendar__day:disabled {
  color: var(--color-grey-300);
  cursor: default;
}

/* Marks a day with bookings: spacing-4 dot, purple on light, white on the selected fill. */
.calendar__dot {
  position: absolute;
  left: 50%;
  bottom: var(--spacing-2);
  width: var(--spacing-4);
  height: var(--spacing-4);
  border-radius: var(--radius-full);
  background: var(--color-purple-600);
  transform: translateX(-50%);
}

.calendar__day--selected .calendar__dot {
  background: var(--color-base-white);
}
</style>
