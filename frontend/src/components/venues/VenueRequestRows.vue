<script setup lang="ts">
/**
 * E4-10: the Venue Staff decision rows. One compact row per booking still
 * waiting on them (Requested or On Hold), with the three decisions on it:
 * place on hold (AC1), approve (AC3/AC4) and reject (AC5). Rejecting opens
 * an inline reason box, because a reason is required and the coordinator is
 * shown it. A refused action keeps its message on the row: a clash names the
 * window that is already taken, setup and turnaround included.
 *
 * The parent owns the list (it filters by venue and date and puts it in
 * order, AC7) and reloads it when a decision lands, because a hold or an
 * approval can auto-reject other requests in the same list (§3a).
 *
 * Column mapping: the rows sit inside the schedule's full-width section; each
 * row is a local grid of date, time, event, attendance and actions (the
 * actions wrap under the row on mobile).
 */
import AppButton from "../ui/AppButton.vue";
import { ref } from "vue";
import {
  approveBooking,
  describeBookingFailure,
  holdBooking,
  rejectBooking,
  type PendingVenueRequest,
} from "../../lib/venuesApi";

defineProps<{ requests: PendingVenueRequest[] }>();
const emit = defineEmits<{ decided: [message: string] }>();

/** The row currently being acted on, so only its buttons are disabled. */
const busyId = ref<number | null>(null);
const rowError = ref<{ id: number; message: string } | null>(null);

/** The row whose reject-reason box is open, and what's typed in it. */
const rejectingId = ref<number | null>(null);
const rejectReason = ref("");
const rejectReasonError = ref<string | null>(null);

/** Booking ids whose layout / facility details are open. */
const expanded = ref<Set<number>>(new Set());
function toggleDetails(id: number): void {
  const next = new Set(expanded.value);
  if (!next.delete(id)) next.add(id);
  expanded.value = next;
}

async function runDecision(
  request: PendingVenueRequest,
  decide: () => Promise<{ autoRejectedBookingIds: number[] }>,
  past: string,
): Promise<void> {
  busyId.value = request.id;
  rowError.value = null;
  try {
    const result = await decide();
    const alsoRejected = result.autoRejectedBookingIds.length;
    rejectingId.value = null;
    rejectReason.value = "";
    emit(
      "decided",
      `${request.venue.name} ${past} for ${request.event.name ?? `event #${request.event.id}`}.` +
        (alsoRejected > 0
          ? ` ${alsoRejected} overlapping request${alsoRejected === 1 ? " was" : "s were"} rejected automatically.`
          : ""),
    );
  } catch (err) {
    rowError.value = { id: request.id, message: describeBookingFailure(err) };
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
  return date.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

function formatWindow(request: PendingVenueRequest): string {
  const { startTime, endTime } = request.event;
  return startTime && endTime ? `${startTime}–${endTime}` : "All day";
}

/** What the venue is actually tied up for, padding included. */
function paddingNote(request: PendingVenueRequest): string {
  const { setupMinutes, turnaroundMinutes } = request.venue;
  if (setupMinutes === 0 && turnaroundMinutes === 0) return "";
  return `+ ${setupMinutes} min setup, ${turnaroundMinutes} min turnaround`;
}

function formatMoment(value: string | null): string {
  if (!value) return "";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  return at.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}
</script>

<template>
  <ul class="rows">
    <li class="rows__head" aria-hidden="true">
      <span>Date</span><span>Time</span><span>Event</span><span>Attendance</span><span />
    </li>
    <li v-for="request in requests" :key="request.id" class="row">
      <div class="row__main">
        <span class="row__date">{{ formatDate(request.event.date) }}</span>
        <span class="row__time">
          {{ formatWindow(request) }}
          <span v-if="paddingNote(request)" class="row__sub">{{ paddingNote(request) }}</span>
        </span>
        <span class="row__event">
          <span class="row__name">{{ request.event.name ?? `Event #${request.event.id}` }}</span>
          <span class="row__sub">{{ request.venue.name }} · {{ request.venue.location }}</span>
          <span v-if="request.status === 'On Hold' && request.holdExpiresAt" class="row__hold">
            On hold · Hold expires {{ formatMoment(request.holdExpiresAt) }}
          </span>
          <button type="button" class="link-button row__toggle" :aria-expanded="expanded.has(request.id)"
            @click="toggleDetails(request.id)">
            {{ expanded.has(request.id) ? "Hide details" : "Details" }}
          </button>
        </span>
        <!-- E4-17: what this venue is for, sized for its own session. -->
        <span class="row__people">
          <template v-if="request.setup">
            {{ request.setup.headcount ?? "—" }} people
            <span class="row__sub">{{ request.setup.purpose }}</span>
          </template>
          <template v-else>{{ request.event.expectedAttendance ?? "—" }}</template>
        </span>

        <div v-if="rejectingId !== request.id" class="row__actions">
          <AppButton v-if="request.status === 'Requested'" variant="outline" size="sm" type="button"
            :disabled="busyId === request.id" @click="hold(request)">
            Hold
          </AppButton>
          <AppButton variant="primary" size="sm" type="button" :disabled="busyId === request.id" @click="approve(request)">
            Approve
          </AppButton>
          <AppButton variant="danger" size="sm" type="button" :disabled="busyId === request.id" @click="openReject(request)">
            Reject
          </AppButton>
        </div>
        <span v-else />
      </div>

      <div v-if="rejectingId === request.id" class="reject-box">
        <label :for="`reason-${request.id}`" class="row__sub">Reason for rejecting</label>
        <textarea :id="`reason-${request.id}`" v-model="rejectReason" rows="2" class="reason-input"
          placeholder="The coordinator is shown this." />
        <p v-if="rejectReasonError" class="row__error">{{ rejectReasonError }}</p>
        <div class="row__actions">
          <AppButton variant="danger" type="button" :disabled="busyId === request.id" @click="confirmReject(request)">
            {{ busyId === request.id ? "Rejecting…" : "Confirm rejection" }}
          </AppButton>
          <AppButton variant="outline" type="button" :disabled="busyId === request.id" @click="cancelReject">
            Cancel
          </AppButton>
        </div>
      </div>

      <dl v-if="expanded.has(request.id)" class="row__details">
        <div>
          <dt class="detail__label">Layout</dt>
          <dd v-if="(request.setup ?? request.event).layouts.length > 0" class="tags">
            <span v-for="layout in (request.setup ?? request.event).layouts" :key="layout" class="tag">{{ layout }}</span>
          </dd>
          <dd v-else class="row__sub">Not specified</dd>
        </div>
        <div>
          <dt class="detail__label">Facility requirements</dt>
          <dd v-if="(request.setup ?? request.event).facilities.length > 0" class="tags">
            <span v-for="facility in (request.setup ?? request.event).facilities" :key="facility" class="tag">
              {{ facility }}
            </span>
          </dd>
          <dd v-else class="row__sub">None specified</dd>
        </div>
      </dl>

      <p v-if="rowError?.id === request.id" class="row__error row__error--pad" role="alert">{{ rowError.message }}</p>
    </li>
  </ul>
</template>

<style scoped>
.rows {
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-sm);
  background: var(--color-base-white);
}

.rows__head {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--color-base-white);
}

