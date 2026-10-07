<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ChevronDownIcon } from "@heroicons/vue/16/solid";
import CalendarPicker, { type DayMarker } from "../components/venues/CalendarPicker.vue";
import BlockOutPanel from "../components/venues/BlockOutPanel.vue";
import UnavailabilityCard from "../components/venues/UnavailabilityCard.vue";
import { fetchStaffVenues, fetchVenueBookings, type StaffVenueOption, type VenueBooking } from "../lib/venuesApi";
import {
  deleteUnavailability,
  fetchUnavailability,
  type CreatePeriodResult,
  type UnavailabilityPeriod,
} from "../lib/unavailabilityApi";


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
 * Tabs split bookings by booking status: Bookings (approved) and Requested
 * (awaiting a decision). Rejected bookings aren't shown. The tabs filter
 * the list only: the calendar marks every day with a booking (purple dot)
 * or a request (blue dot), whichever tab is open.
 */

type ScheduleTab = "bookings" | "requested";

const TABS: { key: ScheduleTab; label: string; status: VenueBooking["status"]; noun: string; empty: string }[] = [
  { key: "bookings", label: "Bookings", status: "Approved", noun: "booking", empty: "No confirmed bookings on this day." },
  { key: "requested", label: "Requests", status: "Requested", noun: "request", empty: "No booking requests on this day." },
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

/**
 * Whether a booking belongs in a tab. A booking flagged Replacement
 * Required by a block-out (E4-3) was approved, so it stays under Bookings
 * (with a badge) rather than disappearing from both tabs.
 */
function inTab(booking: VenueBooking, tab: (typeof TABS)[number]): boolean {
  return booking.status === tab.status || (tab.key === "bookings" && booking.status === "Replacement Required");
}

/** This month's bookings in the active tab. */
const tabBookings = computed(() => bookings.value.filter((b) => inTab(b, activeTabConfig.value)));

/** Every day this month with a booking or request, for the calendar's dots. */
const dateMarkers = computed(() => {
  const markers: Record<string, DayMarker[]> = {};
  for (const booking of bookings.value) {
    const kind: DayMarker | null =
      booking.status === "Approved" || booking.status === "Replacement Required"
        ? "booking"
        : booking.status === "Requested"
          ? "request"
          : null;
    if (!kind) continue;
    const kinds = (markers[booking.date] ??= []);
    if (!kinds.includes(kind)) kinds.push(kind);
  }
  return markers;
});

const dayBookings = computed(() => tabBookings.value.filter((b) => b.date === selectedDate.value));

/** Each tab's total for the selected day, shown beside its label. */
const tabDayCounts = computed(() => {
  const counts: Record<ScheduleTab, number> = { bookings: 0, requested: 0 };
  for (const booking of bookings.value) {
    if (booking.date !== selectedDate.value) continue;
    const tab = TABS.find((t) => inTab(booking, t));
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

// ---- E4-3: block-out periods -------------------------------------------

const periods = ref<UnavailabilityPeriod[]>([]);
const periodsError = ref<string | null>(null);
const panelOpen = ref(false);
/** The period being edited in the panel; null while adding a new one. */
const editingPeriod = ref<UnavailabilityPeriod | null>(null);
const removingId = ref<number | null>(null);
/** Outcome of the last block-out change, shown above the day's list. */
const notice = ref<{ text: string; warning: boolean } | null>(null);

const selectedVenueName = computed(() => venues.value.find((v) => v.id === venueId.value)?.name ?? "");

/** Every visible-month day a period covers, split into all-day and some-hours. */
const blockedDays = computed(() => {
  const { year, month } = visibleMonth.value;
  const first = toKey(new Date(year, month, 1));
  const last = toKey(new Date(year, month + 1, 0));
  const full = new Set<string>();
  const partial = new Set<string>();
  for (const period of periods.value) {
    const to = period.endDate < last ? period.endDate : last;
    for (const day = fromKey(period.startDate > first ? period.startDate : first); toKey(day) <= to; day.setDate(day.getDate() + 1)) {
      (period.allDay ? full : partial).add(toKey(day));
    }
  }
  return { full: [...full], partial: [...partial].filter((key) => !full.has(key)) };
});

/** Periods covering the selected day: all-day first, then by start time. */
const dayPeriods = computed(() =>
  periods.value
    .filter((p) => p.startDate <= selectedDate.value && p.endDate >= selectedDate.value)
    .sort((a, b) => Number(b.allDay) - Number(a.allDay) || (a.startTime ?? "").localeCompare(b.startTime ?? "")),
);

let periodsSeq = 0;

async function loadUnavailability(): Promise<void> {
  if (venueId.value === null) return;
  const { year, month } = visibleMonth.value;
  const from = toKey(new Date(year, month, 1));
  const to = toKey(new Date(year, month + 1, 0));

  const seq = ++periodsSeq;
  try {
    const result = await fetchUnavailability(venueId.value, from, to);
    if (seq !== periodsSeq) return;
    periods.value = result;
    periodsError.value = null;
  } catch {
    if (seq !== periodsSeq) return;
    periods.value = [];
    periodsError.value = "We couldn't load this venue's unavailable periods.";
  }
}

watch([venueId, visibleMonth], loadUnavailability);
watch(venueId, () => (notice.value = null));

function openBlockOut(period: UnavailabilityPeriod | null = null): void {
  editingPeriod.value = period;
  panelOpen.value = true;
}

function closeBlockOut(): void {
  panelOpen.value = false;
  editingPeriod.value = null;
}

function onBlockOutSaved(result: CreatePeriodResult): void {
  const verb = editingPeriod.value ? "Block-out updated." : "Period blocked out.";
  closeBlockOut();

  const flagged = result.affected.filter((b) => b.replacementRequired).length;
  const pending = result.affected.length - flagged;
  if (result.affected.length === 0) {
    notice.value = { text: `${verb} It shows as unavailable on the calendar.`, warning: false };
  } else {
    const parts = [];
    if (flagged > 0) parts.push(`${flagged} booking${flagged === 1 ? "" : "s"} marked Replacement Required`);
    if (pending > 0) parts.push(`${pending} pending request${pending === 1 ? "" : "s"} clash with it`);
    const notified = result.notificationsFailed
      ? "but we couldn't notify the coordinators — please let them know directly."
      : `${result.coordinatorsNotified} coordinator${result.coordinatorsNotified === 1 ? "" : "s"} notified.`;
    notice.value = { text: `${verb} ${parts.join("; ")}; ${notified}`, warning: result.notificationsFailed };
  }
  selectedDate.value = result.period.startDate;
  void loadUnavailability();
  void loadBookings();
}

async function removePeriod(period: UnavailabilityPeriod): Promise<void> {
  if (!window.confirm(`Remove this block-out (${period.reason})? The venue will show as available again.`)) return;
  removingId.value = period.id;
  try {
    await deleteUnavailability(period.id);
    notice.value = { text: "Block-out removed.", warning: false };
    await loadUnavailability();
  } catch {
    notice.value = { text: "We couldn't remove that block-out. Please try again.", warning: true };
  } finally {
    removingId.value = null;
  }
}

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
    Desktop (12-col, grid-desktop-margin 80px): header col 1-12 (title left, "Block out time" right); sidebar
      (venue picker above calendar card + key) col 1-4; schedule col 5-12, block-out cards above the tabs.
      The Block out time panel is an overlay drawer outside this grid (mapping in BlockOutPanel.vue).
      Nested grid: each booking card's detail rows use a local 8-col grid (the schedule's span);
      time and attendance span 4 each, layout and facilities span 8.
    Tablet (6-col, grid-tablet-margin 32px): header, sidebar and schedule each col 1-6, stacked.
      Card detail grid is 6-col; time/attendance span 3 each, layout/facilities span 6.
    Mobile (4-col, grid-mobile-margin 6px): everything col 1-4, stacked; card detail rows span 4.
  -->
  <div class="page">
    <div class="page-header page-header--with-action">
      <div>
        <h1 class="h2">Venue schedule</h1>
        <p class="subheading">Select a date and venue to see bookings and requests for that day</p>
      </div>
      <!-- E4-3: the page's one primary action. -->
      <button v-if="venueId !== null" type="button" class="btn-primary" @click="openBlockOut()">
        Block out time
      </button>
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
            :blocked-dates="blockedDays.full" :partly-blocked-dates="blockedDays.partial"
            @month-change="visibleMonth = $event" />
          <ul class="legend" aria-hidden="true">
            <li class="legend__item"><span class="legend__dot legend__dot--booking" />Booking</li>
            <li class="legend__item"><span class="legend__dot legend__dot--request" />Request</li>
            <li class="legend__item"><span class="legend__swatch" />Unavailable</li>
            <li class="legend__item"><span class="legend__swatch legend__swatch--partial" />Partly unavailable</li>
          </ul>
        </section>
      </div>

      <section class="schedule" aria-live="polite" :aria-busy="loadingBookings">
        <div class="schedule__header">
          <h2 class="h5 schedule__day">
            {{ dayHeading }}
          </h2>
        </div>

        <p v-if="notice" class="notice" :class="{ 'notice--warning': notice.warning }" role="status">
          {{ notice.text }}
        </p>
        <p v-if="periodsError" class="body-default error-text">{{ periodsError }}</p>

        <!-- E4-3 AC1: block-outs sit above the tabs so an unavailable day is obvious whichever tab is open. -->
        <ul v-if="dayPeriods.length > 0" class="booking-list block-list">
          <li v-for="period in dayPeriods" :key="period.id">
            <UnavailabilityCard :period="period" :removing="removingId === period.id" @edit="openBlockOut(period)"
              @remove="removePeriod(period)" />
          </li>
        </ul>

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
              <span v-if="booking.status === 'Replacement Required'" class="replacement-badge">
                Replacement Required
              </span>
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

    <BlockOutPanel v-if="panelOpen && venueId !== null" :key="editingPeriod?.id ?? 'new'" :venue-id="venueId"
      :venue-name="selectedVenueName" :initial-date="selectedDate" :period="editingPeriod"
      @close="closeBlockOut" @saved="onBlockOutSaved" />
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

/* ---- E4-3: block-out periods ---- */

.page-header--with-action {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--spacing-16);
}

.btn-primary {
  height: 40px;
  padding: 0 var(--spacing-16);
  border: none;
  border-radius: var(--radius-xs);
  background: var(--color-purple-600);
  color: var(--color-base-white);
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  cursor: pointer;
}

.btn-primary:hover {
  background: var(--color-purple-500);
}

.btn-primary:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

/* Four keys no longer fit on one line in the sidebar. */
.legend {
  flex-wrap: wrap;
  row-gap: var(--spacing-8);
}

/* Style.md 3.5: pattern-unavailable / -partial, as calendar swatches. */
.legend__swatch {
  width: var(--spacing-12);
  height: var(--spacing-12);
  border-radius: var(--radius-xs);
  box-shadow: inset 0 0 0 1px var(--color-grey-300);
  background: repeating-linear-gradient(135deg,
      var(--color-grey-200) 0 var(--spacing-2),
      var(--color-grey-50) var(--spacing-2) var(--spacing-4));
}

.legend__swatch--partial {
  background: repeating-linear-gradient(135deg,
      var(--color-grey-200) 0 var(--spacing-2),
      var(--color-grey-50) var(--spacing-2) var(--spacing-4)) bottom / 100% 50% no-repeat;
}

.notice {
  margin: 0 0 var(--spacing-16);
  padding: var(--spacing-12) var(--spacing-16);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-xs);
  background: var(--color-grey-50);
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-700);
}

.notice--warning {
  border-color: var(--color-warning-300);
  background: var(--color-warning-100);
  color: var(--color-warning-900);
}

.block-list {
  margin-bottom: var(--spacing-16);
}

/* Style.md 3.5: Replacement Required badge. */
.replacement-badge {
  display: inline-block;
  margin-bottom: var(--spacing-8);
  padding: var(--spacing-2) var(--spacing-8);
  border: 1px solid var(--color-warning-300);
  border-radius: var(--radius-full);
  background: var(--color-warning-200);
  color: var(--color-warning-900);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
}
</style>
