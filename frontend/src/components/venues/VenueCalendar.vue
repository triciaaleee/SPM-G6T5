<script setup lang="ts">
import AppButton from "../ui/AppButton.vue";
import { computed, onMounted, ref, watch } from "vue";
import { ChevronLeftIcon, ChevronRightIcon } from "@heroicons/vue/16/solid";
import CalendarEntryButton from "./CalendarEntryButton.vue";
import VenueIcon from "./VenueIcon.vue";
import { CALENDAR_STATUSES } from "../../lib/calendarStatus";
import { fetchVenueBookings, type StaffVenueOption } from "../../lib/venuesApi";
import { fetchUnavailability } from "../../lib/unavailabilityApi";
import {
  blockEntries,
  bookingEntries,
  fromKey,
  layoutLanes,
  MAX_VENUES,
  shiftAnchor,
  toKey,
  visibleRange,
  type CalendarEntry,
  type CalendarView,
} from "../../lib/venueCalendar";

/**
 * E1-5: one calendar for everything booked into the staff member's venues —
 * bookings (Requested, On Hold, Approved, Replacement Required) and block-out
 * periods, with event name, time and expected attendance. Day, week or month.
 * Day and week draw at most four venues at once (a column per venue / side-by-side
 * lanes, and only four colours); month collapses entries into chips, so it draws
 * every venue the page's filter picks. Up to four venues each get their own
 * colour (the legend).
 * Only the range on screen is fetched, so the date-range criterion holds.
 */

const VIEWS: { key: CalendarView; label: string }[] = [
  { key: "day", label: "Day" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
];
const STORAGE_KEY = "venue-calendar";
const HOUR_PX = 48;
const MONTH_CHIPS = 3;

/**
 * The venues the page's filter picked; `total` is how many that is. Day and week draw only the first
 * `maxVenues` (four by default); month draws all of them.
 */
const props = defineProps<{
  venues: StaffVenueOption[];
  day?: string;
  total?: number;
  from?: string;
  to?: string;
  prompt?: string;
  maxVenues?: number;
}>();
/** The day on screen (or last clicked); the page uses it to pick which day its lists show. */
const emit = defineEmits<{ "day-change": [day: string]; "show-requests": [] }>();

const view = ref<CalendarView>("week");

const venues = computed(() => (view.value === "month" ? props.venues : props.venues.slice(0, props.maxVenues ?? MAX_VENUES)));

const selectedIds = computed(() => venues.value.map((v) => v.id));
/** Venue colours only mean something while there are few enough venues to tell apart. */
const coloured = computed(() => selectedIds.value.length <= MAX_VENUES);

const anchor = ref(props.day ?? toKey(new Date()));
const today = toKey(new Date());

const bookingEntriesByVenue = ref<Record<number, CalendarEntry[]>>({});
const blockEntriesByVenue = ref<Record<number, CalendarEntry[]>>({});
const loading = ref(false);
const loadError = ref<string | null>(null);
const picked = ref<CalendarEntry | null>(null);

const range = computed(() => visibleRange(view.value, anchor.value));
const multi = computed(() => selectedIds.value.length > 1);

const venueName = (id: number) => venues.value.find((v) => v.id === id)?.name ?? "Venue";
/** Each shown venue's colour: its position among the venues on screen. */
const slotOf = (id: number) => (coloured.value ? Math.max(0, selectedIds.value.indexOf(id)) : 0);

// ---- Loading -------------------------------------------------------------

let loadSeq = 0;

async function load(): Promise<void> {
  if (selectedIds.value.length === 0) return;
  const seq = ++loadSeq;
  const { from, to } = range.value;
  loading.value = true;
  loadError.value = null;
  const bookings: Record<number, CalendarEntry[]> = {};
  const blocks: Record<number, CalendarEntry[]> = {};
  const failed: string[] = [];
  await Promise.all(
    selectedIds.value.map(async (id) => {
      const [b, p] = await Promise.allSettled([fetchVenueBookings(id, from, to), fetchUnavailability(id, from, to)]);
      bookings[id] = b.status === "fulfilled" ? bookingEntries(id, b.value) : [];
      blocks[id] = p.status === "fulfilled" ? blockEntries(p.value, from, to) : [];
      if (b.status === "rejected" || p.status === "rejected") failed.push(venueName(id));
    }),
  );
  if (seq !== loadSeq) return;
  bookingEntriesByVenue.value = bookings;
  blockEntriesByVenue.value = blocks;
  if (failed.length > 0) loadError.value = `We couldn't load everything for ${failed.join(", ")}. Please try again.`;
  loading.value = false;
}

watch([selectedIds, view, anchor], load, { immediate: true });
watch(anchor, (day) => emit("day-change", day));
watch(() => props.day, (day) => {
  if (day && day !== anchor.value) anchor.value = day;
});

watch(view, () => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ view: view.value }));
  } catch {
    // Storage unavailable (private window etc.); the calendar works without it.
  }
});

