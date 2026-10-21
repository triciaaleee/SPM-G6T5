<script setup lang="ts">
import { computed } from "vue";
import VenueIcon from "./VenueIcon.vue";
import type { CalendarEntry } from "../../lib/venueCalendar";

/**
 * E1-5: one booking or block-out on the venue calendar. The venue colour
 * (slot 0-3) is the fill/border; the status changes the treatment — solid for
 * Approved, dashed outline for Requested, a tag for On Hold and Replacement
 * Required, hatching and a lock for block-outs — so colour is never the only
 * cue. `showVenue` prints the venue name when several venues share the view.
 */
const props = defineProps<{
  entry: CalendarEntry;
  venueName: string;
  colorSlot: number;
  showVenue: boolean;
  compact?: boolean;
}>();
defineEmits<{ select: [] }>();

const TAGS: Record<string, string> = { "On Hold": "Hold", Requested: "Request", "Replacement Required": "Replace venue" };

const tag = computed(() => (props.entry.status ? (TAGS[props.entry.status] ?? null) : null));

const times = computed(() =>
  props.entry.allDay || !props.entry.startTime ? "All day" : `${props.entry.startTime}–${props.entry.endTime}`,
);

const attendance = computed(() => {
  const n = props.entry.attendance;
  return typeof n === "number" ? `${n} guest${n === 1 ? "" : "s"}` : null;
});

const label = computed(() =>
  [props.entry.title, times.value, attendance.value, props.showVenue ? props.venueName : null].filter(Boolean).join(", "),
);
</script>

<template>
  <button type="button" class="entry" :class="[
    `entry--slot-${colorSlot}`,
    entry.kind === 'block' ? 'entry--block' : `entry--${entry.status === 'Requested' ? 'requested' : entry.status === 'Replacement Required' ? 'replace' : 'solid'}`,
    { 'entry--compact': compact },
  ]" :aria-label="label" @click.stop="$emit('select')">
    <span class="entry__title">
      <VenueIcon v-if="entry.kind === 'block'" name="lock" :size="12" class="entry__lock" />
      {{ entry.title }}
      <span v-if="tag" class="entry__tag">{{ tag }}</span>
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
  border-left-width: var(--spacing-4);
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

.entry__title {
  display: block;
  overflow: hidden;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.entry__meta,
.entry__venue {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.entry__venue {
  font-weight: 700;
}

.entry__tag {
  margin-left: var(--spacing-4);
  padding: 0 var(--spacing-4);
  border-radius: var(--radius-full);
  background: var(--color-base-white);
  border: 1px solid var(--entry-border);
  font-size: 0.625rem;
  font-weight: 700;
}

.entry__lock {
  vertical-align: -1px;
}

/* Approved / On Hold: solid fill. */
.entry--solid {
  background: var(--entry-bg);
}

/* Requested: it doesn't block the venue, so it is an outline only (Style.md 3.5 pending). */
.entry--requested {
  border-style: dashed;
  border-left-style: solid;
  background: var(--color-base-white);
}

/* Replacement Required: the venue became unavailable after booking, so it reads as a problem. */
.entry--replace {
  border-color: var(--color-error-600);
  background: var(--color-error-200);
  color: var(--color-error-800);
}

/* Block-out: hatched, as in Style.md 3.5 pattern-unavailable. */
.entry--block {
  background: repeating-linear-gradient(135deg,
      var(--color-grey-200) 0 var(--spacing-4),
      var(--color-grey-50) var(--spacing-4) var(--spacing-8));
  color: var(--color-grey-900);
}

.entry--slot-0 {
  --entry-bg: var(--color-purple-100);
  --entry-border: var(--color-purple-600);
  --entry-text: var(--color-purple-800);
}

.entry--slot-1 {
  --entry-bg: var(--color-blue-200);
  --entry-border: var(--color-blue-600);
  --entry-text: var(--color-blue-800);
}

.entry--slot-2 {
  --entry-bg: var(--color-success-200);
  --entry-border: var(--color-success-600);
  --entry-text: var(--color-success-900);
}

.entry--slot-3 {
  --entry-bg: var(--color-warning-200);
  --entry-border: var(--color-warning-800);
  --entry-text: var(--color-warning-900);
}
</style>