.rows__head,
.row__main {
  display: grid;
  /* The last column is a fixed width, so the heading row and every row line up. */
  grid-template-columns: 6rem 8rem minmax(0, 1fr) 8rem 18rem;
  align-items: start;
  gap: var(--spacing-16);
  padding: var(--spacing-12) var(--spacing-16);
}

.rows__head {
  border-bottom: 1px solid var(--color-grey-100);
  font-size: 0.75rem;
  font-weight: 700;
  color: var(--color-grey-500);
}

.row + .row {
  border-top: 1px solid var(--color-grey-100);
}

.row__main {
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-900);
}

.row__date {
  font-weight: 700;
}

.row__time,
.row__event,
.row__people {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.row__name {
  overflow: hidden;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row__sub {
  font-size: 0.75rem;
  color: var(--color-grey-500);
}

.row__hold {
  font-size: 0.75rem;
  font-weight: 700;
  color: var(--color-warning-800);
}

.row__actions {
  display: flex;
  flex-wrap: nowrap;
  gap: var(--spacing-8);
  justify-content: flex-end;
}

.link-button {
  align-self: flex-start;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-purple-600);
  font-family: var(--font-family-lato);
  font-size: 0.75rem;
  font-weight: 700;
  cursor: pointer;
}

.link-button:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

.reject-box {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
  padding: 0 var(--spacing-16) var(--spacing-12);
}

/* Style.md 2.2: Grey/200 default input border. 8.2: inputs get both rings. */
.reason-input {
  width: 100%;
  padding: var(--spacing-8) var(--spacing-12);
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-xs);
  font-family: inherit;
  font-size: 0.875rem;
  resize: vertical;
}

.reason-input:focus-visible {
  outline: 2px solid var(--color-purple-600);
  outline-offset: 1px;
  box-shadow: 0 0 0 4px var(--color-purple-100);
}

.row__error {
  margin: 0;
  font-size: 0.75rem;
  color: var(--color-error-600);
}

.row__error--pad {
  padding: 0 var(--spacing-16) var(--spacing-12);
}

.row__details {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--spacing-16);
  margin: 0;
  padding: var(--spacing-12) var(--spacing-16) var(--spacing-16);
  background: var(--color-grey-25);
}

.row__details dd {
  margin: 0;
}

.detail__label {
  margin-bottom: var(--spacing-4);
  font-size: 0.75rem;
  font-weight: 700;
  color: var(--color-grey-500);
}

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-4);
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

@media (max-width: 1024px) {
  .row__main {
    grid-template-columns: 6rem 8rem minmax(0, 1fr);
  }

  .row__people,
  .row__actions {
    grid-column: 1 / 4;
    justify-content: flex-start;
  }

  .row__actions {
    flex-wrap: wrap;
  }
}

@media (max-width: 640px) {
  .rows__head {
    display: none;
  }

  .row__main {
    grid-template-columns: 1fr;
  }

  .row__people,
  .row__actions {
    grid-column: auto;
  }

  .row__details {
    grid-template-columns: 1fr;
  }
}
</style>
