<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ChevronRightIcon, MagnifyingGlassIcon, XMarkIcon } from "@heroicons/vue/24/outline";
import PublicLayout from "../../components/public/PublicLayout.vue";
import PublicEventCard from "../../components/public/PublicEventCard.vue";
import {
  byStartTime,
  fetchPublicEventVenues,
  fetchPublicEvents,
  type PublicEvent,
} from "../../lib/publicApi";

/**
 * Guest "Events" tab: every publicly listed event, searchable, filterable by
 * whether registration is open, sortable by date. Each card opens the public
 * event page, where registering asks the guest to sign up first.
 */
type Tab = "all" | "open" | "closed";
type Sort = "soonest" | "latest";

const TABS: { value: Tab; label: string }[] = [
  { value: "all", label: "All events" },
  { value: "open", label: "Open for registration" },
  { value: "closed", label: "Registration closed" },
];

/** The venue lookup takes at most this many ids per request (venue-service's limit). */
const VENUE_LOOKUP_BATCH = 100;

const events = ref<PublicEvent[]>([]);
const venuesByEvent = ref(new Map<number, string[]>());
const loading = ref(true);
const errorMessage = ref<string | null>(null);

const tab = ref<Tab>("all");
const query = ref("");
const sort = ref<Sort>("soonest");

const tabCounts = computed(() => ({
  all: events.value.length,
  open: events.value.filter((e) => e.open).length,
  closed: events.value.filter((e) => !e.open).length,
}));

const visible = computed(() => {
  const needle = query.value.trim().toLowerCase();
  const list = events.value.filter((event) => {
    if (tab.value === "open" && !event.open) return false;
    if (tab.value === "closed" && event.open) return false;
    if (!needle) return true;
    const venues = (venuesByEvent.value.get(event.id) ?? []).join(" ");
    return `${event.name ?? ""} ${event.description ?? ""} ${event.organiserName ?? ""} ${venues}`
      .toLowerCase()
      .includes(needle);
  });
  list.sort(byStartTime);
  return sort.value === "latest" ? list.reverse() : list;
});

async function loadVenues(ids: number[]): Promise<Map<number, string[]>> {
  const merged = new Map<number, string[]>();
  for (let i = 0; i < ids.length; i += VENUE_LOOKUP_BATCH) {
    const batch = await fetchPublicEventVenues(ids.slice(i, i + VENUE_LOOKUP_BATCH));
    batch.forEach((names, id) => merged.set(id, names));
  }
  return merged;
}

onMounted(async () => {
  try {
    events.value = await fetchPublicEvents();
  } catch {
    errorMessage.value = "We couldn't load events. Please try again.";
    loading.value = false;
    return;
  }
  loading.value = false;
  // Venue names fill in after the cards; the page works without them.
  venuesByEvent.value = await loadVenues(events.value.map((e) => e.id)).catch(() => new Map());
});
</script>

<template>
  <PublicLayout>
    <!--
      Column mapping — Public events
      Desktop (12-col, grid-desktop-margin 80px): breadcrumb, heading, tabs, search row and count col 1-12;
        cards col 1-12, each span 4 (3 per row).
      Tablet (6-col, grid-tablet-margin 32px): everything col 1-6; cards span 3 (2 per row).
      Mobile (4-col, grid-mobile-margin 6px): everything col 1-4; cards span 4 (1 per row); search and sort stack.
      Nested grid: the card list repeats the page's column count (12 / 6 / 4).
    -->
    <div class="page">
      <div class="content">
        <nav class="breadcrumb" aria-label="Breadcrumb">
          <RouterLink :to="{ name: 'welcome' }" class="breadcrumb__link">Home</RouterLink>
          <ChevronRightIcon class="breadcrumb__icon" aria-hidden="true" />
          <span aria-current="page">Events</span>
        </nav>

        <div>
          <h1 class="h2">Events<span class="accent">.</span></h1>
          <p class="subheading">Find your next unforgettable night out. Browse what's on and sign up to reserve your place.</p>
        </div>

        <div class="tabs" role="tablist" aria-label="Filter events">
          <button v-for="option in TABS" :key="option.value" type="button" role="tab" class="tab"
            :class="{ 'tab--active': tab === option.value }" :aria-selected="tab === option.value"
            @click="tab = option.value">
            {{ option.label }} <span class="tab__count">{{ tabCounts[option.value] }}</span>
          </button>
        </div>

        <div class="toolbar">
          <div class="search-box">
            <MagnifyingGlassIcon class="search-box__icon" aria-hidden="true" />
            <input v-model="query" type="search" class="search-box__input" placeholder="Search events, organisers or venues"
              aria-label="Search events" />
            <button v-if="query" type="button" class="search-box__clear" aria-label="Clear search" @click="query = ''">
              <XMarkIcon class="search-box__icon" aria-hidden="true" />
            </button>
          </div>
          <label class="sort">
            <span class="sort__label">Sort by</span>
            <select v-model="sort" class="sort__select">
              <option value="soonest">Date: soonest</option>
              <option value="latest">Date: latest</option>
            </select>
          </label>
        </div>

        <p v-if="loading" class="body-default muted">Loading events…</p>
        <p v-else-if="errorMessage" class="body-default error-text" role="alert">{{ errorMessage }}</p>
        <p v-else-if="events.length === 0" class="body-default muted">No events are listed right now. Check back soon.</p>
        <p v-else-if="visible.length === 0" class="body-default muted">No events match your search.</p>

        <template v-else>
          <p class="count">Showing {{ visible.length }} of {{ events.length }} {{ events.length === 1 ? "event" : "events" }}</p>
          <ul class="card-list">
            <li v-for="event in visible" :key="event.id" class="card-item">
              <PublicEventCard :event="event" :venues="venuesByEvent.get(event.id)" />
            </li>
          </ul>
        </template>
      </div>
    </div>
  </PublicLayout>
