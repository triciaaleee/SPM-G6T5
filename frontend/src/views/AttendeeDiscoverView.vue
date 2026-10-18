<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { fetchOpenEvents, type OpenEvent } from "../lib/registrationApi";
import { registrationBadgeClass } from "../lib/registrationStatus";
import EventCard, { type CardFact } from "../components/ui/EventCard.vue";
import { eventThumbnail, formatCardDate, formatCardTimeRange, slotsLabel } from "../lib/attendeeEvents";

/**
 * Attendee "Discover events": every event open for registration. Each card
 * only links to the event's details page; registering happens there. Only
 * the fields registration-service returns for an open event are shown.
 */
const events = ref<OpenEvent[]>([]);
const loading = ref(true);
const errorMessage = ref<string | null>(null);
const query = ref("");

function startsAt(event: OpenEvent): number {
  const value = event.proposedDate ? new Date(`${event.proposedDate}T${event.startTime ?? "00:00"}`).getTime() : NaN;
  return Number.isNaN(value) ? Number.MAX_SAFE_INTEGER : value;
}

// Soonest first.
const sorted = computed(() => [...events.value].sort((a, b) => startsAt(a) - startsAt(b)));

// Keyword search over name/description, applied on top of the sort.
const filtered = computed(() => {
  const needle = query.value.trim().toLowerCase();
  if (!needle) return sorted.value;
  return sorted.value.filter((event) =>
    `${event.name ?? ""} ${event.description ?? ""}`.toLowerCase().includes(needle),
  );
});

/** Date and time each get their own line; any accessibility note follows. */
function cardFacts(event: OpenEvent): CardFact[] {
  const facts: CardFact[] = [
    { icon: "calendar", text: formatCardDate(event.proposedDate) },
    { icon: "clock", text: formatCardTimeRange(event.startTime, event.endTime) },
  ];
  if (event.accessibility) facts.push({ icon: "accessibility", text: event.accessibility, clamp: true });
  return facts;
}

/** Places left sit at the right end of the title row, not in the fact list. */
function slotsAside(event: OpenEvent): CardFact | null {
  if (event.slotsLeft == null) return null;
  return { icon: "people", text: slotsLabel(event.slotsLeft) ?? "", alert: event.slotsLeft === 0, testid: "slots-left" };
}

function eventTitle(event: OpenEvent): string {
  return event.name || `Event #${event.id}`;
}