onMounted(() => {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as { view?: CalendarView };
    if (VIEWS.some((v) => v.key === stored.view)) view.value = stored.view!;
  } catch {
    // Nothing stored, or storage unavailable: keep the default view.
  }
});

// ---- Layout --------------------------------------------------------------

/** Everything loaded for the venues on screen, narrowed to the page's date range when one is set. */
const allEntries = computed(() =>
  selectedIds.value
    .flatMap((id) => [...(bookingEntriesByVenue.value[id] ?? []), ...(blockEntriesByVenue.value[id] ?? [])])
    .filter((e) => (!props.from || e.date >= props.from) && (!props.to || e.date <= props.to)),
);

/** The hours drawn: 08:00-18:00 at least, stretched to fit anything earlier or later. */
const hours = computed(() => {
  let first = 8;
  let last = 18;
  for (const e of allEntries.value) {
    if (e.startMin === null || e.endMin === null) continue;
    first = Math.min(first, Math.floor(e.startMin / 60));
    last = Math.max(last, Math.ceil(e.endMin / 60));
  }
  return Array.from({ length: last - first }, (_, i) => first + i);
});
const gridStartMin = computed(() => hours.value[0] * 60);

interface Column {
  key: string;
  title: string;
  subtitle: string | null;
  isToday: boolean;
  entries: CalendarEntry[];
}

/** Day view: a column per venue. Week view: a column per day. */
const columns = computed<Column[]>(() => {
  if (view.value === "day") {
    const day = anchor.value;
    return selectedIds.value.map((id) => ({
      key: String(id),
      title: venueName(id),
      subtitle: null,
      isToday: false,
      entries: allEntries.value.filter((e) => e.venueId === id && e.date === day),
    }));
  }
  return range.value.days.map((day) => ({
    key: day,
    title: fromKey(day).toLocaleDateString("en-GB", { weekday: "short" }),
    subtitle: fromKey(day).toLocaleDateString("en-GB", { day: "numeric", month: "short" }),
    isToday: day === today,
    entries: allEntries.value.filter((e) => e.date === day),
  }));
});

function timedLayout(entries: CalendarEntry[]): { entry: CalendarEntry; style: Record<string, string> }[] {
  const timed = entries.filter((e) => e.startMin !== null && e.endMin !== null);
  const lanes = layoutLanes(timed.map((e) => ({ startMin: e.startMin!, endMin: e.endMin! })));
  return timed.map((entry, i) => {
    const { lane, lanes: count } = lanes[i];
    return {
      entry,
      style: {
        top: `${((entry.startMin! - gridStartMin.value) / 60) * HOUR_PX}px`,
        height: `${Math.max(((entry.endMin! - entry.startMin!) / 60) * HOUR_PX, 20)}px`,
        left: `${(lane / count) * 100}%`,
        width: `${100 / count}%`,
      },
    };
  });
}

const allDayOf = (col: Column) => col.entries.filter((e) => e.startMin === null || e.endMin === null);

const monthDays = computed(() =>
  range.value.days.map((day) => {
    const entries = allEntries.value
      .filter((e) => e.date === day)
      .sort((a, b) => (a.startMin ?? -1) - (b.startMin ?? -1) || a.venueId - b.venueId);
    return {
      day,
      entries,
      inMonth: fromKey(day).getMonth() === fromKey(anchor.value).getMonth(),
      isToday: day === today,
    };
  }),
);

