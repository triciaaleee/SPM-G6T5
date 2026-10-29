<script setup lang="ts">
/**
 * E1-10/E3-12/E3-13: the Safety Officer's queue — every event awaiting an
 * Operational Safety Check, with the coordinator's safety notes, and the
 * approve (E3-12), request changes (E3-14) and reject (E3-13) actions.
 * Rejecting opens an inline reason box, because a reason is required and
 * the coordinator is sent it. Requesting changes opens a box listing the
 * event's venue bookings and equipment: at least one must be picked and
 * what must change described (E3-14 AC1/AC2). An event resubmitted after a
 * change request shows which of those flags were addressed (AC3).
 * Matches VenueRequestQueue.vue's layout and styling.
 */
import AppButton from "../../components/ui/AppButton.vue";
import { computed, onMounted, ref } from "vue";
import {
  approveSafetyReview,
  fetchSafetyReviewQueue,
  MAX_SAFETY_REJECT_REASON_LENGTH,
  rejectSafetyReview,
  requestSafetyChanges,
  SafetyChangesError,
  SafetyReviewApproveError,
  SafetyReviewRejectError,
  type SafetyArrangementOption,
  type SafetyReviewQueueItem,
} from "../../lib/eventsApi";

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
  cancelChanges();
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

// ---- E3-14: request changes ---------------------------------------------

/**
 * The row whose request-changes box is open, the arrangements ticked, what
 * must change about each (keyed like the server's `note:<type>:<id>`
 * fields) and the optional general note.
 */
const changesId = ref<number | null>(null);
const changesSelected = ref<Set<string>>(new Set());
const changesNotes = ref<Record<string, string>>({});
const changesGeneral = ref("");
const changesErrors = ref<Record<string, string | undefined>>({});

function arrangementKey(option: { type: string; id: number }): string {
  return `${option.type}:${option.id}`;
}

function openChanges(event: SafetyReviewQueueItem): void {
  cancelReject();
  changesId.value = event.id;
  changesSelected.value = new Set();
  changesNotes.value = {};
  changesGeneral.value = "";
  changesErrors.value = {};
  rowError.value = null;
}

function cancelChanges(): void {
  changesId.value = null;
  changesSelected.value = new Set();
  changesNotes.value = {};
  changesGeneral.value = "";
  changesErrors.value = {};
}

function noteKey(option: { type: string; id: number }): string {
  return `note:${arrangementKey(option)}`;
}

function toggleArrangement(option: SafetyArrangementOption): void {
  const next = new Set(changesSelected.value);
  const key = arrangementKey(option);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  changesSelected.value = next;
  if (next.size > 0) changesErrors.value = { ...changesErrors.value, arrangements: undefined };
}

/** AC2: mirrors the backend's checks — at least one arrangement, each with what must change. */
async function confirmChanges(event: SafetyReviewQueueItem): Promise<void> {
  const selected = (event.arrangements ?? []).filter((option) => changesSelected.value.has(arrangementKey(option)));
  const general = changesGeneral.value.trim();
  const errors: Record<string, string> = {};
  if (selected.length === 0) errors.arrangements = "Select at least one venue booking or equipment reservation that must change.";
  for (const option of selected) {
    const note = (changesNotes.value[noteKey(option)] ?? "").trim();
    if (!note) errors[noteKey(option)] = "Say what must change here.";
    else if (note.length > MAX_SAFETY_REJECT_REASON_LENGTH) {
      errors[noteKey(option)] = `Keep this under ${MAX_SAFETY_REJECT_REASON_LENGTH} characters.`;
    }
  }
  if (general.length > MAX_SAFETY_REJECT_REASON_LENGTH) {
    errors.generalNote = `Keep this under ${MAX_SAFETY_REJECT_REASON_LENGTH} characters.`;
  }
  changesErrors.value = errors;
  if (Object.keys(errors).length > 0) return;

  busyId.value = event.id;
  rowError.value = null;
  notice.value = null;
  try {
    await requestSafetyChanges(
      event.id,
      selected.map(({ type, id }) => ({ type, id, note: changesNotes.value[noteKey({ type, id })].trim() })),
      general || null,
    );
    notice.value = `Changes requested for ${eventName(event)} — back in Planning. The coordinator has been sent your notes.`;
    cancelChanges();
    await load();
  } catch (err) {
    if (err instanceof SafetyChangesError && Object.keys(err.fields).length > 0) changesErrors.value = err.fields;
    rowError.value = {
      id: event.id,
      message: err instanceof SafetyChangesError ? err.message : "Couldn't request changes. Try again.",
    };
  } finally {
    busyId.value = null;
  }
}

