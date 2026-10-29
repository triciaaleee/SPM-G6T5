<script setup lang="ts">
import { computed } from "vue";
import VenueIcon from "./VenueIcon.vue";
import { calendarStatusOf } from "../../lib/calendarStatus";
import type { CalendarEntry } from "../../lib/venueCalendar";

/**
 * E1-5: one booking or block-out on the venue calendar. The status is the
 * fill, border and text — green Approved, amber On Hold, dashed outline
 * Requested, red Replacement Required, flat grey Unavailable — each with its
 * icon and name, so colour is never the only cue. The venue (slot 0-3) is only
 * the left edge. `showVenue` prints the venue name when several venues share
 * the view. Style.md 3.5, `schedule-block-*`.
 */
const props = defineProps<{
  entry: CalendarEntry;
  venueName: string;
  colorSlot: number;
  showVenue: boolean;
  compact?: boolean;
}>();
defineEmits<{ select: [] }>();

const status = computed(() => calendarStatusOf(props.entry));
const isBlock = computed(() => props.entry.kind === "block");

const times = computed(() =>
  props.entry.allDay || !props.entry.startTime ? "All day" : `${props.entry.startTime}–${props.entry.endTime}`,
);

const attendance = computed(() => {
  const n = props.entry.attendance;
  return typeof n === "number" ? `${n} guest${n === 1 ? "" : "s"}` : null;
});

const label = computed(() =>
  [props.entry.title, status.value.label, times.value, attendance.value, props.showVenue ? props.venueName : null]
    .filter(Boolean)
    .join(", "),
);
</script>

<template>
  <button type="button" class="entry" :class="[
    `entry--slot-${colorSlot}`,
    `entry--${status.key}`,
    { 'entry--compact': compact },
  ]" :aria-label="label" @click.stop="$emit('select')">
    <span v-if="!compact && !isBlock" class="entry__status">
      <VenueIcon :name="status.icon" :size="14" />
      {{ status.label }}
    </span>
    <span class="entry__title">
      <VenueIcon v-if="compact || isBlock" :name="status.icon" :size="12" class="entry__icon" />
      {{ entry.title }}
    </span>
    <span v-if="!compact" class="entry__meta">{{ times }}<template v-if="attendance"> · {{ attendance }}</template></span>
    <span v-if="showVenue && !compact" class="entry__venue">{{ venueName }}</span>
  </button>
</template>

<style scoped>
.entry {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-2);
  width: 100%;
  height: 100%;
  min-width: 0;
  padding: var(--spacing-4) var(--spacing-8);
  overflow: hidden;
  border: 1px solid var(--entry-border);
  border-left: var(--spacing-4) solid var(--venue-color);
  border-radius: var(--radius-xs);
  background: var(--entry-bg);
  color: var(--entry-text);
  font-family: var(--font-family-lato);
  font-size: 0.75rem;
  line-height: 1rem;
  text-align: left;
  cursor: pointer;
}

.entry:hover {
  box-shadow: var(--shadow-popover);
}

.entry:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

.entry--compact {
  flex-direction: row;
  align-items: center;
  height: auto;
  padding: var(--spacing-2) var(--spacing-8);
}

/* First line: the status's icon and name, in the status colour. */
.entry__status {
  display: flex;
  align-items: center;
  gap: var(--spacing-4);
  font-weight: 700;
}

.entry__title {
  display: block;
  overflow: hidden;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-grey-900);
}

.entry__meta,
.entry__venue {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-grey-900);
}

.entry__venue {
  font-weight: 700;
}

.entry__icon {
  vertical-align: -1px;
  color: var(--entry-text);
}

.entry--approved {
  --entry-bg: var(--color-success-200);
  --entry-border: var(--color-success-600);
  --entry-text: var(--color-success-800);
}

.entry--hold {
  --entry-bg: var(--color-warning-100);
  --entry-border: var(--color-warning-400);
  --entry-text: var(--color-warning-900);
}

/* Requested: it doesn't block the venue, so it is an outline only (Style.md 3.5 pending). */
.entry--requested {
  --entry-bg: var(--color-base-white);
  --entry-border: var(--color-grey-600);
  --entry-text: var(--color-grey-700);
  border-style: dashed;
  border-left-style: solid;
}

/* Replacement Required: needs a new venue, so it takes the Orange Warning "needs action" colours (Style.md 3.5). */
.entry--replace {
  --entry-bg: var(--color-warning-200);
  --entry-border: var(--color-warning-300);
  --entry-text: var(--color-warning-900);
}

/* Block-out: a flat grey, no stripes. */
.entry--block {
  --entry-bg: var(--color-grey-100);
  --entry-border: var(--color-grey-300);
  --entry-text: var(--color-grey-900);
}

.entry--slot-0 {
  --venue-color: var(--color-purple-600);
}

.entry--slot-1 {
  --venue-color: var(--color-blue-600);
}

.entry--slot-2 {
  --venue-color: var(--color-venue-magenta);
}

.entry--slot-3 {
  --venue-color: var(--color-venue-slate);
}
</style>
