<script setup lang="ts">
import AppButton from "../components/ui/AppButton.vue";
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import {
  ArrowPathIcon,
  ArrowRightIcon,
  ArrowTopRightOnSquareIcon,
  CheckIcon,
  ExclamationTriangleIcon,
} from "@heroicons/vue/20/solid";
import { useRoute, useRouter } from "vue-router";
import { landingRouteForRole } from "../lib/auth";
import {
  AccessDeniedError,
  AssignmentError,
  NotFoundError,
  ReviewActionError,
  ValidationError,
  approveEvent,
  assignCoordinator,
  cancelEvent,
  completeEvent,
  openRegistration,
  closeRegistration,
  followRegistrationSchedule,
  setRegistrationOpenDate,
  reassignCoordinator,
  fetchEventById,
  fetchEventHistory,
  getCurrentUser,
  rejectEvent,
  requestClarification,
  updateEventDetails,
  submitChangeRequest,
  fetchChangeRequests,
  fetchSafetyChanges,
  approveChangeRequest,
  rejectChangeRequest,
  ChangeRequestDecisionError,
  type EventHistoryEntry,
  type SafetyChangeRequest,
  type EventRequestPayload,
  type EventSummary,
  type ChangeRequestResult,
  type ChangeRequestEntry,
} from "../lib/eventsApi";
import { formatEventDate, statusBadgeClass, statusLabel, statusLastChangedAt } from "../lib/eventStatus";
import { hasEventEnded } from "../lib/eventTiming";
import { REGISTRATION_STATE_LABEL, registrationState } from "../lib/registrationPeriod";
import EventStatusTracker from "../components/EventStatusTracker.vue";
import ClarificationPanel from "../components/ClarificationPanel.vue";
import VenueRecommendations from "../components/venues/VenueRecommendations.vue";
import EquipmentRequestPanel from "../components/equipment/EquipmentRequestPanel.vue";
import VenueRequestsPanel from "../components/venues/VenueRequestsPanel.vue";
import BookingPlanForm from "../components/venues/BookingPlanForm.vue";
import SafetyReviewPanel from "../components/SafetyReviewPanel.vue";
import SafetyChangesCard from "../components/SafetyChangesCard.vue";
import RegistrationsPanel from "../components/RegistrationsPanel.vue";
import {
  fetchEventSuitability,
  fetchEventVenueBookings,
  fetchVenueFilterOptions,
  planRouteQuery,
  type BookingPlan,
  type EventSuitability,
  type EventVenueBooking,
  type VenueFilterOptions,
} from "../lib/venuesApi";
import { fetchEquipmentRequestsForEvent, type EquipmentRequest } from "../lib/equipmentApi";
import { fetchCoordinators, type CoordinatorOption } from "../lib/usersApi";


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
const router = useRouter();
const activeTab = ref<"overview" | "registrations" | "history">("overview");
/** Registered attendees, reported by the Registrations tab once it has loaded (shown in the tab label). */
const registeredCount = ref(0);
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

/** E1-8: the Event Coordinator Lead sees the request read-only; their only
 * actions are assign (E2-13) and reassign (E2-12). */
const isLead = computed(() => currentUser.value.role === "coordinator_lead");

/** The owning organiser: GET /:id only answers an organiser for their own
 * event, so anyone who isn't internal staff and loaded it is the owner. */
const isOwnerView = computed(() => !isCoordinator.value && !isLead.value);

/** Only the assigned coordinator may act — mirrors the backend's
 * authorizeCoordinatorReview. An event with no coordinator is the Lead's
 * to assign (E2-13), not for any coordinator to claim by acting on it. */
const canReview = computed(() => isAssignedCoordinator.value);

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

/**
 * E3-5: the assigned coordinator marks a Confirmed event completed once it
 * has run (AC1); before its end time the action is blocked (AC2) — the
 * backend decides, this only mirrors it. `now` ticks every minute so the
 * button unlocks when the event ends, without a reload. Completed is
 * terminal, so the action asks for confirmation first.
 */
const now = ref(new Date());
let nowTimer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  nowTimer = setInterval(() => (now.value = new Date()), 60_000);
});
onUnmounted(() => clearInterval(nowTimer));

const eventHasEnded = computed(() =>
  hasEventEnded(event.value?.submitted_details as Record<string, unknown> | undefined, now.value),
);

const eventEndLabel = computed(() => {
  const details = asSubmittedDetails(event.value?.submitted_details ?? {});
  const date = formatEventDate(details.proposedDate);
  return details.endTime ? `${date} at ${details.endTime}` : date;
});

const confirmingComplete = ref(false);

async function handleComplete(): Promise<void> {
  if (!event.value) return;
  isReviewing.value = true;
  actionError.value = null;
  try {
    event.value = await completeEvent(event.value.id);
    confirmingComplete.value = false;
    await loadHistory();
  } catch (err) {
    actionError.value = err instanceof ReviewActionError ? err.message : "We couldn't complete that action. Please try again.";
  } finally {
    isReviewing.value = false;
  }
}

/**
 * Registration period (coordinator). The assigned coordinator sets the day
 * registration opens and can open/close it by hand; it otherwise closes by
 * itself 5 days before the event or when full. The backend decides — this
 * only mirrors it (lib/registrationPeriod.ts).
 */
/** Same audience as before: the owning organiser and coordinators, and only when registration is needed. */
const showRegistrationsTab = computed(
  () => (isOwnerView.value || isCoordinator.value) && registrationNeeded.value,
);

const registrationNeeded = computed(
  () => asSubmittedDetails(event.value?.submitted_details ?? {}).registrationNeeded === true,
);

const registrationStateLabel = computed(() => {
  if (!event.value) return "";
  return REGISTRATION_STATE_LABEL[
    registrationState(
      event.value.status,
      event.value.submitted_details,
      event.value.registration_open_date,
      event.value.registration_override,
      now.value,
    )
  ];
});

const showRegistrationControls = computed(
  () =>
    isAssignedCoordinator.value &&
    registrationNeeded.value &&
    ["Planning", "Safety Review", "Confirmed"].includes(event.value?.status ?? ""),
);

const registrationDateInput = ref("");
const registrationDateDirty = ref(false);
const registrationDateValue = computed({
  get: () => (registrationDateDirty.value ? registrationDateInput.value : event.value?.registration_open_date ?? ""),
  set: (value: string) => {
    registrationDateInput.value = value;
    registrationDateDirty.value = true;
  },
});

async function runRegistrationAction(action: () => Promise<EventSummary>): Promise<void> {
  isReviewing.value = true;
  actionError.value = null;
  try {
    event.value = await action();
    registrationDateDirty.value = false;
    await loadHistory();
  } catch (err) {
    actionError.value = err instanceof ReviewActionError ? err.message : "We couldn't complete that action. Please try again.";
  } finally {
    isReviewing.value = false;
  }
}

function saveRegistrationDate(): Promise<void> {
  if (!event.value || !registrationDateValue.value) return Promise.resolve();
  const id = event.value.id;
  return runRegistrationAction(() => setRegistrationOpenDate(id, registrationDateValue.value));
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
  () => isOwnerView.value && event.value?.status === "Clarification Requested",
);
/** E2-7 AC1: the owning organiser can edit directly while still pending
 * review or still in Planning — per AGENTS.md §3 the lifecycle only truly
 * locks down once Confirmed, so Planning stays editable. Same "if they can
 * see it, they're the owner" reasoning as canRespondToClarification above. */
const canEditDirectly = computed(
  () =>
    isOwnerView.value &&
    (event.value?.status === "Requested" ||
      event.value?.status === "Unassigned" ||
      event.value?.status === "Planning"),
);
/** E3-9: once Confirmed, direct edits are blocked but the organiser can
 * raise a change request instead — the only edit path left at this
 * status. */
const canRequestChange = computed(() => isOwnerView.value && event.value?.status === "Confirmed");
/** Past Confirmed (Completed/Cancelled/etc.) there's no edit path at all. */
const editBlockedMessage = computed(() => {
  if (!isOwnerView.value || !event.value) return null;
  const status = event.value.status;
  if (
    status === "Requested" ||
    status === "Unassigned" ||
    status === "Planning" ||
    status === "Clarification Requested" ||
    status === "Confirmed"
  )
    return null;
  return "This request can no longer be edited or changed at this stage.";
});
/** E3-7: the assigned coordinator can edit all fields while the event is
 * in Planning — separate from the organiser paths above. */
