<script setup lang="ts">
/**
 * E4 venue recommendations for one event request, shown in the Venue part
 * of the Coordinator Details card. Every venue listed meets all of the
 * event's requirements (venue-service does the matching). All of them are
 * shown one card at a time in a carousel so the side column stays short;
 * they're ordered tightest capacity fit first.
 *
 * Column mapping: lives inside the event detail page's side column
 * (desktop: the 1fr of the 2fr/1fr detail grid; tablet/mobile: full width
 * once that grid collapses to one column). The component fills its
 * parent's width at every breakpoint; the carousel track shows one card
 * per view.
 */
import { computed, onMounted, ref, watch } from "vue";
import VenueIcon from "./VenueIcon.vue";
import { fetchVenueRecommendations, type VenueRecommendations } from "../../lib/venuesApi";

const props = defineProps<{
  eventId: number;
  /** The event's submitted details; recommendations refresh when they change. */
  details: unknown;
}>();

const loading = ref(true);
const errorMessage = ref("");
const result = ref<VenueRecommendations | null>(null);

const trackRef = ref<HTMLElement | null>(null);
const activeIndex = ref(0);

const venues = computed(() => result.value?.venues ?? []);

const requiredFeatures = computed(() => {
  const r = result.value?.requirements;
  return r ? [...r.layouts, ...r.facilities, ...r.accessibility] : [];
});

async function load(): Promise<void> {
  loading.value = true;
  errorMessage.value = "";
  try {
    result.value = await fetchVenueRecommendations(props.eventId);
    activeIndex.value = 0;
    trackRef.value?.scrollTo({ left: 0 });
  } catch (err) {
    result.value = null;
    errorMessage.value = err instanceof Error ? err.message : "Failed to load venue recommendations";
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(
  () => [props.eventId, JSON.stringify(props.details)],
  () => void load(),
);

function onScroll(): void {
  const track = trackRef.value;
  if (!track || track.clientWidth === 0) return;
  activeIndex.value = Math.round(track.scrollLeft / track.clientWidth);
}

function goTo(index: number): void {
  const track = trackRef.value;
  if (!track) return;
  const clamped = Math.max(0, Math.min(index, venues.value.length - 1));
  track.scrollTo({ left: clamped * track.clientWidth, behavior: "smooth" });
  activeIndex.value = clamped;
}

function isRequired(feature: string): boolean {
  return requiredFeatures.value.some((f) => f.toLowerCase() === feature.toLowerCase());
}

/** The venue's features that the event asked for, in the order listed above. */
function matchedFeatures(venue: VenueRecommendations["venues"][number]): string[] {
  return [...venue.layouts, ...venue.facilities, ...venue.accessibility].filter(isRequired);
}
</script>

<template>
  <section class="recommendations" aria-labelledby="venue-recommendations-title">
    <div class="recommendations__header">
      <p id="venue-recommendations-title" class="body-default font-semibold recommendations__title">
        Recommended venues
      </p>
      <p v-if="venues.length > 0" class="body-small muted">{{ venues.length }} suitable</p>
    </div>

    <p v-if="loading" class="body-small muted">Finding suitable venues…</p>

    <p v-else-if="errorMessage" class="body-small error-text">{{ errorMessage }}</p>

    <template v-else-if="result">
      <div class="requirements">
        <p class="body-small muted">Checked against</p>
        <div class="tags">
          <span v-if="result.requirements.attendance" class="tag">
            Fits {{ result.requirements.attendance }}
          </span>
          <span v-if="result.requirements.date" class="tag">Free at event time</span>
          <span v-for="feature in requiredFeatures" :key="feature" class="tag">{{ feature }}</span>
        </div>
        <p v-if="requiredFeatures.length === 0" class="body-small muted">
          No specific layout, facility or accessibility needs in this request.
        </p>
      </div>

      <div v-if="venues.length === 0" class="empty-state" role="status">
        <p class="body-small font-semibold">No suitable venues were found.</p>
        <p class="body-small muted">
          No venue meets all of this event's requirements. Try Find venues to loosen the criteria.
        </p>
      </div>

      <div v-else class="carousel">
        <ul ref="trackRef" class="carousel__track" aria-label="Recommended venues" @scroll.passive="onScroll">
          <li v-for="(venue, index) in venues" :key="venue.id" class="venue-card"
            :aria-label="`${index + 1} of ${venues.length}: ${venue.name}`">
            <p class="body-default font-semibold venue-card__name">{{ venue.name }}</p>
            <p class="body-small muted venue-card__meta">
              <VenueIcon name="location" :size="14" />
              {{ venue.location }}
            </p>
            <p class="body-small muted venue-card__meta">
              <VenueIcon name="users" :size="14" />
              Capacity {{ venue.capacity }}
              <template v-if="result.requirements.attendance">
                · {{ result.requirements.attendance }} expected
              </template>
            </p>
            <div v-if="matchedFeatures(venue).length > 0" class="tags">
              <span v-for="feature in matchedFeatures(venue)" :key="feature" class="tag tag--match">
                {{ feature }}
              </span>
            </div>
          </li>
        </ul>

        <div v-if="venues.length > 1" class="carousel__controls">
          <button type="button" class="carousel__arrow" aria-label="Previous venue" :disabled="activeIndex === 0"
            @click="goTo(activeIndex - 1)">
            <VenueIcon name="chevron-left" :size="16" />
          </button>
          <p class="body-small muted" aria-live="polite">{{ activeIndex + 1 }} of {{ venues.length }}</p>
          <button type="button" class="carousel__arrow" aria-label="Next venue"
            :disabled="activeIndex === venues.length - 1" @click="goTo(activeIndex + 1)">
            <VenueIcon name="chevron-right" :size="16" />
          </button>
        </div>
      </div>
    </template>
  </section>
</template>

<style scoped>
/* Style.md 5: Body Default / Body Small; 3.2 muted and error text. */
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

.recommendations {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-12);
}

.recommendations__header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--spacing-8);
}