const title = computed(() => {
  const date = fromKey(anchor.value);
  if (view.value === "month") return date.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  if (view.value === "day") return date.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const { from, to } = range.value;
  const a = fromKey(from);
  const b = fromKey(to);
  const sameMonth = a.getMonth() === b.getMonth();
  return `${a.toLocaleDateString("en-GB", { day: "numeric", ...(sameMonth ? {} : { month: "short" }) })} – ${b.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`;
});

const isEmpty = computed(() => !loading.value && allEntries.value.length === 0);

function pick(entry: CalendarEntry): void {
  picked.value = entry;
  emit("day-change", entry.date);
}

function openDay(day: string): void {
  anchor.value = day;
  view.value = "day";
}

const weekdayHeads = computed(() => range.value.days.slice(0, 7).map((d) => fromKey(d).toLocaleDateString("en-GB", { weekday: "short" })));

function pickedWhen(entry: CalendarEntry): string {
  const day = fromKey(entry.date).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  return entry.allDay || !entry.startTime ? `${day}, all day` : `${day}, ${entry.startTime}–${entry.endTime}`;
}

/** Re-fetch the range on screen, e.g. after a block-out is added or removed. */
defineExpose({ refresh: load });

function nudge(direction: 1 | -1): void {
  anchor.value = shiftAnchor(view.value, anchor.value, direction);
}
</script>