const canCoordinatorEdit = computed(
  () => isAssignedCoordinator.value && event.value?.status === "Planning",
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
/** The coordinator's registration open date, edited alongside the other details (YYYY-MM-DD, "" = not set). */
const editRegistrationDate = ref("");
const editFieldErrors = ref<Record<string, string>>({});
const editGeneralError = ref<string | null>(null);
const submittingEdit = ref(false);
/** E3-9: shown once a change request is submitted, summarising what applied
 * immediately versus what's now held for the coordinator's review. */
const changeRequestResult = ref<ChangeRequestResult | null>(null);

function startEditingDetails(): void {
  if (!event.value) return;
  changeRequestResult.value = null;
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
  editRegistrationDate.value = event.value.registration_open_date ?? "";

  // E3-9: a field already held in a Pending request is pre-filled with
  // its *requested* value, not the committed one — otherwise simply
  // reopening this form and resubmitting untouched fields would read as
  // reverting every held field back to its original value (the backend
  // diffs against whatever's shown here).
  if (canRequestChange.value && pendingChangeRequest.value) {
    for (const field of pendingChangeRequest.value.fields) {
      if (!field.isCritical) continue;
      (editForm as unknown as Record<string, unknown>)[field.field] =
        field.field === "expectedAttendance" ? Number(field.newValue) : field.newValue;
    }
  }

  editFieldErrors.value = {};
  editGeneralError.value = null;
  isEditingDetails.value = true;
}

function cancelEditingDetails(): void {
  isEditingDetails.value = false;
}

/** Saving either posts the edit as a clarification reply and clears the
 * flag (E2-10), or just saves directly with no status change (E2-7 AC1) —
 * the backend decides which based on the event's current status. Refresh
 * the event, the clarification thread, and the edit history so the
 * change is visible immediately regardless of which path applied. */
async function submitEditedDetails(): Promise<void> {
  if (!event.value) return;
  submittingEdit.value = true;
  editGeneralError.value = null;
  editFieldErrors.value = {};
  try {
    if (canRequestChange.value) {
      // E3-9/E3-8: the backend applies non-critical fields immediately and
      // holds critical ones for the coordinator — refetch so the organiser
      // sees exactly what actually changed, not just what they submitted.
      changeRequestResult.value = await submitChangeRequest(event.value.id, editForm);
      event.value = await fetchEventById(String(event.value.id));
      isEditingDetails.value = false;
      await Promise.all([loadHistory(), loadChangeRequests()]);
      return;
    }
    event.value = await updateEventDetails(event.value.id, editForm);
    // The coordinator's registration open date is saved by its own route, after the details.
    if (
      canCoordinatorEdit.value &&
      editForm.registrationNeeded &&
      editRegistrationDate.value &&
      editRegistrationDate.value !== (event.value.registration_open_date ?? "")
    ) {
      event.value = await setRegistrationOpenDate(event.value.id, editRegistrationDate.value);
    }
    isEditingDetails.value = false;
    await Promise.all([clarificationPanelRef.value?.refresh(), loadHistory()]);
  } catch (err) {
    if (err instanceof ValidationError) {
      editFieldErrors.value = err.fields;
    } else if (err instanceof ReviewActionError) {
      editGeneralError.value = err.message;
    } else {
      editGeneralError.value = canRequestChange.value
        ? "We couldn't submit your change request. Please try again."
        : "We couldn't save your response. Please try again.";
    }
  } finally {
    submittingEdit.value = false;
  }
}

/** E2-7 AC3: structured edit history, visible to the owning organiser and
 * any coordinator (same audience as the clarification thread). */
const historyEntries = ref<EventHistoryEntry[]>([]);
const historyLoading = ref(false);

async function loadHistory(): Promise<void> {
  if (!event.value) return;
  historyLoading.value = true;
  try {
    historyEntries.value = await fetchEventHistory(event.value.id);
  } catch {
    // Non-critical — the rest of the page still works without history.
    historyEntries.value = [];
  } finally {
    historyLoading.value = false;
  }
}

/** E3-9: every change request the organiser has raised on this event,
 * most recent first — persists across reloads, unlike changeRequestResult
 * (which only covers the submission that just happened). */
const changeRequests = ref<ChangeRequestEntry[]>([]);

async function loadChangeRequests(): Promise<void> {
  // E3-8 AC2/AC4: the assigned coordinator sees the same list, with impact
  // data attached to a Pending request (the backend scopes that itself).
  if (!event.value || !(isOwnerView.value || isAssignedCoordinator.value)) return;
  try {
    changeRequests.value = await fetchChangeRequests(event.value.id);
  } catch {
    // Non-critical — the rest of the page still works without this.
    changeRequests.value = [];
  }
}

/** Manual re-fetch for the change-request review card — its impact (conflicts, bookings) can shift from other sessions' actions without a full page reload. */
const refreshingChangeRequest = ref(false);
async function refreshChangeRequestCard(): Promise<void> {
  refreshingChangeRequest.value = true;
  try {
    await loadChangeRequests();
  } finally {
    refreshingChangeRequest.value = false;
  }
}

/** The most recent change request, if any — what the highlighted form below reflects. */
const latestChangeRequest = computed(() => changeRequests.value[0] ?? null);
/**
 * Every earlier change request on this event — once a new one is raised,
 * the previous one (decided or not) drops out of the live card above and
 * surfaces here instead, in the History tab, so it's never just gone.
 */
const pastChangeRequests = computed(() => changeRequests.value.slice(1));
/** E3-8 AC2/AC4: the open request the assigned coordinator reviews. */
const pendingChangeRequest = computed(() => changeRequests.value.find((r) => r.status === "Pending") ?? null);
/**
 * E3-9: an Approved request with decided_by null was resolved by the
 * system, not a coordinator (E3-11 isn't built, so there's no other way
 * to become Approved yet) — but "withdrawn" (every held field reverted)
 * and "auto-applied" (nothing critical was ever touched) read very
 * differently, and both would otherwise show as a bare, ambiguous
 * "Approved". The backend stamps decisionReason with one of two fixed
 * prefixes so both sides can tell which happened.
 */
function isWithdrawn(request: ChangeRequestEntry | null): boolean {
  return !!request && request.status === "Auto-Withdrawn";
}
/**
 * Unlike withdrawal, "Approved" is accurate here regardless of who/what
 * approved it — decided_by (null vs set) already tells system from a
 * future coordinator decision (E3-11), so this stays a reason-text check
 * rather than its own status.
 */
function isAutoApplied(request: ChangeRequestEntry | null): boolean {
  return !!request && request.status === "Approved" && !!request.decisionReason?.startsWith("Applied automatically");
}
/** E3-11: a real coordinator decision (not the system auto-applying a purely non-critical submission). */
function isGenuineApproval(request: ChangeRequestEntry | null): boolean {
  return !!request && request.status === "Approved" && !isAutoApplied(request);
}
/**
 * The coordinator's card shows the open request if there is one, or
 * otherwise whatever the most recent request's outcome was — approved,
 * rejected, withdrawn, auto-applied — so a decision (including the
 * coordinator's own, E3-11) never just vanishes from the page once the
 * event moves on to Planning.
 */
const coordinatorChangeRequest = computed(() => pendingChangeRequest.value ?? latestChangeRequest.value);
/**
 * Which held critical field a schedule-related availability conflict is
 * pinned to, for the per-row status column — the impact check itself
 * (loadChangeRequestImpact) only reports the conflict against the
 * booking, not a specific requested field, so this picks the most
 * specific held schedule field as a stand-in (end time over start time
 * over the date itself).
 */
const SCHEDULE_FIELD_PRIORITY = ["endTime", "startTime", "proposedDate"] as const;
const availabilityConflictFieldName = computed(() => {
  const held = new Set((coordinatorChangeRequest.value?.fields ?? []).filter((f) => f.isCritical).map((f) => f.field));
  return SCHEDULE_FIELD_PRIORITY.find((f) => held.has(f)) ?? null;
});

/** E3-8 AC4 / E3-10 AC2: each conflict as one title + description + the field it's pinned to, for the review-blocking list. */
const conflictItems = computed(() => {
  const impact = coordinatorChangeRequest.value?.impact;
  if (!impact) return [];
  const items: { title: string; description: string; fieldLabel: string; linkLabel: string }[] = [];
  if (impact.capacityConflict) {
    items.push({
      title: "Capacity conflict",
      description: `${impact.capacityConflict.venueName} holds ${impact.capacityConflict.capacity}, but ${impact.capacityConflict.requestedAttendance} is requested.`,
      fieldLabel: CHANGE_REQUEST_FIELD_LABELS.expectedAttendance,
      linkLabel: "Review venue capacity",
    });
  }
  const scheduleFieldLabel = availabilityConflictFieldName.value
    ? `${CHANGE_REQUEST_FIELD_LABELS[availabilityConflictFieldName.value as keyof EventRequestPayload]} · requested interval`
    : "Requested interval";
  if (impact.availabilityConflict?.unavailabilityConflict) {
    items.push({
      title: "Availability conflict",
      description: `The venue is unavailable ${impact.availabilityConflict.unavailabilityConflict.description} (${impact.availabilityConflict.unavailabilityConflict.reason}).`,
      fieldLabel: scheduleFieldLabel,
      linkLabel: "Review venue availability",
    });
  }
  if (impact.availabilityConflict?.bookingConflict) {
    items.push({
      title: "Availability conflict",
      description: `Clashes with another booking (${impact.availabilityConflict.bookingConflict.status}) for ${impact.availabilityConflict.bookingConflict.window}.`,
      fieldLabel: scheduleFieldLabel,
      linkLabel: "Review booking overlap",
    });
  }
  return items;
});

/**
 * What the per-row "Review status" column shows for one held field —
 * informational only. Approving a field with a conflict is a valid
 * decision (the coordinator is saying "I'm okay with this change, find a
 * replacement"): the backend already flags the affected booking for
 * rebooking / equipment for reassessment on approval (E3-11 AC2/AC3)
 * rather than requiring the conflict resolved first.
 */
function fieldReviewStatus(fieldName: string): "capacity" | "availability" | null {
  const impact = coordinatorChangeRequest.value?.impact;
  if (!impact) return null;
  if (fieldName === "expectedAttendance" && impact.capacityConflict) return "capacity";
  if (fieldName === availabilityConflictFieldName.value && impact.availabilityConflict) return "availability";
  return null;
}
/** Approved reads as settled (green); everything else (Withdrawn, Requested, Rejected, Expired…) as neutral. */
function reservationStatusBadgeClass(status: string): string {
  return status === "Approved" || status === "Arranged" ? "status-success" : "badge-neutral";
}

/** E3-11: the assigned coordinator's own approve/reject decision on a Pending held change. */
const changeDecisionSubmitting = ref(false);
const changeDecisionError = ref<string | null>(null);
const changeDecisionRejecting = ref(false);
const changeDecisionReason = ref("");

/**
 * Per-field approve/reject selection for the current Pending request —
 * a held field defaults to approved unless explicitly unchecked. Keyed by
 * field name rather than request id: cleared after every decision (see
 * refreshAfterChangeDecision), so a stale entry from a prior request never
 * carries over.
 */
const fieldApprovalSelection = ref<Record<string, boolean>>({});
function isFieldApproved(fieldName: string): boolean {
  return fieldApprovalSelection.value[fieldName] !== false;
}
function toggleFieldApproval(fieldName: string): void {
  fieldApprovalSelection.value = { ...fieldApprovalSelection.value, [fieldName]: !isFieldApproved(fieldName) };
}
/** Still-open critical fields on the Pending request — the only ones a decision can act on. */
const heldCriticalFields = computed(
  () => pendingChangeRequest.value?.fields.filter((f) => f.isCritical && f.outcome === "pending") ?? [],
);
/** Critical fields already applied in an earlier partial approval on this same still-open request. */
const appliedCriticalFields = computed(
  () => pendingChangeRequest.value?.fields.filter((f) => f.isCritical && f.outcome === "applied") ?? [],
);
const selectedFieldCount = computed(() => heldCriticalFields.value.filter((f) => isFieldApproved(f.field)).length);
const totalHeldFieldCount = computed(() => heldCriticalFields.value.length);

async function refreshAfterChangeDecision(updatedEvent: EventSummary): Promise<void> {
  event.value = updatedEvent;
  fieldApprovalSelection.value = {};
  changeDecisionReason.value = "";
  await loadChangeRequests();
}

async function handleApproveChangeRequest(): Promise<void> {
  if (!event.value || !pendingChangeRequest.value) return;
  const heldFieldNames = heldCriticalFields.value.map((f) => f.field);
  const fieldsToApprove = heldFieldNames.filter((f) => isFieldApproved(f));

  if (fieldsToApprove.length === 0) {
    changeDecisionError.value = "Approve at least one field, or use \"Reject all\" to decline the whole request.";
    return;
  }

  changeDecisionError.value = null;
  changeDecisionSubmitting.value = true;
  try {
    // Fields the coordinator just didn't select are left held, not
    // rejected — open for a later decision (AGENTS.md E3-11).
    const result = await approveChangeRequest(event.value.id, pendingChangeRequest.value.id, { fields: fieldsToApprove });
    await refreshAfterChangeDecision(result.event);
  } catch (err) {
    changeDecisionError.value =
      err instanceof ChangeRequestDecisionError ? err.message : "We couldn't approve this change. Please try again.";
  } finally {
    changeDecisionSubmitting.value = false;
  }
}

function openRejectChangeRequest(): void {
  changeDecisionRejecting.value = true;
  changeDecisionReason.value = "";
  changeDecisionError.value = null;
}

function cancelRejectChangeRequest(): void {
  changeDecisionRejecting.value = false;
  changeDecisionReason.value = "";
  changeDecisionError.value = null;
}

async function submitRejectChangeRequest(): Promise<void> {
  if (!event.value || !pendingChangeRequest.value) return;
  if (!changeDecisionReason.value.trim()) {
    changeDecisionError.value = "A reason is required.";
    return;
  }
  changeDecisionError.value = null;
  changeDecisionSubmitting.value = true;
  try {
    const updated = await rejectChangeRequest(event.value.id, pendingChangeRequest.value.id, changeDecisionReason.value.trim());
    changeDecisionRejecting.value = false;
    await refreshAfterChangeDecision(updated);
  } catch (err) {
    changeDecisionError.value =
      err instanceof ChangeRequestDecisionError ? err.message : "We couldn't reject this change. Please try again.";
  } finally {
    changeDecisionSubmitting.value = false;
  }
}

/** Same fields as the edit form, labelled for a read-only display. */
const CHANGE_REQUEST_FIELD_LABELS: Record<keyof EventRequestPayload, string> = {
  name: "Title",
  purpose: "Purpose",
  description: "Description",
  proposedDate: "Proposed date",
  startTime: "Start time",
  endTime: "End time",
  expectedAttendance: "Expected attendance",
  venue: "Venue Requirements",
  accessibility: "Accessibility Needs",
  equipment: "Equipment Requirements",
  technicalSupport: "Technical Support",
  registrationNeeded: "Registration Needs",
};

function changeRequestBadgeClass(request: ChangeRequestEntry): string {
  if (request.status === "Auto-Withdrawn") return "badge-neutral";
  if (request.status === "Approved") return "status-success";
  if (request.status === "Rejected") return "status-error";
  return "status-warning"; // Pending
}

/** "Auto-Withdrawn" reads friendlier to the user as plain "Withdrawn". */
function changeRequestBadgeLabel(request: ChangeRequestEntry): string {
  return request.status === "Auto-Withdrawn" ? "Withdrawn" : request.status;
}

/** "Pending review" reads clearer to the organiser than a bare "Pending"; a plain auto-apply reads as "Applied", not "Approved" (no one actually approved it). */
function organiserChangeRequestBadgeLabel(request: ChangeRequestEntry): string {
  if (request.status === "Auto-Withdrawn") return "Withdrawn";
  if (request.status === "Pending") return "Pending review";
  if (isAutoApplied(request)) return "Applied";
  return request.status;
}

/**
 * The fields still held — what the "Requested changes" grid shows.
 * Critical field rows survive past Pending (kept as a historical record
 * on an Approved/Rejected request, see routes/events.ts), so this is
 * explicitly scoped to Pending — otherwise an already-decided request
 * would still read as "awaiting review".
 */
const heldFields = computed(() =>
  latestChangeRequest.value?.status === "Pending" ? latestChangeRequest.value.fields.filter((f) => f.isCritical) : [],
);
/** The same fields once a genuine approval applied them — for the "what changed" summary. */
const approvedFields = computed(() =>
  isGenuineApproval(latestChangeRequest.value) ? latestChangeRequest.value!.fields.filter((f) => f.isCritical) : [],
);

/** Short, human word for one held field, for the summary sentence — startTime/endTime fold into one "times". */
const PENDING_SUMMARY_WORD: Partial<Record<keyof EventRequestPayload, string>> = {
  expectedAttendance: "attendance",
  proposedDate: "date",
  venue: "venue",
  equipment: "equipment",
  accessibility: "accessibility needs",
};

/** "attendance and times" / "venue, attendance and times" — the fields awaiting review, read as prose. */
const pendingSummary = computed(() => {
  const fields = heldFields.value.map((f) => f.field);
  const words = fields
    .filter((f) => f !== "startTime" && f !== "endTime")
    .map((f) => PENDING_SUMMARY_WORD[f as keyof EventRequestPayload] ?? f);
  if (fields.includes("startTime") || fields.includes("endTime")) words.push("times");
  if (words.length === 0) return { text: "", plural: false };
  if (words.length === 1) return { text: words[0], plural: words[0] === "times" };
  return { text: `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`, plural: true };
});

/**
 * Everything not currently held — already live in submitted_details, so
 * shown as settled fact, not "pending". Grouped the same way the held
 * grid reads: schedule / venue / logistics. Title is skipped: it's
 * already the page heading above. Purpose/description/proposedDate get
 * their own row regardless (see template) since they're never grouped.
 */
const heldFieldSet = computed(() => new Set(heldFields.value.map((f) => f.field)));
const appliedScheduleFields = computed(
  () => (["startTime", "endTime"] as const).filter((f) => !heldFieldSet.value.has(f)),
);
const appliedVenueFields = computed(
  () => (["venue", "accessibility"] as const).filter((f) => !heldFieldSet.value.has(f)),
);
const appliedLogisticsFields = computed(
  () => (["equipment", "technicalSupport", "registrationNeeded"] as const).filter((f) => !heldFieldSet.value.has(f)),
);

function changeRequestFieldDisplayValue(field: string): string {
  const details = asSubmittedDetails(event.value!.submitted_details);
  const value = (details as Record<string, unknown>)[field];
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return value === undefined || value === null || value === "" ? "—" : String(value);
}

/**
 * E3-1 AC3 / E4-8 AC5: this event's venue bookings, owned here so the
 * outstanding-arrangements line and the requests panel read the same list
 * and refresh together after a request is submitted. Undefined until the
 * first load finishes, which is how the tracker knows not to claim a venue
 * is missing before it has looked.
 */
const venueBookings = ref<EventVenueBooking[] | undefined>(undefined);
const venueBookingsError = ref<string | null>(null);
const venueBookingsLoading = ref(false);

/**
 * E3-1 AC3: this event's equipment requests, owned here (not inside
 * EquipmentRequestPanel) so the outstanding-arrangements line can read it
 * too — the organiser has no form to submit a request and never mounts
 * that panel, but still needs real arrangement status, same as they
 * already get for venueBookings above.
 */
const equipmentRequests = ref<EquipmentRequest[] | undefined>(undefined);

async function loadVenueBookings(): Promise<void> {
  if (!event.value) return;
  venueBookingsLoading.value = true;
  venueBookingsError.value = null;
  try {
    venueBookings.value = await fetchEventVenueBookings(event.value.id);
  } catch (err) {
    venueBookings.value = [];
    venueBookingsError.value =
      err instanceof Error ? err.message : "Failed to load this event's venue requests";
  } finally {
    venueBookingsLoading.value = false;
  }
  // E4-17: suitability is read from the same bookings, so it refreshes with them.
  if (isCoordinator.value) void loadSuitability();
  // E3-14: a flag clears once its booking changes, so re-check with them.
  if (isCoordinator.value) void loadSafetyChanges();
}

/*
 * E3-14 AC3: the Safety Officer's open change request, if any — re-read
 * whenever the event's venue bookings or equipment reload, since that's
 * when a flagged arrangement can have changed.
 */
const safetyChanges = ref<SafetyChangeRequest | null>(null);
let safetyChangesSeq = 0;

async function loadSafetyChanges(): Promise<void> {
  if (!event.value) return;
  const seq = ++safetyChangesSeq;
  try {
    const result = await fetchSafetyChanges(event.value.id);
    if (seq === safetyChangesSeq) safetyChanges.value = result;
  } catch {
    // Keep what's shown; the next reload tries again.
  }
}

/*
 * E4-17: each venue booking checked against its own purpose and headcount,
 * plus the plan for the next booking — which drives the recommendations,
 * the Find venues link and what a request records.
 */
const suitability = ref<EventSuitability | null>(null);
const bookingPlan = ref<BookingPlan | null>(null);
const venueOptions = ref<VenueFilterOptions | null>(null);

/** Planning the next booking is the assigned coordinator's, while venues may be requested (E4-8). */
const canPlanBooking = computed(() => isAssignedCoordinator.value && event.value?.status === "Planning");

/** The recommendations' plan: undefined keeps E4-7's whole-event view where no booking is being planned. */
const recommendationPlan = computed(() =>
  canPlanBooking.value ? (suitability.value ? bookingPlan.value : null) : undefined,
);

const findVenuesQuery = computed(() => ({
  eventId: String(event.value?.id ?? ""),
  ...(canPlanBooking.value && bookingPlan.value ? planRouteQuery(bookingPlan.value) : {}),
}));

async function loadSuitability(): Promise<void> {
  if (!event.value) return;
  try {
    suitability.value = await fetchEventSuitability(event.value.id);
  } catch {
    // Leave the last result; the requests panel simply shows no suitability line.
  }
  if (canPlanBooking.value && !venueOptions.value) {
    fetchVenueFilterOptions()
      .then((options) => (venueOptions.value = options))
      .catch(() => undefined);
  }
}

async function loadEquipmentRequests(): Promise<void> {
  if (!event.value) return;
  try {
    equipmentRequests.value = await fetchEquipmentRequestsForEvent(event.value.id);
  } catch {
    equipmentRequests.value = [];
  }
  // E3-14: a flagged equipment reservation clears once it changes.
  if (isCoordinator.value) void loadSafetyChanges();
}

function formatHistoryTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

const NOT_PROVIDED = "Not provided";

function formatDate(value: string | undefined | null): string {
  if (!value) return NOT_PROVIDED;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" });
}

/** Returns to wherever the user came from (the events list, a coordinator
 * queue, a search result, etc.) rather than always landing on the role's
 * home page. `history.state.back` is only set once there's actual in-app
 * navigation history to go back to — e.g. a bookmarked/direct link here has
 * none — so that case falls back to the role's landing route instead of
 * leaving the back button a dead end or taking the user out of the app. */
function goBack(): void {
  if (window.history.state?.back) {
    router.back();
  } else {
    router.push({ name: landingRouteForRole(currentUser.value.role) });
  }
}

/** §3: no transitions out of these, so no reassignment either (E2-12 AC3). */
const CLOSED_STATUSES = new Set(["Rejected", "Cancelled", "Completed"]);

/** E3-6 / AGENTS.md §3 transitions table: every active stage the owning
 * Organiser may cancel from — mirrors the backend's CANCELLABLE_STATUSES. */
const CANCELLABLE_STATUSES = new Set([
  "Unassigned",
  "Requested",
  "Clarification Requested",
  "Planning",
  "Safety Review",
  "Confirmed",
]);
const canCancelEvent = computed(
  () => isOwnerView.value && !!event.value && CANCELLABLE_STATUSES.has(event.value.status),
);

const confirmingCancel = ref(false);
const cancelReason = ref("");
const cancelling = ref(false);
const cancelError = ref<string | null>(null);

function openCancel(): void {
  confirmingCancel.value = true;
  cancelReason.value = "";
  cancelError.value = null;
}

function closeCancel(): void {
  confirmingCancel.value = false;
  cancelReason.value = "";
  cancelError.value = null;
}

/** E3-6 AC2: cancellation is automatic (no coordinator approval) once the
 * Organiser confirms it with a reason — the reason is required client-side
 * too, but the backend is what actually enforces it. */
async function handleCancel(): Promise<void> {
  if (!event.value) return;
  const reason = cancelReason.value.trim();
  if (!reason) {
    cancelError.value = "A reason is required to cancel this event.";
    return;
  }

  cancelling.value = true;
  cancelError.value = null;
  try {
    event.value = await cancelEvent(event.value.id, reason);
    confirmingCancel.value = false;
    cancelReason.value = "";
    await loadHistory();
  } catch (err) {
    cancelError.value = err instanceof ReviewActionError ? err.message : "We couldn't cancel this event. Please try again.";
  } finally {
    cancelling.value = false;
  }
}

const coordinators = ref<CoordinatorOption[]>([]);
const coordinatorsLoading = ref(false);
const coordinatorsError = ref<string | null>(null);
const selectedCoordinatorId = ref("");
const confirmingReassign = ref(false);
const assigning = ref(false);
const assignmentError = ref<string | null>(null);
const assignmentNotice = ref<string | null>(null);

/** E2-13: only a request still in the unassigned queue can be assigned. */
const canAssign = computed(
  () => isLead.value && event.value?.status === "Unassigned" && !event.value?.coordinator_id,
);
/** E2-12: an assigned event that isn't closed can be reassigned (AC3/AC4). */
const canReassign = computed(
  () => isLead.value && !!event.value?.coordinator_id && !CLOSED_STATUSES.has(event.value.status),
);
/** E2-12 AC1: the choice must be a *different* active coordinator. */
const coordinatorChoices = computed(() =>
  coordinators.value.filter((c) => c.id !== event.value?.coordinator_id),
);
const selectedCoordinatorName = computed(
  () => coordinators.value.find((c) => c.id === selectedCoordinatorId.value)?.name ?? "",
);

async function loadCoordinators(): Promise<void> {
  coordinatorsLoading.value = true;
  coordinatorsError.value = null;
  try {
    coordinators.value = await fetchCoordinators();
  } catch {
    coordinatorsError.value = "We couldn't load the list of coordinators. Please try again.";
  } finally {
    coordinatorsLoading.value = false;
  }
}

function startReassign(): void {
  assignmentError.value = null;
  if (!selectedCoordinatorId.value) {
    assignmentError.value = "Choose a coordinator.";
    return;
  }
  confirmingReassign.value = true;
}

async function submitAssignment(): Promise<void> {
  if (!event.value) return;
  if (!selectedCoordinatorId.value) {
    assignmentError.value = "Choose a coordinator.";
    return;
  }

  const reassigning = canReassign.value;
  const name = selectedCoordinatorName.value;
  assigning.value = true;
  assignmentError.value = null;
  assignmentNotice.value = null;
  try {
    const result = reassigning
      ? await reassignCoordinator(event.value.id, selectedCoordinatorId.value)
      : await assignCoordinator(event.value.id, selectedCoordinatorId.value);
    event.value = result.event;
    selectedCoordinatorId.value = "";
    confirmingReassign.value = false;
    assignmentNotice.value =
      `${reassigning ? "Reassigned" : "Assigned"} to ${name}.` +
      (result.notificationsFailed ? " The change is saved, but not everyone could be notified." : "");
    await loadHistory();
  } catch (err) {
    assignmentError.value =
      err instanceof AssignmentError ? err.message : "We couldn't save that change. Please try again.";
    confirmingReassign.value = false;
  } finally {
    assigning.value = false;
  }
}

onMounted(async () => {
  const id = route.params.id as string;
  try {
    const [eventData, user] = await Promise.all([fetchEventById(id), getCurrentUser()]);
    event.value = eventData;
    currentUser.value = user;
    await Promise.all([loadHistory(), loadChangeRequests()]);
    if (user.role === "coordinator_lead") await loadCoordinators();
    // Only an event in Planning shows the outstanding arrangements. A
    // coordinator also sees the venue requests panel at every later stage,
    // so its bookings load then too — a Completed event's bookings must stay
    // viewable (E3-5 AC3), not sit on "Loading…".
    const showsVenueRequests = user.role === "coordinator" && eventData.status !== "Rejected";
    await Promise.all([
      eventData.status === "Planning" || showsVenueRequests ? loadVenueBookings() : undefined,
      eventData.status === "Planning" ? loadEquipmentRequests() : undefined,
    ]);
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
      <button type="button" class="back-link" @click="goBack">&larr; Back</button>

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
        <div class="event-title-row">
          <h1 class="h2">{{ asSubmittedDetails(event.submitted_details).name || `Event #${event.id}` }}</h1>
          <span class="badge" :class="statusBadgeClass(event.status)">{{ statusLabel(event.status) }}</span>
        </div>
        <p class="body-default muted event-id">
          Event #{{ event.id }}, requested by {{ event.organiser?.name ?? "Unknown" }}, submitted {{ formatEventDate(event.created_at) }}
        </p>

        <!-- The event timeline: always visible, above the tabs -->
        <EventStatusTracker :status="event.status" :last-changed-at="statusLastChangedAt(event)"
          :submitted-at="event.created_at" :review-outcome="event.review_outcome" title="Event Timeline"
          :show-outstanding="false" />

        <div class="tab-bar">
          <button type="button" class="tab-btn" :class="{ active: activeTab === 'overview' }"
            @click="activeTab = 'overview'">
            Overview
          </button>
          <button v-if="showRegistrationsTab" type="button" class="tab-btn"
            :class="{ active: activeTab === 'registrations' }" @click="activeTab = 'registrations'">
            Registrations ({{ registeredCount }})
          </button>
          <button type="button" class="tab-btn" :class="{ active: activeTab === 'history' }"
            @click="activeTab = 'history'">
            History
          </button>
        </div>

        <!-- Registrations tab: kept mounted (hidden) so the count in the tab label is known on load -->
        <RegistrationsPanel v-if="showRegistrationsTab" v-show="activeTab === 'registrations'" :event-id="event.id"
          :capacity="Number(asSubmittedDetails(event.submitted_details).expectedAttendance) || null"
          @loaded="registeredCount = $event" />


        <div v-show="activeTab !== 'registrations'" class="detail-grid">
          <div class="detail-grid-col">
            <template v-if="activeTab === 'overview'">
                <div class="details-card">
                  <div class="section-header">
                    <h2 class="section-title">Event Details</h2>
                    <button v-if="(canRespondToClarification || canEditDirectly || canCoordinatorEdit || canRequestChange) && !isEditingDetails" type="button"
                      class="btn-icon" :title="canRespondToClarification ? 'Edit & respond' : canRequestChange ? 'Request a change' : 'Edit request'"
                      :aria-label="canRespondToClarification ? 'Edit & respond' : canRequestChange ? 'Request a change' : 'Edit request'"
                      @click="startEditingDetails">
                      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5"
                        stroke="currentColor" class="btn-icon__svg">
                        <path stroke-linecap="round" stroke-linejoin="round"
                          d="m16.862 4.487 1.687-1.688a1.875 1.875 0 1 1 2.652 2.652L10.582 16.07a4.5 4.5 0 0 1-1.897 1.13L6 18l.8-2.685a4.5 4.5 0 0 1 1.13-1.897l8.932-8.931Zm0 0L19.5 7.125M18 14v4.75A2.25 2.25 0 0 1 15.75 21H5.25A2.25 2.25 0 0 1 3 18.75V8.25A2.25 2.25 0 0 1 5.25 6H10" />
                      </svg>
                    </button>
                  </div>
                  <p v-if="editBlockedMessage && !isEditingDetails" class="body-small muted edit-blocked-note">
                    {{ editBlockedMessage }}
                  </p>
                  <p v-if="canRequestChange && !isEditingDetails && !changeRequestResult" class="body-small muted edit-blocked-note">
                    This event is Confirmed. Use the edit icon to request a change — non-critical fields apply
                    immediately, critical fields (date/time, attendance, venue, equipment, accessibility) are held for
                    your coordinator to review.
                  </p>
                  <div v-if="changeRequestResult" class="change-request-result">
                    <p v-if="changeRequestResult.applied.length > 0" class="body-small">
                      Applied immediately: <strong>{{ changeRequestResult.applied.join(", ") }}</strong>
                    </p>
                    <p v-if="changeRequestResult.held.length > 0" class="body-small">
                      Held for your coordinator's review: <strong>{{ changeRequestResult.held.join(", ") }}</strong>
                    </p>
                    <p v-if="changeRequestResult.reverted.length > 0" class="body-small">
                      No longer pending (back to how it was): <strong>{{ changeRequestResult.reverted.join(", ") }}</strong>
                    </p>
                    <p v-if="changeRequestResult.autoResolved" class="body-small muted">
                      Nothing is pending on this event anymore.
                    </p>
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
                  <p v-if="isEditingDetails && editGeneralError" class="body-default error-text">{{ editGeneralError }}
                  </p>
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
                        <input id="edit-expectedAttendance" v-model="editForm.expectedAttendance" type="number" min="1"
                          class="edit-input" />
                        <p v-if="editFieldErrors.expectedAttendance" class="body-small error-text">
                          {{ editFieldErrors.expectedAttendance }}
                        </p>
                      </div>
                    </div>
                    <div class="field-row field-row-3">
                      <div class="field">
                        <label for="edit-proposedDate" class="body-small muted mb-1">Proposed date</label>
                        <input id="edit-proposedDate" v-model="editForm.proposedDate" type="date" class="edit-input" />
                        <p v-if="editFieldErrors.proposedDate" class="body-small error-text">{{
                          editFieldErrors.proposedDate }}</p>
                      </div>
                      <div class="field">
                        <label for="edit-startTime" class="body-small muted mb-1">Start time</label>
                        <input id="edit-startTime" v-model="editForm.startTime" type="time" class="edit-input" />
                        <p v-if="editFieldErrors.startTime" class="body-small error-text">{{ editFieldErrors.startTime }}
                        </p>
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
                      <p v-if="editFieldErrors.description" class="body-small error-text">{{ editFieldErrors.description
                      }}</p>
                    </div>
                  </template>
<template v-else>
                    <div class="field-row field-row-3">
                      <div class="field">
                        <p class="body-small muted mb-1">Title</p>
                        <p class="body-default field-value">{{ asSubmittedDetails(event.submitted_details).name || "—" }}
                        </p>
                      </div>
                      <div class="field">
                        <p class="body-small muted mb-1">Purpose</p>
                        <span class="badge badge-neutral">{{ asSubmittedDetails(event.submitted_details).purpose || "—"
                        }}</span>
                      </div>
                      <div class="field">
                        <p class="body-small muted mb-1">Expected attendance</p>
                        <p class="body-default field-value">{{
                          asSubmittedDetails(event.submitted_details).expectedAttendance
                          ?? "—" }}</p>
                      </div>
                    </div>
                    <div class="field-row field-row-3">
                      <div class="field">
                        <p class="body-small muted mb-1">Proposed date</p>
                        <p class="body-default field-value">{{ asSubmittedDetails(event.submitted_details).proposedDate ||
                          "—"
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
                      <p class="body-default field-value">{{ asSubmittedDetails(event.submitted_details).description ||
                        "—" }}
                      </p>
                    </div>
                  </template>
<hr class="divider" />
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
                        <p v-if="editFieldErrors.equipment" class="body-small error-text">{{ editFieldErrors.equipment }}
                        </p>
                      </div>
                    </div>
                    <div class="field-row">
                      <div class="field">
                        <label for="edit-accessibility" class="body-small muted mb-1">Accessibility Needs</label>
                        <textarea id="edit-accessibility" v-model="editForm.accessibility" rows="2" class="edit-input" />
                        <p v-if="editFieldErrors.accessibility" class="body-small error-text">{{
                          editFieldErrors.accessibility }}</p>
                      </div>
                      <div class="field">
                        <label for="edit-technicalSupport" class="body-small muted mb-1">Technical Support</label>
                        <textarea id="edit-technicalSupport" v-model="editForm.technicalSupport" rows="2"
                          class="edit-input" />
                        <p v-if="editFieldErrors.technicalSupport" class="body-small error-text">{{
                          editFieldErrors.technicalSupport }}</p>
                      </div>
                    </div>
                    <div class="field">
                      <label class="body-small muted mb-1">Registration Needs (Where relevant)</label>
                      <div class="flex gap-2" role="group" aria-label="Registration needed">
                        <AppButton :variant="editForm.registrationNeeded ? 'primary' : 'outline'"
                          :aria-pressed="editForm.registrationNeeded" @click="editForm.registrationNeeded = true">
                          Yes
                        </AppButton>
                        <AppButton :variant="!editForm.registrationNeeded ? 'primary' : 'outline'"
                          :aria-pressed="!editForm.registrationNeeded" @click="editForm.registrationNeeded = false">
                          No
                        </AppButton>
                      </div>
                    </div>
                    <div v-if="canCoordinatorEdit && editForm.registrationNeeded" class="field">
                      <label for="edit-registration-open-date" class="body-small muted mb-1">Registration open date</label>
                      <input id="edit-registration-open-date" v-model="editRegistrationDate" type="date"
                        class="edit-input" />
                      <p class="body-small muted">Registration closes automatically 5 days before the event, or when it is full.</p>
                    </div>
                    <div class="edit-actions">
                      <AppButton variant="primary" type="button" :disabled="submittingEdit"
                        @click="submitEditedDetails">
                        {{ submittingEdit ? "Submitting…" : canRequestChange ? "Submit change request" : "Submit response" }}
                      </AppButton>
                      <AppButton variant="outline" type="button" :disabled="submittingEdit"
                        @click="cancelEditingDetails">
                        Cancel
                      </AppButton>
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
                        <p class="body-default field-value">{{ asSubmittedDetails(event.submitted_details).accessibility
                          ||
                          NOT_PROVIDED }}</p>
                      </div>
                      <div class="field">
                        <p class="body-small muted mb-1">Registration Needs (Where relevant)</p>
                        <p class="body-default field-value">
                          {{ asSubmittedDetails(event.submitted_details).registrationNeeded ? "Yes" : "No" }}
                        </p>
                      </div>
                      <div v-if="asSubmittedDetails(event.submitted_details).registrationNeeded" class="field"
                        data-testid="registration-open-date">
                        <p class="body-small muted mb-1">Registration open date</p>
                        <p class="body-default field-value">
                          {{ event.registration_open_date ? formatEventDate(event.registration_open_date) : "Not set" }}
                          <span v-if="event.registration_override && event.registration_override !== 'NONE'" class="body-small muted">
                            (manually {{ event.registration_override === "FORCE_OPEN" ? "opened" : "closed" }})
                          </span>
                        </p>
                      </div>
                    </div>
                  </template>

  <!-- E3-6: the owning Organiser cancels their own event with a required reason. -->
  <div v-if="isOwnerView && event.status !== 'Draft'" class="cancel-event-row">
    <div v-if="event.status === 'Cancelled'" class="cancel-event-row__cancelled-note">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"
        class="cancel-event-row__icon">
        <path stroke-linecap="round" stroke-linejoin="round" d="m9.75 9.75 4.5 4.5m0-4.5-4.5 4.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
      </svg>
      <p class="body-default">
        This event was cancelled{{ event.review_outcome ? `: "${event.review_outcome}"` : "." }}
      </p>
    </div>
    <AppButton variant="danger" v-else-if="canCancelEvent" type="button" class="cancel-event-row__button"
      @click="openCancel">
      <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"
        class="cancel-event-row__icon">
        <path stroke-linecap="round" stroke-linejoin="round" d="m9.75 9.75 4.5 4.5m0-4.5-4.5 4.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
      </svg>
      Cancel event
    </AppButton>
  </div>
</div>

<!-- E3-9: the organiser's own latest change request on this event — what's
     still awaiting review, and what's already live. Not the coordinator's
     decision screen (E3-11). -->
<div v-if="isOwnerView && latestChangeRequest" class="details-card change-request-card">
  <div class="section-header">
    <div>
      <h2 class="section-title">Your change request</h2>
      <p class="body-small muted mb-1">
        {{ asSubmittedDetails(event.submitted_details).name || `Event #${event.id}` }} · Submitted
        {{ formatDate(latestChangeRequest.createdAt) }}
      </p>
    </div>
    <span class="badge" :class="changeRequestBadgeClass(latestChangeRequest)">{{ organiserChangeRequestBadgeLabel(latestChangeRequest) }}</span>
  </div>

  <template v-if="heldFields.length > 0">
    <p class="body-small muted eyebrow">Requested changes</p>
    <div class="requested-changes">
      <div v-for="field in heldFields" :key="field.field">
        <p class="body-small muted mb-1">{{ CHANGE_REQUEST_FIELD_LABELS[field.field as keyof EventRequestPayload] ?? field.field }}</p>
        <p class="requested-changes__value">
          {{ field.newValue }} <span class="body-small muted">(was {{ field.oldValue ?? "—" }})</span>
        </p>
      </div>
    </div>
    <p class="body-default">
      Your requested {{ pendingSummary.text }} {{ pendingSummary.plural ? "are" : "is" }} awaiting review. Everything
      else is already applied.
    </p>
    <hr class="divider" />
  </template>
  <template v-else-if="isGenuineApproval(latestChangeRequest)">
    <p class="body-small muted eyebrow">Changes applied</p>
    <div class="requested-changes">
      <div v-for="field in approvedFields" :key="field.field">
        <p class="body-small muted mb-1">{{ CHANGE_REQUEST_FIELD_LABELS[field.field as keyof EventRequestPayload] ?? field.field }}</p>
        <p class="requested-changes__value">
          {{ field.newValue }} <span class="body-small muted">(was {{ field.oldValue ?? "—" }})</span>
        </p>
      </div>
    </div>
    <p class="body-default">Your coordinator approved this change and it's now applied.</p>
    <hr class="divider" />
  </template>
  <p v-else-if="isWithdrawn(latestChangeRequest)" class="body-default muted change-request-card__note">
    Automatically withdrawn — you took every held field back to how it was before your coordinator reviewed it, so
    there's nothing pending anymore.
  </p>
  <p v-else-if="isAutoApplied(latestChangeRequest)" class="body-default muted change-request-card__note">
    Applied automatically — none of the changed fields needed your coordinator's review.
  </p>
  <p v-else-if="latestChangeRequest.status === 'Rejected'" class="body-default error-text change-request-card__note">
    Rejected{{ latestChangeRequest.decisionReason ? `: ${latestChangeRequest.decisionReason}` : "." }}
  </p>

  <p class="body-small muted eyebrow">Event details · Already applied</p>
  <div class="applied-details">
    <p v-for="field in (['proposedDate', 'purpose', 'description'] as const)" :key="field" class="applied-details__row">
      <span class="muted">{{ CHANGE_REQUEST_FIELD_LABELS[field] }}</span> {{ changeRequestFieldDisplayValue(field) }}
    </p>
    <p v-if="appliedScheduleFields.length > 0" class="applied-details__row applied-details__row--grouped">
      <template v-for="(field, index) in appliedScheduleFields" :key="field">
        <span v-if="index > 0" class="applied-details__divider">·</span>
        <span class="muted">{{ CHANGE_REQUEST_FIELD_LABELS[field] }}</span> {{ changeRequestFieldDisplayValue(field) }}
      </template>
    </p>
    <p v-if="appliedVenueFields.length > 0" class="applied-details__row applied-details__row--grouped">
      <template v-for="(field, index) in appliedVenueFields" :key="field">
        <span v-if="index > 0" class="applied-details__divider">·</span>
        <span class="muted">{{ CHANGE_REQUEST_FIELD_LABELS[field] }}</span> {{ changeRequestFieldDisplayValue(field) }}
      </template>
    </p>
    <p class="applied-details__row applied-details__row--grouped">
      <template v-for="(field, index) in appliedLogisticsFields" :key="field">
        <span v-if="index > 0" class="applied-details__divider">·</span>
        <span class="muted">{{ CHANGE_REQUEST_FIELD_LABELS[field] }}</span> {{ changeRequestFieldDisplayValue(field) }}
      </template>
    </p>
  </div>
</div>

<!-- E3-8 AC2/AC4: the assigned coordinator's read-only review of a held
     change request — affected bookings/equipment/registrations, and a
     capacity conflict if the requested attendance exceeds a booked
     venue's capacity. No approve/reject here (E3-11, not built). -->
<section v-if="isAssignedCoordinator && coordinatorChangeRequest" aria-labelledby="change-review-title">
  <div class="details-card change-request-card">
    <div class="section-header">
      <h2 id="change-review-title" class="section-title">
        {{ pendingChangeRequest ? "Change request pending your review" : "Change request" }}
      </h2>
      <div class="change-request-card__header-actions">
        <button
          type="button"
          class="btn-icon"
          title="Refresh"
          aria-label="Refresh this change request"
          :disabled="refreshingChangeRequest"
          @click="refreshChangeRequestCard"
        >
          <ArrowPathIcon class="btn-icon__svg" :class="{ 'btn-icon__svg--spinning': refreshingChangeRequest }" aria-hidden="true" />
        </button>
        <span class="badge" :class="changeRequestBadgeClass(coordinatorChangeRequest)">{{ changeRequestBadgeLabel(coordinatorChangeRequest) }}</span>
      </div>
    </div>
    <p class="body-small muted mb-1">Submitted {{ formatDate(coordinatorChangeRequest.createdAt) }}</p>

    <template v-if="isWithdrawn(coordinatorChangeRequest)">
      <p class="body-small muted change-request-card__note">
        {{ coordinatorChangeRequest.decisionReason }} Nothing is pending on this event anymore.
      </p>
    </template>
    <template v-else-if="isAutoApplied(coordinatorChangeRequest)">
      <p class="body-small muted change-request-card__note">
        {{ coordinatorChangeRequest.decisionReason }} Nothing needed your review.
      </p>
    </template>
    <template v-else>
      <div class="proposed-changes">
        <div class="proposed-changes__head">
          <p class="body-default proposed-changes__title">
            {{
              pendingChangeRequest
                ? "Proposed changes"
                : isGenuineApproval(coordinatorChangeRequest)
                  ? "Changes you decided"
                  : "Changes you rejected"
            }}
          </p>
          <p class="body-small muted">
            {{ pendingChangeRequest ? `${selectedFieldCount} of ${totalHeldFieldCount} changes selected` : "Current → requested" }}
          </p>
        </div>

        <template v-if="pendingChangeRequest">
          <p class="body-small muted change-request-card__instructions">
            Select the fields to approve. Unselected changes will not be approved.
          </p>

          <div class="change-review-table-wrap">
            <table class="change-review-table">
              <thead>
                <tr>
                  <th class="change-review-table__field-col">Field to approve</th>
                  <th>Current</th>
                  <th>Requested</th>
                  <th>Review status</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="field in appliedCriticalFields" :key="field.field" class="change-review-table__row--applied">
                  <td>
                    <span class="change-review-table__checkbox-label">
                      <CheckIcon class="change-review-table__applied-icon" aria-hidden="true" />
                      <span>{{ CHANGE_REQUEST_FIELD_LABELS[field.field as keyof EventRequestPayload] ?? field.field }}</span>
                    </span>
                  </td>
                  <td class="change-review-table__current">{{ field.oldValue ?? "—" }}</td>
                  <td class="change-review-table__requested">
                    <ArrowRightIcon class="change-review-table__arrow" aria-hidden="true" />
                    {{ field.newValue }}
                  </td>
                  <td>
                    <span class="change-review-table__status change-review-table__status--applied">Applied</span>
                  </td>
                </tr>
                <tr v-for="field in heldCriticalFields" :key="field.field">
                  <td>
                    <label class="change-review-table__checkbox-label">
                      <input
                        type="checkbox"
                        :checked="isFieldApproved(field.field)"
                        :disabled="changeDecisionSubmitting"
                        @change="toggleFieldApproval(field.field)"
                      />
                      <span>{{ CHANGE_REQUEST_FIELD_LABELS[field.field as keyof EventRequestPayload] ?? field.field }}</span>
                    </label>
                  </td>
                  <td class="change-review-table__current">{{ field.oldValue ?? "—" }}</td>
                  <td class="change-review-table__requested">
                    <ArrowRightIcon class="change-review-table__arrow" aria-hidden="true" />
                    {{ field.newValue }}
                  </td>
                  <td>
                    <span
                      v-if="fieldReviewStatus(field.field) === 'capacity'"
                      class="change-review-table__status change-review-table__status--conflict"
                    >
                      <ExclamationTriangleIcon class="change-review-table__status-icon" aria-hidden="true" />
                      Capacity conflict
                    </span>
                    <span
                      v-else-if="fieldReviewStatus(field.field) === 'availability'"
                      class="change-review-table__status change-review-table__status--conflict"
                    >
                      <ExclamationTriangleIcon class="change-review-table__status-icon" aria-hidden="true" />
                      Availability conflict
                    </span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>

        <div v-else class="proposed-changes__grid">
          <div v-for="field in coordinatorChangeRequest.fields.filter((f) => f.isCritical)" :key="field.field">
            <div class="proposed-changes__field-head">
              <p class="body-small muted mb-1">{{ CHANGE_REQUEST_FIELD_LABELS[field.field as keyof EventRequestPayload] ?? field.field }}</p>
              <span class="badge" :class="field.outcome === 'applied' ? 'status-success' : 'status-error'">
                {{ field.outcome === "applied" ? "Applied" : "Rejected" }}
              </span>
            </div>
            <div class="proposed-field">
              <div>
                <p class="body-small muted proposed-field__tag">Current</p>
                <p class="body-default proposed-field__current">{{ field.oldValue ?? "—" }}</p>
              </div>
              <ArrowRightIcon class="proposed-field__arrow" aria-hidden="true" />
              <div>
                <p class="body-small proposed-field__tag proposed-field__tag--requested">Requested</p>
                <p class="body-default proposed-field__requested">{{ field.newValue }}</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <template v-if="pendingChangeRequest">
        <template v-if="coordinatorChangeRequest.impact">
          <div v-if="conflictItems.length > 0" class="conflicts">
            <div class="conflicts__head">
              <p class="body-default conflicts__title">Conflicts to review</p>
              <span class="conflicts__count">{{ conflictItems.length }}</span>
            </div>
            <div class="conflicts__box">
              <div v-for="(item, index) in conflictItems" :key="`${item.title}-${index}`" class="conflict-item">
                <ExclamationTriangleIcon class="conflict-item__icon" aria-hidden="true" />
                <div class="conflict-item__body">
                  <div class="conflict-item__head">
                    <p class="body-default conflict-item__title">{{ item.title }}</p>
                    <span class="body-small muted conflict-item__field">{{ item.fieldLabel }}</span>
                  </div>
                  <p class="body-small conflict-item__description">{{ item.description }}</p>
                  <a href="#change-review-reservations" class="body-small conflict-item__link">
                    {{ item.linkLabel }}
                    <ArrowTopRightOnSquareIcon class="conflict-item__link-icon" aria-hidden="true" />
                  </a>
                </div>
              </div>
            </div>
          </div>

          <div id="change-review-reservations" class="reservations">
            <p class="body-default reservations__title">Registration &amp; reservations</p>
            <div class="reservations__grid">
              <div>
                <p class="body-small muted mb-1">Registrations</p>
                <p class="body-default reservations__value">
                  {{ coordinatorChangeRequest.impact.registrations.registeredCount }} registered of
                  {{ coordinatorChangeRequest.impact.registrations.total }} total
                </p>
              </div>
              <div>
                <p class="body-small muted mb-1">Venue booking(s)</p>
                <p v-if="coordinatorChangeRequest.impact.bookings.length === 0" class="body-default muted">None</p>
                <div v-else class="reservations__list">
                  <div v-for="booking in coordinatorChangeRequest.impact.bookings" :key="booking.id" class="reservations__row">
                    <span class="body-default">{{ booking.venue?.name ?? "Unknown venue" }}</span>
                    <span class="badge" :class="reservationStatusBadgeClass(booking.status)">{{ booking.status }}</span>
                  </div>
                </div>
              </div>
              <div>
                <p class="body-small muted mb-1">Equipment reservation(s)</p>
                <p v-if="coordinatorChangeRequest.impact.equipmentReservations.length === 0" class="body-default muted">None</p>
                <div v-else class="reservations__list">
                  <div v-for="reservation in coordinatorChangeRequest.impact.equipmentReservations" :key="reservation.id" class="reservations__row">
                    <span class="body-default">Request #{{ reservation.id }}</span>
                    <span class="badge" :class="reservationStatusBadgeClass(reservation.status)">{{ reservation.status }}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </template>
        <p v-else class="body-small muted">Affected arrangements couldn't be loaded right now.</p>

        <hr class="divider change-request-card__actions-divider" />

        <p v-if="changeDecisionError" class="body-default error-text change-request-card__note">{{ changeDecisionError }}</p>

        <div v-if="changeDecisionRejecting" class="review-actions__form">
          <label for="change-decision-reason" class="body-small muted">Reason for rejection</label>
          <textarea id="change-decision-reason" v-model="changeDecisionReason" rows="3" class="review-actions__textarea" />
          <div class="change-request-card__actions">
            <AppButton variant="outline" type="button" :disabled="changeDecisionSubmitting" @click="cancelRejectChangeRequest">
              Cancel
            </AppButton>
            <AppButton variant="danger" type="button" :disabled="changeDecisionSubmitting" @click="submitRejectChangeRequest">
              {{ changeDecisionSubmitting ? "Rejecting…" : "Confirm rejection" }}
            </AppButton>
          </div>
        </div>
        <div v-else class="change-request-card__actions">
          <AppButton variant="outline" type="button" :disabled="changeDecisionSubmitting" @click="openRejectChangeRequest">
            Reject all
          </AppButton>
          <AppButton variant="primary" type="button" :disabled="changeDecisionSubmitting" @click="handleApproveChangeRequest">
            {{ changeDecisionSubmitting ? "Approving…" : `Approve selected (${selectedFieldCount})` }}
          </AppButton>
        </div>
      </template>
      <p v-else-if="isGenuineApproval(coordinatorChangeRequest)" class="body-default muted change-request-card__note">
        You approved this change. It's now applied to the event.
      </p>
      <p v-else-if="coordinatorChangeRequest.status === 'Rejected'" class="body-default error-text change-request-card__note">
        You rejected this change{{ coordinatorChangeRequest.decisionReason ? `: ${coordinatorChangeRequest.decisionReason}` : "." }}
      </p>
    </template>
  </div>
</section>

<!-- E3-14 AC3: what the Safety Officer asked to change, and which flags have cleared -->
<SafetyChangesCard v-if="isCoordinator && safetyChanges" :change-request="safetyChanges" />

<!-- Venue search: opens pre-filled with this event's date, time and attendance -->
<div v-if="isCoordinator && event.status !== 'Rejected'" class="details-card venue-search-entry">
  <h2 class="section-title">Venue Recommendations</h2>
  <!-- E4-17: what the next booking is for; recommendations and Find venues follow it. Re-keyed after
       each request so the next booking starts from the right defaults. -->
  <BookingPlanForm v-if="canPlanBooking && suitability" :key="`${suitability.defaults.hasMainProgramme}-${suitability.defaults.liveBookingCount}`"
    :defaults="suitability.defaults" :options="venueOptions" @update:plan="bookingPlan = $event" />
  <VenueRecommendations :event-id="event.id" :details="event.submitted_details"
    :can-request="isAssignedCoordinator && event.status === 'Planning'" :plan="recommendationPlan"
    @requested="loadVenueBookings()" />
  <AppButton variant="outline" block :to="{ name: 'venue-search', query: findVenuesQuery }">
    Find venues
  </AppButton>
</div>

<!-- E4-8 AC5: this event's venue requests and the state each one is in -->
<VenueRequestsPanel v-if="isCoordinator && event.status !== 'Rejected'" :bookings="venueBookings"
  :loading="venueBookingsLoading" :load-error="venueBookingsError" :can-withdraw="isAssignedCoordinator"
  :suitability="suitability?.bookings" @changed="loadVenueBookings()" />

<!-- E5-1: equipment requirements, recorded by the assigned coordinator while Planning -->
<div v-if="isCoordinator && event.status !== 'Rejected'" class="details-card">
  <EquipmentRequestPanel :event-id="event.id"
    :organiser-note="asSubmittedDetails(event.submitted_details).equipment || null" :can-submit="canCoordinatorEdit"
    @submitted="loadEquipmentRequests" @changed="loadEquipmentRequests" />
</div>

<!-- E3-4: the assigned coordinator submits a Planning event for the Safety Officer's check -->
<div v-if="isAssignedCoordinator && event.status === 'Planning'" class="details-card">
  <SafetyReviewPanel :event-id="event.id" @submitted="(updated) => (event = updated)" />
</div>

<ClarificationPanel ref="clarificationPanelRef" :event-id="event.id" :can-manage="canManageClarifications"
  :current-user-id="currentUser.id" :read-only="isLead" />
</template>

<template v-else>
  <!-- E2-7 AC3: structured edit history, same visibility as the
                   clarification thread (owning organiser or any coordinator). -->
  <div v-if="!historyLoading && historyEntries.length > 0" class="details-card history-card">
    <h2 class="section-title">Edit history</h2>
    <ul class="history-list">
      <li v-for="entry in historyEntries" :key="entry.id" class="history-list__item">
        <p class="body-default field-value">
          <strong>{{ entry.field }}</strong> changed from
          <em>'{{ entry.old_value ?? "—" }}'</em> to <em>'{{ entry.new_value }}'</em>
        </p>
        <p class="body-small muted">
          {{ formatHistoryTimestamp(entry.changed_at) }} by {{ entry.changed_by_user?.name ??
          entry.changed_by }}
        </p>
      </li>
    </ul>
  </div>

  <!-- E3-9/E3-11: every change request superseded by a later one — same
       visibility as the live card (owning organiser or assigned coordinator). -->
  <div
    v-if="(isOwnerView || isAssignedCoordinator) && pastChangeRequests.length > 0"
    class="details-card history-card"
  >
    <h2 class="section-title">Past change requests</h2>
    <div class="past-change-requests">
      <div v-for="request in pastChangeRequests" :key="request.id" class="past-change-request">
        <div class="past-change-request__head">
          <p class="body-small muted mb-1">Submitted {{ formatDate(request.createdAt) }}</p>
          <span class="badge" :class="changeRequestBadgeClass(request)">{{ changeRequestBadgeLabel(request) }}</span>
        </div>

        <p v-if="isWithdrawn(request)" class="body-small muted">
          {{ request.decisionReason }}
        </p>
        <p v-else-if="isAutoApplied(request)" class="body-small muted">
          {{ request.decisionReason }}
        </p>
        <template v-else>
          <div
            v-for="field in request.fields.filter((f) => f.isCritical)"
            :key="field.field"
            class="past-change-request__field"
          >
            <span class="body-small muted">{{ CHANGE_REQUEST_FIELD_LABELS[field.field as keyof EventRequestPayload] ?? field.field }}</span>
            <span class="body-small">
              {{ field.oldValue ?? "—" }} <ArrowRightIcon class="past-change-request__arrow" aria-hidden="true" /> {{ field.newValue }}
              <span class="badge" :class="field.outcome === 'applied' ? 'status-success' : 'status-error'">
                {{ field.outcome === "applied" ? "Applied" : "Rejected" }}
              </span>
            </span>
          </div>
          <p v-if="request.status === 'Rejected'" class="body-small error-text">
            {{ request.decisionReason }}
          </p>
        </template>
      </div>
    </div>
  </div>
</template>
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
    <!-- E2-13 / E2-12: the Event Coordinator Lead assigns or reassigns. -->
    <div v-if="isLead" class="lead-panel">
      <p v-if="assignmentNotice" class="body-small lead-panel__notice" role="status">{{ assignmentNotice }}</p>

      <template v-if="canAssign || canReassign">
        <h3 class="lead-panel__title">{{ canAssign ? "Assign a coordinator" : "Reassign coordinator" }}</h3>
        <p v-if="coordinatorsLoading" class="body-small muted">Loading coordinators…</p>
        <p v-else-if="coordinatorsError" class="body-small error-text">{{ coordinatorsError }}</p>
        <!-- E2-13 AC3: with no active coordinator there is nobody to pick. -->
        <p v-else-if="coordinatorChoices.length === 0" class="body-small muted">
          {{
            canAssign
              ? "There are no active coordinators to assign. This request stays in the unassigned queue."
              : "There is no other active coordinator to reassign this event to."
          }}
        </p>
        <template v-else>
          <label for="coordinator-select" class="body-small muted mb-1">Coordinator</label>
          <select id="coordinator-select" v-model="selectedCoordinatorId" class="lead-panel__select"
            :disabled="assigning || confirmingReassign">
            <option value="" disabled>Choose a coordinator</option>
            <option v-for="c in coordinatorChoices" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>

          <p v-if="assignmentError" class="body-small error-text" role="alert">{{ assignmentError }}</p>

          <!-- E2-12 AC1: reassignment is confirmed before it takes effect. -->
          <div v-if="confirmingReassign" class="lead-panel__confirm">
            <p class="body-small field-value">
              Reassign to {{ selectedCoordinatorName }}? {{ event.coordinator?.name ?? "The current coordinator" }}
              will keep read access but can no longer act on this event.
            </p>
            <div class="lead-panel__buttons">
              <AppButton variant="primary" block type="button" :disabled="assigning" @click="submitAssignment">
                {{ assigning ? "Reassigning…" : "Confirm reassignment" }}
              </AppButton>
              <AppButton variant="outline" block type="button" :disabled="assigning"
                @click="confirmingReassign = false">
                Cancel
              </AppButton>
            </div>
          </div>
          <AppButton variant="primary" block v-else-if="canAssign" type="button" :disabled="assigning"
            @click="submitAssignment">
            {{ assigning ? "Assigning…" : "Assign coordinator" }}
          </AppButton>
          <AppButton variant="primary" block v-else type="button" :disabled="assigning" @click="startReassign">
            Reassign
          </AppButton>
        </template>
      </template>
      <!-- E2-12 AC3 -->
      <p v-else-if="CLOSED_STATUSES.has(event.status)" class="body-small muted">
        This event is {{ event.status }}. Closed events cannot be reassigned.
      </p>
    </div>
    <!-- E1-4.2: coordinator review actions -->
    <div v-if="isCoordinator">
      <h3 class="text-lg font-semibold text-[--color-grey-900]">Coordinator actions</h3>
      <div class="review-actions ">
        <p v-if="event.status === 'Rejected'" class="body-small muted">
          This request has been rejected and cannot be moved forward.
        </p>
        <p v-else-if="!isAssignedCoordinator" class="body-small muted">
          Only the assigned coordinator can review this request.
        </p>
        <!-- E3-5: once the event has run, the assigned coordinator closes it -->
        <template v-else-if="event.status === 'Confirmed'">
          <p v-if="actionError" class="body-default error-text">{{ actionError }}</p>
          <p v-if="!eventHasEnded" class="body-small muted review-actions__note" data-testid="complete-blocked">
            This event is Confirmed. You can mark it completed after it ends ({{ eventEndLabel }}).
          </p>
          <div v-if="confirmingComplete" class="review-actions__form">
            <p class="body-small">
              Mark this event as completed? This can't be undone. Its details, history, bookings, equipment and
              registrations stay available.
            </p>
            <div class="review-actions__buttons">
              <AppButton variant="primary" type="button" :disabled="isReviewing" @click="handleComplete">
                {{ isReviewing ? "Completing…" : "Confirm" }}
              </AppButton>
              <AppButton variant="outline" type="button" :disabled="isReviewing"
                @click="confirmingComplete = false">
                Cancel
              </AppButton>
            </div>
          </div>
          <div v-else class="review-actions__buttons">
            <AppButton variant="primary" type="button" :disabled="!eventHasEnded || isReviewing"
              @click="confirmingComplete = true">
              Mark as completed
            </AppButton>
          </div>
        </template>
        <p v-else-if="event.status === 'Completed'" class="body-small muted">
          This event has been completed. Its full record stays available here.
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
                        <AppButton variant="primary" type="button" :disabled="isReviewing"
                          @click="submitPendingAction">
                          {{ isReviewing ? "Submitting…" : "Confirm" }}
                        </AppButton>
                        <AppButton variant="outline" type="button" :disabled="isReviewing"
                          @click="cancelPendingAction">
                          Cancel
                        </AppButton>
                      </div>
                    </div>

                    <div v-else class="review-actions__buttons">
                      <template v-if="event.status !== 'Planning'">
                        <AppButton variant="primary" type="button" :disabled="!canApprove || isReviewing"
                          @click="handleApprove">
                          Accept
                        </AppButton>
                      </template>

        <AppButton variant="outline" :disabled="!canAskClarification || isReviewing" @click="openClarify">
          {{ event.status === "Clarification Requested" ? "Clarification Requested" : "Request Clarification" }}
        </AppButton>

        <template v-if="event.status !== 'Planning'">
                        <AppButton variant="danger" type="button" :disabled="!canReject || isReviewing"
                          @click="openReject">
                          Reject
                        </AppButton>
                      </template>
      </div>
      </template>
      <p v-else class="body-small muted">
        No coordinator actions are available for this request's current status ({{ event.status }}).
      </p>

      <!-- Registration period: when it opens, and the manual open/close -->
      <div v-if="showRegistrationControls" class="review-actions__form" data-testid="registration-controls">
        <h4 class="text-base font-semibold text-[--color-grey-900]">Registration</h4>
        <p class="body-small muted">
          Status: <strong data-testid="registration-state">{{ registrationStateLabel }}</strong>.
          Registration closes automatically 5 days before the event, or when it is full, and always stops when the event starts.
        </p>
        <p v-if="actionError && event.status !== 'Confirmed'" class="body-default error-text">{{ actionError }}</p>
        <label for="registration-open-date" class="body-small muted">Registration opens on</label>
        <div class="review-actions__buttons">
          <input id="registration-open-date" v-model="registrationDateValue" type="date" class="review-actions__textarea" />
          <AppButton variant="outline" type="button" :disabled="isReviewing || !registrationDateValue"
            @click="saveRegistrationDate">
            Save open date
          </AppButton>
        </div>
        <div v-if="event.status === 'Confirmed'" class="review-actions__buttons">
          <AppButton variant="primary" type="button" :disabled="isReviewing || event.registration_override === 'FORCE_OPEN'"
            @click="runRegistrationAction(() => openRegistration(event!.id))">
            Open registration
          </AppButton>
          <AppButton variant="danger" type="button" :disabled="isReviewing || event.registration_override === 'FORCE_CLOSED'"
            @click="runRegistrationAction(() => closeRegistration(event!.id))">
            Close registration
          </AppButton>
          <AppButton v-if="event.registration_override && event.registration_override !== 'NONE'" variant="outline" type="button" :disabled="isReviewing"
            @click="runRegistrationAction(() => followRegistrationSchedule(event!.id))">
            Use automatic schedule
          </AppButton>
        </div>
      </div>
    </div>
  </div>

</div>

<!-- Outstanding arrangements: what is still to be arranged while the event is in Planning -->
<EventStatusTracker v-if="activeTab === 'overview' && event.status === 'Planning'" :status="event.status"
  :last-changed-at="statusLastChangedAt(event)" :review-outcome="event.review_outcome" title="Outstanding Arrangements"
  :show-timeline="false" :venue-bookings="venueBookings" :equipment-requests="equipmentRequests" />

<!-- E3-6: a popup for the mandatory cancellation reason, same pattern as
     VenueRequestsPanel's withdraw/release confirm dialog. -->
<div v-if="confirmingCancel" class="modal-overlay" @click.self="closeCancel">
  <div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="cancel-event-title">
    <p id="cancel-event-title" class="modal-title">Cancel this event?</p>
    <p class="body-default muted">
      Cancelling releases every venue booking and equipment reservation, and notifies
      {{ event.coordinator_id ? "your coordinator" : "the Event Coordinator Leads" }} and anyone registered.
      <strong class="modal-emphasis">This can't be undone.</strong>
    </p>

    <label for="cancel-reason" class="body-small muted mb-1 modal-label">
      Reason for cancellation <span class="modal-required">*</span>
    </label>
    <textarea id="cancel-reason" v-model="cancelReason" rows="3" class="review-actions__textarea"
      placeholder="Let your coordinator and attendees know why this event is being cancelled…" />
    <p v-if="cancelError" class="body-default error-text" role="alert">{{ cancelError }}</p>

    <div class="modal-actions">
      <AppButton variant="outline" type="button" :disabled="cancelling" @click="closeCancel">
        Keep event
      </AppButton>
      <AppButton variant="danger-solid" type="button" :disabled="cancelling || !cancelReason.trim()"
        @click="handleCancel">
        {{ cancelling ? "Cancelling…" : "Confirm cancellation" }}
      </AppButton>
    </div>
  </div>
</div>
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
  background: none;
  border: none;
  padding: 0;
  font-family: inherit;
  color: var(--color-purple-600);
  cursor: pointer;
}

.back-link:hover {
  color: var(--color-purple-700);
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
  margin-bottom: var(--spacing-32);
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

.event-title-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--spacing-12);
}

.tab-bar {
  display: flex;
  gap: var(--spacing-24);
  border-bottom: 1px solid var(--color-grey-100);
  margin-bottom:var(--spacing-24)
}

.tab-btn {
  background: none;
  border: none;
  padding: var(--spacing-12) 0;
  font-size: 16px;
  font-weight: 700;
  color: var(--color-grey-500);
  border-bottom: 2px solid transparent;
  cursor: pointer;
}

.tab-btn:hover {
  color: var(--color-grey-900);
}

.tab-btn.active {
  color: var(--color-purple-700);
  border-bottom-color: var(--color-purple-600);
}

.detail-grid {
  display: grid;
  /* minmax(0, …): a bare fr track won't shrink below its content's width, and the
     venue carousel's track is as wide as all its cards side by side. */
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
  gap: var(--grid-desktop-gutter);
  align-items: start;
}

@media (max-width: 1024px) {
  .detail-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

.detail-grid-col {
  min-width: 0;
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
  border-top: 1px solid var(--color-grey-200);
  margin: var(--spacing-24) 0;
  border-top: 1px solid var(--color-grey-200);
  margin: var(--spacing-24) 0;
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
  margin-bottom:12px!important;
  margin-bottom:12px!important;
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

.edit-blocked-note {
  margin: 0 0 var(--spacing-16);
}

.change-request-result {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-4);
  margin: 0 0 var(--spacing-16);
  padding: var(--spacing-12);
  border-radius: var(--radius-sm);
  background: var(--color-grey-50);
}

.change-request-card .section-header {
  margin-bottom: var(--spacing-4);
}

.change-request-card__header-actions {
  display: flex;
  align-items: center;
  gap: var(--spacing-8);
}

.change-request-card__note {
  margin: 0 0 var(--spacing-16);
}

.change-request-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--spacing-16) var(--spacing-24);
}

.field-changed {
  padding: var(--spacing-8);
  margin: calc(var(--spacing-8) * -1);
  border-radius: var(--radius-xs);
  background: var(--color-warning-100);
}

.change-request-card__requested {
  color: var(--color-warning-800);
  margin: var(--spacing-4) 0 0;
}

/* Proposed changes --------------------------------------------------- */

.proposed-changes {
  margin: 0 0 var(--spacing-24);
}

.proposed-changes__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: var(--spacing-12);
}

.proposed-changes__head .muted {
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: 0.75rem;
}

.proposed-changes__title {
  font-weight: 700;
}

.proposed-changes__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: var(--spacing-16);
  padding: var(--spacing-16);
  border-radius: var(--radius-sm);
  background: var(--color-grey-50);
}

.proposed-changes__body {
  flex: 1;
  min-width: 0;
}

.proposed-changes__field-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-8);
}

