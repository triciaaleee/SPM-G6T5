<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { fetchEventById, type EventSummary } from "../lib/eventsApi";
import {
  clearCriterion,
  describeBookingFailure,
  emptyVenueFilters,
  fetchVenueAvailability,
  fetchVenueFilterOptions,
  searchVenues,
  submitVenueBooking,
  timeWindowError,
  VenueSearchError,
  type AvailabilityTarget,
  type CriterionKey,
  type RelaxOption,
  type Venue,
  type VenueAvailability,
  type VenueFilterOptions,
} from "../lib/venuesApi";
import { fromKey } from "../lib/availabilityCalendar";
import VenueFilterBar from "../components/venues/VenueFilterBar.vue";
import VenueIcon from "../components/venues/VenueIcon.vue";
import VenueTimeSlotGrid from "../components/venues/VenueTimeSlotGrid.vue";

interface EventScheduleDetails {
  name?: string;
  proposedDate?: string;
  startTime?: string;
  endTime?: string;
  expectedAttendance?: number | string;
}

const route = useRoute();

const filters = ref(emptyVenueFilters());
const options = ref<VenueFilterOptions | null>(null);
const venues = ref<Venue[]>([]);
const relax = ref<RelaxOption[]>([]);
const loading = ref(true);
const errorMessage = ref<string | null>(null);

/** Set when the search was opened from an event (AC4). */
const sourceEvent = ref<EventSummary | null>(null);
const sourceEventError = ref<string | null>(null);

const sourceEventName = computed(() => {
  const details = sourceEvent.value?.submitted_details as EventScheduleDetails | undefined;
  return details?.name || (sourceEvent.value ? `Event #${sourceEvent.value.id}` : "");
});

/**
 * AC4: pre-fill from the event's schedule and expected attendance. Only
 * fields the event actually has are copied — a missing end time leaves
 * the window empty (whole-day check) rather than half-set. Attendance
 * becomes the minimum capacity, since there's no separate attendance chip.
 */
function prefillFromEvent(event: EventSummary): void {
  const details = event.submitted_details as EventScheduleDetails;
  if (details.proposedDate) filters.value.date = details.proposedDate;
  if (details.startTime && details.endTime) {
    filters.value.startTime = details.startTime;
    filters.value.endTime = details.endTime;
  }
  const attendance = Number(details.expectedAttendance);
  if (Number.isInteger(attendance) && attendance > 0) filters.value.capacityMin = attendance;
}

/**
 * E4-8: a venue can only be requested for an event, so the action appears
 * only when the search was opened from one (?eventId=) and that event is
 * still in Planning — the only status a booking request may be made in
 * (AGENTS.md §3a). The outcome stays on the card it came from: a refusal
 * carries the clashing occupied window, which is the point of the message
 * (AC4/AC6).
 */
const canRequest = computed(() => sourceEvent.value?.status === "Planning");

const requestingVenueId = ref<number | null>(null);
const requestedVenueIds = ref<Set<number>>(new Set());
const requestErrorVenueId = ref<number | null>(null);
const requestError = ref("");

async function requestVenue(venueId: number): Promise<void> {
  const event = sourceEvent.value;
  if (!event) return;

  requestingVenueId.value = venueId;
  requestErrorVenueId.value = null;
  requestError.value = "";
  try {
    await submitVenueBooking(event.id, venueId);
    requestedVenueIds.value = new Set(requestedVenueIds.value).add(venueId);
  } catch (err) {
    requestErrorVenueId.value = venueId;
    requestError.value = describeBookingFailure(err, "Failed to request this venue");
  } finally {
    requestingVenueId.value = null;
  }
}

// Responses can land out of order when filters change quickly; only the
// latest request is allowed to update the results.
let requestSeq = 0;

