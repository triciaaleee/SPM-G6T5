<script setup lang="ts">
/**
 * E4-8 AC5: the venue requests made for one event and the state each one
 * is in, so a coordinator can see a request is pending without leaving the
 * event page. An event may have any number of bookings (AGENTS.md §3a
 * change 3), each decided on its own by Venue Staff, so they are listed
 * rather than summarised into a single "venue" field.
 *
 * Read-only here: withdrawing a request is E4-9 and approving or rejecting
 * one is Venue Staff's (E4-10).
 *
 * Column mapping: its own card in the event detail page's main column (the
 * 2fr of its 2fr/1fr desktop grid, full width once that collapses), a
 * sibling of the venue recommendations card rather than part of it. The
 * list inside is a single column at every breakpoint.
 */
import { computed } from "vue";
import type { EventVenueBooking } from "../../lib/venuesApi";
import { bookingStatusBadgeClass, bookingStatusLabel } from "../../lib/bookingStatus";

/**
 * The bookings are owned by the event page rather than fetched here: the
 * outstanding-arrangements line reads the same list, and both must refresh
 * together when a request is submitted from the recommendations above.
 */
const props = defineProps<{
  /** Undefined while the first load is still in flight. */
  bookings: EventVenueBooking[] | undefined;
  loading: boolean;
  loadError: string | null;
}>();

const bookings = computed(() => props.bookings ?? []);

function formatMoment(value: string | null): string {
  if (!value) return "";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  return at.toLocaleString("en-US", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
</script>

<template>
  <div class="details-card venue-requests">
    <h2 class="section-title">Venue Requests</h2>

    <p v-if="loading || !props.bookings" class="body-default muted">Loading venue requests…</p>
    <p v-else-if="loadError" class="body-default error-text">{{ loadError }}</p>
    <p v-else-if="bookings.length === 0" class="body-default muted">
      No venue has been requested for this event yet.
    </p>

    <ul v-else class="request-list">
      <li v-for="booking in bookings" :key="booking.id" class="request-row">
        <div class="request-venue">
          <p class="body-default request-name">{{ booking.venue?.name ?? "Venue unavailable" }}</p>
          <p v-if="booking.venue" class="body-small muted">{{ booking.venue.location }}</p>
          <p class="body-small muted">Requested {{ formatMoment(booking.createdAt) }}</p>
          <p v-if="booking.status === 'On Hold' && booking.holdExpiresAt" class="body-small muted">
            Hold expires {{ formatMoment(booking.holdExpiresAt) }}
          </p>
          <!-- E4-10 AC4: Venue Staff must record why they refused, and the
               coordinator is told it. -->
          <p v-if="booking.status === 'Rejected' && booking.decisionReason" class="body-small reason">
            Reason: {{ booking.decisionReason }}
          </p>
        </div>
        <span class="badge" :class="bookingStatusBadgeClass(booking.status)">
          {{ bookingStatusLabel(booking.status) }}
        </span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.venue-requests {
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

.reason {
  color: var(--color-error-600);
}

.request-list {
  display: grid;
  gap: var(--spacing-12);
  list-style: none;
  margin: 0;
  padding: 0;
}

.request-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--spacing-16);
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-xs);
  padding: var(--spacing-16);
}

.request-name {
  font-weight: 700;
}

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
  background: #e5eee5;
  color: var(--color-success-700);
}

.status-warning {
  background: #fef5e7;
  color: var(--color-warning-600);
}

.status-error {
  background: var(--color-error-200);
  color: var(--color-error-600);
}

.status-info {
  background: var(--color-warning-200);
  color: var(--color-warning-700);
}
</style>