.proposed-field {
  display: flex;
  align-items: center;
  gap: var(--spacing-8);
}

.proposed-field__arrow {
  flex-shrink: 0;
  width: var(--spacing-16);
  height: var(--spacing-16);
  color: var(--color-grey-500);
}

.proposed-field__tag {
  margin: 0;
}

.proposed-field__tag--requested {
  color: var(--color-purple-600);
}

.proposed-field__current {
  color: var(--color-grey-600);
  font-weight: 700;
}

.proposed-field__requested {
  color: var(--color-purple-600);
  font-weight: 700;
}

.change-request-card__instructions {
  margin-bottom: var(--spacing-12);
}

.change-request-card__actions-divider {
  margin: var(--spacing-24) 0 var(--spacing-16);
}

.change-request-card__actions {
  display: flex;
  justify-content: space-between;
  gap: var(--spacing-12);
}

.change-request-card__actions .btn {
  flex: 0 0 auto;
}

/* Per-field review table (E3-11) --------------------------------------- */

.change-review-table-wrap {
  overflow-x: auto;
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-md);
  margin-bottom: var(--spacing-24);
}

.change-review-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
}

.change-review-table th {
  padding: var(--spacing-16) var(--spacing-24);
  background: var(--color-grey-50);
  color: var(--color-grey-500);
  text-align: left;
  font-size: 0.75rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  white-space: nowrap;
}

