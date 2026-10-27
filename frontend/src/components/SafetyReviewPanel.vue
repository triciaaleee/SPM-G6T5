<script setup lang="ts">
/**
 * E3-4: the assigned coordinator submits a Planning event for the Safety
 * Officer's Operational Safety Check. The safety notes are all required
 * (AC5). Whether the venue and equipment arrangements are settled is the
 * backend's call (AC1–AC4); when it refuses, each outstanding booking and
 * equipment item it names is listed here so the coordinator knows what to
 * chase.
 *
 * The card opens with a readiness checklist (venues approved, equipment
 * reserved) so the coordinator sees what is still to settle, and the Submit
 * button stays disabled until both are done. The backend makes the final
 * call; the checklist only mirrors its rule (lib/safetyReadiness.ts). The
 * organiser and other coordinators see the checklist read-only
 * (`canSubmit` false).
 *
 * E3-13: if the Safety Officer's most recent decision sent the event back
 * to Planning, it is shown at the top with the reason, so the coordinator
 * doesn't have to rely on the notification while reworking the
 * arrangements.
 */
import AppButton from "./ui/AppButton.vue";
import { computed, onMounted, reactive, ref } from "vue";
import { equipmentReadiness, isReadyForSafetyReview, venueReadiness } from "../lib/safetyReadiness";
import type { EquipmentRequest } from "../lib/equipmentApi";
import type { EventVenueBooking } from "../lib/venuesApi";
import {
  fetchSafetyReviews,
  SafetyReviewSubmitError,
  submitForSafetyReview,
  type EventSummary,
  type OutstandingArrangements,
  type SafetyNotes,
  type SafetyReviewDecision,
} from "../lib/eventsApi";

const props = withDefaults(
  defineProps<{
    eventId: number;
    /** This event's venue bookings and equipment requests; undefined while they are still loading. */
    venueBookings?: EventVenueBooking[];
    equipmentRequests?: EquipmentRequest[];
    /** The organiser's Equipment Requirements text; NA / None means no equipment is needed. */
    equipmentRequirements?: string;
    /** Only the assigned coordinator submits; everyone else sees the checklist read-only. */
    canSubmit?: boolean;
  }>(),
  { venueBookings: undefined, equipmentRequests: undefined, equipmentRequirements: undefined, canSubmit: true },
);

const emit = defineEmits<{ submitted: [event: EventSummary] }>();

const NOTE_FIELDS: { key: keyof SafetyNotes; label: string; hint: string }[] = [
  {
    key: "equipmentPlacement",
    label: "Equipment placement",
    hint: "Where equipment, cables and staging will go.",
  },
  {
    key: "crowdMovement",
    label: "Crowd movement",
    hint: "Entrances, exits, queues and how attendees move through the venue.",
  },
  {
    key: "emergencyAccess",
    label: "Emergency access",
    hint: "Fire exits, access routes and anything that must stay clear.",
  },
  {
    key: "venueRestrictions",
    label: "Known venue restrictions",
    hint: 'Capacity limits, noise, rigging or other rules. Write "None known" if there are none.',
  },
];

const formOpen = ref(false);
const submitting = ref(false);
const notes = reactive<SafetyNotes>({
  equipmentPlacement: "",
  crowdMovement: "",
  emergencyAccess: "",
  venueRestrictions: "",
});
const fieldErrors = ref<Record<string, string>>({});
const generalError = ref<string | null>(null);
const outstanding = ref<OutstandingArrangements | null>(null);

const decisions = ref<SafetyReviewDecision[]>([]);

/**
 * The latest decision, unless it was an approval: an approved event is only
 * back in Planning through the automatic re-review, and "approved" tells
 * the coordinator nothing to fix.
 */
const lastReturnedDecision = computed(() => {
  const latest = decisions.value.at(-1);
  return latest && latest.outcome !== "Approved" ? latest : null;
});

const DECISION_HEADINGS: Record<SafetyReviewDecision["outcome"], string> = {
  Approved: "The Safety Officer approved the last safety review",
  Rejected: "The Safety Officer rejected the last safety review",
  "Changes Requested": "The Safety Officer requested changes in the last safety review",
};

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

const venues = computed(() => venueReadiness(props.venueBookings));
const equipment = computed(() => equipmentReadiness(props.equipmentRequests, props.equipmentRequirements));
const ready = computed(() => isReadyForSafetyReview(props.venueBookings, props.equipmentRequests, props.equipmentRequirements));

type CheckState = "done" | "action" | "pending";

function checkState(item: { done: boolean; needsAction: boolean }): CheckState {
  if (item.done) return "done";
  return item.needsAction ? "action" : "pending";
}

const CHECK_BADGE: Record<CheckState, string> = { done: "Done", action: "Needs action", pending: "Pending" };

const checklist = computed(() =>
  [
    { key: "venues", label: "Venues approved", ...venues.value },
    { key: "equipment", label: "Equipment reserved", ...equipment.value },
  ].map((item) => ({ ...item, state: checkState(item) })),
);

