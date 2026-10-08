<script setup lang="ts">
/**
 * E4 venue recommendations for one event request, shown in the Venue part
 * of the Coordinator Details card. Every venue listed meets all of the
 * event's main requirements (venue-service does the matching). All of them are
 * shown one card at a time in a carousel so the side column stays short;
 * they're ordered tightest capacity fit first. The carousel loops: a copy
 * of the last card sits before the first and a copy of the first after the
 * last, so moving past either end keeps scrolling the same way, then
 * silently jumps to the real card once the scroll settles.
 *
 * Column mapping: lives inside the event detail page's side column
 * (desktop: the 1fr of the 2fr/1fr detail grid; tablet/mobile: full width
 * once that grid collapses to one column). The component fills its
 * parent's width at every breakpoint; the carousel track shows one card
 * per view.
 */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import VenueIcon from "./VenueIcon.vue";
import {
  BookingConflictError,
  fetchVenueRecommendations,
  submitVenueBooking,
  type VenueRecommendations,
} from "../../lib/venuesApi";

const props = defineProps<{
  eventId: number;
  /** The event's submitted details; recommendations refresh when they change. */
  details: unknown;
  /** E4-8: a venue can only be requested while the event is in Planning. */
  canRequest?: boolean;
}>();

const emit = defineEmits<{ requested: [venueId: number] }>();

// E4-8: one request at a time, with the outcome shown on the card it came
// from. A refused request keeps its message until another is attempted:
// the clashing window is the whole point of the message (AC6).
const requestingVenueId = ref<number | null>(null);
const requestedVenueIds = ref<Set<number>>(new Set());
const requestErrorVenueId = ref<number | null>(null);
const requestError = ref("");

async function requestVenue(venueId: number): Promise<void> {
  requestingVenueId.value = venueId;
  requestErrorVenueId.value = null;
  requestError.value = "";
  try {
    await submitVenueBooking(props.eventId, venueId);
    requestedVenueIds.value = new Set(requestedVenueIds.value).add(venueId);
    emit("requested", venueId);
  } catch (err) {
    requestErrorVenueId.value = venueId;
    if (err instanceof BookingConflictError && err.conflict) {
      requestError.value = `${err.message}. Booked ${err.conflict.window} (setup ${err.conflict.setupMinutes} min, turnaround ${err.conflict.turnaroundMinutes} min); this event needs ${err.conflict.requestedWindow}.`;
    } else {
      requestError.value = err instanceof Error ? err.message : "Failed to request this venue";
    }
  } finally {
    requestingVenueId.value = null;
  }
}

const loading = ref(true);
const errorMessage = ref("");
const result = ref<VenueRecommendations | null>(null);

const trackRef = ref<HTMLElement | null>(null);
const activeIndex = ref(0);

const venues = computed(() => result.value?.venues ?? []);

type Venue = VenueRecommendations["venues"][number];

/** Track contents: the venues, wrapped in a copy of each end when there's more than one. */
const slides = computed<{ venue: Venue; key: string; index: number; clone: boolean }[]>(() => {
  const list = venues.value.map((venue, index) => ({ venue, key: String(venue.id), index, clone: false }));
  if (list.length < 2) return list;
  const first = list[0];
  const last = list[list.length - 1];
  return [{ ...last, key: "clone-last", clone: true }, ...list, { ...first, key: "clone-first", clone: true }];
});

/** Track position of the first real venue (1 when the end copies are present). */
const firstRealPosition = computed(() => (venues.value.length > 1 ? 1 : 0));

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
  } catch (err) {
    result.value = null;
    errorMessage.value = err instanceof Error ? err.message : "Failed to load venue recommendations";
  } finally {
    loading.value = false;
  }
  // The track only renders once loading ends; start on the first real card.
  await nextTick();
  jumpTo(firstRealPosition.value);
}

onMounted(load);
watch(
  () => [props.eventId, JSON.stringify(props.details)],
  () => void load(),
);

let settleTimer: ReturnType<typeof setTimeout> | undefined;

