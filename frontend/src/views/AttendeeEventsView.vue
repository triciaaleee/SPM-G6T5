<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { getStoredUser } from "../lib/auth";
import { fetchMyRegistrations, type MyRegistration } from "../lib/registrationApi";
import { registrationBadgeClass } from "../lib/registrationStatus";
import { formatCardDate, formatCardTimeRange, isPastRegistration } from "../lib/attendeeEvents";

/**
 * Attendee homepage: the events this attendee has registered for, split into
 * what is still to come and what has already happened. Only the fields
 * registration-service returns for an attendee are shown.
 */
type EventsTab = "upcoming" | "past" | "withdrawn";

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

const tabs: { key: EventsTab; label: string }[] = [
  { key: "upcoming", label: "Upcoming" },
  { key: "past", label: "Past" },
  { key: "withdrawn", label: "Withdrawn" },
];

const visible = computed(() => {
  if (activeTab.value === "past") return past.value;
  if (activeTab.value === "withdrawn") return withdrawn.value;
  return upcoming.value;
});

const EMPTY_MESSAGES: Record<EventsTab, string> = {
  upcoming: "You have no upcoming events.",
  past: "You have no past events.",
  withdrawn: "You haven't withdrawn from any events.",
};

function eventTitle(registration: MyRegistration): string {
  return registration.event?.name || `Event #${registration.eventId}`;
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
            <article class="card">
              <!-- A finished event is "Event over" whatever the registration status was. -->
              <span v-if="activeTab === 'past'" class="badge status-over">Event over</span>
              <span v-else class="badge" :class="registrationBadgeClass(registration.status)">
                {{ registration.status }}
              </span>

              <div class="card-body">
                <h2 class="card-title">{{ eventTitle(registration) }}</h2>
                <p v-if="registration.event?.description" class="card-description">
                  {{ registration.event.description }}
                </p>
              </div>

              <ul class="card-facts">
                <li class="fact">
                  <svg class="fact__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5" /></svg>
                  <span>{{ formatCardDate(registration.event?.proposedDate) }}</span>
                </li>
                <li class="fact">
                  <svg class="fact__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>
                  <span>{{ formatCardTimeRange(registration.event?.startTime, registration.event?.endTime) }}</span>
                </li>
                <li class="fact">
                  <svg class="fact__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" /><path d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z" /></svg>
                  <span>{{ venueLabel(registration) }}</span>
                </li>
                <li v-if="registration.event?.accessibility" class="fact fact--accessibility">
                  <svg class="fact__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="4.5" r="1.75" /><path d="M5.5 8.5 12 10l6.5-1.5M12 10v4.5m0 0-3 6m3-6 3 6" /></svg>
                  <span class="fact__text">{{ registration.event.accessibility }}</span>
                </li>
              </ul>

              <hr class="card-divider" />

              <RouterLink
                :to="{ name: 'attendee-event-detail', params: { id: registration.eventId } }"
                class="btn-secondary"
              >
                View details
              </RouterLink>
            </article>
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

.card {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-16);
  padding: var(--spacing-24);
  box-sizing: border-box;
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
}

/* Status badge — no leading dot. */
.badge {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  height: var(--spacing-24);
  padding: 0 var(--spacing-12);
  border-radius: var(--radius-full);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
}

.status-success {
  background: var(--color-success-200);
  color: var(--color-success-700);
}

.status-warning {
  background: var(--color-warning-100);
  color: var(--color-warning-900);
}

/* Past events: neutral grey, so a finished event doesn't read as a live one. */
.status-over {
  background: var(--color-grey-200);
  color: var(--color-grey-900);
}

.card-body {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
}

.card-title {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
}

.card-description {
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-700);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.card-facts {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
}

.fact {
  display: flex;
  align-items: center;
  gap: var(--spacing-8);
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-600);
}

.fact__icon {
  flex: none;
  color: var(--color-grey-500);
}

/* Accessibility notes can run long: top-align the icon and keep cards even. */
.fact--accessibility {
  align-items: flex-start;
}

.fact--accessibility .fact__icon {
  margin-top: var(--spacing-2);
}

.fact__text {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.card-divider {
  margin: auto 0 0;
  border: none;
  border-top: 1px solid var(--color-grey-100);
}

/* Secondary button: Style.md 3.4 — outline in Purple 300, label in Purple 600. */
.btn-secondary {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  padding: 0 var(--spacing-24);
  border: 1px solid var(--color-purple-300);
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--color-purple-600);
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  text-decoration: none;
  cursor: pointer;
}

.btn-secondary:hover {
  background: var(--color-purple-100);
}

.btn-secondary:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}
</style>
