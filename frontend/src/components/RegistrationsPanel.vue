<script setup lang="ts">
/**
 * E3-5 AC3 / E6-5: the event's registrations, read-only, for the owning
 * organiser and coordinators — so a Completed event's attendee list stays
 * viewable. The top shows the registered count against capacity and a
 * Registered / Withdrawn breakdown (a Cancelled registration means the
 * organiser cancelled the event, which they already know, so it isn't
 * counted). The roster lists everyone, those still attending first;
 * withdrawn and cancelled ones stay as part of the record.
 *
 * Column mapping: its own card in the event detail page's main column (the
 * 2fr of its 2fr/1fr desktop grid, full width once that collapses), like
 * the Venue Requests card. The list inside is a single column at every
 * breakpoint.
 */
import { computed, onMounted, ref } from "vue";
import { fetchEventRegistrations, type EventRegistration } from "../lib/registrationApi";
import { registrationBadgeClass } from "../lib/registrationStatus";

const props = defineProps<{
  eventId: number;
  /** How many may register (the event's expected attendance); omit or null for no cap. */
  capacity?: number | null;
}>();

const registrations = ref<EventRegistration[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);

const registeredCount = computed(() => registrations.value.filter((r) => r.status === "Registered").length);
const withdrawnCount = computed(() => registrations.value.filter((r) => r.status === "Withdrawn").length);

const cap = computed(() =>
  typeof props.capacity === "number" && Number.isInteger(props.capacity) && props.capacity > 0 ? props.capacity : null,
);
const placesLeft = computed(() => (cap.value === null ? null : Math.max(0, cap.value - registeredCount.value)));
const fillPercent = computed(() =>
  cap.value === null ? 0 : Math.min(100, Math.round((registeredCount.value / cap.value) * 100)),
);

// Still attending first, then withdrawn, then cancelled; oldest first within each (the sort is stable).
const STATUS_ORDER: Record<string, number> = { Registered: 0, Withdrawn: 1, Cancelled: 2 };
const roster = computed(() =>
  [...registrations.value].sort((a, b) => (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3)),
);

function formatMoment(value: string): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  return at.toLocaleString("en-US", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

onMounted(async () => {
  try {
    registrations.value = await fetchEventRegistrations(props.eventId);
  } catch {
    loadError.value = "We couldn't load the registrations for this event.";
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="details-card registrations">
    <h2 class="section-title">Registrations</h2>
    <p v-if="loading" class="body-default muted">Loading registrations…</p>
    <p v-else-if="loadError" class="body-default error-text">{{ loadError }}</p>
    <p v-else-if="registrations.length === 0" class="body-default muted">No one has registered for this event.</p>
    <template v-else>
      <div class="summary">
        <p class="summary__count" data-testid="registered-count">
          <template v-if="cap !== null">{{ registeredCount }} of {{ cap }} registered</template>
          <template v-else>{{ registeredCount }} registered</template>
        </p>
        <template v-if="cap !== null">
          <div class="meter" role="progressbar" aria-label="Registered places" :aria-valuenow="registeredCount"
            aria-valuemin="0" :aria-valuemax="cap">
            <div class="meter__fill" :style="{ width: `${fillPercent}%` }" />
          </div>
          <p class="body-small muted" data-testid="places-left">
            {{ placesLeft === 0 ? "Full" : `${placesLeft} ${placesLeft === 1 ? "place" : "places"} left` }}
          </p>
        </template>
        <div class="breakdown" aria-label="Breakdown by status" data-testid="breakdown">
          <span class="badge status-success">Registered {{ registeredCount }}</span>
          <span class="badge status-warning">Withdrawn {{ withdrawnCount }}</span>
        </div>
      </div>
      <ul class="registration-list">
        <li v-for="registration in roster" :key="registration.registrationId" class="registration-row"
          :class="{ 'registration-row--inactive': registration.status !== 'Registered' }">
          <div>
            <p class="body-default registration-name">{{ registration.name ?? registration.userId }}</p>
            <p class="body-small muted">Registered {{ formatMoment(registration.createdAt) }}</p>
          </div>
          <span class="badge" :class="registrationBadgeClass(registration.status)">{{ registration.status }}</span>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
/* Same card as VenueRequestsPanel.vue. Style.md 3.3 surfaces, 7 radius, 6.1 spacing. */
.registrations {
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
  padding: var(--spacing-32);
}

.section-title {
  font-size: 1.125rem;
  font-weight: 700;
  color: var(--color-grey-900);
  margin-bottom: var(--spacing-16);
}

.body-default {
  font-size: 0.875rem;
  color: var(--color-grey-900);
}

.body-small {
  font-size: 0.75rem;
}

.muted {
  color: var(--color-grey-500);
}

.error-text {
  color: var(--color-error-600);
}

.summary {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
  margin-bottom: var(--spacing-16);
}

/* Subheading, bold */
.summary__count {
  margin: 0;
  font-size: 1.125rem;
  line-height: 1.375rem;
  font-weight: 700;
  color: var(--color-grey-900);
}

.summary .body-small {
  margin: 0;
}

/* Purple Primary fill on a Grey/100 track. */
.meter {
  height: var(--spacing-8);
  background: var(--color-grey-100);
  border-radius: var(--radius-full);
  overflow: hidden;
}

.meter__fill {
  height: 100%;
  background: var(--color-purple-600);
  border-radius: var(--radius-full);
}

.breakdown {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-8);
}

/* Withdrawn and cancelled rows read as no longer attending. */
.registration-row--inactive {
  background: var(--color-grey-25);
}

.registration-row--inactive .registration-name {
  color: var(--color-grey-500);
}

.registration-list {
  display: grid;
  gap: var(--spacing-12);
  list-style: none;
  margin: 0;
  padding: 0;
}

.registration-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--spacing-16);
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-xs);
  padding: var(--spacing-16);
}

.registration-name {
  font-weight: 700;
  overflow-wrap: anywhere;
}

/* Registration badge colours, as in AttendeeEventsView.vue (Style.md 2.6/2.7). */
.badge {
  display: inline-block;
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  padding: var(--spacing-4) var(--spacing-8);
  border-radius: var(--radius-xs);
  white-space: nowrap;
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
</style>
