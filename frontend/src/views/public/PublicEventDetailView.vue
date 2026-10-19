<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { CalendarIcon, ChevronRightIcon, ClockIcon, MapPinIcon, UserIcon } from "@heroicons/vue/24/outline";
import PublicLayout from "../../components/public/PublicLayout.vue";
import AppButton from "../../components/ui/AppButton.vue";
import {
  PublicEventNotFoundError,
  fetchPublicEvent,
  fetchPublicEventVenues,
  type PublicEvent,
} from "../../lib/publicApi";
import { registrationStateBadge } from "../../lib/registrationStatus";
import { eventThumbnail, formatCardTimeRange, formatLongDate } from "../../lib/attendeeEvents";

/**
 * One listed event, for a guest. They can read everything an attendee sees
 * before registering, but registering needs an account (E6 AC: guest
 * registration is not permitted) — so the Register action sends them to
 * sign up (or log in), and from there straight back to this event's
 * attendee page to finish registering.
 */
const route = useRoute();
const eventId = String(route.params.id);

const event = ref<PublicEvent | null>(null);
const venues = ref<string[]>([]);
const loading = ref(true);
const notFound = ref(false);
const errorMessage = ref<string | null>(null);

/** Where the attendee registers once signed in. */
const attendeePath = `/attendee/events/${eventId}`;
const signupLink = { name: "signup", query: { redirect: attendeePath } };
const loginLink = { name: "login", query: { redirect: attendeePath } };

const badge = computed(() => registrationStateBadge(event.value?.registrationState));

const paragraphs = computed(() =>
  (event.value?.description ?? "")
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean),
);

onMounted(async () => {
  try {
    event.value = await fetchPublicEvent(eventId);
  } catch (err) {
    if (err instanceof PublicEventNotFoundError) notFound.value = true;
    else errorMessage.value = "We couldn't load this event. Please try again.";
    loading.value = false;
    return;
  }
  loading.value = false;
  venues.value = (await fetchPublicEventVenues([event.value.id]).catch(() => new Map())).get(event.value.id) ?? [];
});
</script>

<template>
  <PublicLayout>
    <!--
      Column mapping — Public event detail
      Desktop (12-col, grid-desktop-margin 80px): breadcrumb and banner col 1-12; main column (title, description,
        details, accessibility) col 1-8; registration panel col 9-12.
      Tablet (6-col, grid-tablet-margin 32px): everything col 1-6, the registration panel below the title.
      Mobile (4-col, grid-mobile-margin 6px): everything col 1-4, the registration panel below the title.
    -->
    <div class="page">
      <nav class="breadcrumb full" aria-label="Breadcrumb">
        <RouterLink :to="{ name: 'welcome' }" class="breadcrumb__link">Home</RouterLink>
        <ChevronRightIcon class="breadcrumb__icon" aria-hidden="true" />
        <RouterLink :to="{ name: 'public-events' }" class="breadcrumb__link">Events</RouterLink>
        <ChevronRightIcon class="breadcrumb__icon" aria-hidden="true" />
        <span aria-current="page">{{ event?.name || "Event" }}</span>
      </nav>

      <p v-if="loading" class="full body-default muted">Loading event…</p>

      <section v-else-if="notFound" class="full notice" role="alert">
        <h1 class="h4">This event isn't available</h1>
        <p class="body-default muted">It may have ended, or registration hasn't opened yet.</p>
        <AppButton variant="outline" :to="{ name: 'public-events' }">Browse events</AppButton>
      </section>

      <p v-else-if="errorMessage || !event" class="full body-default error-text" role="alert">{{ errorMessage }}</p>

      <template v-else>
        <img :src="eventThumbnail(event.id)" alt="" class="full banner" />

        <div class="main">
          <span class="badge" :class="badge.className">{{ badge.label }}</span>
          <h1 class="h2">{{ event.name || `Event #${event.id}` }}</h1>

          <div v-if="paragraphs.length > 0" class="description">
            <p v-for="(paragraph, index) in paragraphs" :key="index" class="body-default">{{ paragraph }}</p>
          </div>

          <ul class="details" aria-label="Event details">
            <li class="detail">
              <CalendarIcon class="detail__icon" aria-hidden="true" />
              <span class="detail__label">Date</span>
              <span class="detail__value">{{ formatLongDate(event.proposedDate) }}</span>
            </li>
            <li class="detail">
              <ClockIcon class="detail__icon" aria-hidden="true" />
              <span class="detail__label">Time</span>
              <span class="detail__value">{{ formatCardTimeRange(event.startTime, event.endTime) }}</span>
            </li>
            <li class="detail">
              <MapPinIcon class="detail__icon" aria-hidden="true" />
              <span class="detail__label">Venue</span>
              <span class="detail__value">{{ venues.length > 0 ? venues.join(", ") : "To be confirmed" }}</span>
            </li>
            <li v-if="event.organiserName" class="detail">
              <UserIcon class="detail__icon" aria-hidden="true" />
              <span class="detail__label">Organiser</span>
              <span class="detail__value">{{ event.organiserName }}</span>
            </li>
          </ul>

          <div v-if="event.accessibility" class="accessibility">
            <h2 class="h6">Accessibility</h2>
            <p class="body-default">{{ event.accessibility }}</p>
          </div>
        </div>

        <aside class="register-panel" aria-labelledby="register-title">
          <h2 id="register-title" class="h6">Register for this event</h2>
          <template v-if="event.open">
            <p class="body-small muted" data-testid="guest-register-note">
              Guest registration isn't available. Sign up for a free attendee account, or log in, to reserve your place.
            </p>
            <AppButton variant="primary" size="xl" block :to="signupLink">Sign up to register</AppButton>
            <p class="body-small muted login-hint">
              Already have an account? <RouterLink :to="loginLink" class="link">Log in to register</RouterLink>
            </p>
          </template>
          <p v-else class="body-small muted" data-testid="registration-closed">Registration for this event is closed.</p>
        </aside>
      </template>
    </div>
  </PublicLayout>
