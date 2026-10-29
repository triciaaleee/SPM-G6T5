<script setup lang="ts">
import { computed } from "vue";
import { BuildingOffice2Icon, CalendarIcon, MapPinIcon, UsersIcon } from "@heroicons/vue/24/outline";
import type { PublicVenue } from "../../lib/publicApi";
import { formatCardDate } from "../../lib/attendeeEvents";

/**
 * A venue on the guest pages: what it is, where, how many it holds, and the
 * next publicly listed event there (linking to that event). Venues have no
 * photos yet, so the image area is a plain branded tile — swap in a real
 * picture once venues carry one.
 */
const props = defineProps<{ venue: PublicVenue }>();

const nextEvent = computed(() => props.venue.upcomingEvents[0] ?? null);
const moreEvents = computed(() => Math.max(0, props.venue.upcomingEvents.length - 1));

/** Layouts double as the venue's "type" line; at most three keep cards even. */
const layouts = computed(() => props.venue.layouts.slice(0, 3).join(" · "));
</script>

<template>
  <article class="venue-card">
    <div class="venue-card__image" aria-hidden="true">
      <BuildingOffice2Icon class="venue-card__image-icon" />
    </div>

    <div class="venue-card__body">
      <h3 class="venue-card__title">{{ venue.name }}</h3>

      <ul class="facts">
        <li class="fact"><MapPinIcon class="fact__icon" aria-hidden="true" />{{ venue.location }}</li>
        <li class="fact"><UsersIcon class="fact__icon" aria-hidden="true" />Up to {{ venue.capacity }} guests</li>
        <li v-if="layouts" class="fact fact--muted">{{ layouts }}</li>
      </ul>

      <p v-if="venue.description" class="venue-card__description">{{ venue.description }}</p>

      <div class="next-event" :class="{ 'next-event--none': !nextEvent }">
        <template v-if="nextEvent">
          <span class="next-event__label">Next event</span>
          <RouterLink :to="{ name: 'public-event-detail', params: { id: nextEvent.id } }" class="next-event__link">
            {{ nextEvent.name || `Event #${nextEvent.id}` }}
          </RouterLink>
          <span class="next-event__date">
            <CalendarIcon class="fact__icon" aria-hidden="true" />{{ formatCardDate(nextEvent.proposedDate) }}
            <template v-if="moreEvents > 0"> · +{{ moreEvents }} more</template>
          </span>
        </template>
        <span v-else class="next-event__label">No upcoming events</span>
      </div>
    </div>
  </article>
</template>

<style scoped>
.venue-card {
  display: flex;
  flex-direction: column;
  width: 100%;
  overflow: hidden;
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
}

/* Placeholder until venues have photos: same 3:1 ratio as event thumbnails. */
.venue-card__image {
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 3 / 1;
  background: var(--color-purple-50);
}

.venue-card__image-icon {
  width: var(--spacing-48);
  height: var(--spacing-48);
  color: var(--color-purple-300);
}

.venue-card__body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-12);
  padding: var(--spacing-24);
}

/* H6 */
.venue-card__title {
  margin: 0;
  font-size: 1.25rem;
  line-height: 1.75rem;
  font-weight: 700;
  color: var(--color-grey-900);
}

.facts {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
}

/* Body Small */
.fact {
  display: flex;
  align-items: center;
  gap: var(--spacing-8);
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-700);
}

.fact--muted {
  color: var(--color-grey-600);
}

.fact__icon {
  flex: none;
  width: var(--spacing-16);
  height: var(--spacing-16);
  color: var(--color-grey-600);
}

/* Body Small, two lines max. */
.venue-card__description {
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-600);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.next-event {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-4);
  padding: var(--spacing-12) var(--spacing-16);
  background: var(--color-purple-50);
  border-radius: var(--radius-xs);
}

.next-event--none {
  background: var(--color-grey-50);
}

/* Small Text / Tag */
.next-event__label {
  font-size: 0.75rem;
  line-height: 1rem;
  font-weight: 700;
  color: var(--color-grey-600);
}

/* Body Small, bold link */
.next-event__link {
  font-size: 0.875rem;
  line-height: 1.125rem;
  font-weight: 700;
  color: var(--color-purple-600);
  text-decoration: none;
}

.next-event__link:hover {
  color: var(--color-purple-700);
  text-decoration: underline;
}

.next-event__link:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

/* Small Text */
.next-event__date {
  display: flex;
  align-items: center;
  gap: var(--spacing-4);
  font-size: 0.75rem;
  line-height: 1rem;
  color: var(--color-grey-600);
}
</style>
