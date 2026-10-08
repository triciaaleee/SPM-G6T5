<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ChevronLeftIcon, ChevronRightIcon } from "@heroicons/vue/16/solid";
import VenuePicker from "../components/venues/VenuePicker.vue";
import {
  emptyVenueFilters,
  fetchVenueAvailability,
  searchVenues,
  type AvailabilityTarget,
  type Venue,
  type VenueAvailability,
} from "../lib/venuesApi";
import {
  MINUTES_PER_DAY,
  blocksForDay,
  fromKey,
  isBlockedAllDay,
  isDateKey,
  isInTarget,
  isSameMonth,
  monthGridDays,
  shiftFocus,
  toKey,
  toMinutes,
  visibleRange,
  weekDays,
  type CalendarView,
  type DayBlock,
} from "../lib/availabilityCalendar";

/**
 * Venue availability calendar (coordinators). Pick a venue to see when it
 * could realistically be requested:
 *
 * - Approved bookings (solid purple) and On Hold bookings (dashed orange)
 *   are unavailable, each drawn over its padded window — setup before,
 *   turnaround after — with the advertised event time shaded darker.
 * - Requested, Rejected and Expired bookings never appear: the API only
 *   returns bookings that block the venue.
 * - Recorded block-outs (stripes) and hours outside the venue's operating
 *   hours (plain grey) are unavailable too, each with its own look.
 * - With a target date and time range, the free slots inside it are
 *   highlighted green.
 *
 * Month view gives the overview; week view shows each day hour by hour.
 * The venue, view, date and target live in the URL so a refresh or a
 * shared link reopens the same calendar.
 */

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** Items shown in a month cell before "+N more". */
const MONTH_CELL_LIMIT = 3;

const route = useRoute();
const router = useRouter();

function queryParam(name: string): string | null {
  const value = route.query[name];
  return typeof value === "string" ? value : null;
}

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const today = toKey(new Date());

function timeParam(name: string): string {
  const value = queryParam(name);
  return value && TIME_PATTERN.test(value) ? value : "";
}

const venues = ref<Venue[]>([]);
const venueId = ref<number | null>(null);
const view = ref<CalendarView>(queryParam("view") === "week" ? "week" : "month");
const focus = ref(isDateKey(queryParam("date")) ? queryParam("date")! : today);

/** The target form as typed; `appliedTarget` is what the calendar is showing. */
const draft = reactive({
  fromDate: isDateKey(queryParam("tFrom")) ? queryParam("tFrom")! : "",
  toDate: isDateKey(queryParam("tTo")) ? queryParam("tTo")! : "",
  startTime: timeParam("tStart"),
  endTime: timeParam("tEnd"),
});
const targetErrors = ref<Record<string, string>>({});
const appliedTarget = ref<AvailabilityTarget | null>(draft.fromDate ? toTarget() : null);

const data = ref<VenueAvailability | null>(null);
const loadingVenues = ref(true);
const loading = ref(false);
const venuesError = ref<string | null>(null);
const loadError = ref<string | null>(null);

/** Without times, free slots are searched across the venue's whole operating day on each target date. */
function toTarget(): AvailabilityTarget {
  return {
    fromDate: draft.fromDate,
    toDate: draft.toDate || draft.fromDate,
    startTime: draft.startTime || null,
    endTime: draft.endTime || null,
  };
}

/** Mirrors the API's target checks so a bad target is flagged inline instead of 400ing. */
function validateTarget(): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!draft.fromDate) errors.fromDate = "Pick a start date.";
  if (draft.toDate && draft.fromDate && draft.toDate < draft.fromDate) {
    errors.toDate = "The end date must not be before the start date.";
  }
  if (draft.startTime && draft.endTime && draft.endTime <= draft.startTime) {
    errors.endTime = "The end time must be after the start time.";
  }
  return errors;
}

function applyTarget(): void {
  targetErrors.value = validateTarget();
  if (Object.keys(targetErrors.value).length > 0) return;
  appliedTarget.value = toTarget();
  focus.value = appliedTarget.value.fromDate;
}

function clearTarget(): void {
  draft.fromDate = "";
  draft.toDate = "";
  draft.startTime = "";
  draft.endTime = "";
  targetErrors.value = {};
  appliedTarget.value = null;
}

const range = computed(() => visibleRange(view.value, focus.value));

let controller: AbortController | null = null;

