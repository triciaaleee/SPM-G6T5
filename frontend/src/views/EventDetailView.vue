<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import {
  AccessDeniedError,
  NotFoundError,
  ReviewActionError,
  approveEvent,
  fetchEventById,
  getCurrentUser,
  rejectEvent,
  requestClarification,
  type EventSummary,
} from "../lib/eventsApi";
import { statusBadgeClass } from "../lib/eventStatus";

interface SubmittedEventDetails {
  name?: string;
  purpose?: string;
  description?: string;
  proposedDate?: string;
  startTime?: string;
  endTime?: string;
  expectedAttendance?: number;
  venue?: string;
  accessibility?: string;
  equipment?: string;
  technicalSupport?: string;
  registrationNeeded?: boolean;
}

const route = useRoute();
const event = ref<EventSummary | null>(null);
const loading = ref(true);
const accessDenied = ref(false);
const notFound = ref(false);
const errorMessage = ref<string | null>(null);
const currentUser = ref<{ id: string; role: string | undefined }>({ id: "", role: undefined });

const isCoordinator = computed(() => currentUser.value.role === "coordinator");
const isAssignedCoordinator = computed(
  () => isCoordinator.value && event.value?.coordinator_id === currentUser.value.id,
);
const isOtherCoordinatorEvent = computed(
  () =>
    isCoordinator.value &&
    event.value?.coordinator_id !== null &&
    event.value?.coordinator_id !== currentUser.value.id,
);

/** Any coordinator may act while unassigned; once assigned, only that
 * coordinator may act again — mirrors the backend's authorizeCoordinatorReview. */
const canReview = computed(() => isCoordinator.value && !isOtherCoordinatorEvent.value);

const canApprove = computed(() => canReview.value && event.value?.status === "Requested");
const canRequestClarification = computed(() => canReview.value && event.value?.status === "Requested");
const canReject = computed(
  () =>
    canReview.value &&
    (event.value?.status === "Requested" || event.value?.status === "Clarification Requested"),
);
const showReviewActions = computed(
  () => canReview.value && (canApprove.value || canRequestClarification.value || canReject.value),
);

const isReviewing = ref(false);
const actionError = ref<string | null>(null);
const pendingAction = ref<"reject" | "clarify" | null>(null);
const actionText = ref("");

function openReject(): void {
  pendingAction.value = "reject";
  actionText.value = "";
  actionError.value = null;
}

function openClarify(): void {
  pendingAction.value = "clarify";
  actionText.value = "";
  actionError.value = null;
}

function cancelPendingAction(): void {
  pendingAction.value = null;
  actionText.value = "";
  actionError.value = null;
}

async function handleApprove(): Promise<void> {
  if (!event.value) return;
  isReviewing.value = true;
  actionError.value = null;
  try {
    event.value = await approveEvent(event.value.id);
  } catch (err) {
    actionError.value = err instanceof ReviewActionError ? err.message : "We couldn't complete that action. Please try again.";
  } finally {
    isReviewing.value = false;
  }
}

async function submitPendingAction(): Promise<void> {
  if (!event.value || !pendingAction.value) return;

  const text = actionText.value.trim();
  if (!text) {
    actionError.value =
      pendingAction.value === "reject" ? "A reason is required to reject a request." : "A message is required.";
    return;
  }

  isReviewing.value = true;
  actionError.value = null;
  try {
    event.value =
      pendingAction.value === "reject"
        ? await rejectEvent(event.value.id, text)
        : await requestClarification(event.value.id, text);
    cancelPendingAction();
  } catch (err) {
    actionError.value = err instanceof ReviewActionError ? err.message : "We couldn't complete that action. Please try again.";
  } finally {
    isReviewing.value = false;
  }
}

function asSubmittedDetails(value: EventSummary["submitted_details"]): SubmittedEventDetails {
  return value as SubmittedEventDetails;
}

