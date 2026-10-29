<script setup lang="ts">
import EmptyState from "../../components/ui/EmptyState.vue";
import AppButton from "../../components/ui/AppButton.vue";
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import VenueCalendar from "../../components/venues/VenueCalendar.vue";
import VenuePicker from "../../components/venues/VenuePicker.vue";
import {
  emptyVenueFilters,
  fetchVenueAvailability,
  searchVenues,
  type AvailabilityTarget,
  type Venue,
  type VenueAvailability,
} from "../../lib/venuesApi";
import { availabilityEntries, blockEntries, fromKey, toKey } from "../../lib/venueCalendar";
import { isDateKey } from "../../lib/availabilityCalendar";
import type { CalendarStatusKey } from "../../lib/calendarStatus";

/**
 * Venue availability (coordinators). Pick a venue to see when it could realistically be requested.
 *
 * The calendar and its key are the venue staff's own (`VenueCalendar`), fed from the availability
 * endpoint instead of the staff one: only the bookings that block the venue (Approved, On Hold) and
 * its recorded block-outs ever reach a coordinator, so the key lists just those three.
 * With a target date and time range, the free slots inside it are listed under the venue summary.
 *
 * The venue, date and target live in the URL so a refresh or a shared link reopens the same calendar.
 */

/** The statuses a coordinator can see. */
const VISIBLE_STATUSES: CalendarStatusKey[] = ["approved", "hold", "block"];

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
const focus = ref(isDateKey(queryParam("date")) ? queryParam("date")! : today);
const calendar = ref<InstanceType<typeof VenueCalendar> | null>(null);

/** The target form as typed; `appliedTarget` is what the calendar is showing. */
const draft = reactive({
  fromDate: isDateKey(queryParam("tFrom")) ? queryParam("tFrom")! : "",
  toDate: isDateKey(queryParam("tTo")) ? queryParam("tTo")! : "",
  startTime: timeParam("tStart"),
  endTime: timeParam("tEnd"),
});
const targetErrors = ref<Record<string, string>>({});
const appliedTarget = ref<AvailabilityTarget | null>(draft.fromDate ? toTarget() : null);

/** The latest response: the venue's details and free slots, for the summary above the calendar. */
const data = ref<VenueAvailability | null>(null);
const loadedRange = ref<{ from: string; to: string } | null>(null);
const loadingVenues = ref(true);
const venuesError = ref<string | null>(null);

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

/** The calendar only reloads when its venue or day changes; a new target on the same day needs a nudge. */
function reloadIfStill(dayBefore: string): void {
  if (focus.value === dayBefore) void calendar.value?.refresh();
}

function applyTarget(): void {
  targetErrors.value = validateTarget();
  if (Object.keys(targetErrors.value).length > 0) return;
  const dayBefore = focus.value;
  appliedTarget.value = toTarget();
  focus.value = appliedTarget.value.fromDate;
  reloadIfStill(dayBefore);
}

function clearTarget(): void {
  const dayBefore = focus.value;
  draft.fromDate = "";
  draft.toDate = "";
  draft.startTime = "";
  draft.endTime = "";
  targetErrors.value = {};
  appliedTarget.value = null;
  reloadIfStill(dayBefore);
}

/** One venue at a time; a stable array so the calendar only reloads when the venue really changes. */
const calendarVenues = computed(() => {
  const venue = venues.value.find((v) => v.id === venueId.value);
  return venue ? [{ id: venue.id, name: venue.name }] : [];
});

let latestLoad = 0;

/** The calendar's data source: one availability request, kept for the summary and free slots. */
async function loadEntries(id: number, from: string, to: string) {
  const load = ++latestLoad;
  const result = await fetchVenueAvailability(id, from, to, appliedTarget.value);
  if (load === latestLoad) {
    data.value = result;
    loadedRange.value = { from, to };
  }
  return {
    bookings: availabilityEntries(id, result.bookings),
    blocks: blockEntries(result.unavailability, from, to),
  };
}

// replace, not push: moving around the calendar shouldn't flood the history.
watch([venueId, focus, appliedTarget], ([venue, date, target]) => {
  if (venue === null) return;
  const query: Record<string, string> = { venue: String(venue), date };
  if (target) {
    query.tFrom = target.fromDate;
    query.tTo = target.toDate;
    if (target.startTime) query.tStart = target.startTime;
    if (target.endTime) query.tEnd = target.endTime;
  }
  void router.replace({ query });
});