async function load(): Promise<void> {
  if (venueId.value === null) return;
  controller?.abort();
  const current = new AbortController();
  controller = current;
  loading.value = true;
  loadError.value = null;
  try {
    data.value = await fetchVenueAvailability(
      venueId.value,
      range.value.from,
      range.value.to,
      appliedTarget.value,
      current.signal,
    );
  } catch (err) {
    if (current.signal.aborted) return;
    data.value = null;
    loadError.value = err instanceof Error && err.message ? err.message : "We couldn't load this venue's availability.";
  } finally {
    if (controller === current) loading.value = false;
  }
}

watch([venueId, () => range.value.from, () => range.value.to, appliedTarget], load);
onBeforeUnmount(() => controller?.abort());

// replace, not push: moving around the calendar shouldn't flood the history.
watch([venueId, view, focus, appliedTarget], ([venue, currentView, date, target]) => {
  if (venue === null) return;
  const query: Record<string, string> = { venue: String(venue), view: currentView, date };
  if (target) {
    query.tFrom = target.fromDate;
    query.tTo = target.toDate;
    if (target.startTime) query.tStart = target.startTime;
    if (target.endTime) query.tEnd = target.endTime;
  }
  void router.replace({ query });
});

onMounted(async () => {
  try {
    const result = await searchVenues(emptyVenueFilters());
    venues.value = [...result.venues].sort((a, b) => a.name.localeCompare(b.name));
    const queryVenue = Number(queryParam("venue"));
    venueId.value = venues.value.find((v) => v.id === queryVenue)?.id ?? venues.value[0]?.id ?? null;
  } catch {
    venuesError.value = "We couldn't load the venue list. Please refresh the page.";
  } finally {
    loadingVenues.value = false;
  }
});

// ---- Navigation -----------------------------------------------------------

function step(direction: -1 | 1): void {
  focus.value = shiftFocus(view.value, focus.value, direction);
}

function goToday(): void {
  focus.value = today;
}

function openWeek(date: string): void {
  focus.value = date;
  view.value = "week";
}

const periodLabel = computed(() => {
  const focusDate = fromKey(focus.value);
  if (view.value === "month") return focusDate.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  const days = weekDays(focus.value);
  const first = fromKey(days[0]);
  const last = fromKey(days[6]);
  const sameMonth = first.getMonth() === last.getMonth();
  const start = first.toLocaleDateString("en-GB", sameMonth ? { day: "numeric" } : { day: "numeric", month: "short" });
  return `${start} – ${last.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`;
});

// ---- Formatting -----------------------------------------------------------

function formatRange(start: string, end: string): string {
  return `${start}–${end}`;
}