</template>

<style scoped>
.page {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  column-gap: var(--grid-desktop-gutter);
  row-gap: var(--spacing-24);
  align-content: start;
  padding: var(--spacing-32) var(--grid-desktop-margin) var(--spacing-80);
}

.full {
  grid-column: 1 / 13;
}

.main {
  grid-column: 1 / 9;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--spacing-16);
}

.register-panel {
  grid-column: 9 / 13;
  align-self: start;
  position: sticky;
  top: var(--spacing-80);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-16);
  padding: var(--spacing-24);
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
}

.breadcrumb {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--spacing-4);
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-900);
}

.breadcrumb__link {
  color: var(--color-grey-500);
  text-decoration: none;
}

.breadcrumb__link:hover {
  color: var(--color-purple-700);
}

.breadcrumb__link:focus-visible,
.link:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

.breadcrumb__icon {
  width: var(--spacing-16);
  height: var(--spacing-16);
  color: var(--color-grey-400);
}

.banner {
  width: 100%;
  aspect-ratio: 3 / 1;
  object-fit: cover;
  border-radius: var(--radius-lg);
}

.notice {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--spacing-12);
  padding: var(--spacing-24);
  background: var(--color-grey-50);
  border-radius: var(--radius-lg);
}

/* Status badge: same colours as EventCard's (Style.md 3.4 Event card). */
.badge {
  display: inline-flex;
  align-items: center;
  height: var(--spacing-24);
  padding: 0 var(--spacing-12);
  border-radius: var(--radius-full);
  font-size: 0.75rem;
  line-height: 1rem;
  font-weight: 700;
}

.status-open {
  background: var(--color-blue-200);
  color: var(--color-blue-800);
}

.status-warning {
  background: var(--color-warning-100);
  color: var(--color-warning-900);
}

.description {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-12);
  max-width: 720px;
}

.details {
  list-style: none;
  width: 100%;
  margin: var(--spacing-8) 0 0;
  padding: var(--spacing-16) 0;
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--spacing-16) var(--spacing-32);
  border-top: 1px solid var(--color-grey-100);
  border-bottom: 1px solid var(--color-grey-100);
}

.detail {
  display: grid;
  grid-template-columns: auto 1fr;
  grid-template-rows: auto auto;
  column-gap: var(--spacing-12);
  align-items: center;
}

.detail__icon {
  grid-row: 1 / 3;
  width: var(--spacing-24);
  height: var(--spacing-24);
  color: var(--color-purple-600);
}

/* Small Text / Tag */
.detail__label {
  font-size: 0.75rem;
  line-height: 1rem;
  font-weight: 700;
  color: var(--color-grey-500);
}

/* Body Default */
.detail__value {
  font-size: 1rem;
  line-height: 1.25rem;
  color: var(--color-grey-900);
}

.accessibility {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
}

.login-hint {
  text-align: center;
}

.link {
  color: var(--color-purple-600);
  font-weight: 700;
}

.link:hover {
  color: var(--color-purple-700);
}

/* Text styles (Style.md 5) */
.h2 {
  margin: 0;
  font-size: 2.25rem;
  line-height: 2.625rem;
  font-weight: 700;
  color: var(--color-grey-900);
}

.h4 {
  margin: 0;
  font-size: 1.75rem;
  line-height: 2.25rem;
  font-weight: 700;
  color: var(--color-grey-900);
}

.h6 {
  margin: 0;
  font-size: 1.25rem;
  line-height: 1.75rem;
  font-weight: 700;
  color: var(--color-grey-900);
}

.body-default {
  margin: 0;
  font-size: 1rem;
  line-height: 1.25rem;
  color: var(--color-grey-700);
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

@media (max-width: 1024px) {
  .page {
    grid-template-columns: repeat(6, 1fr);
    column-gap: var(--grid-tablet-gutter);
    padding: var(--spacing-32) var(--grid-tablet-margin) var(--spacing-80);
  }
  .full,
  .main,
  .register-panel {
    grid-column: 1 / 7;
  }
  .register-panel { position: static; grid-row: 4; }
}

@media (max-width: 640px) {
  .page {
    grid-template-columns: repeat(4, 1fr);
    column-gap: var(--grid-mobile-gutter);
    padding: var(--spacing-24) var(--grid-mobile-margin) var(--spacing-48);
  }
  .full,
  .main,
  .register-panel {
    grid-column: 1 / 5;
  }
  .details { grid-template-columns: 1fr; }
}
</style>