<template>
  <!--
    Column mapping — Venue calendar (top of the Venue schedule page, which places it in col 1-12 / 1-6 / 1-4)
    Desktop: toolbar (prev / today / next, range title; venue picker and view switch right); legend; calendar card.
      Nested grid: day/week use a local grid of one 56px time gutter plus N equal columns (N = venues or 7 days);
      month uses a local 7-col grid.
    Tablet and mobile: blocks stack; the day/week grid scrolls sideways inside the card rather than squeezing columns.
  -->
  <div class="vc">
    <div class="toolbar">
      <div class="toolbar__nav">
        <button type="button" class="icon-btn" aria-label="Previous" @click="nudge(-1)">
          <ChevronLeftIcon class="icon-btn__icon" aria-hidden="true" />
        </button>
        <AppButton variant="outline" type="button" @click="anchor = today">Today</AppButton>
        <button type="button" class="icon-btn" aria-label="Next" @click="nudge(1)">
          <ChevronRightIcon class="icon-btn__icon" aria-hidden="true" />
        </button>
        <h2 class="range-title" aria-live="polite">{{ title }}</h2>
      </div>

      <div class="toolbar__controls">
        <p v-if="total !== undefined && total > venues.length" class="cap-note">
          Showing {{ venues.length }} of {{ total }} venues in {{ view === "day" ? "Day" : "Week" }} view. Month shows all of them.
        </p>

        <div class="segmented" role="group" aria-label="Calendar view">
          <button v-for="v in VIEWS" :key="v.key" type="button" class="segmented__btn"
            :class="{ 'segmented__btn--active': view === v.key }" :aria-pressed="view === v.key" @click="view = v.key">
            {{ v.label }}
          </button>
        </div>
      </div>
    </div>

    <div class="legend" role="group" aria-label="Key">
      <ul v-if="coloured" class="legend__group" aria-label="Venue">
        <li class="legend__heading" aria-hidden="true">Venue</li>
        <li v-for="id in selectedIds" :key="id" class="legend__item">
          <span class="swatch" :class="`swatch--slot-${slotOf(id)}`" />{{ venueName(id) }}
        </li>
      </ul>
      <span v-if="coloured" class="legend__divider" aria-hidden="true" />
      <ul class="legend__group" aria-label="Status">
        <li class="legend__heading" aria-hidden="true">Status</li>
        <li v-for="status in CALENDAR_STATUSES" :key="status.key" class="legend__item">
          <span class="key" :class="`key--${status.key}`"><VenueIcon :name="status.icon" :size="12" /></span>{{ status.label }}
        </li>
      </ul>
    </div>

    <p v-if="loadError" class="body-small error-text" role="alert">{{ loadError }}</p>

    <section class="calendar" aria-label="Calendar" :aria-busy="loading">
      <!-- Day and week -->
      <div v-if="view !== 'month'" class="scroller">
        <div class="timegrid" :style="{ '--cols': columns.length }">
          <div class="timegrid__head">
            <span />
            <div v-for="col in columns" :key="col.key" class="col-head" :class="{ 'col-head--today': col.isToday }">
              <span class="col-head__title">{{ col.title }}</span>
              <span v-if="col.subtitle" class="col-head__sub">{{ col.subtitle }}</span>
            </div>
          </div>

          <div class="timegrid__allday">
            <span class="gutter-label">All day</span>
            <div v-for="col in columns" :key="col.key" class="allday-cell">
              <CalendarEntryButton v-for="entry in allDayOf(col)" :key="entry.id" :entry="entry"
                :venue-name="venueName(entry.venueId)" :color-slot="slotOf(entry.venueId)" :show-venue="multi" compact
                @select="pick(entry)" />
            </div>
          </div>

          <div class="timegrid__body" :style="{ '--hour': `${HOUR_PX}px`, height: `${hours.length * HOUR_PX}px` }">
            <div class="gutter">
              <span v-for="h in hours" :key="h" class="gutter__hour">{{ String(h).padStart(2, "0") }}:00</span>
            </div>
            <div v-for="col in columns" :key="col.key" class="track" :class="{ 'track--today': col.isToday }">
              <div v-for="item in timedLayout(col.entries)" :key="item.entry.id" class="track__item" :style="item.style">
                <CalendarEntryButton :entry="item.entry" :venue-name="venueName(item.entry.venueId)"
                  :color-slot="slotOf(item.entry.venueId)" :show-venue="multi" @select="pick(item.entry)" />
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Month -->
      <div v-else class="month">
        <div v-for="name in weekdayHeads" :key="name" class="month__weekday">{{ name }}</div>
        <div v-for="cell in monthDays" :key="cell.day" class="month__cell"
          :class="{ 'month__cell--out': !cell.inMonth, 'month__cell--today': cell.isToday }" @click="openDay(cell.day)">
          <button type="button" class="month__date" :aria-label="`Open ${cell.day}`" @click.stop="openDay(cell.day)">
            {{ fromKey(cell.day).getDate() }}
          </button>
          <CalendarEntryButton v-for="entry in cell.entries.slice(0, MONTH_CHIPS)" :key="entry.id" :entry="entry"
            :venue-name="venueName(entry.venueId)" :color-slot="slotOf(entry.venueId)" :show-venue="multi" compact
            @select="pick(entry)" />
          <button v-if="cell.entries.length > MONTH_CHIPS" type="button" class="month__more"
            @click.stop="openDay(cell.day)">
            +{{ cell.entries.length - MONTH_CHIPS }} more
          </button>
        </div>
      </div>

      <p v-if="prompt" class="empty-note body-default muted">{{ prompt }}</p>
      <p v-else-if="isEmpty" class="empty-note body-default muted">Nothing booked or blocked in this range.</p>
    </section>

    <!-- Details of the clicked entry. -->
    <div v-if="picked" class="overlay" @click.self="picked = null">
      <aside class="panel" role="dialog" aria-modal="true" aria-labelledby="entry-title" @keydown.esc="picked = null">
        <header class="panel__header">
          <h2 id="entry-title" class="panel__title">{{ picked.title }}</h2>
          <button type="button" class="icon-btn" aria-label="Close" @click="picked = null">×</button>
        </header>
        <dl class="panel__list">
          <dt>Venue</dt>
          <dd>
            <span class="swatch" :class="`swatch--slot-${slotOf(picked.venueId)}`" />{{ venueName(picked.venueId) }}
          </dd>
          <dt>When</dt>
          <dd>{{ pickedWhen(picked) }}</dd>
          <template v-if="picked.kind === 'booking'">
            <dt>Status</dt>
            <dd>{{ picked.status }}</dd>
            <dt>Expected attendance</dt>
            <dd>{{ picked.attendance ?? "Not specified" }}</dd>
          </template>
          <template v-else>
            <dt>Type</dt>
            <dd>Venue unavailable</dd>
          </template>
        </dl>
        <div class="panel__actions">
          <AppButton v-if="picked.kind === 'booking' && picked.status === 'Requested'" variant="primary" type="button"
            @click="picked = null; emit('show-requests')">
            Review in Requests
          </AppButton>
          <AppButton variant="outline" type="button" @click="picked = null">Close</AppButton>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.vc {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-16);
  min-width: 0;
}