function formatMinutes(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function formatDay(key: string): string {
  return fromKey(key).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

function formatLongDay(key: string): string {
  return fromKey(key).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
}

function formatHoldExpiry(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  return `${date.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ${date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
}

function formatBuffer(minutes: number): string {
  if (minutes === 0) return "none";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? `${h} h` : "", m ? `${m} min` : ""].filter(Boolean).join(" ");
}

/** Full description of a block, used for its tooltip and screen-reader label. */
function describe(block: DayBlock): string {
  const window = `${formatMinutes(block.start)}–${formatMinutes(block.end)}`;
  switch (block.kind) {
    case "approved":
    case "on-hold": {
      const b = block.booking!;
      const status = b.status === "On Hold" ? `On Hold${b.holdExpiresAt ? ` until ${formatHoldExpiry(b.holdExpiresAt)}` : ""}` : "Approved";
      const advertised = b.startTime && b.endTime ? `event ${formatRange(b.startTime, b.endTime)}, ` : "no event times recorded, ";
      return `${block.label} — ${status}. Unavailable ${window} (${advertised}including setup and turnaround).`;
    }
    case "blocked":
      return `Unavailable ${block.period!.allDay ? "all day" : window}: ${block.label}.`;
    case "closed":
      return `Closed ${window} (outside operating hours).`;
    case "free":
      return `Available ${window}. An event fits ${formatRange(block.slot!.eventStart, block.slot!.eventEnd)} after setup and turnaround.`;
  }
}

/** The short time shown on a block in the calendar. */
function blockTime(block: DayBlock): string {
  if (block.kind === "blocked" && block.period!.allDay) return "All day";
  return `${formatMinutes(block.start)}–${formatMinutes(block.end)}`;
}

// ---- Month view -----------------------------------------------------------

const KIND_ORDER: Record<DayBlock["kind"], number> = { blocked: 0, approved: 1, "on-hold": 1, free: 2, closed: 3 };

const monthCells = computed(() => {
  const current = data.value;
  return monthGridDays(focus.value).map((date) => {
    const items = current
      ? blocksForDay(current, date)
          .filter((b) => b.kind !== "closed")
          .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.start - b.start)
      : [];
    return {
      date,
      day: fromKey(date).getDate(),
      inMonth: isSameMonth(date, focus.value),
      isToday: date === today,
      blockedAllDay: current ? isBlockedAllDay(current, date) : false,
      inTarget: current ? isInTarget(current, date) : false,
      hasFree: items.some((b) => b.kind === "free"),
      shown: items.slice(0, MONTH_CELL_LIMIT),
      more: Math.max(0, items.length - MONTH_CELL_LIMIT),
    };
  });
});

function cellLabel(cell: (typeof monthCells.value)[number]): string {
  const parts = [formatLongDay(cell.date)];
  if (cell.blockedAllDay) parts.push("unavailable all day");
  const bookings = cell.shown.filter((b) => b.kind === "approved" || b.kind === "on-hold").length;
  if (bookings > 0) parts.push(`${bookings} booking${bookings === 1 ? "" : "s"}`);
  if (cell.hasFree) parts.push("has free slots in your target");
  return `${parts.join(", ")}. Open week view.`;
}

// ---- Week view ------------------------------------------------------------

const weekColumns = computed(() => {
  const current = data.value;
  return weekDays(focus.value).map((date) => ({
    date,
    isToday: date === today,
    inTarget: current ? isInTarget(current, date) : false,
    blocks: current ? blocksForDay(current, date) : [],
  }));
});

function pct(minutes: number): string {
  return `${(minutes / MINUTES_PER_DAY) * 100}%`;
}

function blockStyle(block: DayBlock): Record<string, string> {
  const style: Record<string, string> = { top: pct(block.start), height: pct(block.end - block.start) };
  if (block.kind === "approved" || block.kind === "on-hold") {
    style.left = `${(block.lane / block.lanes) * 100}%`;
    style.width = `${100 / block.lanes}%`;
  }
  return style;
}

/** The advertised event time inside a booking's padded window. */
function coreStyle(block: DayBlock): Record<string, string> {
  const span = block.end - block.start;
  const core = block.core!;
  return {
    top: `${((core.start - block.start) / span) * 100}%`,
    height: `${((core.end - core.start) / span) * 100}%`,
  };
}

const weekScroller = ref<HTMLElement | null>(null);

/** Opens the week view scrolled to an hour before opening, so the working day is in sight. */
async function scrollToOpening(): Promise<void> {
  await nextTick();
  const scroller = weekScroller.value;
  if (!scroller || !data.value) return;
  const hour = Math.max(0, Math.floor(toMinutes(data.value.venue.openingTime) / 60) - 1);
  scroller.scrollTop = (scroller.scrollHeight / 24) * hour;
}

watch([view, () => data.value?.venue.id], ([currentView]) => {
  if (currentView === "week") void scrollToOpening();
});

// ---- Target summary -------------------------------------------------------

const visibleFreeSlots = computed(() => data.value?.freeSlots ?? []);

/** Whether any of the target falls inside the dates on screen. */
const targetVisible = computed(() => {
  const target = data.value?.target;
  return Boolean(target && target.fromDate <= range.value.to && target.toDate >= range.value.from);
});

function jumpToTarget(): void {
  if (appliedTarget.value) focus.value = appliedTarget.value.fromDate;
}

const targetSummary = computed(() => {
  const t = appliedTarget.value;
  if (!t) return "";
  const dates = t.toDate !== t.fromDate ? `${formatDay(t.fromDate)} – ${formatDay(t.toDate)}` : formatDay(t.fromDate);
  const times = t.startTime || t.endTime ? `, ${t.startTime ?? "opening"}–${t.endTime ?? "closing"}` : ", any time";
  return `${dates}${times}`;
});

/** The "To" date can't be before "From". */
const minToDate = computed(() => draft.fromDate || undefined);
</script>

<template>
  <!--
    Column mapping — Venue Availability
    Desktop (12-col, grid-desktop-margin 80px): header col 1-12. Controls card col 1-12, with a nested
      12-col grid: venue picker col 1-4, target fieldset col 5-12 (its own nested 8-col grid: from date,
      to date, start time, end time span 2 each); actions col 1-12 below, right-aligned. Venue summary +
      legend col 1-12.
      Calendar toolbar col 1-12. Calendar col 1-12 (the 7-day calendar grid is the calendar's own day
      grid, not a layout grid — same as CalendarPicker).
    Tablet (6-col, grid-tablet-margin 32px): everything col 1-6. Controls grid 6-col: picker span 6,
      target fieldset span 6 (nested 6-col: dates and times span 3 each), actions span 6 right-aligned.
    Mobile (4-col, grid-mobile-margin 6px): everything col 1-4. Controls grid 4-col: picker span 4,
      fieldset span 4 (nested 4-col: dates and times span 2 each), actions span 4 right-aligned. Week view scrolls
      sideways inside its own card so the page never does.
  -->
  <div class="page">
    <header class="page-header">
      <h1 class="h2">Venue availability</h1>
      <p class="subheading">See when a venue is free before you request it.</p>
    </header>

    <p v-if="venuesError" class="body-default error-text full-row">{{ venuesError }}</p>
    <p v-else-if="loadingVenues" class="body-default muted full-row">Loading venues…</p>
    <div v-else-if="venues.length === 0" class="empty-state full-row">
      <p class="empty-state__title">No venues yet</p>
      <p class="body-default muted">There are no active venues to show availability for.</p>
    </div>

    <template v-else>
      <section class="controls full-row" aria-label="Venue and target">
        <div class="controls__venue">
          <label for="venue-picker" class="field-label">Venue</label>
          <VenuePicker v-model="venueId" input-id="venue-picker" :venues="venues" />
        </div>

        <form id="target-form" class="target" novalidate @submit.prevent="applyTarget">
          <fieldset class="target__fields" aria-label="Target dates and times">
            <div class="target__field">
              <label for="target-from" class="field-label">From</label>
              <input id="target-from" v-model="draft.fromDate" type="date" class="input"
                :class="{ 'input--error': targetErrors.fromDate }" :aria-invalid="Boolean(targetErrors.fromDate)"
                aria-describedby="target-from-error" />
              <p v-if="targetErrors.fromDate" id="target-from-error" class="field-error">{{ targetErrors.fromDate }}</p>
            </div>
            <div class="target__field">
              <label for="target-to" class="field-label">To</label>
              <input id="target-to" v-model="draft.toDate" type="date" class="input" :min="minToDate"
                :class="{ 'input--error': targetErrors.toDate }" :aria-invalid="Boolean(targetErrors.toDate)"
                aria-describedby="target-to-error" />
              <p v-if="targetErrors.toDate" id="target-to-error" class="field-error">{{ targetErrors.toDate }}</p>
            </div>
            <div class="target__field">
              <label for="target-start" class="field-label">Start time</label>
              <input id="target-start" v-model="draft.startTime" type="time" class="input" />
            </div>
            <div class="target__field">
              <label for="target-end" class="field-label">End time</label>
              <input id="target-end" v-model="draft.endTime" type="time" class="input"
                :class="{ 'input--error': targetErrors.endTime }" :aria-invalid="Boolean(targetErrors.endTime)"
                aria-describedby="target-end-error" />
              <p v-if="targetErrors.endTime" id="target-end-error" class="field-error">{{ targetErrors.endTime }}</p>
            </div>
          </fieldset>
        </form>

        <!-- Bottom right of the controls box; submits the target form via form="target-form". -->
        <div class="controls__actions">
          <button v-if="appliedTarget" type="button" class="btn-ghost" @click="clearTarget">Clear target</button>
          <button type="submit" form="target-form" class="btn-primary">Show free slots</button>
        </div>
      </section>

      <section v-if="data" class="summary full-row" aria-label="Venue details and key">
        <p class="summary__venue">
          <span class="summary__name">{{ data.venue.name }}</span>
          <span class="muted">{{ data.venue.location }} · {{ data.venue.capacity }} capacity</span>
        </p>
        <dl class="summary__facts">
          <div><dt>Open</dt><dd>{{ formatRange(data.venue.openingTime, data.venue.closingTime) }} daily</dd></div>
          <div><dt>Setup</dt><dd>{{ formatBuffer(data.venue.setupMinutes) }}</dd></div>
          <div><dt>Turnaround</dt><dd>{{ formatBuffer(data.venue.turnaroundMinutes) }}</dd></div>
        </dl>
        <ul class="legend">
          <li class="legend__item"><span class="swatch swatch--approved" />Approved booking</li>
          <li class="legend__item"><span class="swatch swatch--on-hold" />On Hold booking</li>
          <li class="legend__item"><span class="swatch swatch--blocked" />Unavailable (blocked out)</li>
          <li class="legend__item"><span class="swatch swatch--closed" />Closed (outside hours)</li>
          <li v-if="appliedTarget" class="legend__item"><span class="swatch swatch--free" />Free in your target</li>
        </ul>
      </section>

      <section v-if="appliedTarget && data" class="target-result full-row" aria-live="polite">
        <p class="target-result__heading">
          Free slots for {{ targetSummary }}
        </p>
        <p v-if="!targetVisible" class="body-small muted">
          Your target is outside the dates shown.
          <button type="button" class="btn-link" @click="jumpToTarget">Go to target</button>
        </p>
        <p v-else-if="visibleFreeSlots.length === 0" class="body-small muted">
          No free slots in your target on the dates shown{{ data.venue.setupMinutes || data.venue.turnaroundMinutes ? " once setup and turnaround are allowed for" : "" }}.
        </p>
        <ul v-else class="slot-list">
          <li v-for="slot in visibleFreeSlots" :key="`${slot.date}-${slot.start}`" class="slot-chip">
            <span class="slot-chip__day">{{ formatDay(slot.date) }}</span>
            {{ formatRange(slot.start, slot.end) }}
            <span v-if="slot.eventStart !== slot.start || slot.eventEnd !== slot.end" class="slot-chip__fit">
              (event {{ formatRange(slot.eventStart, slot.eventEnd) }})
            </span>
          </li>
        </ul>
      </section>

      <div class="toolbar full-row">
        <div class="toolbar__nav">
          <button type="button" class="btn-outline" @click="goToday">Today</button>
          <button type="button" class="icon-btn" :aria-label="view === 'month' ? 'Previous month' : 'Previous week'"
            @click="step(-1)">
            <ChevronLeftIcon class="icon" aria-hidden="true" />
          </button>
          <button type="button" class="icon-btn" :aria-label="view === 'month' ? 'Next month' : 'Next week'"
            @click="step(1)">
            <ChevronRightIcon class="icon" aria-hidden="true" />
          </button>
          <h2 class="h6 toolbar__label" aria-live="polite">{{ periodLabel }}</h2>
        </div>
        <div class="view-toggle" role="group" aria-label="Calendar view">
          <button type="button" class="toggle-btn" :class="{ 'toggle-btn--active': view === 'month' }"
            :aria-pressed="view === 'month'" @click="view = 'month'">Month</button>
          <button type="button" class="toggle-btn" :class="{ 'toggle-btn--active': view === 'week' }"
            :aria-pressed="view === 'week'" @click="view = 'week'">Week</button>
        </div>
      </div>

      <p v-if="loadError" class="body-default error-text full-row">{{ loadError }}</p>

      <!-- Month view -->
      <section v-if="view === 'month'" class="calendar full-row" :class="{ 'is-stale': loading }"
        :aria-busy="loading" aria-label="Month calendar">
        <div class="month">
          <div v-for="label in WEEKDAY_LABELS" :key="label" class="month__weekday" aria-hidden="true">{{ label }}</div>
          <button v-for="cell in monthCells" :key="cell.date" type="button" class="month__cell" :class="{
            'is-outside': !cell.inMonth,
            'is-blocked': cell.blockedAllDay,
            'is-target': cell.inTarget,
            'has-free': cell.hasFree,
          }" :aria-label="cellLabel(cell)" @click="openWeek(cell.date)">
            <span class="month__day" :class="{ 'is-today': cell.isToday }">{{ cell.day }}</span>
            <span v-for="block in cell.shown" :key="block.key" class="chip" :class="`chip--${block.kind}`"
              :title="describe(block)">
              <span class="chip__time">{{ blockTime(block) }}</span>
              <span class="chip__label">{{ block.kind === "free" ? "Free" : block.label }}</span>
            </span>
            <span v-if="cell.more > 0" class="month__more">+{{ cell.more }} more</span>
          </button>
        </div>
      </section>

      <!-- Week view -->
      <section v-else class="calendar full-row" :class="{ 'is-stale': loading }" :aria-busy="loading"
        aria-label="Week calendar">
        <div ref="weekScroller" class="week-scroll">
          <div class="week">
            <div class="week__corner" aria-hidden="true" />
            <div v-for="col in weekColumns" :key="`h-${col.date}`" class="week__head"
              :class="{ 'is-today': col.isToday, 'is-target': col.inTarget }">
              <span class="week__weekday">{{ fromKey(col.date).toLocaleDateString("en-GB", { weekday: "short" }) }}</span>
              <span class="week__date">{{ fromKey(col.date).getDate() }}</span>
            </div>

            <div class="week__gutter" aria-hidden="true">
              <span v-for="h in HOURS" :key="h" class="week__hour">{{ String(h).padStart(2, "0") }}:00</span>
            </div>

            <ul v-for="col in weekColumns" :key="col.date" class="week__day" :class="{ 'is-target': col.inTarget }"
              :aria-label="formatLongDay(col.date)">
              <li v-for="block in col.blocks" :key="block.key" class="block" :class="`block--${block.kind}`"
                :style="blockStyle(block)" :title="describe(block)" :aria-label="describe(block)">
                <span v-if="block.core" class="block__core" :style="coreStyle(block)" aria-hidden="true" />
                <span v-if="block.kind !== 'closed'" class="block__text" aria-hidden="true">
                  <span class="block__label">{{ block.kind === "free" ? "Available" : block.label }}</span>
                  <span class="block__time">{{ blockTime(block) }}</span>
                </span>
              </li>
            </ul>
          </div>
        </div>
      </section>
    </template>
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
  min-width: 0;
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
    column-gap: var(--grid-mobile-gutter);
    padding: var(--spacing-24) var(--grid-mobile-margin);
  }

  .page-header,
  .full-row {
    grid-column: 1 / 5;
  }
}

/* ---- Type (Style.md 5) ---- */

.h2 {
  margin: 0;
  font-size: 2.25rem;
  font-weight: 700;
  line-height: 2.625rem;
  color: var(--color-grey-900);
}

.h6 {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
}

.subheading {
  margin: var(--spacing-8) 0 0;
  font-size: 1.125rem;
  line-height: 1.375rem;
  color: var(--color-grey-500);
}

.body-default {
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

.field-label {
  display: block;
  margin-bottom: var(--spacing-4);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  color: var(--color-grey-600);
}

.field-error {
  margin: var(--spacing-4) 0 0;
  font-size: 0.75rem;
  line-height: 1rem;
  color: var(--color-error-600);
}

/* ---- Controls ---- */

.controls {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: var(--spacing-16) var(--grid-desktop-gutter);
  align-content: start;
  padding: var(--spacing-24);
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
}

.controls__venue {
  grid-column: 1 / 5;
  min-width: 0;
}

.target {
  grid-column: 5 / 13;
  min-width: 0;
}

.target__fields {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: var(--spacing-12) var(--grid-desktop-gutter);
  align-content: start;
  margin: 0;
  padding: 0;
  border: none;
}

.target__field {
  grid-column: span 2;
  min-width: 0;
}

/* Full-width last row of the controls box, buttons pushed to the right. */
.controls__actions {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--spacing-12);
}

@media (max-width: 1024px) {
  .controls {
    grid-template-columns: repeat(6, 1fr);
  }

  .controls__venue,
  .target {
    grid-column: 1 / -1;
  }

  .target__fields {
    grid-template-columns: repeat(6, 1fr);
  }

  .target__field {
    grid-column: span 3;
  }
}

@media (max-width: 640px) {
  .controls {
    grid-template-columns: repeat(4, 1fr);
    column-gap: var(--grid-mobile-gutter);
    padding: var(--spacing-16);
  }

  .target__fields {
    grid-template-columns: repeat(4, 1fr);
    column-gap: var(--grid-mobile-gutter);
  }

  .target__field {
    grid-column: span 2;
  }
}

.input {
  width: 100%;
  height: 40px;
  padding: 0 var(--spacing-12);
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-xs);
  background: var(--color-base-white);
  color: var(--color-grey-900);
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  line-height: 1.125rem;
}

.input:focus {
  outline: none;
  border-color: var(--ring-brand);
  box-shadow: 0 0 0 4px var(--ring-light);
}

.input--error {
  border-color: var(--color-error-600);
}

/* ---- Buttons (Style.md 3.4: one solid button per view) ---- */

.btn-primary,
.btn-outline,
.btn-ghost {
  height: 40px;
  padding: 0 var(--spacing-16);
  border-radius: var(--radius-xs);
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  cursor: pointer;
}

.btn-primary {
  border: none;
  background: var(--color-purple-600);
  color: var(--color-base-white);
}

.btn-primary:hover {
  background: var(--color-purple-500);
}

.btn-outline {
  border: 1px solid var(--color-purple-300);
  background: transparent;
  color: var(--color-purple-600);
}

.btn-outline:hover {
  background: var(--color-purple-100);
}

.btn-ghost {
  border: none;
  background: transparent;
  color: var(--color-purple-600);
}

.btn-ghost:hover {
  background: var(--color-purple-100);
}

.btn-link {
  padding: 0;
  border: none;
  background: none;
  color: var(--color-purple-600);
  font: inherit;
  font-weight: 700;
  text-decoration: underline;
  cursor: pointer;
}

.btn-link:hover {
  color: var(--color-purple-700);
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--color-purple-600);
  cursor: pointer;
}

.icon-btn:hover {
  background: var(--color-purple-100);
}

.icon {
  width: var(--spacing-16);
  height: var(--spacing-16);
}

.btn-primary:focus-visible,
.btn-outline:focus-visible,
.btn-ghost:focus-visible,
.btn-link:focus-visible,
.icon-btn:focus-visible,
.toggle-btn:focus-visible,
.month__cell:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

/* ---- Summary + legend ---- */

.summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--spacing-12) var(--spacing-24);
}

.summary__venue {
  display: flex;
  flex-direction: column;
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.125rem;
}

.summary__name {
  font-size: 1rem;
  font-weight: 700;
  line-height: 1.25rem;
  color: var(--color-grey-900);
}

.summary__facts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-16);
  margin: 0;
}

.summary__facts div {
  display: flex;
  gap: var(--spacing-4);
  font-size: 0.875rem;
  line-height: 1.125rem;
}

.summary__facts dt {
  color: var(--color-grey-500);
}

.summary__facts dd {
  margin: 0;
  font-weight: 700;
  color: var(--color-grey-700);
}

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-8) var(--spacing-16);
  margin: 0 0 0 auto;
  padding: 0;
  list-style: none;
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
  width: var(--spacing-16);
  height: var(--spacing-12);
  border-radius: var(--radius-xs);
}

/* ---- Style.md 3.5 availability treatments ---- */

.swatch--approved,
.chip--approved,
.block--approved {
  background: var(--color-purple-100);
  border: 1px solid var(--color-purple-300);
  border-left: var(--spacing-4) solid var(--color-purple-600);
  color: var(--color-purple-800);
}

.swatch--on-hold,
.chip--on-hold,
.block--on-hold {
  background: var(--color-warning-100);
  border: 1px dashed var(--color-warning-300);
  border-left: var(--spacing-4) solid var(--color-warning-500);
  color: var(--color-warning-900);
}

.swatch--blocked,
.chip--blocked,
.block--blocked,
.month__cell.is-blocked {
  background: repeating-linear-gradient(135deg,
      var(--color-grey-200) 0 var(--spacing-4),
      var(--color-grey-50) var(--spacing-4) var(--spacing-8));
  border: 1px solid var(--color-grey-300);
  color: var(--color-grey-900);
}

.swatch--closed,
.block--closed {
  background: var(--color-grey-75);
  color: var(--color-grey-500);
}

.swatch--free,
.chip--free,
.block--free {
  background: var(--color-success-100);
  border: 1px dashed var(--color-success-300);
  color: var(--color-success-600);
}

/* ---- Target result ---- */

.target-result {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
}

.target-result__heading {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  color: var(--color-grey-700);
}

.slot-list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-8);
  margin: 0;
  padding: 0;
  list-style: none;
}

.slot-chip {
  padding: var(--spacing-4) var(--spacing-8);
  border: 1px dashed var(--color-success-300);
  border-radius: var(--radius-xs);
  background: var(--color-success-100);
  color: var(--color-success-600);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
}

.slot-chip__day {
  margin-right: var(--spacing-4);
  color: var(--color-grey-700);
}

.slot-chip__fit {
  font-weight: 400;
}

/* ---- Toolbar ---- */

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--spacing-12);
}

.toolbar__nav {
  display: flex;
  align-items: center;
  gap: var(--spacing-4);
}

.toolbar__label {
  margin-left: var(--spacing-12);
}

.view-toggle {
  display: flex;
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-xs);
  overflow: hidden;
}

.toggle-btn {
  padding: var(--spacing-8) var(--spacing-16);
  border: none;
  border-right: 1px solid var(--color-grey-200);
  background: var(--color-base-white);
  color: var(--color-grey-600);
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  cursor: pointer;
}

.toggle-btn:last-child {
  border-right: none;
}

.toggle-btn:hover:not(.toggle-btn--active) {
  background: var(--color-grey-50);
  color: var(--color-grey-900);
}

.toggle-btn--active {
  background: var(--color-purple-100);
  color: var(--color-purple-700);
}

/* ---- Calendar shared ---- */

.calendar {
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
  background: var(--color-base-white);
  overflow: hidden;
}

.is-stale {
  opacity: 0.6;
  transition: opacity 0.15s;
}

/* ---- Month view ---- */

.month {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  align-content: start;
}

.month__weekday {
  padding: var(--spacing-8);
  border-bottom: 1px solid var(--color-grey-100);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  color: var(--color-grey-500);
  text-align: center;
}

.month__cell {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-4);
  min-width: 0;
  min-height: 120px;
  padding: var(--spacing-8);
  border: none;
  border-right: 1px solid var(--color-grey-100);
  border-bottom: 1px solid var(--color-grey-100);
  background: var(--color-base-white);
  font-family: var(--font-family-lato);
  text-align: left;
  cursor: pointer;
}

.month__cell:nth-of-type(7n) {
  border-right: none;
}

.month__cell:hover {
  background: var(--color-grey-50);
}

.month__cell.is-outside {
  background: var(--color-grey-25);
}

.month__cell.is-outside .month__day {
  color: var(--color-grey-300);
}

.month__cell.is-blocked {
  border-width: 0 1px 1px 0;
  border-color: var(--color-grey-100);
}

.month__cell.is-target {
  box-shadow: inset 0 0 0 2px var(--color-success-300);
}

.month__day {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--spacing-24);
  height: var(--spacing-24);
  border-radius: var(--radius-full);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  color: var(--color-grey-700);
}

.month__day.is-today {
  background: var(--color-purple-600);
  color: var(--color-base-white);
}

.chip {
  display: flex;
  gap: var(--spacing-4);
  min-width: 0;
  padding: var(--spacing-2) var(--spacing-4);
  border-radius: var(--radius-xs);
  font-size: 0.75rem;
  line-height: 1rem;
  white-space: nowrap;
  overflow: hidden;
}

.chip__time {
  flex-shrink: 0;
  font-weight: 700;
}

.chip__label {
  overflow: hidden;
  text-overflow: ellipsis;
}

.month__more {
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  color: var(--color-grey-500);
}

@media (max-width: 1024px) {
  .chip__label {
    display: none;
  }
}

@media (max-width: 640px) {
  .month__cell {
    min-height: 72px;
    padding: var(--spacing-4);
  }

  .chip__time {
    display: none;
  }

  .chip {
    height: var(--spacing-6);
    padding: 0;
  }
}

/* ---- Week view ---- */

.week-scroll {
  max-height: 640px;
  overflow: auto;
}

.week {
  --hour-height: var(--spacing-40);
  display: grid;
  grid-template-columns: var(--spacing-48) repeat(7, minmax(96px, 1fr));
  grid-template-rows: auto calc(var(--hour-height) * 24);
  min-width: 720px;
}

.week__corner,
.week__head {
  position: sticky;
  top: 0;
  z-index: 3;
  background: var(--color-base-white);
  border-bottom: 1px solid var(--color-grey-100);
}

.week__head {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: var(--spacing-8) var(--spacing-4);
  border-left: 1px solid var(--color-grey-100);
}

.week__head.is-target {
  background: var(--color-success-100);
}

.week__weekday {
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  color: var(--color-grey-500);
}

.week__date {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--spacing-32);
  height: var(--spacing-32);
  border-radius: var(--radius-full);
  font-size: 1rem;
  font-weight: 700;
  line-height: 1.25rem;
  color: var(--color-grey-900);
}

.week__head.is-today .week__date {
  background: var(--color-purple-600);
  color: var(--color-base-white);
}

.week__gutter {
  display: grid;
  grid-template-rows: repeat(24, var(--hour-height));
}

.week__hour {
  padding-right: var(--spacing-4);
  transform: translateY(calc(var(--spacing-8) * -1));
  font-size: 0.75rem;
  line-height: 1rem;
  color: var(--color-grey-400);
  text-align: right;
}

.week__hour:first-child {
  visibility: hidden;
}

.week__day {
  position: relative;
  margin: 0;
  padding: 0;
  list-style: none;
  border-left: 1px solid var(--color-grey-100);
  background-image: repeating-linear-gradient(to bottom,
      transparent 0 calc(var(--hour-height) - 1px),
      var(--color-grey-100) calc(var(--hour-height) - 1px) var(--hour-height));
}

.block {
  position: absolute;
  left: 0;
  width: 100%;
  overflow: hidden;
  border-radius: var(--radius-xs);
  font-size: 0.75rem;
  line-height: 1rem;
}

/* Background kinds sit under bookings and leave a sliver so bookings stay clickable/readable. */
.block--closed {
  z-index: 0;
  border-radius: 0;
}

.block--blocked {
  z-index: 1;
}

.block--free {
  z-index: 1;
  left: var(--spacing-2);
  width: calc(100% - var(--spacing-4));
}

.block--approved,
.block--on-hold {
  z-index: 2;
}

.block__core {
  position: absolute;
  left: 0;
  right: 0;
}

.block--approved .block__core {
  background: var(--color-purple-200);
}

.block--on-hold .block__core {
  background: var(--color-warning-200);
}

.block__text {
  position: relative;
  display: flex;
  flex-direction: column;
  padding: var(--spacing-2) var(--spacing-4);
}

.block__label {
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.block__time {
  white-space: nowrap;
}

/* ---- Empty state ---- */

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: var(--spacing-40) var(--spacing-24);
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
  text-align: center;
}

.empty-state__title {
  margin: 0 0 var(--spacing-8);
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
}
</style>