/** Under the Submit button: what to resolve, what it is waiting on, or that the event locks once submitted. */
const submitNote = computed(() => {
  if (venues.value.needsAction && equipment.value.needsAction) return "Resolve the venue and equipment issues to submit.";
  if (venues.value.needsAction) return "Resolve the venue issue to submit.";
  if (equipment.value.needsAction) return "Resolve the equipment issue to submit.";
  if (!venues.value.done) return "Available once all venues are approved.";
  if (!equipment.value.done) return "Available once all requested equipment is reserved.";
  return "The event can't be edited while it is under review.";
});

onMounted(async () => {
  if (!props.canSubmit) return;
  try {
    decisions.value = await fetchSafetyReviews(props.eventId);
  } catch {
    // Non-critical — the panel still works without the decision history.
    decisions.value = [];
  }
});

function openForm(): void {
  formOpen.value = true;
}

function closeForm(): void {
  formOpen.value = false;
  fieldErrors.value = {};
  generalError.value = null;
  outstanding.value = null;
}

/** Mirrors the backend's AC5 check so an empty note is caught before the round trip. */
function validate(): boolean {
  const errors: Record<string, string> = {};
  for (const field of NOTE_FIELDS) {
    if (!notes[field.key].trim()) errors[field.key] = `${field.label} is required.`;
  }
  fieldErrors.value = errors;
  return Object.keys(errors).length === 0;
}

async function submit(): Promise<void> {
  generalError.value = null;
  outstanding.value = null;
  if (!validate()) return;

  submitting.value = true;
  try {
    const event = await submitForSafetyReview(props.eventId, { ...notes });
    emit("submitted", event);
  } catch (err) {
    if (err instanceof SafetyReviewSubmitError) {
      fieldErrors.value = err.fields;
      outstanding.value = err.outstanding;
      if (!err.outstanding) generalError.value = err.message;
    } else {
      generalError.value = "We couldn't submit this event for safety review. Please try again.";
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <section class="sr-panel" aria-labelledby="safety-review-title">
    <h2 id="safety-review-title" class="sr-title">Ready for safety review</h2>

    <div v-if="lastReturnedDecision" class="sr-decision" data-testid="safety-decision">
      <p class="body-small font-semibold">{{ DECISION_HEADINGS[lastReturnedDecision.outcome] }}</p>
      <p class="body-small">
        {{ lastReturnedDecision.officer?.name ?? "Safety Officer" }}, {{ formatTimestamp(lastReturnedDecision.created_at) }}
      </p>
      <p class="body-small sr-decision__reason">{{ lastReturnedDecision.reason }}</p>
      <p class="body-small">Fix the arrangements, then submit for safety review again.</p>
    </div>

    <ul class="sr-checklist" data-testid="safety-checklist">
      <li v-for="item in checklist" :key="item.key" class="sr-check" :data-testid="`check-${item.key}`">
        <span class="sr-check__mark" :class="`sr-check__mark--${item.state}`" aria-hidden="true">
          <svg v-if="item.state === 'done'" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2.5"
            stroke-linecap="round" stroke-linejoin="round">
            <path d="m5 10.5 3.25 3.25L15 7" />
          </svg>
          <svg v-else-if="item.state === 'action'" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 9v4m0 3.5h.01M10.3 3.9 2.4 17.6a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
          </svg>
        </span>
        <div class="sr-check__text">
          <p class="sr-check__label">{{ item.label }}</p>
          <p class="sr-check__caption">{{ item.caption }}</p>
        </div>
        <span class="sr-badge" :class="`sr-badge--${item.state}`">{{ CHECK_BADGE[item.state] }}</span>
      </li>
    </ul>

    <template v-if="canSubmit">
      <template v-if="!formOpen">
        <AppButton variant="primary" block type="button" :disabled="!ready" @click="openForm">
          Submit for safety review
        </AppButton>
        <p class="sr-note" data-testid="submit-note">{{ submitNote }}</p>
      </template>

      <form v-else class="sr-form" novalidate @submit.prevent="submit">
        <div v-if="outstanding" class="sr-outstanding" role="alert">
          <p class="body-small font-semibold">Settle these before submitting:</p>
          <ul class="sr-outstanding__list">
            <li v-if="outstanding.noApprovedVenue" class="body-small">This event has no approved venue booking.</li>
            <li v-for="booking in outstanding.bookings" :key="`b-${booking.bookingId}`" class="body-small">
              {{ booking.venueName ?? `Venue booking #${booking.bookingId}` }} is still {{ booking.status }}.
            </li>
            <li
              v-for="item in outstanding.equipment"
              :key="`e-${item.requestId}-${item.equipmentType}`"
              class="body-small"
            >
              {{ item.equipmentType }}: {{ item.quantityReserved }} of {{ item.quantity }} reserved.
            </li>
          </ul>
        </div>
        <p v-if="generalError" class="body-small error-text" role="alert">{{ generalError }}</p>

        <div v-for="field in NOTE_FIELDS" :key="field.key" class="field">
          <label :for="`sr-${field.key}`" class="body-small sr-label">{{ field.label }}</label>
          <p :id="`sr-${field.key}-hint`" class="body-small muted sr-hint">{{ field.hint }}</p>
          <textarea
            :id="`sr-${field.key}`"
            v-model="notes[field.key]"
            rows="3"
            maxlength="2000"
            class="sr-input"
            :aria-describedby="`sr-${field.key}-hint`"
            :aria-invalid="!!fieldErrors[field.key]"
          />
          <p v-if="fieldErrors[field.key]" class="body-small error-text">{{ fieldErrors[field.key] }}</p>
        </div>

        <div class="sr-actions">
          <AppButton variant="primary" type="submit" :disabled="submitting">
            {{ submitting ? "Submitting…" : "Submit for safety review" }}
          </AppButton>
          <AppButton variant="outline" type="button" :disabled="submitting" @click="closeForm">Cancel</AppButton>
        </div>
      </form>
    </template>
  </section>
</template>

<style scoped>
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

/* The card itself (Style.md 3.3 surfaces): same as the page's other cards. */
.sr-panel {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-24);
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
  padding: var(--spacing-32);
}

.sr-title {
  margin: 0;
  font-size: 1.5rem;
  font-weight: 700;
  line-height: 2rem;
  color: var(--color-grey-900);
}

/* Readiness checklist: a circle, the item and what is left, and a badge on the right. */
.sr-checklist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-16);
}

