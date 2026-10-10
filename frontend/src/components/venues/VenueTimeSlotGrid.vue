<script setup lang="ts">
import { computed } from "vue";
import type { Venue, VenueAvailability } from "../../lib/venuesApi";
import { MINUTES_PER_DAY, blocksForDay, toMinutes, type DayBlock } from "../../lib/availabilityCalendar";

/**
 * One horizontal day timeline per venue, so a coordinator can compare
 * availability across venues at a glance instead of opening each venue's
 * own calendar. Reuses blocksForDay()'s segmentation (the same source the
 * single-venue week view draws from) but lays it out left-to-right and
 * collapses every non-"free" kind into one "Booked" visual, since this
 * view doesn't need to distinguish why a period is unavailable.
 */

const props = defineProps<{
  venues: Venue[];
  date: string;
  availability: Map<number, VenueAvailability>;
  eventWindow: { start: string; end: string } | null;
  selectedVenueId: number | null;
}>();

const emit = defineEmits<{ select: [venueId: number, start: string, end: string] }>();

interface Segment {
  key: string;
  kind: "booked" | "available" | "closed";
  start: number;
  end: number;
  label: string;
  timeLabel: string;
}

interface Row {
  venue: Venue;
  segments: Segment[];
}

function formatMinutes(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function segmentKind(blockKind: DayBlock["kind"]): Segment["kind"] {
  if (blockKind === "free") return "available";
  if (blockKind === "closed") return "closed";
  return "booked";
}

/**
 * Adjacent blocks of the same visual kind collapse into one segment.
 * "closed" (outside operating hours) stays distinct from "booked"
 * (approved/on-hold bookings, or recorded block-outs) — a venue that
 * simply hasn't opened yet isn't "booked".
 */
function toSegments(blocks: DayBlock[]): Segment[] {
  const sorted = [...blocks].filter((b) => b.lane === 0).sort((a, b) => a.start - b.start);
  const segments: Segment[] = [];
  for (const block of sorted) {
    const kind = segmentKind(block.kind);
    const last = segments[segments.length - 1];
    if (last && last.kind === kind && last.end === block.start) {
      last.end = block.end;
    } else {
      segments.push({ key: block.key, kind, start: block.start, end: block.end, label: "", timeLabel: "" });
    }
  }
  const LABELS: Record<Segment["kind"], string> = { available: "Available", booked: "Booked", closed: "Closed" };
  for (const segment of segments) {
    segment.label = LABELS[segment.kind];
    segment.timeLabel = `${formatMinutes(segment.start)}–${formatMinutes(segment.end)}`;
  }
  return segments;
}

const rows = computed<Row[]>(() =>
  props.venues.map((venue) => {
    const data = props.availability.get(venue.id);
    return { venue, segments: data ? toSegments(blocksForDay(data, props.date)) : [] };
  }),
);

/** Visible hour range: the widest opening-to-closing span across the venues shown, clamped. */
const range = computed(() => {
  let min = 22 * 60;
  let max = 6 * 60;
  for (const data of props.availability.values()) {
    min = Math.min(min, toMinutes(data.venue.openingTime));
    max = Math.max(max, Math.min(MINUTES_PER_DAY, toMinutes(data.venue.closingTime)));
  }
  min = Math.min(min, 6 * 60);
  max = Math.max(max, 22 * 60);
  return { start: min, end: max };
});

const hours = computed(() => {
  const list: number[] = [];
  for (let h = Math.floor(range.value.start / 60); h <= Math.ceil(range.value.end / 60); h++) list.push(h);
  return list;
});

function pctX(minutes: number): string {
  const span = range.value.end - range.value.start;
  return `${((minutes - range.value.start) / span) * 100}%`;
}

function segmentStyle(segment: Segment): Record<string, string> {
  return { left: pctX(Math.max(segment.start, range.value.start)), width: pctX(Math.min(segment.end, range.value.end)) };
}

function isSelected(venueId: number, segment: Segment): boolean {
  return props.selectedVenueId === venueId && segment.kind === "available";
}

function select(venueId: number, segment: Segment): void {
  if (segment.kind !== "available") return;
  emit("select", venueId, formatMinutes(segment.start), formatMinutes(segment.end));
}
</script>

<template>
  <div class="grid" role="table" aria-label="Available time slots by venue">
    <div class="grid__legend">
      <span class="legend__item"><span class="swatch swatch--available" />Available</span>
      <span class="legend__item"><span class="swatch swatch--booked" />Booked</span>
      <span class="legend__item"><span class="swatch swatch--closed" />Closed</span>
      <span class="legend__item"><span class="swatch swatch--selected" />Selected</span>
    </div>

    <div class="grid__scroll">
      <div class="grid__inner" :style="{ '--hour-count': hours.length - 1 }">
        <div class="grid__head">
          <div class="grid__venue-col" aria-hidden="true" />
          <div class="grid__timeline">
            <span v-for="h in hours" :key="h" class="hour-label">{{ String(h).padStart(2, "0") }}:00</span>
            <div v-if="eventWindow" class="event-window" :style="{
              left: pctX(Math.max(toMinutes(eventWindow.start), range.start)),
              width: `calc(${pctX(Math.min(toMinutes(eventWindow.end), range.end))} - ${pctX(range.start)})`,
            }">
              Your event · {{ eventWindow.start }}–{{ eventWindow.end }}
            </div>
          </div>
        </div>

        <div v-for="row in rows" :key="row.venue.id" class="grid__row" role="row">
          <div class="grid__venue-col" role="rowheader">
            <p class="venue-name">{{ row.venue.name }}</p>
            <p class="venue-meta body-small muted">{{ row.venue.capacity }} capacity · {{ row.venue.location }}</p>
          </div>
          <div class="grid__timeline">
            <div class="timeline-track">
              <button v-for="segment in row.segments" :key="segment.key" type="button" class="segment"
                :class="[`segment--${segment.kind}`, { 'segment--selected': isSelected(row.venue.id, segment) }]"
                :style="segmentStyle(segment)" :disabled="segment.kind !== 'available'"
                :aria-pressed="isSelected(row.venue.id, segment)"
                :aria-label="`${row.venue.name}, ${isSelected(row.venue.id, segment) ? 'Selected' : segment.label} ${segment.timeLabel}`"
                @click="select(row.venue.id, segment)">
                <span class="segment__label">{{ isSelected(row.venue.id, segment) ? "Selected" : segment.label }}</span>
                <span class="segment__time">{{ segment.timeLabel }}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.grid {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-16);
  padding: var(--spacing-24);
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
}

