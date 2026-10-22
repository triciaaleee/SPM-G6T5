<script setup lang="ts">
import { computed, useSlots } from "vue";
import type { RouteLocationRaw } from "vue-router";

/**
 * The one event card (Style.md 3.4, "Event card"), based on the organiser's
 * list card. The whole card is a link to the event. Facts are passed in as
 * data (icon, text) so every page lays them out the same way: date, time
 * (with the clock icon), then venue and the rest, each on its own line.
 */
export interface CardFact {
  icon: "calendar" | "clock" | "pin" | "people" | "accessibility";
  text: string;
  /** Clamp long text (an accessibility note) to two lines. */
  clamp?: boolean;
  /** Draw the fact in the error colour (e.g. "Full"). */
  alert?: boolean;
  /** Hook for tests and automation. */
  testid?: string;
}

const props = withDefaults(
  defineProps<{
    to: RouteLocationRaw;
    thumbnail: string;
    title: string;
    /** Optional blurb under the title, clamped to two lines. */
    description?: string | null;
    statusLabel: string;
    /** One of the status-* badge classes (status-success, status-warning, status-error, status-info, status-open, status-over). */
    statusClass: string;
    /** A leading dot on the status badge. */
    dot?: boolean;
    /** Extra badges beside the status, e.g. "Registration Required". */
    extraBadges?: string[];
    facts?: CardFact[];
    /** One short fact at the right end of the title row (e.g. "12 slots left"). */
    titleAside?: CardFact | null;
    /** "Coordinator" or "Organiser": the label of the person line. */
    personLabel?: string;
    personName?: string | null;
    /** Shown instead of a name when there isn't one; without it the person line is hidden. */
    personEmpty?: string;
    /** A small line in the footer, e.g. "Submitted: 12/10/2026". */
    meta?: string;
  }>(),
  { description: null, dot: true, extraBadges: () => [], facts: () => [], titleAside: null, personName: null },
);

const slots = useSlots();

const personText = computed(() => {
  if (!props.personLabel) return null;
  const name = props.personName?.trim();
  if (name) return `${props.personLabel}: ${name}`;
  return props.personEmpty ? `${props.personLabel}: ${props.personEmpty}` : null;
});

const initial = computed(() => props.personName?.trim().charAt(0).toUpperCase() ?? "");
const hasFooter = computed(() => !!personText.value || !!props.meta || !!slots["footer-actions"]);

/** Inline icon paths (24px grid), so the card needs no icon library. */
const ICONS: Record<CardFact["icon"], string[]> = {
  calendar: [
    "M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5",
  ],
  clock: ["M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"],
  pin: [
    "M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
    "M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z",
  ],
  people: [
    "M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z",
  ],
  accessibility: ["M5.5 8.5 12 10l6.5-1.5M12 10v4.5m0 0-3 6m3-6 3 6", "M13.75 4.5a1.75 1.75 0 1 1-3.5 0 1.75 1.75 0 0 1 3.5 0Z"],
};
</script>

<template>
  <RouterLink :to="to" class="event-card">
    <img :src="thumbnail" alt="" class="card-thumbnail" loading="lazy" decoding="async" />

    <div class="card-content">
      <div class="card-header">
        <span class="badge" :class="statusClass">
          <span v-if="dot" class="badge__dot" />
          {{ statusLabel }}
        </span>
        <span v-for="badge in extraBadges" :key="badge" class="badge badge-extra">{{ badge }}</span>
                <span
          v-if="titleAside"
          class="card-aside"
          :class="{ 'card-aside--alert': titleAside.alert }"
          :data-testid="titleAside.testid"
        >

          {{ titleAside.text }}
        </span>
      </div>

      <div class="card-title-row">
        <h2 class="card-title">{{ title }}</h2>

      </div>
      <p v-if="description" class="card-description">{{ description }}</p>

      <ul v-if="facts.length > 0" class="card-facts">
        <li
          v-for="fact in facts"
          :key="fact.icon + fact.text"
          class="fact"
          :class="{ 'fact--alert': fact.alert, 'fact--clamp': fact.clamp }"
          :data-testid="fact.testid"
        >
          <svg class="fact__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path v-for="path in ICONS[fact.icon]" :key="path" :d="path" />
          </svg>
          <span class="fact__text">{{ fact.text }}</span>
        </li>
      </ul>

      <!-- The divider splits the top part (status, title, facts) from the bottom (who, when submitted, actions). -->
      <template v-if="hasFooter">
        <hr class="card-divider" />
        <div class="card-footer">
          <div v-if="personText || meta" class="card-footer__row">
            <p v-if="personText" class="card-person">
              <span v-if="initial" class="person-avatar" aria-hidden="true">{{ initial }}</span>
              <span class="card-person__text">{{ personText }}</span>
            </p>
            <span v-if="meta" class="card-footer__meta">{{ meta }}</span>
          </div>
          <div v-if="$slots['footer-actions']" class="card-footer__actions">
            <slot name="footer-actions" />
          </div>
        </div>
      </template>
    </div>
  </RouterLink>
