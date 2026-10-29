<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import PublicLayout from "../../components/public/PublicLayout.vue";
import PublicEventCard from "../../components/public/PublicEventCard.vue";
import VenueCard from "../../components/public/VenueCard.vue";
import AppButton from "../../components/ui/AppButton.vue";
import heroImage from "../../assets/event_thumbnail_1.jpg";
import {
  byStartTime,
  fetchPublicEventVenues,
  fetchPublicEvents,
  fetchPublicVenues,
  type PublicEvent,
  type PublicVenue,
} from "../../lib/publicApi";

/**
 * The guest landing page: what ConnectSphere is, a taste of upcoming events
 * and popular venues, and the way in (Sign up / Log in). Anyone can browse;
 * registering needs an attendee account.
 */
const PREVIEW_COUNT = 3;

const events = ref<PublicEvent[]>([]);
const venuesByEvent = ref(new Map<number, string[]>());
const venues = ref<PublicVenue[]>([]);
const eventsError = ref(false);
const venuesError = ref(false);
const loading = ref(true);

// Open events first (soonest first), then the rest, so the preview shows something you can sign up for.
const previewEvents = computed(() =>
  [...events.value]
    .sort((a, b) => Number(b.open) - Number(a.open) || byStartTime(a, b))
    .slice(0, PREVIEW_COUNT),
);

// "Popular": the venues hosting the most upcoming events, then the largest.
const previewVenues = computed(() =>
  [...venues.value]
    .sort((a, b) => b.upcomingEvents.length - a.upcomingEvents.length || b.capacity - a.capacity)
    .slice(0, PREVIEW_COUNT),
);

onMounted(async () => {
  const [eventsResult, venuesResult] = await Promise.allSettled([fetchPublicEvents(), fetchPublicVenues()]);

  if (eventsResult.status === "fulfilled") {
    events.value = eventsResult.value;
    // Venue names are a nice-to-have on the cards: if they fail, the cards still show.
    venuesByEvent.value = await fetchPublicEventVenues(previewEvents.value.map((e) => e.id)).catch(() => new Map());
  } else {
    eventsError.value = true;
  }

  if (venuesResult.status === "fulfilled") venues.value = venuesResult.value;
  else venuesError.value = true;

  loading.value = false;
});
</script>

<template>
  <PublicLayout>
    <!--
      Column mapping — Landing
      Desktop (12-col, grid-desktop-margin 80px): hero heading col 2-11 centred; hero text col 4-9 centred; hero
        buttons col 1-12 centred; hero image col 3-10 centred. Section headings col 3-10 centred; card rows col 1-12,
        each card span 4 (3 per row); "Explore more" buttons col 1-12 centred.
      Tablet (6-col, grid-tablet-margin 32px): every block col 1-6 full width; cards span 3 (2 per row).
      Mobile (4-col, grid-mobile-margin 6px): every block col 1-4 full width; cards span 4 (1 per row).
      Nested grid: the card rows repeat the page's column count (12 / 6 / 4).
    -->
    <section class="page hero" aria-labelledby="hero-title">
      <h1 id="hero-title" class="h1 hero__title">
        Discover &amp; Connect with <span class="accent">Events</span> and <span class="accent">Venues</span>
      </h1>
      <p class="subheading hero__text">
        Find upcoming events, explore the venues that host them, and reserve your place in a few clicks.
        Everything happening around you, all in one place.
      </p>
      <div class="hero__actions">
        <AppButton variant="primary" :to="{ name: 'signup' }">Sign up for free</AppButton>
        <AppButton variant="outline" :to="{ name: 'public-events' }">Explore events</AppButton>
      </div>
      <img :src="heroImage" alt="A crowd enjoying a live event" class="hero__image" fetchpriority="high" decoding="async" />
    </section>

    <section class="page section" aria-labelledby="events-title">
      <div class="section__intro">
        <span class="tag">Events</span>
        <h2 id="events-title" class="h3">Explore Upcoming Events</h2>
        <p class="body-default muted">
          Browse what's coming up on ConnectSphere. Create a free attendee account to register and secure your spot.
        </p>
      </div>

      <p v-if="loading" class="section__status body-default muted">Loading events…</p>
      <p v-else-if="eventsError" class="section__status body-default error-text" role="alert">
        We couldn't load events. Please try again.
      </p>
      <p v-else-if="previewEvents.length === 0" class="section__status body-default muted">
        No events are listed right now. Check back soon.
      </p>
      <ul v-else class="card-list">
        <li v-for="event in previewEvents" :key="event.id" class="card-item">
          <PublicEventCard :event="event" :venues="venuesByEvent.get(event.id)" />
        </li>
      </ul>

      <div class="section__more">
        <AppButton variant="outline" :to="{ name: 'public-events' }">Explore more events</AppButton>
      </div>
    </section>

    <section class="page section" aria-labelledby="venues-title">
      <div class="section__intro">
        <span class="tag">Venues</span>
        <h2 id="venues-title" class="h3">Popular Venues</h2>
        <p class="body-default muted">
          From intimate rooms to grand halls, discover the spaces where our events come to life.
        </p>
      </div>

      <p v-if="loading" class="section__status body-default muted">Loading venues…</p>
      <p v-else-if="venuesError" class="section__status body-default error-text" role="alert">
        We couldn't load venues. Please try again.
      </p>
      <p v-else-if="previewVenues.length === 0" class="section__status body-default muted">No venues to show yet.</p>
      <ul v-else class="card-list">
        <li v-for="venue in previewVenues" :key="venue.id" class="card-item">
          <VenueCard :venue="venue" />
        </li>
      </ul>

      <div class="section__more">
        <AppButton variant="outline" :to="{ name: 'public-venues' }">Explore more venues</AppButton>
      </div>
    </section>
  </PublicLayout>
