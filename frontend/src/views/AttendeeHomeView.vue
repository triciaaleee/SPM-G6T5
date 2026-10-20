<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { getStoredUser } from "../lib/auth.ts";
import { fetchMyRegistrations, type MyRegistration } from "../lib/registrationApi.ts";
import { registrationBadgeClass } from "../lib/registrationStatus.ts";
import EventCard, { type CardFact } from "../components/ui/EventCard.vue";
import { eventThumbnail, formatCardDate, formatCardTimeRange, isPastRegistration } from "../lib/attendeeEvents.ts";

/**
 * Attendee homepage: the events this attendee has registered for, split into
 * what is still to come and what has already happened. Only the fields
 * registration-service returns for an attendee are shown.
 */
type EventsTab = "upcoming" | "past" | "withdrawn" | "cancelled";

const registrations = ref<MyRegistration[]>([]);
const loading = ref(true);
const errorMessage = ref<string | null>(null);
const activeTab = ref<EventsTab>("upcoming");

function startsAt(registration: MyRegistration): number {
  const date = registration.event?.proposedDate;
  const time = registration.event?.startTime ?? "00:00";
  const value = date ? new Date(`${date}T${time}`).getTime() : NaN;
  return Number.isNaN(value) ? Number.MAX_SAFE_INTEGER : value;
}

// A withdrawn registration lives only under Withdrawn, whatever the event's
// date; Upcoming and Past hold the events the attendee still has a place in.
const active = computed(() => registrations.value.filter((r) => r.status === "Registered"));

// Soonest first for what's coming up; most recent first for what's done.
const upcoming = computed(() =>
  active.value.filter((r) => !isPastRegistration(r)).sort((a, b) => startsAt(a) - startsAt(b)),
);
const past = computed(() =>
  active.value.filter((r) => isPastRegistration(r)).sort((a, b) => startsAt(b) - startsAt(a)),
);
const withdrawn = computed(() =>
  registrations.value.filter((r) => r.status === "Withdrawn").sort((a, b) => startsAt(b) - startsAt(a)),
);
// Events the organiser cancelled (E3-6) — kept apart from the attendee's own withdrawals.
const cancelled = computed(() =>
  registrations.value.filter((r) => r.status === "Cancelled").sort((a, b) => startsAt(b) - startsAt(a)),
);

const tabs: { key: EventsTab; label: string }[] = [
  { key: "upcoming", label: "Upcoming" },
  { key: "past", label: "Past" },
  { key: "withdrawn", label: "Withdrawn" },
  { key: "cancelled", label: "Cancelled" },
];

const visible = computed(() => {
  if (activeTab.value === "past") return past.value;
  if (activeTab.value === "withdrawn") return withdrawn.value;
  if (activeTab.value === "cancelled") return cancelled.value;
  return upcoming.value;
});

const EMPTY_MESSAGES: Record<EventsTab, string> = {
  upcoming: "You have no upcoming events.",
  past: "You have no past events.",
  withdrawn: "You haven't withdrawn from any events.",
  cancelled: "None of your events have been cancelled.",
};

function eventTitle(registration: MyRegistration): string {
  return registration.event?.name || `Event #${registration.eventId}`;
}

/** Date and time each get their own line, then the venue. The accessibility note is on the event page only. */
function cardFacts(registration: MyRegistration): CardFact[] {
  const event = registration.event;
  const facts: CardFact[] = [
    { icon: "calendar", text: formatCardDate(event?.proposedDate) },
    { icon: "clock", text: formatCardTimeRange(event?.startTime, event?.endTime) },
    { icon: "pin", text: venueLabel(registration) },
  ];
  return facts;
}

function venueLabel(registration: MyRegistration): string {
  const venues = registration.event?.venues ?? [];
  return venues.length > 0 ? venues.join(", ") : "Venue to be confirmed";
}

onMounted(async () => {
  try {
    const user = getStoredUser();
    if (!user) throw new Error("Not signed in");
    registrations.value = await fetchMyRegistrations(user.id);
  } catch {
    errorMessage.value = "We couldn't load your events. Please try again.";
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <!--
    Column mapping — Attendee homepage (My events)
    Desktop (12-col): outer container col 1-12 (grid-desktop-margin 80px); heading and tabs col 1-12; each card col span 4 (3 per row).
    Tablet (6-col): content col 1-6 full width, grid-tablet-margin 32px; each card col span 3 (2 per row).
    Mobile (4-col): content col 1-4 full width, grid-mobile-margin 6px; each card col span 4 (1 per row).
    Nested grid: the card list repeats the page's column count (12 / 6 / 4) so card spans line up with the heading.
  -->
  <div class="page">
    <div class="content">
      <div>
        <h1 class="h2">My events</h1>
        <p class="subheading">Events you have registered for.</p>
      </div>

      <div v-if="!loading && !errorMessage" class="tabs" role="tablist" aria-label="My events">
        <button
          v-for="tab in tabs"
          :id="`events-tab-${tab.key}`"
          :key="tab.key"
          type="button"
          role="tab"
          class="tab"
          :class="{ 'tab--active': activeTab === tab.key }"
          :aria-selected="activeTab === tab.key"
          aria-controls="events-panel"
          @click="activeTab = tab.key"
        >
          {{ tab.label }}
        </button>
      </div>

      <div id="events-panel" role="tabpanel" :aria-labelledby="`events-tab-${activeTab}`">
        <p v-if="loading" class="body-default muted">Loading your events…</p>
        <p v-else-if="errorMessage" class="body-default error-text" role="alert">{{ errorMessage }}</p>
        <p v-else-if="visible.length === 0" class="body-default muted">
          {{ EMPTY_MESSAGES[activeTab] }}
        </p>

        <ul v-else class="card-list">
          <li v-for="registration in visible" :key="registration.registrationId" class="card-item">
            <EventCard
              :to="{ name: 'attendee-event-detail', params: { id: registration.eventId } }"
              :thumbnail="eventThumbnail(registration.eventId)"
              :title="eventTitle(registration)"
              :description="registration.event?.description"
              :status-label="activeTab === 'past' ? 'Event over' : registration.status"
              :status-class="activeTab === 'past' ? 'status-over' : registrationBadgeClass(registration.status)"
              :facts="cardFacts(registration)"
              person-label="Organiser"
              :person-name="registration.event?.organiserName"
            />
          </li>
        </ul>
      </div>
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

/* Tabs: Style.md 2.4 — Purple 600 marks the active tab, same treatment as EventsListView. */
.tabs {
  display: flex;
  gap: var(--spacing-32);
  border-bottom: 1px solid var(--color-grey-100);
}

.tab {
  display: flex;
  align-items: center;
  appearance: none;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  padding: var(--spacing-12) var(--spacing-4);
  cursor: pointer;
  font-family: var(--font-family-lato);
  font-size: 1rem;
  line-height: 1.25rem;
  font-weight: 700;
  color: var(--color-grey-600);
}

.tab:hover {
  color: var(--color-grey-900);
}

.tab:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

.tab--active,
.tab--active:hover {
  color: var(--color-purple-600);
  border-bottom-color: var(--color-purple-600);
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

/* Past events: neutral grey, so a finished event doesn't read as a live one. */

/* Accessibility notes can run long: top-align the icon and keep cards even. */

</style>