</template>

<style scoped>
.event-card {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  box-sizing: border-box;
  overflow: hidden;
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-card);
  color: inherit;
  text-decoration: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.event-card:hover {
  border-color: var(--color-purple-300);
  box-shadow: var(--shadow-card-hover);
}

.event-card:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

.card-thumbnail {
  display: block;
  width: 100%;
  aspect-ratio: 3 / 1;
  object-fit: cover;
}

.card-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-12);
  padding: var(--spacing-24);
}

/* Badges ------------------------------------------------------------------- */

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-8);
}

.badge {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-6);
  height: var(--spacing-24);
  padding: 0 var(--spacing-12);
  border-radius: var(--radius-full);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
}

.badge__dot {
  flex: none;
  width: var(--spacing-6);
  height: var(--spacing-6);
  border-radius: var(--radius-full);
  background: currentColor;
}

.badge-extra {
  background: var(--color-purple-100);
  color: var(--color-purple-700);
}

.status-success {
  background: var(--color-success-200);
  color: var(--color-success-700);
}

.status-warning {
  background: var(--color-warning-100);
  color: var(--color-warning-900);
}

.status-error {
  background: var(--color-error-200);
  color: var(--color-error-600);
}

/* "Awaiting Clarification" and "Open": the Secondary Blue badge pair. */
.status-info,
.status-open {
  background: var(--color-blue-200);
  color: var(--color-blue-800);
}

/* A finished event reads as neutral grey, not live. */
.status-over {
  background: var(--color-grey-200);
  color: var(--color-grey-900);
}

/* Text ---------------------------------------------------------------------- */

/* Title on the left; a short aside (places left) pushed to the right end of the same row. */
.card-title-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--spacing-12);
}

.card-aside {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-6);
  margin-top: var(--spacing-4);
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  color: var(--color-grey-600);
  white-space: nowrap;
}

.card-aside__icon {
  flex: none;
  color: var(--color-grey-500);
}

/* No places left: the error text colour, icon included (Style.md 3.1). */
.card-aside--alert,
.card-aside--alert .card-aside__icon {
  color: var(--color-error-600);
}

.card-title {
  min-width: 0;
  margin: 0;
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
}

.card-description {
  margin: 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-700);
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
  align-items: flex-start;
  gap: var(--spacing-8);
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-600);
}

.fact__icon {
  flex: none;
  margin-top: var(--spacing-2);
  color: var(--color-grey-500);
}

.fact--clamp .fact__text {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

/* No places left and the like: the error text colour, icon included (Style.md 3.1). */
.fact--alert,
.fact--alert .fact__icon {
  color: var(--color-error-600);
}

.card-person {
  display: flex;
  align-items: center;
  gap: var(--spacing-8);
  min-width: 0;
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-500);
}

.person-avatar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: var(--radius-full);
  background: var(--color-purple-200);
  color: var(--color-purple-600);
  font-size: 0.75rem;
  font-weight: 700;
}

/* Footer: pushed to the bottom so cards in a row end level. */
.card-divider {
  margin: auto 0 0;
  border: none;
  border-top: 1px solid var(--color-grey-100);
}

.card-footer {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
}

.card-footer__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--spacing-8);
}

.card-footer__meta {
  min-width: 0;
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-500);
}

.card-footer__actions {
  display: flex;
  align-items: center;
  gap: var(--spacing-12);
}
</style>
