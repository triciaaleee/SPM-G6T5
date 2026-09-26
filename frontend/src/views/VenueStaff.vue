<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ChevronDownIcon } from "@heroicons/vue/16/solid";
import CalendarPicker from "../components/venues/CalendarPicker.vue";
import { fetchStaffVenues, fetchVenueBookings, type StaffVenueOption, type VenueBooking } from "../lib/venuesApi";

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
      <p class="subheading">Select a date to see what needs to be set up that day.</p>
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
            @month-change="visibleMonth = $event" />
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
</style>