.change-review-table__field-col {
  min-width: 11rem;
}

.change-review-table td {
  padding: var(--spacing-16) var(--spacing-24);
  border-top: 1px solid var(--color-grey-100);
  vertical-align: middle;
}

.change-review-table__checkbox-label {
  display: flex;
  align-items: center;
  gap: var(--spacing-8);
  font-weight: 700;
  color: var(--color-grey-900);
}

.change-review-table__current {
  color: var(--color-grey-600);
}

.change-review-table__requested {
  display: flex;
  align-items: center;
  gap: var(--spacing-8);
  color: var(--color-purple-600);
  font-weight: 700;
  white-space: nowrap;
}

.change-review-table__arrow {
  flex-shrink: 0;
  width: var(--spacing-16);
  height: var(--spacing-16);
  color: var(--color-grey-400);
}

.change-review-table__status {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-4);
  white-space: nowrap;
}

.change-review-table__status-icon {
  flex-shrink: 0;
  width: var(--spacing-16);
  height: var(--spacing-16);
}

.change-review-table__status--conflict {
  color: var(--color-error-600);
  font-weight: 700;
}

.change-review-table__status--applied {
  color: var(--color-success-600);
  font-weight: 700;
}

.change-review-table__row--applied {
  background: var(--color-success-100);
}