onMounted(async () => {
  const id = route.params.id as string;
  try {
    const [eventData, user] = await Promise.all([fetchEventById(id), getCurrentUser()]);
    event.value = eventData;
    currentUser.value = user;
  } catch (err) {
    if (err instanceof AccessDeniedError) {
      accessDenied.value = true;
    } else if (err instanceof NotFoundError) {
      notFound.value = true;
    } else {
      errorMessage.value = "We couldn't load this event. Please try again.";
    }
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <!--
    Column mapping — Event Detail
    Desktop (12-col): outer container col 1-12 (grid-desktop-margin 80px); content col 3-10, centred.
    Tablet (6-col): content col 1-6, full width, grid-tablet-margin 32px.
    Mobile (4-col): content col 1-4, full width, grid-mobile-margin 6px.
  -->
  <div class="page">
    <div class="content">
      <RouterLink to="/" class="back-link">Back to events</RouterLink>

      <p v-if="loading" class="body-default muted">Loading…</p>

      <div v-else-if="accessDenied" class="denied-panel">
        <p class="card-title">Access denied</p>
        <p class="body-default muted">
          This event doesn't belong to you, or it doesn't exist. This attempt has been recorded.
        </p>
      </div>

      <div v-else-if="notFound" class="denied-panel">
        <p class="card-title">Event not found</p>
        <p class="body-default muted">This event does not exist.</p>
      </div>

      <p v-else-if="errorMessage" class="body-default error-text">{{ errorMessage }}</p>

      <div v-else-if="event" class="detail-panel">
        <span class="badge" :class="statusBadgeClass(event.status)">{{ event.status }}</span>
        <p class="card-title">Event #{{ event.id }}</p>

        <!-- Coordinator assignment panel — visible to coordinators only (#68) -->
        <div v-if="isCoordinator" class="coordinator-panel" :class="{
          'coordinator-panel--assigned': isAssignedCoordinator,
          'coordinator-panel--blocked': isOtherCoordinatorEvent,
          'coordinator-panel--unassigned': !isAssignedCoordinator && !isOtherCoordinatorEvent,
        }">
          <p v-if="isAssignedCoordinator" class="body-default coordinator-panel__text">
            You are the assigned coordinator for this event.
          </p>
          <p v-else-if="isOtherCoordinatorEvent" class="body-default coordinator-panel__text">
            This event is assigned to another coordinator. Coordinator actions are not available.
          </p>
          <p v-else class="body-default coordinator-panel__text">
            No coordinator has been assigned to this event yet. Acting on this request will assign it to you.
          </p>
        </div>

        <dl class="detail-list">
          <div class="detail-row">
            <dt class="body-small muted">Coordinator</dt>
            <dd class="body-default">{{ event.coordinator_id ?? "Not yet assigned" }}</dd>
          </div>
          <div class="detail-row">
            <dt class="body-small muted">Review outcome</dt>
            <dd class="body-default">{{ event.review_outcome ?? "Pending" }}</dd>
          </div>
          <div class="detail-row">
            <dt class="body-small muted">Decision date</dt>
            <dd class="body-default">
              {{ event.decided_at ? new Date(event.decided_at).toLocaleString() : "Pending" }}
            </dd>
          </div>
        </dl>

        <!-- E1-4.2: coordinator review actions -->
        <div v-if="isCoordinator" class="review-actions">
          <p v-if="event.status === 'Rejected'" class="body-small muted">
            This request has been rejected and cannot be moved forward.
          </p>
          <p v-else-if="event.status === 'Planning'" class="body-small muted">
            This request has been approved and moved to Planning.
          </p>
          <p v-else-if="isOtherCoordinatorEvent" class="body-small muted">
            Only the assigned coordinator can review this request.
          </p>
          <template v-else-if="showReviewActions">
            <p v-if="event.status === 'Clarification Requested'" class="body-small muted review-actions__note">
              Clarification has been requested from the Organiser. Approval is blocked until it's resolved.
            </p>

            <p v-if="actionError" class="body-default error-text">{{ actionError }}</p>

            <div v-if="pendingAction" class="review-actions__form">
              <label for="action-text" class="body-small muted">
                {{ pendingAction === "reject" ? "Reason for rejection" : "Clarification/amendment needed" }}
              </label>
              <textarea
                id="action-text"
                v-model="actionText"
                rows="3"
                class="review-actions__textarea"
              />
              <div class="review-actions__buttons">
                <button
                  type="button"
                  class="btn btn-primary"
                  :disabled="isReviewing"
                  @click="submitPendingAction"
                >
                  {{ isReviewing ? "Submitting…" : "Confirm" }}
                </button>
                <button type="button" class="btn btn-secondary" :disabled="isReviewing" @click="cancelPendingAction">
                  Cancel
                </button>
              </div>
            </div>

            <div v-else class="review-actions__buttons">
              <button
                type="button"
                class="btn btn-approve"
                :disabled="!canApprove || isReviewing"
                @click="handleApprove"
              >
                Approve
              </button>
              <button
                type="button"
                class="btn btn-secondary"
                :disabled="!canRequestClarification || isReviewing"
                @click="openClarify"
              >
                Request Clarification/Amendment
              </button>
              <button
                type="button"
                class="btn btn-reject"
                :disabled="!canReject || isReviewing"
                @click="openReject"
              >
                Reject
              </button>
            </div>
          </template>
          <p v-else class="body-small muted">
            No coordinator actions are available for this request's current status ({{ event.status }}).
          </p>
        </div>
      </div>

      <div v-if="event" class="detail-panel event-details-panel">
        <p class="card-title">Event details</p>

        <dl class="detail-list">
          <div class="detail-row">
            <dt class="body-small muted">Event name</dt>
            <dd class="body-default">{{ asSubmittedDetails(event.submitted_details).name || "—" }}</dd>
          </div>
          <div class="detail-row">
            <dt class="body-small muted">Purpose</dt>
            <dd class="body-default">{{ asSubmittedDetails(event.submitted_details).purpose || "—" }}</dd>
          </div>
          <div class="detail-row">
            <dt class="body-small muted">Description</dt>
            <dd class="body-default">{{ asSubmittedDetails(event.submitted_details).description || "—" }}</dd>
          </div>
          <div class="detail-row">
            <dt class="body-small muted">Proposed date</dt>
            <dd class="body-default">{{ asSubmittedDetails(event.submitted_details).proposedDate || "—" }}</dd>
          </div>
          <div class="detail-row">
            <dt class="body-small muted">Time</dt>
            <dd class="body-default">
              {{ asSubmittedDetails(event.submitted_details).startTime || "—" }}
              –
              {{ asSubmittedDetails(event.submitted_details).endTime || "—" }}
            </dd>
          </div>
          <div class="detail-row">
            <dt class="body-small muted">Expected attendance</dt>
            <dd class="body-default">{{ asSubmittedDetails(event.submitted_details).expectedAttendance ?? "—" }}</dd>
          </div>
          <div class="detail-row">
            <dt class="body-small muted">Venue Requirements</dt>
            <dd class="body-default">{{ asSubmittedDetails(event.submitted_details).venue || "—" }}</dd>
          </div>
          <div class="detail-row">
            <dt class="body-small muted">Accessibility</dt>
            <dd class="body-default">{{ asSubmittedDetails(event.submitted_details).accessibility || "—" }}</dd>
          </div>
          <div class="detail-row">
            <dt class="body-small muted">Equipment</dt>
            <dd class="body-default">{{ asSubmittedDetails(event.submitted_details).equipment || "—" }}</dd>
          </div>
          <div class="detail-row">
            <dt class="body-small muted">Technical support</dt>
            <dd class="body-default">{{ asSubmittedDetails(event.submitted_details).technicalSupport || "—" }}</dd>
          </div>
          <div class="detail-row">
            <dt class="body-small muted">Registration needed</dt>
            <dd class="body-default">
              {{ asSubmittedDetails(event.submitted_details).registrationNeeded ? "Yes" : "No" }}
            </dd>
          </div>
        </dl>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: var(--grid-desktop-gutter);
  padding: var(--spacing-40) var(--grid-desktop-margin);
  align-content: start;
}

.content {
  grid-column: 3 / 11;
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

.back-link {
  display: inline-block;
  font-size: 0.875rem;
  font-weight: 700;
  margin-bottom: var(--spacing-24);
}

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

.card-title {
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
  margin: var(--spacing-12) 0 var(--spacing-4);
}

.badge {
  display: inline-block;
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  padding: var(--spacing-4) var(--spacing-8);
  border-radius: var(--radius-xs);
}

.status-success {
  background: #F3F9F3;
  color: var(--color-success-600);
}

.status-warning {
  background: #FEF5E7;
  color: var(--color-warning-600);
}

.status-error {
  background: var(--color-error-200);
  color: var(--color-error-600);
}

.status-info {
  background: var(--color-blue-100);
  color: var(--color-blue-600);
}

.denied-panel,
.detail-panel {
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
  padding: var(--spacing-32);
}

.denied-panel .card-title {
  color: var(--color-error-600);
}

.event-details-panel {
  margin-top: var(--spacing-24);
}

/* Coordinator assignment panel */
.coordinator-panel {
  border-radius: var(--radius-xs);
  padding: var(--spacing-12) var(--spacing-16);
  margin: var(--spacing-16) 0;
  border: 1px solid;
}

.coordinator-panel--assigned {
  background: var(--color-purple-100);
  border-color: var(--color-purple-300);
}

.coordinator-panel--assigned .coordinator-panel__text {
  color: var(--color-purple-800);
}

.coordinator-panel--blocked {
  background: var(--color-grey-75);
  border-color: var(--color-grey-200);
}

.coordinator-panel--blocked .coordinator-panel__text {
  color: var(--color-grey-600);
}

.coordinator-panel--unassigned {
  background: var(--color-grey-50);
  border-color: var(--color-grey-100);
}

.coordinator-panel--unassigned .coordinator-panel__text {
  color: var(--color-grey-500);
}

.detail-list {
  margin: var(--spacing-24) 0 0;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-16);
}

.detail-row dt {
  margin-bottom: var(--spacing-4);
}

/* E1-4.2: coordinator review actions */
.review-actions {
  margin-top: var(--spacing-24);
  padding-top: var(--spacing-24);
  border-top: 1px solid var(--color-grey-100);
}

.review-actions__note {
  margin-bottom: var(--spacing-12);
}

.review-actions__buttons {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-12);
}

.review-actions__form {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
}

.review-actions__textarea {
  width: 100%;
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-xs);
  padding: var(--spacing-12);
  font-size: 1rem;
  color: var(--color-grey-900);
  background: var(--color-base-white);
  resize: vertical;
}

.btn {
  border-radius: var(--radius-xs);
  padding: var(--spacing-12) var(--spacing-16);
  font-size: 0.875rem;
  font-weight: 700;
  border: 1px solid transparent;
  cursor: pointer;
}

.btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.btn-approve {
  background: var(--color-success-600);
  color: var(--color-base-white);
}

.btn-approve:not(:disabled):hover {
  background: var(--color-success-700, var(--color-success-600));
}

.btn-reject {
  background: var(--color-error-600);
  color: var(--color-base-white);
}

.btn-reject:not(:disabled):hover {
  background: var(--color-error-700, var(--color-error-600));
}

.btn-secondary {
  background: var(--color-grey-75);
  color: var(--color-grey-900);
  border-color: var(--color-grey-200);
}

.btn-secondary:not(:disabled):hover {
  background: var(--color-grey-100);
}

.btn-primary {
  background: var(--color-purple-600);
  color: var(--color-base-white);
}

.btn-primary:not(:disabled):hover {
  background: var(--color-purple-700, var(--color-purple-600));
}
</style>