.recommendations__title {
  color: var(--color-grey-900);
}

.requirements {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-4);
}

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-4);
}

/* Style.md 5: Small Text / Tag (12px / 700 / 16px), chip radius-xs. */
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

/* Style.md 3.1 Selected: the venue has this required feature. */
.tag--match {
  border-color: var(--color-purple-300);
  background: var(--color-purple-100);
  color: var(--color-purple-800);
}

.empty-state {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-4);
  padding: var(--spacing-16);
  border: 1px dashed var(--color-grey-200);
  border-radius: var(--radius-xs);
  background: var(--color-base-white);
  color: var(--color-grey-700);
}

.carousel {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
}

/* One card per view; swipe/scroll or use the controls to move between them. */
.carousel__track {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 100%;
  grid-template-rows: auto;
  align-content: start;
  gap: 0;
  margin: 0;
  padding: 0;
  list-style: none;
  overflow-x: auto;
  scroll-snap-type: x mandatory;
  scrollbar-width: none;
}

.carousel__track::-webkit-scrollbar {
  display: none;
}

.venue-card {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-4);
  scroll-snap-align: start;
  padding: var(--spacing-16);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-xs);
  background: var(--color-base-white);
}

.venue-card__name {
  color: var(--color-grey-900);
}

.venue-card__meta {
  display: flex;
  align-items: center;
  gap: var(--spacing-4);
}

.venue-card .tags {
  margin-top: var(--spacing-4);
}

.carousel__controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

/* Style.md 3.4 ghost button (Purple Primary). */
.carousel__arrow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-4);
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-purple-600);
  cursor: pointer;
}

.carousel__arrow:not(:disabled):hover {
  background: var(--color-purple-100);
}

.carousel__arrow:disabled {
  color: var(--color-grey-300);
  cursor: default;
}

/* Style.md 8.2: single ring-brand outline for buttons. */
.carousel__arrow:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}
</style>