.change-review-table__applied-icon {
  flex-shrink: 0;
  width: var(--spacing-16);
  height: var(--spacing-16);
  color: var(--color-success-600);
}

/* Review-blocking conflicts ------------------------------------------ */

.conflicts {
  margin: 0 0 var(--spacing-24);
}

.conflicts__head {
  display: flex;
  align-items: center;
  gap: var(--spacing-8);
  margin-bottom: var(--spacing-12);
}

.conflicts__title {
  color: var(--color-error-600);
  font-weight: 700;
}

.conflicts__count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: var(--spacing-20);
  height: var(--spacing-20);
  padding: 0 var(--spacing-6);
  border: 1px solid var(--color-error-300);
  border-radius: var(--radius-xs);
  background: var(--color-base-white);
  color: var(--color-error-600);
  font-size: 0.75rem;
  font-weight: 700;
}

.conflicts__box {
  border-radius: var(--radius-md);
  background: var(--color-error-200);
}

.conflict-item {
  display: flex;
  gap: var(--spacing-12);
  padding: var(--spacing-16) var(--spacing-24);
  border-bottom: 1px solid rgba(0, 0, 0, 0.06);
}

.conflict-item:last-child {
  border-bottom: none;
}

.conflict-item__icon {
  flex-shrink: 0;
  width: var(--spacing-20);
  height: var(--spacing-20);
  color: var(--color-error-600);
}