function formatMoment(value: string): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  return at.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
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

          <!-- E3-14 AC3: on a resubmission, what was asked for last time and whether it was addressed. -->
          <div v-if="event.changeRequest" class="previous-changes">
            <p class="body-small muted">You requested changes on {{ formatMoment(event.changeRequest.requestedAt) }}</p>
            <ul class="flag-list">
              <li v-for="flag in event.changeRequest.flags" :key="`${flag.type}:${flag.id}`" class="flag-row">
                <span class="body-small"><strong>{{ flag.label }}:</strong> {{ flag.note }}</span>
                <span class="flag-state" :class="flag.clearedAt ? 'flag-state--done' : 'flag-state--open'">
                  {{ flag.clearedAt ? "Changed" : "Not changed" }}
                </span>
              </li>
            </ul>
            <p v-if="event.changeRequest.generalNote" class="body-small">
              <strong>General:</strong> {{ event.changeRequest.generalNote }}
            </p>
          </div>

          <div v-if="rejectingId === event.id" class="reject-box">
            <label :for="`reason-${event.id}`" class="body-small muted">Reason for rejecting</label>
            <textarea :id="`reason-${event.id}`" v-model="rejectReason" rows="3" class="reason-input"
              :maxlength="MAX_SAFETY_REJECT_REASON_LENGTH" placeholder="The coordinator is sent this." />
            <p v-if="rejectReasonError" class="body-small error-text">{{ rejectReasonError }}</p>
            <div class="actions">
              <AppButton variant="danger" type="button" :disabled="busyId === event.id" @click="confirmReject(event)">
                {{ busyId === event.id ? "Rejecting…" : "Confirm rejection" }}
              </AppButton>
              <AppButton variant="outline" type="button" :disabled="busyId === event.id" @click="cancelReject">
                Cancel
              </AppButton>
            </div>
          </div>

          <!-- E3-14: pick what must change and describe it (AC1); both are required (AC2). -->
          <div v-else-if="changesId === event.id" class="reject-box">
            <fieldset class="arrangements">
              <legend class="body-small muted">Affected arrangements (pick at least one)</legend>
              <p v-if="!event.arrangements" class="body-small error-text">
                This event's venue bookings and equipment couldn't be loaded. Refresh the page to try again.
              </p>
              <p v-else-if="event.arrangements.length === 0" class="body-small muted">
                This event has no venue bookings or equipment to flag.
              </p>
              <div v-for="option in event.arrangements ?? []" :key="arrangementKey(option)" class="arrangement-item">
                <label class="arrangement">
                  <input type="checkbox" class="arrangement__check"
                    :checked="changesSelected.has(arrangementKey(option))" @change="toggleArrangement(option)" />
                  <span class="body-default">{{ option.label }}</span>
                  <span class="body-small muted">
                    {{ option.type === "venue_booking" ? "Venue booking" : "Equipment" }} · {{ option.detail }}
                  </span>
                </label>
                <!-- Each ticked arrangement says what must change about it (AC1/AC2). -->
                <template v-if="changesSelected.has(arrangementKey(option))">
                  <textarea v-model="changesNotes[noteKey(option)]" rows="2" class="reason-input arrangement__note"
                    :maxlength="MAX_SAFETY_REJECT_REASON_LENGTH" :aria-label="`What must change: ${option.label}`"
                    :placeholder="`What must change about ${option.label}?`" />
                  <p v-if="changesErrors[noteKey(option)]" class="body-small error-text arrangement__note">
                    {{ changesErrors[noteKey(option)] }}
                  </p>
                </template>
              </div>
              <p v-if="changesErrors.arrangements" class="body-small error-text">{{ changesErrors.arrangements }}</p>
            </fieldset>
            <label :for="`changes-general-${event.id}`" class="body-small muted">General notes (optional)</label>
            <textarea :id="`changes-general-${event.id}`" v-model="changesGeneral" rows="2" class="reason-input"
              :maxlength="MAX_SAFETY_REJECT_REASON_LENGTH"
              placeholder="Anything that isn't about one arrangement, e.g. send an updated crowd plan." />
            <p v-if="changesErrors.generalNote" class="body-small error-text">{{ changesErrors.generalNote }}</p>
            <div class="actions">
              <AppButton variant="primary" type="button" :disabled="busyId === event.id" @click="confirmChanges(event)">
                {{ busyId === event.id ? "Sending…" : "Send to coordinator" }}
              </AppButton>
              <AppButton variant="outline" type="button" :disabled="busyId === event.id" @click="cancelChanges">
                Cancel
              </AppButton>
            </div>
          </div>

          <div v-else class="actions">
            <AppButton variant="primary" type="button" :disabled="busyId === event.id" @click="approve(event)">
              {{ busyId === event.id ? "Approving…" : "Approve" }}
            </AppButton>
            <AppButton variant="outline" type="button" :disabled="busyId === event.id" @click="openChanges(event)">
              Request changes
            </AppButton>
            <AppButton variant="danger" type="button" :disabled="busyId === event.id" @click="openReject(event)">
              Reject
            </AppButton>
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

/* Style.md 3.4: outline purple — the secondary action beside the solid Approve. */

/* E3-14: the arrangements to flag, and a resubmitted event's earlier request. */
.arrangements {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
  margin: 0;
  padding: 0;
  border: none;
}

.arrangements legend {
  padding: 0;
  margin-bottom: var(--spacing-4);
}

.arrangement {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--spacing-8);
  cursor: pointer;
}

.arrangement__check {
  accent-color: var(--color-purple-600);
}

.arrangement-item {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-4);
}

/* Indented under its checkbox so it reads as that arrangement's note. */
.arrangement__note {
  margin-left: var(--spacing-24);
}

.previous-changes {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-4);
  margin-top: var(--spacing-16);
  padding: var(--spacing-12) var(--spacing-16);
  border: 1px solid var(--color-warning-300);
  border-radius: var(--radius-xs);
  background: var(--color-warning-100);
}

.previous-changes p {
  margin: 0;
}

.flag-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-4);
  margin: var(--spacing-4) 0 0;
  padding: 0;
  list-style: none;
}

.flag-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-8);
}

.flag-state {
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
}

.flag-state--done {
  color: var(--color-success-600);
}

.flag-state--open {
  color: var(--color-warning-900);
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