async function runSearch(): Promise<void> {
  if (timeWindowError(filters.value) || (filters.value.capacityMin && filters.value.capacityMax && filters.value.capacityMin > filters.value.capacityMax)) {
    // The filter bar is already showing the problem inline; keep the last
    // good results on screen rather than blanking them.
    return;
  }

  const seq = ++requestSeq;
  loading.value = true;
  errorMessage.value = null;
  try {
    const result = await searchVenues(filters.value);
    if (seq !== requestSeq) return;
    venues.value = result.venues;
    relax.value = result.relax;
  } catch (err) {
    if (seq !== requestSeq) return;
    errorMessage.value =
      err instanceof VenueSearchError && Object.keys(err.fields).length > 0
        ? Object.values(err.fields).join(" ")
        : "We couldn't search venues. Please try again.";
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

// Typing in the search box shouldn't fire a request per keystroke; chip
// changes get the same short delay so ticking several boxes is one search.
let debounce: ReturnType<typeof setTimeout> | undefined;
let ready = false;
watch(
  filters,
  () => {
    if (!ready) return;
    clearTimeout(debounce);
    debounce = setTimeout(runSearch, 250);
  },
  { deep: true },
);

onBeforeUnmount(() => clearTimeout(debounce));

function relaxFilter(key: CriterionKey): void {
  clearCriterion(filters.value, key);
}

function clearAllFilters(): void {
  Object.assign(filters.value, emptyVenueFilters());
}

/** Tags matching an active filter are highlighted so it's clear why a venue made the cut. */
function isSelected(group: "accessibility" | "layouts" | "facilities", value: string): boolean {
  return filters.value[group].some((v) => v.toLowerCase() === value.toLowerCase());
}

const resultSummary = computed(() => {
  const n = venues.value.length;
  return `${n} venue${n === 1 ? "" : "s"} ${sourceEvent.value ? "available for this event" : "match your filters"}`;
});

// ---- AC "Available time slots" tab -----------------------------------

const resultsTab = ref<"browse" | "timeslots">("browse");
const availabilityByVenue = ref<Map<number, VenueAvailability>>(new Map());
const availabilityLoading = ref(false);
const availabilityError = ref<string | null>(null);
const selectedVenueId = ref<number | null>(null);
let availabilityCacheKey = "";

const eventWindow = computed(() => {
  const { startTime, endTime } = filters.value;
  return startTime && endTime ? { start: startTime, end: endTime } : null;
});

const dateLabel = computed(() => {
  if (!filters.value.date) return "";
  return fromKey(filters.value.date).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
});

async function loadAvailability(): Promise<void> {
  const date = filters.value.date;
  if (resultsTab.value !== "timeslots" || !date || venues.value.length === 0) return;

  const key = `${date}|${venues.value.map((v) => v.id).join(",")}`;
  if (key === availabilityCacheKey) return;
  availabilityCacheKey = key;

  const target: AvailabilityTarget = {
    fromDate: date,
    toDate: date,
    startTime: filters.value.startTime || null,
    endTime: filters.value.endTime || null,
  };

  availabilityLoading.value = true;
  availabilityError.value = null;
  try {
    const results = await Promise.allSettled(
      venues.value.map((venue) => fetchVenueAvailability(venue.id, date, date, target)),
    );
    const next = new Map<number, VenueAvailability>();
    let anyOk = false;
    results.forEach((result, i) => {
      if (result.status === "fulfilled") {
        next.set(venues.value[i].id, result.value);
        anyOk = true;
      }
    });
    availabilityByVenue.value = next;
    if (!anyOk && venues.value.length > 0) availabilityError.value = "We couldn't load venue availability. Please try again.";
  } finally {
    availabilityLoading.value = false;
  }
}

watch([resultsTab, () => filters.value.date, venues], () => {
  if (resultsTab.value === "timeslots") void loadAvailability();
});

const selectedVenue = computed(() => venues.value.find((v) => v.id === selectedVenueId.value) ?? null);
const selectedSlot = ref<{ start: string; end: string } | null>(null);

function selectSlot(venueId: number, start: string, end: string): void {
  selectedVenueId.value = venueId;
  selectedSlot.value = { start, end };
}

onMounted(async () => {
  const eventId = typeof route.query.eventId === "string" ? route.query.eventId : null;

  const [optionsResult, eventResult] = await Promise.allSettled([
    fetchVenueFilterOptions(),
    eventId ? fetchEventById(eventId) : Promise.resolve(null),
  ]);

  if (optionsResult.status === "fulfilled") options.value = optionsResult.value;

  if (eventResult.status === "fulfilled" && eventResult.value) {
    sourceEvent.value = eventResult.value;
    prefillFromEvent(eventResult.value);
  } else if (eventResult.status === "rejected") {
    sourceEventError.value = "We couldn't load that event, so the search hasn't been pre-filled.";
  }

  ready = true;
  await runSearch();
});
</script>

<template>
  <!--
    Column mapping — Venue Search
    Desktop (12-col): outer container col 1-12 (grid-desktop-margin 80px); header, filter bar and results col 1-12, full width.
    Tablet (6-col): all content col 1-6, full width, grid-tablet-margin 32px.
    Mobile (4-col): all content col 1-4, full width, grid-mobile-margin 6px.
    Nested grid: results use a local grid matching the content area's column count (12 desktop / 6 tablet / 4 mobile);
    cards span 4 (3 per row) desktop, 3 (2 per row) tablet, 4 (1 per row) mobile.
  -->
  <div class="page">
    <div class="content">
      <RouterLink v-if="sourceEvent" :to="{ name: 'event-detail', params: { id: sourceEvent.id } }"
        class="back-link body-small">
        <VenueIcon name="chevron-left" :size="16" />
        Back to {{ sourceEventName }}
      </RouterLink>

      <div class="page-header">
        <div>
          <h1 class="h2">Find a venue</h1>
          <p class="subheading">Filter venues by availability and requirements.</p>
        </div>
      </div>

      <div v-if="sourceEvent" class="context-banner body-small">
        Searching for <strong>{{ sourceEventName }}</strong> — pre-filled with the event's date and time, and its
        expected attendance as the minimum capacity. Adjust any filter to widen the search.
      </div>
      <p v-else-if="sourceEventError" class="context-banner context-banner--warning body-small">{{ sourceEventError }}
      </p>

      <VenueFilterBar v-model="filters" :options="options" />

      <div class="tabs" role="tablist" aria-label="Results view">
        <button type="button" class="tab" :class="{ 'tab--active': resultsTab === 'browse' }"
          role="tab" :aria-selected="resultsTab === 'browse'" @click="resultsTab = 'browse'">
          Browse venues
        </button>
        <button type="button" class="tab" :class="{ 'tab--active': resultsTab === 'timeslots' }"
          role="tab" :aria-selected="resultsTab === 'timeslots'" @click="resultsTab = 'timeslots'">
          Available time slots
        </button>
      </div>

      <section v-if="resultsTab === 'timeslots'" class="timeslots" aria-live="polite">
        <div v-if="!filters.date" class="empty-state">
          <p class="empty-state__title">Pick a date</p>
          <p class="body-default muted">Set a date filter to see venue availability for that day.</p>
        </div>

        <template v-else>
          <div class="timeslots__toolbar">
            <p class="body-small muted">
              Showing {{ venues.length }} venue{{ venues.length === 1 ? "" : "s" }}
              <template v-if="eventWindow"> · all available for your event, {{ eventWindow.start }}–{{ eventWindow.end }}</template>
            </p>
          </div>

          <p v-if="availabilityError" class="body-default error-text">{{ availabilityError }}</p>
          <p v-else-if="availabilityLoading && availabilityByVenue.size === 0" class="body-default muted">Loading availability…</p>
          <VenueTimeSlotGrid v-else :venues="venues" :date="filters.date" :availability="availabilityByVenue"
            :event-window="eventWindow" :selected-venue-id="selectedVenueId" @select="selectSlot" />

          <div v-if="selectedVenue" class="selection-bar">
            <div>
              <p class="selection-bar__venue">{{ selectedVenue.name }}</p>
              <p class="body-small muted">
                {{ dateLabel }} · {{ selectedSlot?.start }}–{{ selectedSlot?.end }} · Capacity {{ selectedVenue.capacity }}
              </p>
            </div>
            <template v-if="canRequest">
              <p v-if="requestedVenueIds.has(selectedVenue.id)" class="body-small requested-note" role="status">
                Requested — awaiting Venue Staff
              </p>
              <button v-else type="button" class="request-btn" :disabled="requestingVenueId === selectedVenue.id"
                @click="requestVenue(selectedVenue.id)">
                {{ requestingVenueId === selectedVenue.id ? "Requesting…" : "Request this venue" }}
              </button>
            </template>
          </div>
          <p v-if="requestErrorVenueId === selectedVenueId" class="body-small error-text" role="alert">
            {{ requestError }}
          </p>
        </template>
      </section>

      <section v-else class="results" aria-live="polite" :aria-busy="loading">
        <p v-if="errorMessage" class="body-default error-text">{{ errorMessage }}</p>

        <template v-else-if="!loading || venues.length > 0">
          <!-- AC3 -->
          <div v-if="venues.length === 0" class="empty-state">
            <p class="empty-state__title">No results found</p>
            <p class="body-default muted">No venue matches all of your filters.</p>

            <button type="button" class="btn btn--ghost empty-state__clear" @click="clearAllFilters">
              Clear all filters
            </button>
          </div>

          <template v-else>
            <p class="body-small muted results__count" :class="{ 'results__count--stale': loading }">
              {{ resultSummary }}
            </p>
            <ul class="card-grid" :class="{ 'card-grid--stale': loading }">
              <li v-for="venue in venues" :key="venue.id" class="venue-card">
                <div class="venue-card__header">
                  <p class="card-title">{{ venue.name }}</p>
                  <span class="capacity-badge">
                    <VenueIcon name="users" :size="14" />
                    {{ venue.capacity }}
                  </span>
                </div>
                <p class="venue-card__location body-small muted">
                  <VenueIcon name="location" :size="14" />
                  {{ venue.location }}
                </p>
                <p v-if="venue.description" class="body-small venue-card__description">{{ venue.description }}</p>

                <hr class="card-divider" />

                <dl class="venue-card__attributes">
                  <div class="attribute">
                    <dt class="attribute__label">Layouts</dt>
                    <dd class="tags">
                      <span v-for="layout in venue.layouts" :key="layout" class="tag"
                        :class="{ 'tag--match': isSelected('layouts', layout) }">{{ layout }}</span>
                    </dd>
                  </div>
                  <div class="attribute">
                    <dt class="attribute__label">Facilities</dt>
                    <dd class="tags">
                      <span v-for="facility in venue.facilities" :key="facility" class="tag"
                        :class="{ 'tag--match': isSelected('facilities', facility) }">{{ facility }}</span>
                    </dd>
                  </div>
                  <div class="attribute">
                    <dt class="attribute__label">Accessibility</dt>
                    <dd class="tags">
                      <span v-for="feature in venue.accessibility" :key="feature" class="tag"
                        :class="{ 'tag--match': isSelected('accessibility', feature) }">{{ feature }}</span>
                      <span v-if="venue.accessibility.length === 0" class="body-small muted">None listed</span>
                    </dd>
                  </div>
                </dl>

                <template v-if="canRequest">
                  <p v-if="requestedVenueIds.has(venue.id)" class="body-small requested-note" role="status">
                    Requested — awaiting Venue Staff
                  </p>
                  <button v-else type="button" class="request-btn" :disabled="requestingVenueId === venue.id"
                    @click="requestVenue(venue.id)">
                    {{ requestingVenueId === venue.id ? "Requesting…" : "Request this venue" }}
                  </button>
                  <p v-if="requestErrorVenueId === venue.id" class="body-small error-text" role="alert">
                    {{ requestError }}
                  </p>
                </template>
              </li>
            </ul>
          </template>
        </template>

        <p v-else class="body-default muted">Searching venues…</p>
      </section>
    </div>
  </div>
</template>

<style scoped>
.page {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: var(--grid-desktop-gutter);
  padding: var(--spacing-40) var(--grid-desktop-margin);
  align-content: start;
}

.content {
  grid-column: 1 / 13;
}

@media (max-width: 1024px) {
  .page {
    grid-template-columns: repeat(6, 1fr);
    padding: var(--spacing-32) var(--grid-tablet-margin);
  }

  .content {
    grid-column: 1 / 7;
  }
}

@media (max-width: 640px) {
  .page {
    grid-template-columns: repeat(4, 1fr);
    padding: var(--spacing-24) var(--grid-mobile-margin);
  }

  .content {
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

.subheading {
  font-size: 1.125rem;
  font-weight: 400;
  line-height: 1.375rem;
  color: var(--color-grey-500);
  margin: var(--spacing-8) 0 var(--spacing-24);
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

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--spacing-16);
}

/* Style.md 3.4 ghost button: no fill until hover. */
.close-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  border-radius: var(--radius-full);
  color: var(--color-grey-700);
}

.close-button:hover {
  background: var(--color-grey-75);
  color: var(--color-grey-900);
}

.back-link {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-4);
  margin-bottom: var(--spacing-16);
  font-weight: 700;
}

.context-banner {
  margin: 0 0 var(--spacing-24);
  padding: var(--spacing-12) var(--spacing-16);
  background: var(--color-purple-100);
  border: 1px solid var(--color-purple-200);
  border-radius: var(--radius-xs);
  color: var(--color-purple-800);
}

.context-banner--warning {
  background: var(--color-warning-100);
  border-color: var(--color-warning-200);
  color: var(--color-warning-900);
}

.tabs {
  display: flex;
  gap: var(--spacing-4);
  margin-top: var(--spacing-24);
  border-bottom: 1px solid var(--color-grey-100);
}

.tab {
  padding: var(--spacing-12) var(--spacing-4);
  margin-bottom: -1px;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--color-grey-500);
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  font-weight: 700;
  cursor: pointer;
}

