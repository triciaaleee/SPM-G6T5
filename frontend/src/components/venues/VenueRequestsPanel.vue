<script setup lang="ts">
/**
 * E4-8 AC5: the venue requests made for one event and the state each one
 * is in, so a coordinator can see a request is pending without leaving the
 * event page. An event may have any number of bookings (AGENTS.md §3a
 * change 3), each decided on its own by Venue Staff, so they are listed
 * rather than summarised into a single "venue" field.
 *
 * E4-9: the assigned coordinator can withdraw a pending request/hold or
 * release a confirmed booking right from this list. Approving or rejecting
 * one is Venue Staff's (E4-10) and stays read-only here.
 *
 * Column mapping: its own card in the event detail page's main column (the
 * 2fr of its 2fr/1fr desktop grid, full width once that collapses), a
 * sibling of the venue recommendations card rather than part of it. The
 * list inside is a single column at every breakpoint.
 */
import AppButton from "../ui/AppButton.vue";
import { computed, ref } from "vue";
import { CheckCircleIcon, XCircleIcon } from "@heroicons/vue/16/solid";
import {
  describeBookingFailure,
  describeSuitabilityReasons,
  purposeLabel,
  releaseVenueBooking,
  withdrawVenueBooking,
  type BookingSuitability,
  type EventVenueBooking,
} from "../../lib/venuesApi";
import { bookingStatusBadgeClass, bookingStatusLabel } from "../../lib/bookingStatus";

/**
 * The bookings are owned by the event page rather than fetched here: the
 * outstanding-arrangements line reads the same list, and both must refresh
 * together when a request is submitted from the recommendations above (or
 * withdrawn/released here).
 */
const props = defineProps<{
  /** Undefined while the first load is still in flight. */
  bookings: EventVenueBooking[] | undefined;
  loading: boolean;
  loadError: string | null;
  /** E4-9: only the event's assigned coordinator may withdraw or release a booking. */
  canWithdraw?: boolean;
  /** E4-17: each booking's purpose, headcount and suitability; left out, none is shown. */
  suitability?: BookingSuitability[];
}>();

/** E4-17: suitability only matters for bookings still holding or asking for a venue. */
const SUITABILITY_STATUSES = new Set(["Requested", "On Hold", "Approved", "Replacement Required"]);

const suitabilityById = computed(() => new Map((props.suitability ?? []).map((s) => [s.bookingId, s])));

/** e.g. "Breakout · 60 people". */
function purposeAndHeadcount(booking: BookingSuitability): string {
  return booking.headcount === null ? purposeLabel(booking) : `${purposeLabel(booking)} · ${booking.headcount} people`;
}

const emit = defineEmits<{ changed: [] }>();

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

/**
 * AC1 vs AC2: a pending request/hold is withdrawn; a confirmed one is
 * released. E4-15 AC3: a Replacement Required booking is also released,
 * once the coordinator has requested a replacement venue.
 */
function actionFor(status: string): "withdraw" | "release" | null {
  if (status === "Requested" || status === "On Hold") return "withdraw";
  if (status === "Approved" || status === "Replacement Required") return "release";
  return null;
}

// One action at a time, with the outcome shown on the row it came from —
// same pattern as venue recommendations' per-card request state.
const actingId = ref<number | null>(null);
const actionErrorId = ref<number | null>(null);
const actionError = ref("");

/** The booking awaiting confirmation in the modal below; null when it's closed. */
const pendingAction = ref<EventVenueBooking | null>(null);

const pendingActionKind = computed(() => (pendingAction.value ? actionFor(pendingAction.value.status) : null));

const pendingActionCopy = computed(() => {
  const venueName = pendingAction.value?.venue?.name ?? "this venue";
  if (pendingActionKind.value === "release") {
    const body =
      pendingAction.value?.status === "Replacement Required"
        ? `${venueName} is no longer available for this event. Releasing it clears the booking now that a replacement has been requested — this cannot be undone.`
        : `${venueName} is Approved for this event. Releasing it frees the venue for other requests — this cannot be undone.`;
    return { title: "Release this booking?", body, confirmLabel: "Release" };
  }
  return {
    title: "Withdraw this request?",
    body: `Venue Staff will be notified and stop working on ${venueName} for this event. You can request another venue afterwards.`,
    confirmLabel: "Withdraw",
  };
});

/** Opens the confirm modal for `booking`'s withdraw/release action. */
function requestAction(booking: EventVenueBooking): void {
  if (!actionFor(booking.status)) return;
  pendingAction.value = booking;
}

function cancelAction(): void {
  pendingAction.value = null;
}