.sr-check {
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-12);
}

.sr-check__mark {
  flex-shrink: 0;
  box-sizing: border-box;
  width: 1.75rem;
  height: 1.75rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  border: 2px solid var(--color-grey-300);
  background: var(--color-base-white);
  color: var(--color-base-white);
}

.sr-check__mark--done {
  border-color: var(--color-success-700);
  background: var(--color-success-700);
}

/* Waiting on someone else: a hollow amber ring. */
.sr-check__mark--pending {
  border-color: var(--color-warning-400);
}

/* Something went wrong: the ring gives way to a bare warning triangle. */
.sr-check__mark--action {
  border-color: transparent;
  background: transparent;
  color: var(--color-warning-900);
}

.sr-check__mark--action svg {
  width: 1.75rem;
  height: 1.75rem;
}

.sr-check__mark svg {
  width: 1rem;
  height: 1rem;
}

.sr-check__text {
  flex: 1;
  min-width: 0;
}

.sr-check__label {
  margin: 0;
  font-size: 1rem;
  font-weight: 700;
  line-height: 1.25rem;
  color: var(--color-grey-900);
}

.sr-check__caption {
  margin: var(--spacing-2) 0 0;
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-500);
}

.sr-badge {
  flex-shrink: 0;
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  padding: var(--spacing-4) var(--spacing-12);
  border-radius: var(--radius-xs);
}

.sr-badge--pending {
  background: var(--color-grey-100);
  color: var(--color-grey-600);
}

.sr-badge--done {
  background: var(--color-success-200);
  color: var(--color-success-700);
}

.sr-badge--action {
  background: var(--color-warning-200);
  color: var(--color-warning-900);
}

/* Not ready yet: the Submit button reads as an empty, outlined field rather than a faded purple one. */
.sr-panel :deep(.btn:disabled) {
  background: var(--color-base-white);
  border-color: var(--color-grey-200);
  color: var(--color-grey-300);
}

.sr-note {
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-500);
  margin-top:-12px;
}

.sr-form {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-12);
  padding: var(--spacing-12);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-xs);
  background: var(--color-base-white);
}

.sr-outstanding {
  padding: var(--spacing-8) var(--spacing-12);
  border-radius: var(--radius-xs);
  background: var(--color-warning-100);
  color: var(--color-warning-900);
}

/* Style.md 2.6: Orange Warning — needs the coordinator's attention, not an error. */
.sr-decision {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-4);
  padding: var(--spacing-8) var(--spacing-12);
  border: 1px solid var(--color-warning-300);
  border-radius: var(--radius-xs);
  background: var(--color-warning-100);
  color: var(--color-warning-900);
}

.sr-decision__reason {
  white-space: pre-line;
  overflow-wrap: anywhere;
}

.sr-outstanding__list {
  margin: var(--spacing-4) 0 0;
  padding-left: var(--spacing-16);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-2);
}

.field {
  min-width: 0;
}

.sr-label {
  display: block;
  font-weight: 700;
  color: var(--color-grey-900);
}

.sr-hint {
  margin: var(--spacing-2) 0 var(--spacing-8);
}

.sr-input {
  width: 100%;
  font-family: var(--font-family-lato);
  font-size: 0.9375rem;
  color: var(--color-grey-900);
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-xs);
  padding: var(--spacing-8) var(--spacing-12);
  resize: vertical;
}

.sr-input[aria-invalid="true"] {
  border-color: var(--color-error-600);
}

.sr-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-8);
}

</style>
