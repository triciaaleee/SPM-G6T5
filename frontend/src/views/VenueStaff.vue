<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { ChevronDownIcon } from "@heroicons/vue/16/solid";
import CalendarPicker, { type DayMarker } from "../components/venues/CalendarPicker.vue";
import { fetchStaffVenues, fetchVenueBookings, type StaffVenueOption, type VenueBooking } from "../lib/venuesApi";


// Current EVENTS  as of 1/10
/* Great Lawn - 30 sept
Grand ballroom - 30 sept
Innovation Hub - 30 sep


/**
 * E1-5: venue staff's schedule. Pick a venue and a date to see what's
 * booked there — event name, date, times, attendance, layout and facility
 * requirements only. The API never sends the wider event plan, so there's
 * nothing here to hide.
 *
 * Tabs split bookings by booking status: Bookings (approved), Requested
 * (awaiting a decision) and On Hold (tentatively held by venue staff, E4-10).
 * Rejected bookings aren't shown. The tabs filter the list only: the
 * calendar marks every day with a booking (purple dot) or a request (blue
 * dot), whichever tab is open.
 *
 * Deciding on a request happens in the queue (VenueRequestQueue.vue), which
 * orders by event date across venues; this view stays the per-venue, per-day
 * schedule.
 */

type ScheduleTab = "bookings" | "requested" | "held";

const TABS: { key: ScheduleTab; label: string; status: VenueBooking["status"]; noun: string; empty: string }[] = [
  { key: "bookings", label: "Bookings", status: "Approved", noun: "booking", empty: "No confirmed bookings on this day." },
  { key: "requested", label: "Requests", status: "Requested", noun: "request", empty: "No booking requests on this day." },
  { key: "held", label: "On Hold", status: "On Hold", noun: "hold", empty: "No venues held on this day." },
];