async function confirmAction(): Promise<void> {
  const booking = pendingAction.value;
  const action = booking ? actionFor(booking.status) : null;
  if (!booking || !action) return;

  actingId.value = booking.id;
  actionErrorId.value = null;
  actionError.value = "";
  try {
    if (action === "withdraw") await withdrawVenueBooking(booking.id);
    else await releaseVenueBooking(booking.id);
    pendingAction.value = null;
    emit("changed");
  } catch (err) {
    pendingAction.value = null;
    actionErrorId.value = booking.id;
    actionError.value = describeBookingFailure(err, `Failed to ${action} this booking`);
  } finally {
    actingId.value = null;
  }
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
          <!-- E4-17: what this venue is for, and whether it suits that (AC2–AC4). -->
          <template v-if="suitabilityById.get(booking.id)">
            <p class="body-small purpose">{{ purposeAndHeadcount(suitabilityById.get(booking.id)!) }}</p>
            <p v-if="SUITABILITY_STATUSES.has(booking.status) && suitabilityById.get(booking.id)!.suitability"
              class="body-small suitability"
              :class="suitabilityById.get(booking.id)!.suitability!.suitable ? 'suitability--ok' : 'suitability--bad'">
              <template v-if="suitabilityById.get(booking.id)!.suitability!.suitable">
                <CheckCircleIcon class="suitability__icon" aria-hidden="true" />Suitable for this booking
              </template>
              <template v-else>
                <XCircleIcon class="suitability__icon" aria-hidden="true" />Unsuitable:
                {{ describeSuitabilityReasons(suitabilityById.get(booking.id)!.suitability!.reasons).join("; ") }}
              </template>
            </p>
          </template>
          <p class="body-small muted">Requested {{ formatMoment(booking.createdAt) }}</p>
          <p v-if="booking.status === 'On Hold' && booking.holdExpiresAt" class="body-small muted">
            Hold expires {{ formatMoment(booking.holdExpiresAt) }}
          </p>
          <!-- E4-10 AC4: Venue Staff must record why they refused, and the
               coordinator is told it. -->
          <p v-if="booking.status === 'Rejected' && booking.decisionReason" class="body-small reason">
            Reason: {{ booking.decisionReason }}
          </p>
          <p v-if="actionErrorId === booking.id" class="body-small error-text" role="alert">
            {{ actionError }}
          </p>
        </div>
        <div class="request-status">
          <span class="badge" :class="bookingStatusBadgeClass(booking.status)">
            {{ bookingStatusLabel(booking.status) }}
          </span>
          <!-- E4-9: withdraw a pending request/hold, or release an Approved
               booking. Approving/rejecting stays Venue Staff's (E4-10). -->
          <AppButton variant="outline" size="sm" class="action-btn" v-if="canWithdraw && actionFor(booking.status)" type="button"
            :disabled="actingId === booking.id" @click="requestAction(booking)">
            {{
              actingId === booking.id
                ? "Working…"
                : actionFor(booking.status) === "withdraw"
                  ? "Withdraw"
                  : "Release"
            }}
          </AppButton>
        </div>
      </li>
    </ul>

    <!-- E4-9: a small confirm dialog in place of the browser's native confirm(). -->
    <div v-if="pendingAction" class="modal-overlay" @click.self="cancelAction">
      <div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="withdraw-confirm-title">
        <p id="withdraw-confirm-title" class="modal-title">{{ pendingActionCopy.title }}</p>
        <p class="body-default muted">{{ pendingActionCopy.body }}</p>
        <div class="modal-actions">
          <AppButton variant="outline" type="button" :disabled="actingId !== null"
            @click="cancelAction">
            Cancel
          </AppButton>
          <AppButton variant="danger-solid" type="button" :disabled="actingId !== null"
            @click="confirmAction">
            {{ actingId !== null ? "Working…" : pendingActionCopy.confirmLabel }}
          </AppButton>
        </div>
      </div>
    </div>
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

/* E4-17: Style.md 3.1 success/error text for the suitability line. */
.purpose {
  color: var(--color-grey-700);
  font-weight: 700;
}

.suitability {
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-4);
}

.suitability__icon {
  flex-shrink: 0;
  width: var(--spacing-16);
  height: var(--spacing-16);
  margin-top: var(--spacing-2);
}

.suitability--ok {
  color: var(--color-success-600);
}

.suitability--bad {
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

.request-status {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: var(--spacing-8);
}

/* Style.md 3.4 Button Hierarchy (outline) + 8.2 focus ring; radius-xs. */

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

.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 40%);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-24);
  z-index: 50;
}

.modal {
  background: var(--color-base-white);
  border-radius: var(--radius-lg);
  padding: var(--spacing-24);
  max-width: 400px;
  width: 100%;
}

.modal-title {
  font-size: 1.125rem;
  font-weight: 700;
  color: var(--color-grey-900);
  margin: 0 0 var(--spacing-8);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--spacing-8);
  margin-top: var(--spacing-24);
}

</style>