.grid__legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-16);
  margin-left: auto;
}

.legend__item {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-6);
  font-size: 0.75rem;
  line-height: 1rem;
  color: var(--color-grey-600);
}

.swatch {
  display: inline-block;
  width: var(--spacing-16);
  height: var(--spacing-12);
  border-radius: var(--radius-xs);
}

.swatch--available {
  background: var(--color-purple-50, var(--color-purple-100));
  border: 1px solid var(--color-purple-300);
}

.swatch--booked {
  background: var(--color-grey-200);
  border: 1px solid var(--color-grey-300);
}

.swatch--closed {
  background: var(--color-grey-75);
}

.swatch--selected {
  background: var(--color-purple-600);
}

.grid__scroll {
  overflow-x: auto;
}

.grid__inner {
  min-width: 640px;
}

.grid__head,
.grid__row {
  display: grid;
  grid-template-columns: 220px 1fr;
  gap: var(--spacing-16);
  align-items: center;
}

.grid__row {
  padding: var(--spacing-8) 0;
  border-top: 1px solid var(--color-grey-100);
}

.grid__venue-col {
  min-width: 0;
}

.venue-name {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  color: var(--color-grey-900);
}

.venue-meta {
  margin: var(--spacing-4) 0 0;
}

.grid__timeline {
  position: relative;
  min-height: 48px;
}

.grid__head .grid__timeline {
  min-height: 24px;
  display: flex;
  justify-content: space-between;
}

.hour-label {
  font-size: 0.75rem;
  color: var(--color-grey-500);
}

.event-window {
  position: absolute;
  top: calc(-1 * var(--spacing-24));
  height: var(--spacing-20);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 var(--spacing-8);
  border-radius: var(--radius-xs);
  background: var(--color-purple-100);
  border: 1px solid var(--color-purple-300);
  color: var(--color-purple-800);
  font-size: 0.75rem;
  font-weight: 700;
  white-space: nowrap;
}

.timeline-track {
  position: relative;
  height: 48px;
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-xs);
}

.segment {
  position: absolute;
  top: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0;
  border: none;
  border-radius: var(--radius-xs);
  font-family: var(--font-family-lato);
  cursor: default;
  overflow: hidden;
  padding: 0 var(--spacing-4);
}

.segment--booked {
  background: var(--color-grey-200);
  color: var(--color-grey-600);
}

.segment--closed {
  background: var(--color-grey-75);
  color: var(--color-grey-500);
}

.segment--available {
  background: var(--color-purple-50, var(--color-purple-100));
  border: 1px solid var(--color-purple-300);
  color: var(--color-purple-800);
  cursor: pointer;
}

.segment--available:hover {
  background: var(--color-purple-100);
}

.segment--selected {
  background: var(--color-purple-600);
  color: var(--color-base-white);
}

.segment:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

.segment__label {
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
}

.segment__time {
  font-size: 0.6875rem;
  line-height: 0.875rem;
}

.body-small {
  font-size: 0.875rem;
  line-height: 1.125rem;
}

.muted {
  color: var(--color-grey-500);
}
</style>