</template>

<style scoped>
.page {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  column-gap: var(--grid-desktop-gutter);
  align-content: start;
  padding: 0 var(--grid-desktop-margin);
}

/* Hero --------------------------------------------------------------------- */

.hero {
  row-gap: var(--spacing-24);
  padding-top: var(--spacing-80);
  padding-bottom: var(--spacing-80);
  background: var(--color-base-white);
  text-align: center;
}

.hero__title {
  grid-column: 2 / 12;
}

.accent {
  color: var(--color-purple-600);
}

.hero__text {
  grid-column: 4 / 10;
}

.hero__actions {
  grid-column: 1 / 13;
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: var(--spacing-12);
}

.hero__image {
  grid-column: 3 / 11;
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  margin-top: var(--spacing-24);
  border-radius: var(--radius-lg);
}

/* Sections ----------------------------------------------------------------- */

.section {
  row-gap: var(--spacing-32);
  padding-top: var(--spacing-80);
}

.section:last-of-type {
  padding-bottom: var(--spacing-80);
}

.section__intro {
  grid-column: 3 / 11;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--spacing-12);
  text-align: center;
}

.section__status,
.section__more {
  grid-column: 1 / 13;
  text-align: center;
}

.section__more {
  display: flex;
  justify-content: center;
}

/* Small Text / Tag in a Purple Primary pill. */
.tag {
  display: inline-flex;
  align-items: center;
  height: var(--spacing-24);
  padding: 0 var(--spacing-12);
  border-radius: var(--radius-full);
  background: var(--color-purple-100);
  color: var(--color-purple-700);
  font-size: 0.75rem;
  line-height: 1rem;
  font-weight: 700;
}

.card-list {
  grid-column: 1 / 13;
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

/* Text styles (Style.md 5) ------------------------------------------------- */

.h1 {
  margin: 0;
}

.h3 {
  margin: 0;
}

.subheading {
  margin: 0;
  color: var(--color-grey-600);
}

.body-default {
  margin: 0;
}

.muted {
  color: var(--color-grey-600);
}

.error-text {
  color: var(--color-error-600);
}

@media (max-width: 1024px) {
  .page {
    grid-template-columns: repeat(6, 1fr);
    column-gap: var(--grid-tablet-gutter);
    padding: 0 var(--grid-tablet-margin);
  }
  .hero { padding-top: var(--spacing-48); padding-bottom: var(--spacing-48); }
  .hero__title,
  .hero__text,
  .hero__actions,
  .hero__image,
  .section__intro,
  .section__status,
  .section__more,
  .card-list {
    grid-column: 1 / 7;
  }
  .card-list { grid-template-columns: repeat(6, 1fr); }
  .card-item { grid-column: span 3; }
}

@media (max-width: 640px) {
  .page {
    grid-template-columns: repeat(4, 1fr);
    column-gap: var(--grid-mobile-gutter);
    padding: 0 var(--grid-mobile-margin);
  }
  .hero { padding-top: var(--spacing-40); padding-bottom: var(--spacing-40); }
  .section { padding-top: var(--spacing-40); }
  .section:last-of-type { padding-bottom: var(--spacing-40); }
  .hero__title,
  .hero__text,
  .hero__actions,
  .hero__image,
  .section__intro,
  .section__status,
  .section__more,
  .card-list {
    grid-column: 1 / 5;
  }
  /* H4 on mobile, so the hero fits. */
  .h1 { font-size: 1.75rem; line-height: 2.25rem; }
  .card-list { grid-template-columns: repeat(4, 1fr); gap: var(--spacing-16); }
  .card-item { grid-column: span 4; }
}
</style>