.tab + .tab {
  margin-left: var(--spacing-16);
}

.tab--active {
  color: var(--color-purple-700);
  border-bottom-color: var(--color-purple-600);
}

.timeslots {
  margin-top: var(--spacing-24);
}

.timeslots__toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-12);
  margin-bottom: var(--spacing-16);
}

.selection-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-16);
  margin-top: var(--spacing-16);
  padding: var(--spacing-16) var(--spacing-24);
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
  position: sticky;
  bottom: var(--spacing-16);
}

.selection-bar__venue {
  margin: 0;
  font-size: 1rem;
  font-weight: 700;
  color: var(--color-grey-900);
}

.results {
  margin-top: var(--spacing-32);
}

.results__count {
  margin: 0 0 var(--spacing-16);
}

.results__count--stale,
.card-grid--stale {
  opacity: 0.6;
  transition: opacity 0.15s;
}

.card-grid {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: var(--grid-desktop-gutter);
  align-content: start;
  list-style: none;
  margin: 0;
  padding: 0;
}

/* Style.md 3.4 Button Hierarchy (primary) + 8.2 focus ring; radius-xs. */
.request-btn {
  margin-top: var(--spacing-16);
  padding: var(--spacing-12) var(--spacing-16);
  border: 1px solid transparent;
  border-radius: var(--radius-xs);
  background: var(--color-purple-600);
  color: var(--color-base-white);
  font-size: 0.875rem;
  font-weight: 700;
  cursor: pointer;
}