watch(venueId, () => {
  data.value = null;
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

onBeforeUnmount(() => {
  latestLoad++;
});

// ---- Formatting -----------------------------------------------------------

function formatRange(start: string, end: string): string {
  return `${start}–${end}`;
}

function formatDay(key: string): string {
  return fromKey(key).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

function formatBuffer(minutes: number): string {
  if (minutes === 0) return "none";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? `${h} h` : "", m ? `${m} min` : ""].filter(Boolean).join(" ");
}

// ---- Target summary -------------------------------------------------------

const visibleFreeSlots = computed(() => data.value?.freeSlots ?? []);

/** Whether any of the target falls inside the dates on screen. */
const targetVisible = computed(() => {
  const target = data.value?.target;
  const range = loadedRange.value;
  return Boolean(target && range && target.fromDate <= range.to && target.toDate >= range.from);
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
      to date, start time, end time span 2 each); footer row col 1-12 below them, inside the card: venue summary at the start, actions at the end.
      Free slots col 1-12. Calendar (toolbar, key and grid, as on Venue schedule) col 1-12.
    Tablet (6-col, grid-tablet-margin 32px): everything col 1-6. Controls grid 6-col: picker span 6,
      target fieldset span 6 (nested 6-col: dates and times span 3 each), actions span 6 right-aligned.
    Mobile (4-col, grid-mobile-margin 6px): everything col 1-4. Controls grid 4-col: picker span 4,
      fieldset span 4 (nested 4-col: dates and times span 2 each), actions span 4 right-aligned. The calendar scrolls
      sideways inside its own card so the page never does.
  -->
  <div class="page">
    <header class="page-header">
      <h1 class="h2">Venue availability</h1>
      <p class="subheading">See when a venue is free before you request it.</p>
    </header>

    <p v-if="venuesError" class="body-default error-text full-row">{{ venuesError }}</p>
    <p v-else-if="loadingVenues" class="body-default muted full-row">Loading venues…</p>
    <EmptyState class="full-row" v-else-if="venues.length === 0">
      <p class="empty-state__title">No venues yet</p>
      <p class="body-default muted">There are no active venues to show availability for.</p>
    </EmptyState>

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

        <!-- Last row of the card: the chosen venue's details on the left, the buttons on the right. -->
        <div class="controls__footer">
          <div v-if="data" class="summary" aria-label="Venue details" role="group">
            <p class="summary__venue">
              <span class="summary__name">{{ data.venue.name }}</span>
              <span class="muted">{{ data.venue.location }} · {{ data.venue.capacity }} capacity</span>
            </p>
            <dl class="summary__facts">
              <div>
                <dt>Open</dt>
                <dd>{{ formatRange(data.venue.openingTime, data.venue.closingTime) }} daily</dd>
              </div>
              <div>
                <dt>Setup</dt>
                <dd>{{ formatBuffer(data.venue.setupMinutes) }}</dd>
              </div>
              <div>
                <dt>Turnaround</dt>
                <dd>{{ formatBuffer(data.venue.turnaroundMinutes) }}</dd>
              </div>
            </dl>
          </div>

          <!-- Submits the target form via form="target-form". -->
          <div class="controls__actions">
            <AppButton variant="ghost" v-if="appliedTarget" type="button" @click="clearTarget">Clear target
            </AppButton>
            <AppButton variant="primary" type="submit" form="target-form">Show free slots</AppButton>
          </div>
        </div>
      </section>

      <section v-if="appliedTarget && data" class="target-result full-row" aria-live="polite">
        <p class="target-result__heading">
          Free slots for {{ targetSummary }}
        </p>
        <p v-if="!targetVisible" class="body-small muted">
          Your target is outside the dates shown.
          <AppButton variant="link" class="btn-link" @click="jumpToTarget">Go to target</AppButton>
        </p>
        <p v-else-if="visibleFreeSlots.length === 0" class="body-small muted">
          No free slots in your target on the dates shown{{ data.venue.setupMinutes || data.venue.turnaroundMinutes ? "once setup and turnaround are allowed for" : "" }}.
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

      <VenueCalendar ref="calendar" class="full-row" :venues="calendarVenues" :load-entries="loadEntries"
        :statuses="VISIBLE_STATUSES" :reviewable="false" :day="focus" @day-change="focus = $event" />
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
}

.h6 {
  margin: 0;
}

.subheading {
  margin: var(--spacing-8) 0 0;
  color: var(--color-grey-600);
}

.body-small {
  margin: 0;
}

.muted {
  color: var(--color-grey-600);
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

/* Full-width last row of the controls box: venue details at the start, buttons at the end, one row. */
.controls__footer {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-16) var(--spacing-24);
  padding-top: var(--spacing-16);
  border-top: 1px solid var(--color-grey-100);
}

.controls__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--spacing-12);
  margin-left: auto;
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
  font-size: 0.875rem;
  line-height: 1.125rem;
}

/* ---- Buttons (Style.md 3.4: one solid button per view) ---- */

/* ---- Summary ---- */

/* The venue's details: the name and location on top, the opening hours, setup and turnaround under them. */
.summary {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--spacing-8);
  min-width: 0;
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
  color: var(--color-grey-600);
}

.summary__facts dd {
  margin: 0;
  font-weight: 700;
  color: var(--color-grey-700);
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

/* ---- Empty state ---- */

.empty-state__title {
  margin: 0 0 var(--spacing-8);
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
}
</style>
