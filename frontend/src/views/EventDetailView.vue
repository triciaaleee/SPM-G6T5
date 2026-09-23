<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useRoute } from "vue-router";
import {
  AccessDeniedError,
  NotFoundError,
  ReviewActionError,
  ValidationError,
  approveEvent,
  fetchEventById,
  getCurrentUser,
  rejectEvent,
  requestClarification,
  updateEventDetails,
  type EventRequestPayload,
  type EventSummary,
} from "../lib/eventsApi";
import { statusBadgeClass, statusLastChangedAt } from "../lib/eventStatus";
import EventStatusTracker from "../components/EventStatusTracker.vue";
import ClarificationPanel from "../components/ClarificationPanel.vue";

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

// E2-3: clarification thread — visible to both parties as soon as one
// exists, but only the reviewing coordinator can add a fresh top-level
// question or resolve one, and only while one is actually outstanding (AC2).
const clarificationPanelRef = ref<InstanceType<typeof ClarificationPanel> | null>(null);
const canManageClarifications = computed(
  () => canReview.value && event.value?.status === "Clarification Requested",
);

const canApprove = computed(
  () =>
    canReview.value &&
    (event.value?.status === "Requested" ||
      (event.value?.status === "Clarification Requested" && clarificationPanelRef.value?.allResolved === true)),
);
const canReject = computed(
  () =>
    canReview.value &&
    (event.value?.status === "Requested" || event.value?.status === "Clarification Requested"),
);
/** Ask for Clarification is for the *first* ask on a Requested event, or a
 * post-approval follow-up on a Planning event — once one is outstanding,
 * this disables alongside Approve, and the coordinator asks follow-up
 * questions from the "+" in the clarification thread instead. */
const canAskClarification = computed(
  () => canReview.value && (event.value?.status === "Requested" || event.value?.status === "Planning"),
);
/** The actions section itself stays visible (Approve/Reject/Request
 * Clarification) for any non-terminal status — Rejected has its own
 * message above this. Planning now falls through here too (rather than a
 * dedicated message) since a coordinator can still ask a follow-up
 * question after approving; the template hides Approve/Reject for
 * Planning and shows only Request Clarification. */
const showReviewActions = computed(() => canReview.value && event.value?.status !== "Rejected");

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
    await clarificationPanelRef.value?.refresh();
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
    await clarificationPanelRef.value?.refresh();
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

/**
 * E2-10: if a non-coordinator successfully loaded this event at all, the
 * backend's own access check (GET /:id) guarantees they're the owning
 * organiser — non-owners get 403 before this component ever mounts. So
 * there's no separate "is owner" id comparison to make here.
 */
const canRespondToClarification = computed(
  () => !isCoordinator.value && event.value?.status === "Clarification Requested",
);
const isEditingDetails = ref(false);
const editForm = reactive<EventRequestPayload>({
  name: "",
  purpose: "",
  description: "",
  proposedDate: "",
  startTime: "",
  endTime: "",
  expectedAttendance: "",
  venue: "",
  accessibility: "",
  equipment: "",
  technicalSupport: "",
  registrationNeeded: false,
});
const editFieldErrors = ref<Record<string, string>>({});
const editGeneralError = ref<string | null>(null);
const submittingEdit = ref(false);

function startEditingDetails(): void {
  if (!event.value) return;
  const details = asSubmittedDetails(event.value.submitted_details);
  editForm.name = details.name ?? "";
  editForm.purpose = details.purpose ?? "";
  editForm.description = details.description ?? "";
  editForm.proposedDate = details.proposedDate ?? "";
  editForm.startTime = details.startTime ?? "";
  editForm.endTime = details.endTime ?? "";
  editForm.expectedAttendance = details.expectedAttendance ?? "";
  editForm.venue = details.venue ?? "";
  editForm.accessibility = details.accessibility ?? "";
  editForm.equipment = details.equipment ?? "";
  editForm.technicalSupport = details.technicalSupport ?? "";
  editForm.registrationNeeded = details.registrationNeeded ?? false;
  editFieldErrors.value = {};
  editGeneralError.value = null;
  isEditingDetails.value = true;
}