.request-btn:hover:not(:disabled) {
  background: var(--color-purple-700);
}

.request-btn:focus-visible {
  outline: 2px solid var(--color-purple-600);
  outline-offset: 2px;
}

.request-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.requested-note {
  margin-top: var(--spacing-16);
  color: var(--color-success-700);
  font-weight: 700;
}

.venue-card {
  grid-column: span 4;
  display: flex;
  flex-direction: column;
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
  padding: var(--spacing-24);
}

@media (max-width: 1024px) {
  .card-grid {
    grid-template-columns: repeat(6, 1fr);
  }

  .venue-card {
    grid-column: span 3;
  }
}

@media (max-width: 640px) {
  .card-grid {
    grid-template-columns: repeat(4, 1fr);
    gap: var(--grid-mobile-gutter);
  }

  .venue-card {
    grid-column: span 4;
  }
}

.venue-card__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--spacing-12);
}

.card-title {
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
  margin: 0;
}

.capacity-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-4);
  flex-shrink: 0;
  margin-top: var(--spacing-4);
  padding: var(--spacing-4) var(--spacing-8);
  border-radius: var(--radius-full);
  background: var(--color-blue-200);
  color: var(--color-blue-800);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
}

.venue-card__location {
  display: flex;
  align-items: center;
  gap: var(--spacing-4);
  margin: var(--spacing-4) 0 0;
}