onMounted(async () => {
  try {
    events.value = await fetchOpenEvents();
  } catch {
    errorMessage.value = "We couldn't load events. Please try again.";
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <!--
    Column mapping — Attendee discover events
    Desktop (12-col): outer container col 1-12 (grid-desktop-margin 80px); heading and count col 1-12; each card col span 4 (3 per row).
    Tablet (6-col): content col 1-6 full width, grid-tablet-margin 32px; each card col span 3 (2 per row).
    Mobile (4-col): content col 1-4 full width, grid-mobile-margin 6px; each card col span 4 (1 per row).
    Nested grid: the card list repeats the page's column count (12 / 6 / 4) so card spans line up with the heading.
  -->
  <div class="page">
    <div class="content">
      <div>
        <h1 class="h2">Events open for registration</h1>
        <p class="subheading">Find events you want to attend, then open one to register.</p>
      </div>

      <p v-if="loading" class="body-default muted">Loading events…</p>
      <p v-else-if="errorMessage" class="body-default error-text" role="alert">{{ errorMessage }}</p>

      <template v-else>
        <div class="search-box">
          <svg class="search-box__icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input v-model="query" type="search" class="search-box__input" placeholder="Search events" aria-label="Search events" />
          <button v-if="query" type="button" class="search-box__clear" aria-label="Clear search" @click="query = ''">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>

        <p v-if="sorted.length === 0" class="body-default muted">No events are open for registration right now.</p>
        <p v-else-if="filtered.length === 0" class="body-default muted">No events match "{{ query }}".</p>

        <template v-else>
          <p class="count">Showing {{ filtered.length }} {{ filtered.length === 1 ? "event" : "events" }}</p>

          <ul class="card-list">
            <li v-for="event in filtered" :key="event.id" class="card-item">
            <EventCard
              :to="{ name: 'attendee-event-detail', params: { id: event.id } }"
              :thumbnail="eventThumbnail(event.id)"
              :title="eventTitle(event)"
              :description="event.description"
              :status-label="event.registrationStatus ?? 'Open'"
              :status-class="event.registrationStatus ? registrationBadgeClass(event.registrationStatus) : 'status-open'"
              :facts="cardFacts(event)"
              :title-aside="slotsAside(event)"
              person-label="Organiser"
              :person-name="event.organiserName"
            />
          </li>
          </ul>
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
.page {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: var(--grid-desktop-gutter);
  padding: var(--spacing-40) var(--grid-desktop-margin) var(--spacing-80);
  align-content: start;
  min-height: 100vh;
}

.content {
  grid-column: 1 / 13;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-24);
}

@media (max-width: 1024px) {
  .page {
    grid-template-columns: repeat(6, 1fr);
    gap: var(--grid-tablet-gutter);
    padding: var(--spacing-40) var(--grid-tablet-margin) var(--spacing-80);
  }
  .content {
    grid-column: 1 / 7;
  }
}

@media (max-width: 640px) {
  .page {
    grid-template-columns: repeat(4, 1fr);
    gap: var(--grid-mobile-gutter);
    padding: var(--spacing-24) var(--grid-mobile-margin) var(--spacing-48);
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
  line-height: 1.375rem;
  color: var(--color-grey-600);
  margin: var(--spacing-8) 0 0;
}

.body-default {
  font-size: 1rem;
  line-height: 1.25rem;
  margin: 0;
}

.muted {
  color: var(--color-grey-500);
}

.error-text {
  color: var(--color-error-600);
}

.count {
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-600);
  margin: 0;
}

/* Search box: same pattern as VenueFilterBar.vue's .search-box. */
.search-box {
  display: flex;
  align-items: center;
  gap: var(--spacing-12);
  height: 56px;
  padding: 0 var(--spacing-16) 0 var(--spacing-24);
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-md);
}

.search-box:focus-within {
  border-color: var(--ring-brand);
  box-shadow: 0 0 0 4px var(--ring-light);
}

.search-box__icon {
  flex: none;
  color: var(--color-grey-700);
}

.search-box__input {
  flex: 1;
  min-width: 0;
  height: 100%;
  border: none;
  background: transparent;
  font-family: var(--font-family-lato);
  font-size: 1.125rem;
  line-height: 1.375rem;
  color: var(--color-grey-900);
}

.search-box__input::placeholder {
  color: var(--color-grey-300);
}

.search-box__input:focus-visible {
  outline: none;
  box-shadow: none;
}

.search-box__input::-webkit-search-cancel-button {
  display: none;
}

.search-box__clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-grey-700);
  cursor: pointer;
}

.search-box__clear:hover {
  background: var(--color-grey-75);
}

.search-box__clear:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

/* Card list: nested grid with the page's column count, each card spanning a third of it. */
.card-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: var(--spacing-32);
  align-content: start;
}

.card-item {
  grid-column: span 4;
  display: flex;
}

@media (max-width: 1024px) {
  .card-list {
    grid-template-columns: repeat(6, 1fr);
  }
  .card-item {
    grid-column: span 3;
  }
}

@media (max-width: 640px) {
  .card-list {
    grid-template-columns: repeat(4, 1fr);
    gap: var(--spacing-16);
  }
  .card-item {
    grid-column: span 4;
  }
}

/* Status badge — no leading dot. */

/* Open for registration, not registered yet: the Secondary Blue badge fill. */

/* No places left: the error text colour (Style.md UI state), icon included. */

/* Accessibility notes can run long: top-align the icon and keep cards even. */

</style>