.body-default {
  margin: 0;
  font-size: 1rem;
  line-height: 1.25rem;
}

.body-small {
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.125rem;
}

.muted {
  color: var(--color-grey-500);
}

.error-text {
  color: var(--color-error-600);
}

/* Toolbar */
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-16);
}

.toolbar__nav,
.toolbar__controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--spacing-12);
}

.range-title {
  margin: 0 0 0 var(--spacing-8);
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-xs);
  background: var(--color-base-white);
  color: var(--color-grey-700);
  font-size: 1.25rem;
  cursor: pointer;
}

.icon-btn:hover {
  background: var(--color-grey-75);
}

.icon-btn:focus-visible,
.segmented__btn:focus-visible,
.month__date:focus-visible,
.month__more:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

.icon-btn__icon {
  width: var(--spacing-16);
  height: var(--spacing-16);
}

.cap-note {
  margin: 0;
  font-size: 0.75rem;
  color: var(--color-grey-500);
}

/* View switch */
.segmented {
  display: inline-flex;
  overflow: hidden;
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-xs);
}

.segmented__btn {
  height: 38px;
  padding: 0 var(--spacing-16);
  border: none;
  background: var(--color-base-white);
  color: var(--color-grey-700);
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  font-weight: 700;
  cursor: pointer;
}

.segmented__btn + .segmented__btn {
  border-left: 1px solid var(--color-grey-200);
}

.segmented__btn--active {
  background: var(--color-purple-100);
  color: var(--color-purple-800);
}

/* Legend and venue swatches */
/* Two labelled groups in one white bar: the venue's left-edge colour, then the status swatches. */
.legend {
  box-sizing: border-box;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--spacing-12) var(--spacing-32);
  padding: var(--spacing-12) var(--spacing-24);
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-900);
}

.legend__group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--spacing-8) var(--spacing-20);
  margin: 0;
  padding: 0;
  list-style: none;
}

.legend__heading {
  font-weight: 700;
}

.legend__item {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-8);
}

.legend__divider {
  width: 1px;
  height: 28px;
  background: var(--color-grey-200);
}

/* A venue's identity: the 4px edge of its blocks. */
.swatch {
  display: inline-block;
  flex-shrink: 0;
  width: var(--spacing-4);
  height: var(--spacing-20);
  border-radius: var(--spacing-2);
}

.panel__list .swatch {
  margin-right: var(--spacing-8);
  vertical-align: middle;
}

.swatch--slot-0 {
  background: var(--color-purple-600);
}

.swatch--slot-1 {
  background: var(--color-blue-600);
}

.swatch--slot-2 {
  background: var(--color-venue-magenta);
}

.swatch--slot-3 {
  background: var(--color-venue-slate);
}

/* A status: the same fill, border and text as its calendar block (Style.md 3.5, schedule-block-*). */
.key {
  box-sizing: border-box;
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: var(--spacing-24);
  height: var(--spacing-20);
  border: 1px solid var(--key-border);
  border-radius: var(--radius-xs);
  background: var(--key-bg);
  color: var(--key-text);
}

.key--approved {
  --key-bg: var(--color-success-200);
  --key-border: var(--color-success-600);
  --key-text: var(--color-success-800);
}

.key--hold {
  --key-bg: var(--color-warning-100);
  --key-border: var(--color-warning-400);
  --key-text: var(--color-warning-900);
}

.key--requested {
  --key-bg: var(--color-base-white);
  --key-border: var(--color-grey-600);
  --key-text: var(--color-grey-700);
  border-style: dashed;
}

.key--replace {
  --key-bg: var(--color-error-200);
  --key-border: var(--color-error-600);
  --key-text: var(--color-error-800);
}

/* Unavailable: a flat grey, no stripes. */
.key--block {
  --key-bg: var(--color-grey-100);
  --key-border: var(--color-grey-300);
  --key-text: var(--color-grey-900);
}

/* Calendar card */
.calendar {
  position: relative;
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-sm);
  background: var(--color-base-white);
}