.conflict-item__title {
  color: var(--color-error-600);
  font-weight: 700;
}

.conflict-item__description {
  color: var(--color-grey-700);
  margin-top: var(--spacing-4);
}

.conflict-item__body {
  flex: 1;
  min-width: 0;
}

.conflict-item__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--spacing-8);
}

.conflict-item__field {
  flex-shrink: 0;
}

.conflict-item__link {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-4);
  margin-top: var(--spacing-8);
  color: var(--color-purple-600);
  font-weight: 700;
  text-decoration: none;
}

.conflict-item__link:hover {
  text-decoration: underline;
}

.conflict-item__link-icon {
  width: var(--spacing-16);
  height: var(--spacing-16);
}

/* Registration & reservations ----------------------------------------- */

.reservations__title {
  font-weight: 700;
  margin-bottom: var(--spacing-12);
}

.reservations__grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: var(--spacing-16) var(--spacing-24);
}

.reservations__value {
  font-weight: 700;
}

.reservations__list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
}

.reservations__row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-8);
}

/* Organiser's "Your change request" card ------------------------------ */

.eyebrow {
  margin: var(--spacing-16) 0 var(--spacing-8);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: 0.75rem;
}

.requested-changes {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: var(--spacing-16);
  padding: var(--spacing-16);
  margin-bottom: var(--spacing-12);
  border-radius: var(--radius-sm);
  background: var(--color-grey-50);
}

