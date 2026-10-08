<script setup lang="ts">
/**
 * E4-10 AC6: the Venue Staff decision queue. Every booking at the venues
 * this staff member is assigned to that is still waiting on them, ordered
 * by event date so the most urgent surfaces first — the venue schedule
 * (VenueStaff.vue) answers "what's on at this venue on this day", which
 * can't show urgency across venues.
 *
 * Each row offers the three decisions (AC1/AC3/AC4). Rejecting opens an
 * inline reason box, because a reason is required and the coordinator is
 * shown it. A refused action keeps its reason on the row: a clash names
 * the window that is already taken, setup and turnaround included.
 *
 * Column mapping: 12-column desktop grid, content spanning 1/13; 6 columns
 * on tablet (1/7) and 4 on mobile (1/5), matching CoordinatorWorkloadView.
 * The request list is a single column at every breakpoint.
 */
import { computed, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import {
  BookingConflictError,
  approveBooking,
  fetchPendingRequests,
  holdBooking,
  rejectBooking,
  type PendingVenueRequest,
} from "../lib/venuesApi";
import { bookingStatusBadgeClass, bookingStatusLabel } from "../lib/bookingStatus";

const requests = ref<PendingVenueRequest[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);

/** The row currently being acted on, so only its buttons are disabled. */
const busyId = ref<number | null>(null);
const rowError = ref<{ id: number; message: string } | null>(null);
const notice = ref<string | null>(null);

/** The row whose reject-reason box is open, and what's typed in it. */
const rejectingId = ref<number | null>(null);
const rejectReason = ref("");
const rejectReasonError = ref<string | null>(null);

const hasRequests = computed(() => requests.value.length > 0);

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    requests.value = await fetchPendingRequests();
  } catch (err) {
    requests.value = [];
    loadError.value = err instanceof Error ? err.message : "Failed to load booking requests";
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function describeFailure(err: unknown): string {
  if (err instanceof BookingConflictError && err.conflict) {
    return `${err.message}. Already booked ${err.conflict.window}; this event needs ${err.conflict.requestedWindow}.`;
  }
  return err instanceof Error ? err.message : "That didn't work. Try again.";
}

/**
 * Every decision reloads the queue rather than patching the row: a hold or
 * an approval can auto-reject other requests in the same list (§3a), so
 * what's on screen is stale the moment one succeeds.
 */
async function runDecision(request: PendingVenueRequest, decide: () => Promise<{ autoRejectedBookingIds: number[] }>, past: string): Promise<void> {
  busyId.value = request.id;
  rowError.value = null;
  notice.value = null;
  try {
    const result = await decide();
    const alsoRejected = result.autoRejectedBookingIds.length;
    notice.value =
      `${request.venue.name} ${past} for ${request.event.name ?? `event #${request.event.id}`}.` +
      (alsoRejected > 0
        ? ` ${alsoRejected} overlapping request${alsoRejected === 1 ? " was" : "s were"} rejected automatically.`
        : "");
    rejectingId.value = null;
    rejectReason.value = "";
    await load();
  } catch (err) {
    rowError.value = { id: request.id, message: describeFailure(err) };
  } finally {
    busyId.value = null;
  }
}

function hold(request: PendingVenueRequest): Promise<void> {
  return runDecision(request, () => holdBooking(request.id), "is on hold");
}

function approve(request: PendingVenueRequest): Promise<void> {
  return runDecision(request, () => approveBooking(request.id), "is approved");
}

function openReject(request: PendingVenueRequest): void {
  rejectingId.value = request.id;
  rejectReason.value = "";
  rejectReasonError.value = null;
  rowError.value = null;
}

function cancelReject(): void {
  rejectingId.value = null;
  rejectReason.value = "";
  rejectReasonError.value = null;
}

async function confirmReject(request: PendingVenueRequest): Promise<void> {
  if (rejectReason.value.trim() === "") {
    rejectReasonError.value = "Give a reason for rejecting this request.";
    return;
  }
  rejectReasonError.value = null;
  await runDecision(request, () => rejectBooking(request.id, rejectReason.value), "was rejected");
}

function formatDate(value: string | null): string {
  if (!value) return "Date not set";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

function formatWindow(request: PendingVenueRequest): string {
  const { startTime, endTime } = request.event;
  return startTime && endTime ? `${startTime}–${endTime}` : "All day";
}

/** AC1/AC6: what the venue is actually tied up for, padding included. */
function paddingNote(request: PendingVenueRequest): string {
  const { setupMinutes, turnaroundMinutes } = request.venue;
  if (setupMinutes === 0 && turnaroundMinutes === 0) return "";
  return `+ ${setupMinutes} min setup, ${turnaroundMinutes} min turnaround`;
}

function formatMoment(value: string | null): string {
  if (!value) return "";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  return at.toLocaleString("en-US", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
</script>

<template>
  <div class="page">
    <div class="content">
      <header class="page-header">
        <div>
          <h1 class="page-title">Booking requests</h1>
          <p class="body-default muted">
            Requests waiting on you, soonest event first. Holding a venue reserves it until the hold expires.
          </p>
        </div>
        <RouterLink :to="{ name: 'venue-schedule' }" class="btn-secondary">Venue schedule</RouterLink>
      </header>

      <p v-if="notice" class="body-default notice" role="status">{{ notice }}</p>

      <p v-if="loading" class="body-default muted">Loading booking requests…</p>
      <p v-else-if="loadError" class="body-default error-text" role="alert">{{ loadError }}</p>
      <p v-else-if="!hasRequests" class="body-default muted">
        Nothing is waiting on a decision right now.
      </p>

      <ul v-else class="request-list">
        <li v-for="request in requests" :key="request.id" class="request-card">
          <div class="request-card__head">
            <div>
              <p class="card-title">{{ request.event.name ?? `Event #${request.event.id}` }}</p>
              <p class="body-small muted">{{ request.venue.name }} · {{ request.venue.location }}</p>
            </div>
            <span class="badge" :class="bookingStatusBadgeClass(request.status)">
              {{ bookingStatusLabel(request.status) }}
            </span>
          </div>

          <dl class="request-card__facts">
            <div class="fact">
              <dt class="body-small muted">Date</dt>
              <dd class="body-default">{{ formatDate(request.event.date) }}</dd>
            </div>
            <div class="fact">
              <dt class="body-small muted">Time</dt>
              <dd class="body-default">
                {{ formatWindow(request) }}
                <span v-if="paddingNote(request)" class="body-small muted">{{ paddingNote(request) }}</span>
              </dd>
            </div>
            <div class="fact">
              <dt class="body-small muted">Attendance</dt>
              <dd class="body-default">{{ request.event.expectedAttendance ?? "—" }}</dd>
            </div>
            <div v-if="request.status === 'On Hold' && request.holdExpiresAt" class="fact">
              <dt class="body-small muted">Hold expires</dt>
              <dd class="body-default">{{ formatMoment(request.holdExpiresAt) }}</dd>
            </div>
          </dl>

          <div v-if="request.event.layouts.length > 0 || request.event.facilities.length > 0" class="tags">
            <span v-for="layout in request.event.layouts" :key="`l-${layout}`" class="tag">{{ layout }}</span>
            <span v-for="facility in request.event.facilities" :key="`f-${facility}`" class="tag">{{ facility }}</span>
          </div>

          <div v-if="rejectingId === request.id" class="reject-box">
            <label :for="`reason-${request.id}`" class="body-small muted">Reason for rejecting</label>
            <textarea :id="`reason-${request.id}`" v-model="rejectReason" rows="2" class="reason-input"
              placeholder="The coordinator is shown this." />
            <p v-if="rejectReasonError" class="body-small error-text">{{ rejectReasonError }}</p>
            <div class="actions">
              <button type="button" class="btn-danger" :disabled="busyId === request.id"
                @click="confirmReject(request)">
                {{ busyId === request.id ? "Rejecting…" : "Confirm rejection" }}
              </button>
              <button type="button" class="btn-secondary" :disabled="busyId === request.id" @click="cancelReject">
                Cancel
              </button>
            </div>
          </div>

          <div v-else class="actions">
            <button v-if="request.status === 'Requested'" type="button" class="btn-secondary"
              :disabled="busyId === request.id" @click="hold(request)">
              Hold
            </button>
            <button type="button" class="btn-primary" :disabled="busyId === request.id" @click="approve(request)">
              Approve
            </button>
            <button type="button" class="btn-danger" :disabled="busyId === request.id" @click="openReject(request)">
              Reject
            </button>
          </div>

          <p v-if="rowError?.id === request.id" class="body-small error-text" role="alert">{{ rowError.message }}</p>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
/* Style.md 6.2 Layout Grid Tokens: 12 / 6 / 4 columns with their margins. */
.page {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: var(--grid-desktop-gutter);
  padding: var(--spacing-40) var(--grid-desktop-margin);
  align-content: start;
}

.content {
  grid-column: 1 / 13;
}

@media (max-width: 1024px) {
  .page {
    grid-template-columns: repeat(6, 1fr);
    padding: var(--spacing-32) var(--grid-tablet-margin);
  }

  .content {
    grid-column: 1 / 7;
  }
}

@media (max-width: 640px) {
  .page {
    grid-template-columns: repeat(4, 1fr);
    padding: var(--spacing-24) var(--grid-mobile-margin);
  }

  .content {
    grid-column: 1 / 5;
  }
}

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--spacing-16);
  margin-bottom: var(--spacing-24);
}

.page-title {
  font-size: 2rem;
  font-weight: 700;
  color: var(--color-grey-900);
}

.card-title {
  font-size: 1rem;
  font-weight: 700;
  color: var(--color-grey-900);
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
  margin-top: var(--spacing-8);
}

.notice {
  background: var(--color-purple-100);
  color: var(--color-purple-800);
  border-radius: var(--radius-xs);
  padding: var(--spacing-12) var(--spacing-16);
  margin-bottom: var(--spacing-16);
}

.request-list {
  display: grid;
  gap: var(--spacing-16);
  list-style: none;
  margin: 0;
  padding: 0;
}

.request-card {
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
  padding: var(--spacing-24);
}

.request-card__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--spacing-16);
  margin-bottom: var(--spacing-16);
}