function toKey(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${m}-${d}`;
}

function fromKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

const route = useRoute();
const router = useRouter();

/** A single string query param, or null. */
function queryParam(name: string): string | null {
  const value = route.query[name];
  return typeof value === "string" ? value : null;
}

/*
 * The selected venue, date and tab live in the URL
 * (?venue=1&date=2026-09-25&tab=requested), so a refresh or a shared link
 * reopens the same view instead of resetting to the first venue and today.
 */
const queryDate = queryParam("date");
const initialDate = queryDate && /^\d{4}-\d{2}-\d{2}$/.test(queryDate) ? fromKey(queryDate) : new Date();
const queryTab = queryParam("tab");

const venues = ref<StaffVenueOption[]>([]);
const venueId = ref<number | null>(null);
const selectedDate = ref(toKey(initialDate));
/** The month the calendar is showing; bookings are loaded a month at a time. */
const visibleMonth = ref({ year: initialDate.getFullYear(), month: initialDate.getMonth() });

const activeTab = ref<ScheduleTab>(TABS.some((tab) => tab.key === queryTab) ? (queryTab as ScheduleTab) : "requested");
const activeTabConfig = computed(() => TABS.find((tab) => tab.key === activeTab.value)!);

const bookings = ref<VenueBooking[]>([]);
const loadingVenues = ref(true);
const loadingBookings = ref(false);
const venuesError = ref<string | null>(null);
const bookingsError = ref<string | null>(null);

/** This month's bookings in the active tab. */
const tabBookings = computed(() => bookings.value.filter((b) => b.status === activeTabConfig.value.status));

/** Every day this month with a booking or request, for the calendar's dots. */
const dateMarkers = computed(() => {
  const markers: Record<string, DayMarker[]> = {};
  for (const booking of bookings.value) {
    const kind: DayMarker | null =
      booking.status === "Approved" ? "booking" : booking.status === "Requested" ? "request" : null;
    if (!kind) continue;
    const kinds = (markers[booking.date] ??= []);
    if (!kinds.includes(kind)) kinds.push(kind);
  }
  return markers;
});

const dayBookings = computed(() => tabBookings.value.filter((b) => b.date === selectedDate.value));

/** Each tab's total for the selected day, shown beside its label. */
const tabDayCounts = computed(() => {
  const counts: Record<ScheduleTab, number> = { bookings: 0, requested: 0, held: 0 };
  for (const booking of bookings.value) {
    if (booking.date !== selectedDate.value) continue;
    const tab = TABS.find((t) => t.status === booking.status);
    if (tab) counts[tab.key] += 1;
  }
  return counts;
});

const dayHeading = computed(() => {
  const date = fromKey(selectedDate.value);
  const dayMonth = date.toLocaleDateString("en-GB", { day: "numeric", month: "long" });
  const weekday = date.toLocaleDateString("en-GB", { weekday: "long" });
  return `${dayMonth}, ${weekday}`;
});

const dayCount = computed(() => {
  const n = dayBookings.value.length;
  return `${n} ${activeTabConfig.value.noun}${n === 1 ? "" : "s"}`;
});

function formatLongDate(key: string): string {
  return fromKey(key).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

/** Times come from the event, which could in principle be missing one. */
function formatTimeRange(start: string | null, end: string | null): string {
  return start && end ? `${start} ${end}` : "Not specified";
}

function formatAttendance(value: number | null): string {
  return value === null ? "Not specified" : `${value} guest${value === 1 ? "" : "s"}`;
}

// Switching venue or month quickly can land responses out of order; only
// the latest request may update the schedule.
let requestSeq = 0;

async function loadBookings(): Promise<void> {
  if (venueId.value === null) return;
  const { year, month } = visibleMonth.value;
  const from = toKey(new Date(year, month, 1));
  const to = toKey(new Date(year, month + 1, 0));

  const seq = ++requestSeq;
  loadingBookings.value = true;
  bookingsError.value = null;
  try {
    const result = await fetchVenueBookings(venueId.value, from, to);
    if (seq !== requestSeq) return;
    bookings.value = result;
  } catch {
    if (seq !== requestSeq) return;
    bookings.value = [];
    bookingsError.value = "We couldn't load this venue's bookings. Please try again.";
  } finally {
    if (seq === requestSeq) loadingBookings.value = false;
  }
}

watch([venueId, visibleMonth], loadBookings);

// replace, not push: picking a date shouldn't add a history entry.
watch([venueId, selectedDate, activeTab], ([venue, date, tab]) => {
  if (venue === null) return;
  void router.replace({ query: { ...route.query, venue: String(venue), date, tab } });
});

onMounted(async () => {
  try {
    venues.value = await fetchStaffVenues();
    const queryVenue = Number(queryParam("venue"));
    venueId.value = venues.value.find((venue) => venue.id === queryVenue)?.id ?? venues.value[0]?.id ?? null;
  } catch {
    venuesError.value = "We couldn't load the venue list. Please refresh the page.";
  } finally {
    loadingVenues.value = false;
  }
});
</script>

<template>
  <!--
    Column mapping — Venue Schedule
    Desktop (12-col, grid-desktop-margin 80px): header col 1-12; sidebar (venue picker above calendar card) col 1-4;
      schedule col 5-12.
      Nested grid: each booking card's detail rows use a local 8-col grid (the schedule's span);
      time and attendance span 4 each, layout and facilities span 8.
    Tablet (6-col, grid-tablet-margin 32px): header, sidebar and schedule each col 1-6, stacked.
      Card detail grid is 6-col; time/attendance span 3 each, layout/facilities span 6.
    Mobile (4-col, grid-mobile-margin 6px): everything col 1-4, stacked; card detail rows span 4.
  -->
  <div class="page">
    <div class="page-header">
      <h1 class="h2">Venue schedule</h1>
      <p class="subheading">Select a date and venue to see bookings and requests for that day</p>
      <!-- E4-10: decisions are made in the queue, which orders by event date. -->
      <RouterLink :to="{ name: 'venue-requests' }" class="queue-link">Go to booking requests</RouterLink>
    </div>

    <p v-if="venuesError" class="body-default error-text full-row">{{ venuesError }}</p>
    <p v-else-if="loadingVenues" class="body-default muted full-row">Loading venues…</p>
    <div v-else-if="venues.length === 0" class="empty-state full-row">
      <p class="empty-state__title">No venues yet</p>
      <p class="body-default muted">There are no active venues to show a schedule for.</p>
    </div>

    <template v-else>
      <!-- The venue picker scopes both the calendar's dots and the day's bookings. -->
      <div class="sidebar">
        <div class="venue-field">
          <label for="venue-select" class="field-label mb-1">Select Venue</label>
          <div class="venue-select">
            <select id="venue-select" v-model="venueId" class="venue-select__input">
              <option v-for="venue in venues" :key="venue.id" :value="venue.id">{{ venue.name }}</option>
            </select>
            <ChevronDownIcon class="venue-select__icon" aria-hidden="true" />
          </div>
        </div>

        <section class="calendar-card" aria-label="Choose a date">
          <CalendarPicker v-model="selectedDate" allow-past :markers="dateMarkers"
            @month-change="visibleMonth = $event" />
          <ul class="legend" aria-hidden="true">
            <li class="legend__item"><span class="legend__dot legend__dot--booking" />Booking</li>
            <li class="legend__item"><span class="legend__dot legend__dot--request" />Request</li>
          </ul>
        </section>
      </div>

      <section class="schedule" aria-live="polite" :aria-busy="loadingBookings">
        <div class="schedule__header">
          <h2 class="h5 schedule__day">
            {{ dayHeading }}
          </h2>
        </div>

        <div class="tabs" role="tablist" aria-label="Booking status">
          <button v-for="tab in TABS" :id="`tab-${tab.key}`" :key="tab.key" type="button" role="tab" class="tab"
            :class="{ 'tab--active': activeTab === tab.key }" :aria-selected="activeTab === tab.key"
            aria-controls="schedule-panel" :tabindex="activeTab === tab.key ? 0 : -1" @click="activeTab = tab.key">
            {{ tab.label }} ({{ tabDayCounts[tab.key] }})
          </button>
        </div>

        <div id="schedule-panel" role="tabpanel" :aria-labelledby="`tab-${activeTab}`">
        <p v-if="bookingsError" class="body-default error-text">{{ bookingsError }}</p>
        <p v-else-if="loadingBookings && bookings.length === 0" class="body-default muted">Loading bookings…</p>

        <div v-else-if="dayBookings.length === 0" class="empty-state" :class="{ 'is-stale': loadingBookings }">
          <p class="empty-state__title">Nothing here</p>
          <p class="body-default muted">{{ activeTabConfig.empty }}</p>
        </div>

        <ul v-else class="booking-list" :class="{ 'is-stale': loadingBookings }">
          <li v-for="booking in dayBookings" :key="booking.id" class="booking-card">
              <p class="card-title">{{ booking.event.name || "Untitled event" }}</p>
              <p class="body-small muted booking-card__date">{{ formatLongDate(booking.date) }}</p>

              <dl class="details">
                <div class="detail detail--half">
                  <dt class="detail__label">Start – end time</dt>
                  <dd class="detail__value">{{ formatTimeRange(booking.startTime, booking.endTime) }}</dd>
                </div>
                <div class="detail detail--half">
                  <dt class="detail__label">Expected attendance</dt>
                  <dd class="detail__value">{{ formatAttendance(booking.event.expectedAttendance) }}</dd>
                </div>
                <div class="detail">
                  <dt class="detail__label">Layout</dt>
                  <dd v-if="booking.event.layouts.length > 0" class="detail__value">
                    {{ booking.event.layouts.join(", ") }}
                  </dd>
                  <dd v-else class="body-small muted">Not specified</dd>
                </div>
                <div class="detail">
                  <dt class="detail__label">Facility requirements</dt>
                  <dd v-if="booking.event.facilities.length > 0" class="tags">
                    <span v-for="facility in booking.event.facilities" :key="facility" class="tag">{{ facility }}</span>
                  </dd>
                  <dd v-else class="body-small muted">None specified</dd>
                </div>
              </dl>
          </li>
        </ul>
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
  margin-bottom:8px;
}

.sidebar {
  grid-column: 1 / 5;
  align-self: start;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-16);
  min-width: 0;
}

.calendar-card {
  padding: var(--spacing-24);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-sm);
}

/* Explains the calendar's dot colours (same colours as CalendarPicker's dots). */
.legend {
  display: flex;
  justify-content: center;
  gap: var(--spacing-16);
  margin: var(--spacing-16) 0 0;
  padding: 0;
  list-style: none;
}

.legend__item {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-6);
  font-size: 0.75rem;
  line-height: 1rem;
  color: var(--color-grey-500);
}

.legend__dot {
  width: var(--spacing-6);
  height: var(--spacing-6);
  border-radius: var(--radius-full);
}

.legend__dot--booking {
  background: var(--color-purple-600);
}

.legend__dot--request {
  background: var(--color-blue-500);
}

.schedule {
  grid-column: 5 / 13;
  min-width: 0;
}

@media (max-width: 1024px) {
  .page {
    grid-template-columns: repeat(6, 1fr);
    padding: var(--spacing-32) var(--grid-tablet-margin);
  }

  .page-header,
  .full-row,
  .sidebar,
  .schedule {
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
  .full-row,
  .sidebar,
  .schedule {
    grid-column: 1 / 5;
  }
}

.h2 {
  font-size: 2.25rem;
  font-weight: 700;
  line-height: 2.625rem;
  color: var(--color-grey-900);
  margin: 0;
}

.h5 {
  font-size: 1.5rem;
  font-weight: 700;
  line-height: 2rem;
  color: var(--color-grey-900);
  margin: 0;
}

.subheading {
  font-size: 1.125rem;
  font-weight: 400;
  line-height: 1.375rem;
  color: var(--color-grey-500);
  margin: var(--spacing-8) 0 0;
}

.body-default {
  font-size: 1rem;
  line-height: 1.25rem;
}

.body-small {
  font-size: 0.875rem;
  line-height: 1.125rem;
}

.muted {
  color: var(--color-grey-500);
}

.error-text {
  color: var(--color-error-600);
}

.schedule__header {
  margin-bottom: var(--spacing-16);
}

/* Style.md 2.4: brand purple for a navigational link. */
.queue-link {
  color: var(--color-purple-600);
  font-size: 0.875rem;
  font-weight: 700;
  text-decoration: none;
}

.queue-link:hover {
  text-decoration: underline;
}

.queue-link:focus-visible {
  outline: 2px solid var(--color-purple-600);
  outline-offset: 2px;
}

/* Tabs: Style.md 2.4 — Purple 600 marks the active tab. */
.tabs {
  display: flex;
  gap: var(--spacing-24);
  margin-bottom: var(--spacing-16);
  border-bottom: 1px solid var(--color-grey-100);
}

.tab {
  margin-bottom: -1px;
  padding: var(--spacing-8) 0;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--color-grey-500);
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  cursor: pointer;
}

.tab:hover {
  color: var(--color-grey-800);
}

.tab--active,
.tab--active:hover {
  border-bottom-color: var(--color-purple-600);
  color: var(--color-purple-600);
}

.schedule__day {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--spacing-8);
}

.schedule__count {
  font-weight: 400;
}

.venue-field {
  display: flex;
  flex-direction: column;
}

/* Form label: Small Text 700, Style.md 3.2 label colour (Grey/600). */
.field-label {
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  color: var(--color-grey-600);
}

.venue-select {
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
}

.venue-select__input {
  appearance: none;
  width: 100%;
  height: 40px;
  padding: 0 var(--spacing-40) 0 var(--spacing-16);
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-sm);
  background: var(--color-base-white);
  color: var(--color-grey-900);
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  line-height: 1.125rem;
  cursor: pointer;
  margin-top:4px;
}

.venue-select__input[selected]{
  font-weight:700;
}

.venue-select__input:hover {
  border-color: var(--color-grey-300);
}

.venue-select__icon {
  position: absolute;
  width: var(--spacing-16);
  height: var(--spacing-16);
  right: var(--spacing-12);
  color: var(--color-grey-700);
  pointer-events: none;
}

.is-stale {
  opacity: 0.6;
  transition: opacity 0.15s;
}

.booking-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-16);
  list-style: none;
  margin: 0;
  padding: 0;
}

.booking-card {
  padding: var(--spacing-24);
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-sm);
}

.card-title {
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
  margin: 0;
}

.booking-card__date {
  margin: var(--spacing-4) 0 0;
}

/* Nested grid: 8 cols = the schedule's span on desktop (Style.md 0.3). */
.details {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: var(--spacing-16) var(--grid-desktop-gutter);
  align-content: start;
  margin: var(--spacing-16) 0 0;
  padding-top: var(--spacing-16);
  border-top: 1px solid var(--color-grey-100);
}

.detail {
  grid-column: span 8;
  min-width: 0;
}

.detail--half {
  grid-column: span 4;
}

@media (max-width: 1024px) {
  .details {
    grid-template-columns: repeat(6, 1fr);
  }

  .detail {
    grid-column: span 6;
  }

  .detail--half {
    grid-column: span 3;
  }
}

@media (max-width: 640px) {
  .details {
    grid-template-columns: repeat(4, 1fr);
    column-gap: var(--grid-mobile-gutter);
  }

  .detail,
  .detail--half {
    grid-column: span 4;
  }
}

.detail__label {
  margin-bottom: var(--spacing-4);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  color: var(--color-grey-500);
}

.detail__value {
  margin: 0;
  font-size: 1rem;
  font-weight: 700;
  line-height: 1.25rem;
  color: var(--color-grey-900);
}

.detail dd {
  margin: 0;
}

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-4);
}

.tag {
  padding: var(--spacing-2) var(--spacing-8);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-xs);
  background: var(--color-base-white);
  color: var(--color-grey-700);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: var(--spacing-40) var(--spacing-24);
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-sm);
}

.empty-state__title {
  margin: 0 0 var(--spacing-8);
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
}
</style>
