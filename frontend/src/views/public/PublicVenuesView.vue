<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { ChevronRightIcon, MagnifyingGlassIcon, XMarkIcon } from "@heroicons/vue/24/outline";
import PublicLayout from "../../components/public/PublicLayout.vue";
import VenueCard from "../../components/public/VenueCard.vue";
import { fetchPublicVenues, type PublicVenue } from "../../lib/publicApi";

/**
 * Guest "Venues" tab: every available venue, with search, location and
 * capacity filters, and each venue's next publicly listed event.
 */
type Tab = "all" | "hosting";
type Sort = "name" | "capacity-desc" | "capacity-asc";

const TABS: { value: Tab; label: string }[] = [
  { value: "all", label: "All venues" },
  { value: "hosting", label: "Hosting events" },
];

/** Minimum-capacity choices; 0 = any. */
const CAPACITY_OPTIONS = [0, 50, 100, 300, 500];

const venues = ref<PublicVenue[]>([]);
const loading = ref(true);
const errorMessage = ref<string | null>(null);

const tab = ref<Tab>("all");
const query = ref("");
const location = ref("");
const minCapacity = ref(0);
const sort = ref<Sort>("name");

const locations = computed(() => [...new Set(venues.value.map((v) => v.location))].sort());

const tabCounts = computed(() => ({
  all: venues.value.length,
  hosting: venues.value.filter((v) => v.upcomingEvents.length > 0).length,
}));

const visible = computed(() => {
  const needle = query.value.trim().toLowerCase();
  const list = venues.value.filter((venue) => {
    if (tab.value === "hosting" && venue.upcomingEvents.length === 0) return false;
    if (location.value && venue.location !== location.value) return false;
    if (venue.capacity < minCapacity.value) return false;
    if (!needle) return true;
    return [venue.name, venue.location, venue.description ?? "", ...venue.layouts, ...venue.facilities]
      .join(" ")
      .toLowerCase()
      .includes(needle);
  });
  if (sort.value === "capacity-desc") list.sort((a, b) => b.capacity - a.capacity);
  else if (sort.value === "capacity-asc") list.sort((a, b) => a.capacity - b.capacity);
  else list.sort((a, b) => a.name.localeCompare(b.name));
  return list;
});

onMounted(async () => {
  try {
    venues.value = await fetchPublicVenues();
  } catch {
    errorMessage.value = "We couldn't load venues. Please try again.";
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <PublicLayout>
    <!--
      Column mapping — Public venues
      Desktop (12-col, grid-desktop-margin 80px): breadcrumb, heading, tabs, search row and count col 1-12;
        cards col 1-12, each span 4 (3 per row).
      Tablet (6-col, grid-tablet-margin 32px): everything col 1-6; cards span 3 (2 per row).
      Mobile (4-col, grid-mobile-margin 6px): everything col 1-4; cards span 4 (1 per row); filters stack.
      Nested grid: the card list repeats the page's column count (12 / 6 / 4).
    -->
    <div class="page">
      <div class="content">
        <nav class="breadcrumb" aria-label="Breadcrumb">
          <RouterLink :to="{ name: 'welcome' }" class="breadcrumb__link">Home</RouterLink>
          <ChevronRightIcon class="breadcrumb__icon" aria-hidden="true" />
          <span aria-current="page">Venues</span>
        </nav>

        <div>
          <h1 class="h2">Venues<span class="accent">.</span></h1>
          <p class="subheading">Find the perfect setting. Explore the spaces that host our events, from intimate rooms to grand halls.</p>
        </div>

        <div class="tabs" role="tablist" aria-label="Filter venues">
          <button v-for="option in TABS" :key="option.value" type="button" role="tab" class="tab"
            :class="{ 'tab--active': tab === option.value }" :aria-selected="tab === option.value"
            @click="tab = option.value">
            {{ option.label }} <span class="tab__count">{{ tabCounts[option.value] }}</span>
          </button>
        </div>

        <div class="toolbar">
          <div class="search-box">
            <MagnifyingGlassIcon class="search-box__icon" aria-hidden="true" />
            <input v-model="query" type="search" class="search-box__input" placeholder="Search venues, facilities or layouts"
              aria-label="Search venues" />
            <button v-if="query" type="button" class="search-box__clear" aria-label="Clear search" @click="query = ''">
              <XMarkIcon class="search-box__icon" aria-hidden="true" />
            </button>
          </div>
          <select v-model="location" class="select" aria-label="Location">
            <option value="">Any location</option>
            <option v-for="option in locations" :key="option" :value="option">{{ option }}</option>
          </select>
          <select v-model.number="minCapacity" class="select" aria-label="Capacity">
            <option v-for="option in CAPACITY_OPTIONS" :key="option" :value="option">
              {{ option === 0 ? "Any capacity" : `${option}+ guests` }}
            </option>
          </select>
          <label class="sort">
            <span class="sort__label">Sort by</span>
            <select v-model="sort" class="select">
              <option value="name">Name</option>
              <option value="capacity-desc">Capacity: largest</option>
              <option value="capacity-asc">Capacity: smallest</option>
            </select>
          </label>
        </div>

        <p v-if="loading" class="body-default muted">Loading venues…</p>
        <p v-else-if="errorMessage" class="body-default error-text" role="alert">{{ errorMessage }}</p>
        <p v-else-if="venues.length === 0" class="body-default muted">No venues to show yet.</p>
        <p v-else-if="visible.length === 0" class="body-default muted">No venues match your filters.</p>

        <template v-else>
          <p class="count">Showing {{ visible.length }} of {{ venues.length }} {{ venues.length === 1 ? "venue" : "venues" }}</p>
          <ul class="card-list">
            <li v-for="venue in visible" :key="venue.id" class="card-item">
              <VenueCard :venue="venue" />
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

/* Breadcrumb, tabs, search box and selects: same treatment as PublicEventsView. */
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
  flex-wrap: wrap;
  gap: var(--spacing-16);
  align-items: center;
}

.search-box {
  flex: 1 1 20rem;
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

.select {
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

.select:focus-visible {
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
  .search-box { flex: none; }
  .card-list { grid-template-columns: repeat(4, 1fr); gap: var(--spacing-16); }
  .card-item { grid-column: span 4; }
}
</style>