.request-card__facts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-24);
  margin-bottom: var(--spacing-12);
}

.fact dd {
  margin: 0;
  display: flex;
  flex-direction: column;
}

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-4);
  margin-bottom: var(--spacing-16);
}

/* Style.md 5: Small Text / Tag; chip radius-xs. */
.tag {
  padding: var(--spacing-2) var(--spacing-8);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-xs);
  background: var(--color-base-white);
  font-size: 0.75rem;
  font-weight: 700;
  color: var(--color-grey-700);
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

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-8);
}

/* Style.md 3.4 Button Hierarchy; 7 radius-xs; 8.2 focus ring. */
.btn-primary,
.btn-secondary,
.btn-danger {
  padding: var(--spacing-8) var(--spacing-16);
  border-radius: var(--radius-xs);
  font-size: 0.875rem;
  font-weight: 700;
  cursor: pointer;
  border: 1px solid transparent;
}

.btn-primary {
  background: var(--color-purple-600);
  color: var(--color-base-white);
}

.btn-primary:hover:not(:disabled) {
  background: var(--color-purple-700);
}

.btn-secondary {
  background: var(--color-base-white);
  border-color: var(--color-grey-200);
  color: var(--color-grey-900);
  text-decoration: none;
  display: inline-block;
}

.btn-secondary:hover:not(:disabled) {
  background: var(--color-grey-50);
}

.btn-danger {
  background: var(--color-base-white);
  border-color: var(--color-error-200);
  color: var(--color-error-600);
}

.btn-danger:hover:not(:disabled) {
  background: var(--color-error-200);
}

.btn-primary:focus-visible,
.btn-secondary:focus-visible,
.btn-danger:focus-visible {
  outline: 2px solid var(--color-purple-600);
  outline-offset: 2px;
}

.btn-primary:disabled,
.btn-secondary:disabled,
.btn-danger:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.reject-box {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
  margin-bottom: var(--spacing-8);
}

/* Style.md 2.2: Grey/200 default input border. 8.2: inputs get both rings. */
.reason-input {
  width: 100%;
  padding: var(--spacing-8) var(--spacing-12);
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-xs);
  font-size: 0.875rem;
  font-family: inherit;
  resize: vertical;
}

.reason-input:focus-visible {
  outline: 2px solid var(--color-purple-600);
  outline-offset: 1px;
  box-shadow: 0 0 0 4px var(--color-purple-100);
}
</style>