.requested-changes__value {
  margin: 0;
  color: var(--color-purple-600);
  font-size: 1.5rem;
  font-weight: 700;
}

.applied-details {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
}

.applied-details__row {
  margin: 0;
  color: var(--color-grey-900);
}

.applied-details__row .muted {
  margin-right: var(--spacing-4);
}

.applied-details__row--grouped {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-4) var(--spacing-16);
}

.applied-details__divider {
  color: var(--color-grey-300);
}

.history-card {
  display: flex;
  flex-direction: column;
}

.history-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-12);
}

.history-list__item {
  border-top: 1px solid var(--color-grey-100);
  padding-top: var(--spacing-12);
}

.history-list__item:first-child {
  border-top: none;
  padding-top: 0;
}

.past-change-requests {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-16);
}

.past-change-request {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
  border-top: 1px solid var(--color-grey-100);
  padding-top: var(--spacing-16);
}

.past-change-request:first-child {
  border-top: none;
  padding-top: 0;
}

.past-change-request__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-8);
}

.past-change-request__field {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-8);
  flex-wrap: wrap;
}

.past-change-request__arrow {
  display: inline-block;
  width: var(--spacing-12);
  height: var(--spacing-12);
  vertical-align: middle;
  color: var(--color-grey-400);
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

/* E2-13 / E2-12: Event Coordinator Lead assignment panel */
.lead-panel {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
}

/* Body Default, bold */
.lead-panel__title {
  font-size: 1rem;
  font-weight: 700;
  line-height: 1.25rem;
  color: var(--color-grey-900);
  margin: 0 0 var(--spacing-4);
}

/* Style.md 8.2: inputs and selects get the two-layer focus ring. */
.lead-panel__select {
  width: 100%;
  font-family: var(--font-family-lato);
  font-size: 1rem;
  line-height: 1.25rem;
  color: var(--color-grey-900);
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-xs);
  padding: var(--spacing-8) var(--spacing-12);
}