function cancelEditingDetails(): void {
  isEditingDetails.value = false;
}

/** E2-10 AC1/AC2: saving posts the edit as a reply in the clarification
 * thread server-side and clears the flag back to "Requested" — refresh
 * both the event and the thread so the change is visible immediately. */
async function submitEditedDetails(): Promise<void> {
  if (!event.value) return;
  submittingEdit.value = true;
  editGeneralError.value = null;
  editFieldErrors.value = {};
  try {
    event.value = await updateEventDetails(event.value.id, editForm);
    isEditingDetails.value = false;
    await clarificationPanelRef.value?.refresh();
  } catch (err) {
    if (err instanceof ValidationError) {
      editFieldErrors.value = err.fields;
    } else {
      editGeneralError.value = "We couldn't save your response. Please try again.";
    }
  } finally {
    submittingEdit.value = false;
  }
}

const NOT_PROVIDED = "Not provided";

function formatDate(value: string | undefined | null): string {
  if (!value) return NOT_PROVIDED;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" });
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
    Desktop (12-col): outer container col 1-12 (grid-desktop-margin 80px); content col 1-12, full width.
    Tablet (6-col): content col 1-6, full width, grid-tablet-margin 32px.
    Mobile (4-col): content col 1-4, full width, grid-mobile-margin 6px.
  -->
  <div class="page">
    <div class="content">
      <RouterLink to="/" class="back-link">&larr; Back</RouterLink>

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

      <div v-else-if="event">
        <h1 class="h2">{{ asSubmittedDetails(event.submitted_details).name || `Event #${event.id}` }}</h1>
        <p class="body-default muted event-id">Event #{{ event.id }}</p>

        <div class="detail-grid">
          <div class="detail-grid-col">
            <div class="details-card">
              <div class="section-header">
                <h2 class="section-title">Event Request Details</h2>
                <button
                  v-if="canRespondToClarification && !isEditingDetails"
                  type="button"
                  class="btn btn-primary"
                  @click="startEditingDetails"
                >
                  Edit &amp; respond
                </button>
              </div>

              <div class="field-row field-row-3">
                <div class="field">
                  <p class="body-small muted mb-1">Event Requestor</p>
                  <p class="body-default field-value">{{ event.organiser?.name ?? NOT_PROVIDED }}</p>
                </div>
                <div class="field">
                  <p class="body-small muted mb-1">Submitted date</p>
                  <p class="body-default field-value">{{ formatDate(event.created_at) }}</p>
                </div>
                <div class="field">
                  <p class="body-small muted mb-1">Status</p>
                  <span class="badge" :class="statusBadgeClass(event.status)">{{ event.status }}</span>
                </div>
              </div>

              <hr class="divider" />

              <p v-if="isEditingDetails && editGeneralError" class="body-default error-text">{{ editGeneralError }}</p>

              <template v-if="isEditingDetails">
                <div class="field-row field-row-3">
                  <div class="field">
                    <label for="edit-name" class="body-small muted mb-1">Title</label>
                    <input id="edit-name" v-model="editForm.name" type="text" class="edit-input" />
                    <p v-if="editFieldErrors.name" class="body-small error-text">{{ editFieldErrors.name }}</p>
                  </div>
                  <div class="field">
                    <label for="edit-purpose" class="body-small muted mb-1">Purpose</label>
                    <input id="edit-purpose" v-model="editForm.purpose" type="text" class="edit-input" />
                    <p v-if="editFieldErrors.purpose" class="body-small error-text">{{ editFieldErrors.purpose }}</p>
                  </div>
                  <div class="field">
                    <label for="edit-expectedAttendance" class="body-small muted mb-1">Expected attendance</label>
                    <input
                      id="edit-expectedAttendance"
                      v-model="editForm.expectedAttendance"
                      type="number"
                      min="1"
                      class="edit-input"
                    />
                    <p v-if="editFieldErrors.expectedAttendance" class="body-small error-text">
                      {{ editFieldErrors.expectedAttendance }}
                    </p>
                  </div>
                </div>

                <div class="field-row field-row-3">
                  <div class="field">
                    <label for="edit-proposedDate" class="body-small muted mb-1">Proposed date</label>
                    <input id="edit-proposedDate" v-model="editForm.proposedDate" type="date" class="edit-input" />
                    <p v-if="editFieldErrors.proposedDate" class="body-small error-text">{{ editFieldErrors.proposedDate }}</p>
                  </div>
                  <div class="field">
                    <label for="edit-startTime" class="body-small muted mb-1">Start time</label>
                    <input id="edit-startTime" v-model="editForm.startTime" type="time" class="edit-input" />
                    <p v-if="editFieldErrors.startTime" class="body-small error-text">{{ editFieldErrors.startTime }}</p>
                  </div>
                  <div class="field">
                    <label for="edit-endTime" class="body-small muted mb-1">End time</label>
                    <input id="edit-endTime" v-model="editForm.endTime" type="time" class="edit-input" />
                    <p v-if="editFieldErrors.endTime" class="body-small error-text">{{ editFieldErrors.endTime }}</p>
                  </div>
                </div>

                <div class="field">
                  <label for="edit-description" class="body-small muted mb-1">Description</label>
                  <textarea id="edit-description" v-model="editForm.description" rows="3" class="edit-input" />
                  <p v-if="editFieldErrors.description" class="body-small error-text">{{ editFieldErrors.description }}</p>
                </div>
              </template>

              <template v-else>
                <div class="field-row field-row-3">
                  <div class="field">
                    <p class="body-small muted mb-1">Title</p>
                    <p class="body-default field-value">{{ asSubmittedDetails(event.submitted_details).name || "—" }}</p>
                  </div>
                  <div class="field">
                    <p class="body-small muted mb-1">Purpose</p>
                    <span class="badge badge-neutral">{{ asSubmittedDetails(event.submitted_details).purpose || "—"
                    }}</span>
                  </div>
                  <div class="field">
                    <p class="body-small muted mb-1">Expected attendance</p>
                    <p class="body-default field-value">{{ asSubmittedDetails(event.submitted_details).expectedAttendance
                      ?? "—" }}</p>
                  </div>
                </div>

                <div class="field-row field-row-3">
                  <div class="field">
                    <p class="body-small muted mb-1">Proposed date</p>
                    <p class="body-default field-value">{{ asSubmittedDetails(event.submitted_details).proposedDate || "—"
                    }}</p>
                  </div>
                  <div class="field">
                    <p class="body-small muted mb-1">Time</p>
                    <p class="body-default field-value">
                      {{ asSubmittedDetails(event.submitted_details).startTime || "—" }}
                      –
                      {{ asSubmittedDetails(event.submitted_details).endTime || "—" }}
                    </p>
                  </div>
                </div>

                <div class="field">
                  <p class="body-small muted mb-1">Description</p>
                  <p class="body-default field-value">{{ asSubmittedDetails(event.submitted_details).description || "—" }}
                  </p>
                </div>
              </template>
            </div>



            <div class="details-card requirements-card">
              <h2 class="section-title">Event Requirements</h2>

              <template v-if="isEditingDetails">
                <div class="field-row">
                  <div class="field">
                    <label for="edit-venue" class="body-small muted mb-1">Venue Requirements</label>
                    <textarea id="edit-venue" v-model="editForm.venue" rows="2" class="edit-input" />
                    <p v-if="editFieldErrors.venue" class="body-small error-text">{{ editFieldErrors.venue }}</p>
                  </div>
                  <div class="field">
                    <label for="edit-equipment" class="body-small muted mb-1">Equipment Requirements</label>
                    <textarea id="edit-equipment" v-model="editForm.equipment" rows="2" class="edit-input" />
                    <p v-if="editFieldErrors.equipment" class="body-small error-text">{{ editFieldErrors.equipment }}</p>
                  </div>
                </div>

                <div class="field-row">
                  <div class="field">
                    <label for="edit-accessibility" class="body-small muted mb-1">Accessibility Needs</label>
                    <textarea id="edit-accessibility" v-model="editForm.accessibility" rows="2" class="edit-input" />
                    <p v-if="editFieldErrors.accessibility" class="body-small error-text">{{ editFieldErrors.accessibility }}</p>
                  </div>
                  <div class="field">
                    <label for="edit-technicalSupport" class="body-small muted mb-1">Technical Support</label>
                    <textarea id="edit-technicalSupport" v-model="editForm.technicalSupport" rows="2" class="edit-input" />
                    <p v-if="editFieldErrors.technicalSupport" class="body-small error-text">{{ editFieldErrors.technicalSupport }}</p>
                  </div>
                </div>

                <div class="field">
                  <label class="body-small muted mb-1">Registration Needs (Where relevant)</label>
                  <div class="flex gap-2" role="group" aria-label="Registration needed">
                    <button
                      type="button"
                      class="btn"
                      :class="editForm.registrationNeeded ? 'btn-primary' : 'btn-secondary'"
                      :aria-pressed="editForm.registrationNeeded"
                      @click="editForm.registrationNeeded = true"
                    >
                      Yes
                    </button>
                    <button
                      type="button"
                      class="btn"
                      :class="!editForm.registrationNeeded ? 'btn-primary' : 'btn-secondary'"
                      :aria-pressed="!editForm.registrationNeeded"
                      @click="editForm.registrationNeeded = false"
                    >
                      No
                    </button>
                  </div>
                </div>

                <div class="edit-actions">
                  <button type="button" class="btn btn-primary" :disabled="submittingEdit" @click="submitEditedDetails">
                    {{ submittingEdit ? "Submitting…" : "Submit response" }}
                  </button>
                  <button type="button" class="btn btn-secondary" :disabled="submittingEdit" @click="cancelEditingDetails">
                    Cancel
                  </button>
                </div>
              </template>

              <template v-else>
                <div class="field-row">
                  <div class="field">
                    <p class="body-small muted mb-1">Venue Requirements</p>
                    <p class="body-default field-value">{{ asSubmittedDetails(event.submitted_details).venue ||
                      NOT_PROVIDED }}</p>
                  </div>
                  <div class="field">
                    <p class="body-small muted mb-1">Equipment Requirements</p>
                    <p class="body-default field-value">{{ asSubmittedDetails(event.submitted_details).equipment ||
                      NOT_PROVIDED }}</p>
                  </div>
                </div>

                <div class="field-row">
                  <div class="field">
                    <p class="body-small muted mb-1">Accessibility Needs</p>
                    <p class="body-default field-value">{{ asSubmittedDetails(event.submitted_details).accessibility ||
                      NOT_PROVIDED }}</p>
                  </div>
                  <div class="field">
                    <p class="body-small muted mb-1">Registration Needs (Where relevant)</p>
                    <p class="body-default field-value">
                      {{ asSubmittedDetails(event.submitted_details).registrationNeeded ? "Yes" : "No" }}
                    </p>
                  </div>
                </div>
              </template>
            </div>
            <EventStatusTracker :status="event.status" :last-changed-at="statusLastChangedAt(event)"
              :review-outcome="event.review_outcome" />
          </div>

          <div class="detail-grid-col">
            <div class="coordinator-card">
              <h2 class="section-title">Coordinator Details</h2>
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
                  No coordinator has been assigned to this event yet.
                </p>
              </div>
              <div class="field mb-field">
                <p class="body-small muted mb-1">Coordinator</p>
                <p class="font-semibold !text-lg field-value">{{ event.coordinator?.name ?? "Not yet assigned" }}</p>
              </div>
              <!-- E1-4.2: coordinator review actions -->
              <div v-if="isCoordinator">
                <h3 class="text-lg font-semibold text-[--color-grey-900]">Coordinator actions</h3>
                <div class="review-actions ">
                  <p v-if="event.status === 'Rejected'" class="body-small muted">
                    This request has been rejected and cannot be moved forward.
                  </p>
                  <p v-else-if="isOtherCoordinatorEvent" class="body-small muted">
                    Only the assigned coordinator can review this request.
                  </p>
                  <template v-else-if="showReviewActions">
                    <p v-if="event.status === 'Planning'" class="body-small muted review-actions__note ">
                      This request has been approved and moved to Planning. You can still ask the organiser a
                      follow-up question if you need more information.
                    </p>
                    <p v-if="event.status === 'Clarification Requested'" class="body-small muted review-actions__note ">
                      Clarification has been requested from the Organiser. Approval is blocked until it's resolved.
                    </p>

                    <p v-if="actionError" class="body-default error-text">{{ actionError }}</p>

                    <div v-if="pendingAction" class="review-actions__form">
                      <label for="action-text" class="body-small muted">
                        {{ pendingAction === "reject" ? "Reason for rejection" : "Clarification/amendment needed" }}
                      </label>
                      <textarea id="action-text" v-model="actionText" rows="3" class="review-actions__textarea" />
                      <div class="review-actions__buttons">
                        <button type="button" class="btn btn-primary" :disabled="isReviewing"
                          @click="submitPendingAction">
                          {{ isReviewing ? "Submitting…" : "Confirm" }}
                        </button>
                        <button type="button" class="btn btn-secondary" :disabled="isReviewing"
                          @click="cancelPendingAction">
                          Cancel
                        </button>
                      </div>
                    </div>

                    <div v-else class="review-actions__buttons">
                      <template v-if="event.status !== 'Planning'">
                        <button type="button" class="btn btn-primary" :disabled="!canApprove || isReviewing"
                          @click="handleApprove">
                          Approve
                        </button>
                      </template>

                      <button type="button" class="btn"
                        :class="event.status === 'Clarification Requested' ? 'btn-clarify--requested' : 'btn-clarify'"
                        :disabled="!canAskClarification || isReviewing" @click="openClarify">
                        {{ event.status === "Clarification Requested" ? "Clarification Requested" : "Request Clarification" }}
                      </button>

                      <template v-if="event.status !== 'Planning'">
                        <button type="button" class="btn btn-reject-outline" :disabled="!canReject || isReviewing"
                          @click="openReject">
                          Reject
                        </button>
                      </template>
                    </div>
                  </template>
                  <p v-else class="body-small muted">
                    No coordinator actions are available for this request's current status ({{ event.status }}).
                  </p>
                </div>
              </div>

              <!-- Venue search: opens pre-filled with this event's date, time and attendance -->
              <div v-if="isCoordinator && event.status !== 'Rejected'" class="venue-search-entry">
                <h3 class="text-lg font-semibold text-[--color-grey-900]">Venue</h3>
                <p class="body-small muted">
                  Shortlist venues that are free at this event's date and time and can fit its expected attendance.
                </p>
                <RouterLink :to="{ name: 'venue-search', query: { eventId: event.id } }" class="btn btn-venue-search">
                  Find venues
                </RouterLink>
              </div>
            </div>

            <ClarificationPanel ref="clarificationPanelRef" :event-id="event.id" :can-manage="canManageClarifications"
              :current-user-id="currentUser.id" />


          </div>
        </div>
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

.mb-1 {
  margin-bottom: var(--spacing-8);
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

.h2 {
  font-size: 2.25rem;
  font-weight: 700;
  line-height: 2.625rem;
  color: var(--color-grey-900);
  margin: var(--spacing-12) 0 var(--spacing-4);
}

.event-id {
  margin-bottom: var(--spacing-24);
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
  background: #e5eee5;
  color: var(--color-success-700);
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
  background: var(--color-warning-200);
  color: var(--color-warning-700);
}

.denied-panel {
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
  padding: var(--spacing-32);
}

.denied-panel .card-title {
  color: var(--color-error-600);
}

.detail-grid {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: var(--grid-desktop-gutter);
  align-items: start;
}

@media (max-width: 1024px) {
  .detail-grid {
    grid-template-columns: 1fr;
  }
}

.detail-grid-col {
  display: flex;
  flex-direction: column;
  gap: var(--grid-desktop-gutter);
}

.details-card,
.coordinator-card {
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
  padding: var(--spacing-32);
}


.divider {
  border: none;
  border-top: 1px solid var(--color-grey-100);
  margin: 0 0 var(--spacing-24);
}

.badge-neutral {
  background: var(--color-purple-100);
  color: var(--color-purple-800);
}

.section-title {
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
  margin: 0 0 var(--spacing-12);
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-12);
}

.section-header .section-title {
  margin: 0;
}

.edit-input {
  width: 100%;
  font-family: var(--font-family-lato);
  font-size: 0.9375rem;
  color: var(--color-grey-900);
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-xs);
  padding: var(--spacing-8) var(--spacing-12);
}

