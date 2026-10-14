<script setup lang="ts">
/**
 * E1-10/E3-12/E3-13: the Safety Officer's queue — every event awaiting an
 * Operational Safety Check, with the coordinator's safety notes, and the
 * approve (E3-12) and reject (E3-13) actions. Rejecting opens an inline
 * reason box, because a reason is required and the coordinator is sent it.
 * Request-changes (E3-14) isn't built yet. Matches VenueRequestQueue.vue's
 * layout and styling.
 */
import { computed, onMounted, ref } from "vue";
import {
  approveSafetyReview,
  fetchSafetyReviewQueue,
  MAX_SAFETY_REJECT_REASON_LENGTH,
  rejectSafetyReview,
  SafetyReviewApproveError,
  SafetyReviewRejectError,
  type SafetyReviewQueueItem,
} from "../lib/eventsApi";

const events = ref<SafetyReviewQueueItem[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);

/** The row currently being acted on, so only its button is disabled. */
const busyId = ref<number | null>(null);
const rowError = ref<{ id: number; message: string } | null>(null);
const notice = ref<string | null>(null);

/** The row whose reject-reason box is open, and what's typed in it. */
const rejectingId = ref<number | null>(null);
const rejectReason = ref("");
const rejectReasonError = ref<string | null>(null);

const hasEvents = computed(() => events.value.length > 0);

function eventName(event: SafetyReviewQueueItem): string {
  const details = event.submitted_details as Record<string, unknown>;
  return (details?.name as string) || `Event #${event.id}`;
}

function eventProposedDate(event: SafetyReviewQueueItem): string | null {
  return ((event.submitted_details as Record<string, unknown>)?.proposedDate as string) ?? null;
}

function eventWindow(event: SafetyReviewQueueItem): string {
  const details = event.submitted_details as Record<string, unknown>;
  const startTime = details?.startTime as string | undefined;
  const endTime = details?.endTime as string | undefined;
  return startTime && endTime ? `${startTime}–${endTime}` : "All day";
}

function eventAttendance(event: SafetyReviewQueueItem): string {
  const details = event.submitted_details as Record<string, unknown>;
  return (details?.expectedAttendance as number | undefined)?.toString() ?? "—";
}

function formatDate(value: string | null): string {
  if (!value) return "Date not set";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    events.value = await fetchSafetyReviewQueue();
  } catch (err) {
    events.value = [];
    loadError.value = err instanceof Error ? err.message : "Failed to load the safety review queue";
  } finally {
    loading.value = false;
  }
}

onMounted(load);

async function approve(event: SafetyReviewQueueItem): Promise<void> {
  busyId.value = event.id;
  rowError.value = null;
  notice.value = null;
  try {
    await approveSafetyReview(event.id);
    notice.value = `${eventName(event)} approved — now Confirmed.`;
    await load();
  } catch (err) {
    rowError.value = {
      id: event.id,
      message: err instanceof SafetyReviewApproveError ? err.message : "Couldn't approve this event. Try again.",
    };
  } finally {
    busyId.value = null;
  }
}

function openReject(event: SafetyReviewQueueItem): void {
  rejectingId.value = event.id;
  rejectReason.value = "";
  rejectReasonError.value = null;
  rowError.value = null;
}

function cancelReject(): void {
  rejectingId.value = null;
  rejectReason.value = "";
  rejectReasonError.value = null;
}

/** E3-13 AC2: mirrors the backend's checks so an empty or over-long reason is caught before the round trip. */
async function confirmReject(event: SafetyReviewQueueItem): Promise<void> {
  const reason = rejectReason.value.trim();
  if (!reason) {
    rejectReasonError.value = "Give a reason for rejecting this safety review.";
    return;
  }
  if (reason.length > MAX_SAFETY_REJECT_REASON_LENGTH) {
    rejectReasonError.value = `Keep the reason under ${MAX_SAFETY_REJECT_REASON_LENGTH} characters.`;
    return;
  }
  rejectReasonError.value = null;

  busyId.value = event.id;
  rowError.value = null;
  notice.value = null;
  try {
    await rejectSafetyReview(event.id, reason);
    notice.value = `${eventName(event)} rejected — back in Planning. The coordinator has been sent your reason.`;
    cancelReject();
    await load();
  } catch (err) {
    rowError.value = {
      id: event.id,
      message: err instanceof SafetyReviewRejectError ? err.message : "Couldn't reject this event. Try again.",
    };
  } finally {
    busyId.value = null;
  }
}
</script>

