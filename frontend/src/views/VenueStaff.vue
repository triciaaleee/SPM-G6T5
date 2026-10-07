<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ChevronDownIcon } from "@heroicons/vue/16/solid";
import CalendarPicker from "../components/venues/CalendarPicker.vue";
import BlockOutPanel from "../components/venues/BlockOutPanel.vue";
import UnavailabilityCard from "../components/venues/UnavailabilityCard.vue";
import { fetchStaffVenues, fetchVenueBookings, type StaffVenueOption, type VenueBooking } from "../lib/venuesApi";
import {
  deleteUnavailability,
  fetchUnavailability,
  type CreatePeriodResult,
  type UnavailabilityPeriod,
} from "../lib/unavailabilityApi";

/**
 * E1-5: venue staff's schedule. Pick a venue and a date to see what's
 * booked there — event name, date, times, attendance, layout and facility
 * requirements only. The API never sends the wider event plan, so there's
 * nothing here to hide.
 */

function toKey(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${m}-${d}`;
}

function fromKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

const today = new Date();

const venues = ref<StaffVenueOption[]>([]);
const venueId = ref<number | null>(null);
const selectedDate = ref(toKey(today));
/** The month the calendar is showing; bookings are loaded a month at a time. */
const visibleMonth = ref({ year: today.getFullYear(), month: today.getMonth() });

const bookings = ref<VenueBooking[]>([]);
const loadingVenues = ref(true);
const loadingBookings = ref(false);
const venuesError = ref<string | null>(null);
const bookingsError = ref<string | null>(null);

const bookedDates = computed(() => [...new Set(bookings.value.map((b) => b.date))]);

const dayBookings = computed(() => bookings.value.filter((b) => b.date === selectedDate.value));

const dayHeading = computed(() =>
  fromKey(selectedDate.value).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }),
);

const dayCount = computed(() => {
  const n = dayBookings.value.length;
  return `${n} booking${n === 1 ? "" : "s"}`;
});

function formatLongDate(key: string): string {
  return fromKey(key).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
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
const removingId = ref<number | null>(null);
/** Outcome of the last block-out or removal, shown above the day's list. */
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
    const from = fromKey(period.startDate > first ? period.startDate : first);
    const to = period.endDate < last ? period.endDate : last;
    for (const day = from; toKey(day) <= to; day.setDate(day.getDate() + 1)) {
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

/** The period being edited in the panel; null while adding a new one. */
const editingPeriod = ref<UnavailabilityPeriod | null>(null);

function openBlockOut(period: UnavailabilityPeriod | null = null): void {
  editingPeriod.value = period;
  panelOpen.value = true;
}

function onBlockOutSaved(result: CreatePeriodResult): void {
  const verb = editingPeriod.value ? "Block-out updated." : "Period blocked out.";
  panelOpen.value = false;
  editingPeriod.value = null;
  const count = result.affected.length;
  if (count === 0) {
    notice.value = { text: `${verb} It shows as unavailable on the calendar.`, warning: false };
  } else {
    const bookings = `${count} booking${count === 1 ? "" : "s"} marked Replacement Required`;
    const notified = result.notificationsFailed
      ? "but we couldn't notify the coordinators — please let them know directly."
      : `and ${result.coordinatorsNotified} coordinator${result.coordinatorsNotified === 1 ? "" : "s"} notified.`;
    notice.value = { text: `${verb} ${bookings}, ${notified}`, warning: result.notificationsFailed };
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

onMounted(async () => {
  try {
    venues.value = await fetchStaffVenues();
    venueId.value = venues.value[0]?.id ?? null;
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
      (venue picker above calendar card + key) col 1-4; schedule col 5-12, block-out cards above the bookings.
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
        <p class="subheading">Select a date to see what needs to be set up that day.</p>
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
        <label class="venue-select">
          <span class="sr-only">Venue</span>
          <select v-model="venueId" class="venue-select__input">
            <option v-for="venue in venues" :key="venue.id" :value="venue.id">{{ venue.name }}</option>
          </select>
          <ChevronDownIcon class="venue-select__icon" aria-hidden="true" />
        </label>

        <section class="calendar-card" aria-label="Choose a date">
          <CalendarPicker v-model="selectedDate" allow-past :marked-dates="bookedDates"
            :blocked-dates="blockedDays.full" :partly-blocked-dates="blockedDays.partial"
            @month-change="visibleMonth = $event" />
          <ul class="legend" aria-label="Calendar key">
            <li class="legend__item"><span class="legend__dot" aria-hidden="true" />Booked</li>
            <li class="legend__item"><span class="legend__swatch" aria-hidden="true" />Unavailable all day</li>
            <li class="legend__item">
              <span class="legend__swatch legend__swatch--partial" aria-hidden="true" />Partly unavailable
            </li>
          </ul>
        </section>
      </div>

      <section class="schedule" aria-live="polite" :aria-busy="loadingBookings">
        <div class="schedule__header">
          <h2 class="h5 schedule__day">
            {{ dayHeading }}
            <span v-if="!loadingBookings && !bookingsError" class="body-default muted schedule__count">{{ dayCount
              }}</span>
          </h2>
        </div>

        <p v-if="notice" class="notice" :class="{ 'notice--warning': notice.warning }" role="status">
          {{ notice.text }}
        </p>
        <p v-if="periodsError" class="body-default error-text">{{ periodsError }}</p>

        <!-- E4-3 AC1: block-outs come first so an unavailable day is obvious at a glance. -->
        <ul v-if="dayPeriods.length > 0" class="booking-list block-list">
          <li v-for="period in dayPeriods" :key="period.id">
            <UnavailabilityCard :period="period" :removing="removingId === period.id" @edit="openBlockOut(period)"
              @remove="removePeriod(period)" />
          </li>
        </ul>

        <p v-if="bookingsError" class="body-default error-text">{{ bookingsError }}</p>
        <p v-else-if="loadingBookings && bookings.length === 0" class="body-default muted">Loading bookings…</p>

        <div v-else-if="dayBookings.length === 0" class="empty-state" :class="{ 'is-stale': loadingBookings }">
          <p class="empty-state__title">Nothing booked</p>
          <p class="body-default muted">This venue has no bookings on this day.</p>
        </div>

        <ul v-else class="booking-list" :class="{ 'is-stale': loadingBookings }">
          <li v-for="booking in dayBookings" :key="booking.id" class="booking-card"
            :class="{ 'booking-card--hold': booking.kind === 'hold' }">
            <template v-if="booking.kind === 'event'">
              <span v-if="booking.status === 'Replacement Required'" class="replacement-badge">
                Replacement Required
              </span>
              <p class="card-title">{{ booking.event.name || "Untitled event" }}</p>
              <p class="body-small muted booking-card__date">{{ formatLongDate(booking.date) }}</p>

              <dl class="details">
                <div class="detail detail--half">
                  <dt class="detail__label">Start – end time</dt>
                  <dd class="detail__value">{{ booking.startTime }} – {{ booking.endTime }}</dd>
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
            </template>

            <template v-else>
              <span class="hold-badge">Venue unavailable</span>
              <p class="card-title">{{ booking.reason || "Venue hold" }}</p>
              <p class="body-small muted booking-card__date">{{ formatLongDate(booking.date) }}</p>
              <dl class="details">
                <div class="detail">
                  <dt class="detail__label">Start – end time</dt>
                  <dd class="detail__value">{{ booking.startTime }} – {{ booking.endTime }}</dd>
                </div>
              </dl>
            </template>
          </li>
        </ul>
      </section>
    </template>

    <BlockOutPanel v-if="panelOpen && venueId !== null" :key="editingPeriod?.id ?? 'new'" :venue-id="venueId"
      :venue-name="selectedVenueName" :initial-date="selectedDate" :period="editingPeriod"
      @close="panelOpen = false; editingPeriod = null" @saved="onBlockOutSaved" />
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

.schedule__day {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--spacing-8);
}

.schedule__count {
  font-weight: 400;
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

.booking-card--hold {
  background: var(--color-grey-50);
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

.hold-badge {
  display: inline-block;
  margin-bottom: var(--spacing-8);
  padding: var(--spacing-2) var(--spacing-8);
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-full);
  background: var(--color-grey-75);
  color: var(--color-grey-700);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
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

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-8) var(--spacing-16);
  margin: var(--spacing-16) 0 0;
  padding: var(--spacing-16) 0 0;
  border-top: 1px solid var(--color-grey-100);
  list-style: none;
}

.legend__item {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-8);
  font-size: 0.75rem;
  line-height: 1rem;
  color: var(--color-grey-700);
}

.legend__dot {
  width: var(--spacing-4);
  height: var(--spacing-4);
  border-radius: var(--radius-full);
  background: var(--color-purple-600);
}

/* Style.md 3.5: pattern-unavailable / -partial, as calendar swatches. */
.legend__swatch {
  width: var(--spacing-16);
  height: var(--spacing-16);
  border-radius: var(--radius-xs);
  box-shadow: inset 0 0 0 1px var(--color-grey-300);
  background: repeating-linear-gradient(135deg,
      var(--color-grey-200) 0 var(--spacing-4),
      var(--color-grey-50) var(--spacing-4) var(--spacing-8));
}

.legend__swatch--partial {
  background: repeating-linear-gradient(135deg,
      var(--color-grey-200) 0 var(--spacing-4),
      var(--color-grey-50) var(--spacing-4) var(--spacing-8)) bottom / 100% 50% no-repeat;
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