.edit-actions {
  display: flex;
  gap: var(--spacing-8);
  margin-top: var(--spacing-8);
}

.field-row {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--spacing-24);
  margin-bottom: var(--spacing-24);
}

.field-row-3 {
  grid-template-columns: repeat(3, 1fr);
}

@media (max-width: 640px) {

  .field-row,
  .field-row-3 {
    grid-template-columns: 1fr;
  }
}

.field {
  min-width: 0;
}

.mb-field {
  margin-bottom: var(--spacing-24);
}

.field-value {
  color: var(--color-grey-900);
  font-weight: 400;
}

/* Coordinator assignment panel */
.coordinator-panel {
  border-radius: var(--radius-xs);
  padding: var(--spacing-12) var(--spacing-16);
  margin-bottom: var(--spacing-16);
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
  background: var(--color-base-white);
  border-color: var(--color-grey-100);
}

.coordinator-panel--unassigned .coordinator-panel__text {
  color: var(--color-grey-500);
}

/* E1-4.2: coordinator review actions */
.review-actions {
  padding-top: var(--spacing-8);
}

.review-actions__note {
  margin-bottom: var(--spacing-12);
  background: var(--color-warning-100);
  border: 1px solid var(--color-warning-400);
  padding: var(--spacing-12) var(--spacing-16);
  border-radius: var(--radius-xs);
  color: var(--color-warning-800)
}