<template>
  <div class="page">
    <div class="content">
      <header class="page-header">
        <div>
          <h1 class="page-title">Safety review queue</h1>
          <p class="body-default muted py-3">
            Events awaiting an Operational Safety Check, with the coordinator's safety notes.
          </p>
        </div>
      </header>

      <p v-if="notice" class="body-default notice" role="status">{{ notice }}</p>

      <p v-if="loading" class="body-default muted">Loading the safety review queue…</p>
      <p v-else-if="loadError" class="body-default error-text" role="alert">{{ loadError }}</p>
      <p v-else-if="!hasEvents" class="body-default muted">No events are awaiting a safety review.</p>

      <ul v-else class="request-list">
        <li v-for="event in events" :key="event.id" class="request-card">
          <div class="request-card__head">
            <div>
              <p class="card-title">{{ eventName(event) }}</p>
              <p class="body-small muted">Coordinator: {{ event.coordinator?.name ?? "Unassigned" }}</p>
            </div>
            <span class="badge status-info">Safety Review</span>
          </div>

          <dl class="request-card__facts">
            <div class="fact">
              <dt class="body-small muted">Date</dt>
              <dd class="body-default">{{ formatDate(eventProposedDate(event)) }}</dd>
            </div>
            <div class="fact">
              <dt class="body-small muted">Time</dt>
              <dd class="body-default">{{ eventWindow(event) }}</dd>
            </div>
            <div class="fact">
              <dt class="body-small muted">Attendance</dt>
              <dd class="body-default">{{ eventAttendance(event) }}</dd>
            </div>
          </dl>

          <dl v-if="event.safetyNotes" class="safety-notes">
            <div class="safety-notes__item">
              <dt class="body-small muted">Equipment placement</dt>
              <dd class="body-default">{{ event.safetyNotes.equipmentPlacement }}</dd>
            </div>
            <div class="safety-notes__item">
              <dt class="body-small muted">Crowd movement</dt>
              <dd class="body-default">{{ event.safetyNotes.crowdMovement }}</dd>
            </div>
            <div class="safety-notes__item">
              <dt class="body-small muted">Emergency access</dt>
              <dd class="body-default">{{ event.safetyNotes.emergencyAccess }}</dd>
            </div>
            <div class="safety-notes__item">
              <dt class="body-small muted">Known venue restrictions</dt>
              <dd class="body-default">{{ event.safetyNotes.venueRestrictions }}</dd>
            </div>
          </dl>

          <div v-if="rejectingId === event.id" class="reject-box">
            <label :for="`reason-${event.id}`" class="body-small muted">Reason for rejecting</label>
            <textarea :id="`reason-${event.id}`" v-model="rejectReason" rows="3" class="reason-input"
              :maxlength="MAX_SAFETY_REJECT_REASON_LENGTH" placeholder="The coordinator is sent this." />
            <p v-if="rejectReasonError" class="body-small error-text">{{ rejectReasonError }}</p>
            <div class="actions">
              <button type="button" class="btn-danger" :disabled="busyId === event.id" @click="confirmReject(event)">
                {{ busyId === event.id ? "Rejecting…" : "Confirm rejection" }}
              </button>
              <button type="button" class="btn-secondary" :disabled="busyId === event.id" @click="cancelReject">
                Cancel
              </button>
            </div>
          </div>

          <div v-else class="actions">
            <button type="button" class="btn-primary" :disabled="busyId === event.id" @click="approve(event)">
              {{ busyId === event.id ? "Approving…" : "Approve" }}
            </button>
            <button type="button" class="btn-danger" :disabled="busyId === event.id" @click="openReject(event)">
              Reject
            </button>
          </div>

          <p v-if="rowError?.id === event.id" class="body-small error-text" role="alert">{{ rowError.message }}</p>
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
  margin-bottom: var(--spacing-16);
}

.fact dd {
  margin: 0;
  display: flex;
  flex-direction: column;
}

.safety-notes {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--spacing-16);
  margin: 0 0 var(--spacing-16);
  padding: var(--spacing-16);
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-xs);
}

.safety-notes__item dd {
  margin: var(--spacing-2) 0 0;
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

.status-info {
  background: var(--color-warning-200);
  color: var(--color-warning-700);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-8);
}

/* Style.md 3.4 Button Hierarchy; 7 radius-xs; 8.2 focus ring. Same set as VenueRequestQueue.vue. */
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