function currentPosition(): number {
  const track = trackRef.value;
  if (!track || track.clientWidth === 0) return firstRealPosition.value;
  return Math.round(track.scrollLeft / track.clientWidth);
}

/** Moves to a track position instantly, with no animation. */
function jumpTo(position: number): void {
  const track = trackRef.value;
  if (!track) return;
  track.scrollTo({ left: position * track.clientWidth, behavior: "instant" });
}

/** If the scroll stopped on an end copy, swap to the real card it copies. */
function settle(): void {
  const position = currentPosition();
  if (venues.value.length < 2) return;
  if (position === 0) jumpTo(venues.value.length);
  else if (position === venues.value.length + 1) jumpTo(1);
}

function onScroll(): void {
  const slide = slides.value[currentPosition()];
  if (slide) activeIndex.value = slide.index;
  clearTimeout(settleTimer);
  settleTimer = setTimeout(settle, 120);
}

/** Scrolls one card forward (1) or back (-1), looping past either end. */
function step(direction: 1 | -1): void {
  const track = trackRef.value;
  if (!track) return;
  // Already on an end copy (e.g. a quick second click): swap to the real card first.
  clearTimeout(settleTimer);
  settle();
  const position = currentPosition() + direction;
  track.scrollTo({ left: position * track.clientWidth, behavior: "smooth" });
  const slide = slides.value[position];
  if (slide) activeIndex.value = slide.index;
}

function isRequired(feature: string): boolean {
  return requiredFeatures.value.some((f) => f.toLowerCase() === feature.toLowerCase());
}

/** The venue's features that the event asked for, in the order listed above. */
function matchedFeatures(venue: Venue): string[] {
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
          No venue meets all of this event's main requirements. Try Find venues to loosen the criteria.
        </p>
      </div>

      <div v-else class="carousel">
        <ul ref="trackRef" class="carousel__track" aria-label="Recommended venues" @scroll.passive="onScroll">
          <li v-for="{ venue, key, index, clone } in slides" :key="key" class="venue-card"
            :aria-hidden="clone ? 'true' : undefined"
            :aria-label="clone ? undefined : `${index + 1} of ${venues.length}: ${venue.name}`">
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
            <template v-if="canRequest && !clone">
              <p v-if="requestedVenueIds.has(venue.id)" class="body-small requested-note" role="status">
                Requested — awaiting Venue Staff
              </p>
              <button v-else type="button" class="request-btn" :disabled="requestingVenueId === venue.id"
                @click="requestVenue(venue.id)">
                {{ requestingVenueId === venue.id ? "Requesting…" : "Request this venue" }}
              </button>
              <p v-if="requestErrorVenueId === venue.id" class="body-small error-text" role="alert">
                {{ requestError }}
              </p>
            </template>
          </li>
        </ul>

        <div v-if="venues.length > 1" class="carousel__controls">
          <button type="button" class="carousel__arrow" aria-label="Previous venue" @click="step(-1)">
            <VenueIcon name="chevron-left" :size="16" />
          </button>
          <p class="body-small muted" aria-live="polite">{{ activeIndex + 1 }} of {{ venues.length }}</p>
          <button type="button" class="carousel__arrow" aria-label="Next venue" @click="step(1)">
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

/* Style.md 3.4 Button Hierarchy (primary) + 8.2 focus ring; radius-xs. */
.request-btn {
  margin-top: var(--spacing-8);
  padding: var(--spacing-8) var(--spacing-12);
  border: 1px solid transparent;
  border-radius: var(--radius-xs);
  background: var(--color-purple-600);
  color: var(--color-base-white);
  font-size: 0.875rem;
  font-weight: 700;
  cursor: pointer;
}

.request-btn:hover:not(:disabled) {
  background: var(--color-purple-700);
}

.request-btn:focus-visible {
  outline: 2px solid var(--color-purple-600);
  outline-offset: 2px;
}

.request-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.requested-note {
  margin-top: var(--spacing-8);
  color: var(--color-success-700);
  font-weight: 700;
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

.carousel__arrow:hover {
  background: var(--color-purple-100);
}

/* Style.md 8.2: single ring-brand outline for buttons. */
.carousel__arrow:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}
</style>