.review-actions__buttons {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-12);
}

.review-actions__buttons .btn {
  width: 100%;
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

.btn-clarify {
  background: transparent;
  color: var(--color-warning-700);
  border-color: var(--color-warning-700);
}

.btn-clarify:not(:disabled):hover {
  background: var(--color-warning-300);
}

.btn-clarify--requested {
  background: transparent;
  color: var(--color-grey-600);
  border-color: var(--color-grey-300);
}

.btn-reject-outline {
  background: transparent;
  color: var(--color-error-600);
  border-color: var(--color-error-600);
}

.btn-reject-outline:not(:disabled):hover {
  background: var(--color-error-200);
}

.venue-search-entry {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
  margin-top: var(--spacing-24);
  padding-top: var(--spacing-24);
  border-top: 1px solid var(--color-grey-100);
}

/* Style.md 3.4 outline button — the solid slot in this card belongs to Approve. */
.btn-venue-search {
  display: block;
  text-align: center;
  background: transparent;
  color: var(--color-purple-600);
  border-color: var(--color-purple-300);
}

.btn-venue-search:hover {
  background: var(--color-purple-100);
  color: var(--color-purple-700);
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
  background: var(--color-grey-300);
  color: var(--color-grey-600);
}

.btn-primary:not(:disabled):hover {
  background: var(--color-purple-700, var(--color-purple-600));
}
</style>