.venue-card__description {
  margin: var(--spacing-12) 0 0;
  color: var(--color-grey-700);
}

.card-divider {
  border: none;
  border-top: 1px solid var(--color-grey-100);
  margin: var(--spacing-16) 0;
}

.venue-card__attributes {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-12);
  margin: 0;
}

.attribute__label {
  margin-bottom: var(--spacing-4);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  color: var(--color-grey-500);
}

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-4);
  margin: 0;
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

.tag--match {
  border-color: var(--color-purple-300);
  background: var(--color-purple-100);
  color: var(--color-purple-800);
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: var(--spacing-40) var(--spacing-24);
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
}

.empty-state__title {
  margin: 0 0 var(--spacing-8);
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
}

.empty-state__prompt {
  margin: var(--spacing-24) 0 var(--spacing-12);
  color: var(--color-grey-700);
  font-weight: 700;
}

.empty-state__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: var(--spacing-8);
}

.empty-state__clear {
  margin-top: var(--spacing-12);
  color: var(--color-blue-600)!important;
}

.empty-state__clear:hover {
  background-color: var(--color-blue-200)!important;
}

.btn {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-8);
  height: 40px;
  padding: 0 var(--spacing-16);
  border-radius: var(--radius-xs);
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  cursor: pointer;
}

.btn--outline {
  border: 1px solid var(--color-purple-300);
  background: transparent;
  color: var(--color-purple-600);
}

.btn--outline:hover {
  background: var(--color-purple-100);
}

.btn--ghost {
  border: none;
  background: transparent;
  color: var(--color-purple-600);
}

.btn--ghost:hover {
  background: var(--color-purple-100);
}

.btn__count {
  font-weight: 400;
  color: var(--color-grey-500);
}
</style>