.lead-panel__select:focus {
  outline: none;
  border-color: var(--ring-brand);
  box-shadow: 0 0 0 4px var(--ring-light);
}

.lead-panel__select:disabled {
  background: var(--color-grey-25);
  border-color: var(--color-grey-100);
  color: var(--color-grey-300);
}

.lead-panel__notice {
  background: var(--color-success-200);
  border: 1px solid var(--color-success-300);
  color: var(--color-success-700);
  border-radius: var(--radius-xs);
  padding: var(--spacing-12) var(--spacing-16);
  margin: 0 0 var(--spacing-8);
}

.lead-panel__confirm {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-12);
  background: var(--color-warning-100);
  border: 1px solid var(--color-warning-300);
  border-radius: var(--radius-xs);
  padding: var(--spacing-12) var(--spacing-16);
}

.lead-panel__buttons {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
}

/* Style.md 3.4: the one solid action in the Lead's panel. */

/* Style.md 3.4: outline Purple Primary for the secondary action. */

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

.btn-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border-radius: var(--radius-xs);
  border: 1px solid var(--color-grey-200);
  background: var(--color-base-white);
  color: var(--color-purple-600);
  cursor: pointer;
}

.btn-icon:hover {
  background: var(--color-purple-100);
  color: var(--color-purple-700);
  border-color: var(--color-purple-300);
}

.btn-icon:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.btn-icon__svg {
  width: 18px;
  height: 18px;
}

.btn-icon__svg--spinning {
  animation: btn-icon-spin 0.8s linear infinite;
}

@keyframes btn-icon-spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

/* E3-6: the trigger lives at the bottom-left of the Event Details card,
   left-aligned like the rest of that card's content rather than
   right-aligned like a dialog's own action row. */
.cancel-event-row {
  margin-top: var(--spacing-24);
  display: flex;
  justify-content: flex-start;
}

.cancel-event-row__button {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-8);
}

.cancel-event-row__icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}

.cancel-event-row__cancelled-note {
  display: flex;
  align-items: center;
  gap: var(--spacing-8);
  background: var(--color-error-200);
  border: 1px solid var(--color-error-300);
  border-radius: var(--radius-xs);
  padding: var(--spacing-12) var(--spacing-16);
  color: var(--color-error-600);
}

.cancel-event-row__cancelled-note p {
  margin: 0;
}

/* E3-6: the reason popup — same overlay/dialog shell as
   VenueRequestsPanel's withdraw/release confirm modal, so every
   "are you sure" dialog in the app looks and behaves the same way. */
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
  max-width: 440px;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-4);
}

.modal-title {
  font-size: 1.125rem;
  font-weight: 700;
  color: var(--color-grey-900);
  margin: 0 0 var(--spacing-8);
}

.modal-label {
  margin-top: var(--spacing-16);
}

.modal-required {
  color: var(--color-error-600);
}

.modal-emphasis {
  color: var(--color-error-600);
  font-weight: 700;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--spacing-8);
  margin-top: var(--spacing-16);
}

.venue-search-entry {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
}

/* Style.md 3.4 outline button — the solid slot in this card belongs to Approve. */

</style>