</template>

<style scoped>
.page {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: var(--grid-desktop-gutter);
  padding: var(--spacing-32) var(--grid-desktop-margin) var(--spacing-80);
  align-content: start;
}

.content {
  grid-column: 1 / 13;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-24);
}

/* Breadcrumb: Body Small, Grey/500, the current page Grey/900. */
.breadcrumb {
  display: flex;
  align-items: center;
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

.breadcrumb__link:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

.breadcrumb__icon {
  width: var(--spacing-16);
  height: var(--spacing-16);
  color: var(--color-grey-400);
}

.accent {
  color: var(--color-purple-600);
}

/* Tabs: underline style; selected = Purple Primary (Style.md 3.1 Selected). */
.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-24);
  border-bottom: 1px solid var(--color-grey-100);
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-8);
  padding: var(--spacing-12) 0;
  margin-bottom: -1px;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  line-height: 1.125rem;
  font-weight: 700;
  color: var(--color-grey-500);
  cursor: pointer;
}

.tab:hover {
  color: var(--color-grey-800);
}

.tab--active {
  color: var(--color-purple-700);
  border-bottom-color: var(--color-purple-600);
}

.tab:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

.tab__count {
  padding: 0 var(--spacing-8);
  border-radius: var(--radius-full);
  background: var(--color-grey-75);
  color: var(--color-grey-600);
  font-size: 0.75rem;
  line-height: 1rem;
}

.tab--active .tab__count {
  background: var(--color-purple-100);
  color: var(--color-purple-800);
}

.toolbar {
  display: flex;
  gap: var(--spacing-16);
  align-items: center;
}

/* Search box: same pattern as AttendeeDiscoverView's. */
.search-box {
  flex: 1;
  display: flex;
  align-items: center;
  gap: var(--spacing-12);
  height: var(--spacing-48);
  padding: 0 var(--spacing-12) 0 var(--spacing-16);
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-xs);
}

.search-box:focus-within {
  border-color: var(--ring-brand);
  box-shadow: 0 0 0 4px var(--ring-light);
}

.search-box__icon {
  flex: none;
  width: var(--spacing-20);
  height: var(--spacing-20);
  color: var(--color-grey-700);
}

.search-box__input {
  flex: 1;
  min-width: 0;
  height: 100%;
  border: none;
  background: transparent;
  font-family: var(--font-family-lato);
  font-size: 1rem;
  line-height: 1.25rem;
  color: var(--color-grey-900);
}

.search-box__input::placeholder {
  color: var(--color-grey-300);
}

.search-box__input:focus-visible {
  outline: none;
}

.search-box__input::-webkit-search-cancel-button {
  display: none;
}

.search-box__clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--spacing-32);
  height: var(--spacing-32);
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  cursor: pointer;
}

.search-box__clear:hover {
  background: var(--color-grey-75);
}

.search-box__clear:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

.sort {
  display: flex;
  align-items: center;
  gap: var(--spacing-8);
}

.sort__label {
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-500);
  white-space: nowrap;
}

.sort__select {
  height: var(--spacing-48);
  padding: 0 var(--spacing-12);
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-xs);
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  line-height: 1.125rem;
  font-weight: 700;
  color: var(--color-grey-900);
}

.sort__select:focus-visible {
  outline: none;
  border-color: var(--ring-brand);
  box-shadow: 0 0 0 4px var(--ring-light);
}

.count {
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-600);
}

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

/* Text styles (Style.md 5) */
.h2 {
  margin: 0;
  font-size: 2.25rem;
  line-height: 2.625rem;
  font-weight: 700;
  color: var(--color-grey-900);
}

.subheading {
  margin: var(--spacing-8) 0 0;
  font-size: 1.125rem;
  line-height: 1.375rem;
  color: var(--color-grey-600);
}

.body-default {
  margin: 0;
  font-size: 1rem;
  line-height: 1.25rem;
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
    gap: var(--grid-tablet-gutter);
    padding: var(--spacing-32) var(--grid-tablet-margin) var(--spacing-80);
  }
  .content { grid-column: 1 / 7; }
  .card-list { grid-template-columns: repeat(6, 1fr); }
  .card-item { grid-column: span 3; }
}

@media (max-width: 640px) {
  .page {
    grid-template-columns: repeat(4, 1fr);
    gap: var(--grid-mobile-gutter);
    padding: var(--spacing-24) var(--grid-mobile-margin) var(--spacing-48);
  }
  .content { grid-column: 1 / 5; }
  .toolbar { flex-direction: column; align-items: stretch; }
  .card-list { grid-template-columns: repeat(4, 1fr); gap: var(--spacing-16); }
  .card-item { grid-column: span 4; }
}
</style>