.scroller {
  overflow-x: auto;
}

.timegrid {
  --gutter: 56px;
  min-width: calc(var(--gutter) + var(--cols) * 120px);
}

.timegrid__head,
.timegrid__allday,
.timegrid__body {
  display: grid;
  grid-template-columns: var(--gutter) repeat(var(--cols), minmax(0, 1fr));
}

.timegrid__head {
  border-bottom: 1px solid var(--color-grey-100);
}

.col-head {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: var(--spacing-8) var(--spacing-4);
  border-left: 1px solid var(--color-grey-100);
}

.col-head--today {
  background: var(--color-purple-50);
}

.col-head__title {
  font-size: 0.875rem;
  font-weight: 700;
  color: var(--color-grey-900);
}

.col-head__sub {
  font-size: 0.75rem;
  color: var(--color-grey-500);
}

.timegrid__allday {
  border-bottom: 1px solid var(--color-grey-100);
}

.gutter-label {
  padding: var(--spacing-8) var(--spacing-4);
  font-size: 0.75rem;
  color: var(--color-grey-500);
  text-align: right;
}

.allday-cell {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-2);
  min-height: 28px;
  padding: var(--spacing-4);
  border-left: 1px solid var(--color-grey-100);
}

.gutter {
  display: flex;
  flex-direction: column;
}

.gutter__hour {
  height: var(--hour);
  padding-right: var(--spacing-8);
  font-size: 0.75rem;
  color: var(--color-grey-500);
  text-align: right;
  transform: translateY(-0.5em);
}

.track {
  position: relative;
  border-left: 1px solid var(--color-grey-100);
  background-image: linear-gradient(var(--color-grey-100) 1px, transparent 1px);
  background-size: 100% var(--hour);
}

.track--today {
  background-color: var(--color-purple-50);
}

.track__item {
  position: absolute;
  padding: 0 1px;
}

/* Month */
.month {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
}

.month__weekday {
  padding: var(--spacing-8);
  border-bottom: 1px solid var(--color-grey-100);
  font-size: 0.75rem;
  font-weight: 700;
  color: var(--color-grey-500);
  text-align: center;
}

.month__cell {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-2);
  min-height: 112px;
  min-width: 0;
  padding: var(--spacing-4);
  border-right: 1px solid var(--color-grey-100);
  border-bottom: 1px solid var(--color-grey-100);
  cursor: pointer;
}

.month__cell:nth-child(7n + 14) {
  border-right: none;
}

.month__cell--out {
  background: var(--color-grey-25);
}

.month__cell--out .month__date {
  color: var(--color-grey-400);
}

.month__cell--today .month__date {
  background: var(--color-purple-600);
  color: var(--color-base-white);
}

.month__date {
  align-self: flex-start;
  min-width: var(--spacing-24);
  height: var(--spacing-24);
  padding: 0 var(--spacing-4);
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-grey-900);
  font-family: var(--font-family-lato);
  font-size: 0.75rem;
  font-weight: 700;
  cursor: pointer;
}

.month__more {
  align-self: flex-start;
  padding: 0 var(--spacing-4);
  border: none;
  background: transparent;
  color: var(--color-purple-600);
  font-family: var(--font-family-lato);
  font-size: 0.75rem;
  font-weight: 700;
  cursor: pointer;
}

.empty-note {
  padding: var(--spacing-24);
  text-align: center;
}

@media (max-width: 640px) {
  .month__cell {
    min-height: 72px;
  }
}

/* Details panel */
.overlay {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  justify-content: flex-end;
  background: var(--color-grey-alpha-40-dark);
}

.panel {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-16);
  width: 400px;
  max-width: 100%;
  height: 100%;
  padding: var(--spacing-24);
  background: var(--color-base-white);
  box-shadow: var(--shadow-popover);
}

.panel__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--spacing-16);
}

.panel__title {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
}

.panel__list {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: var(--spacing-8) var(--spacing-16);
  margin: 0;
  font-size: 0.875rem;
}

.panel__list dt {
  font-weight: 700;
  color: var(--color-grey-600);
}

.panel__list dd {
  margin: 0;
  color: var(--color-grey-900);
}

.panel__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-12);
  margin-top: auto;
}
</style>
