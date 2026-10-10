<script setup lang="ts">
/**
 * E3-4: the assigned coordinator submits a Planning event for the Safety
 * Officer's Operational Safety Check. The safety notes are all required
 * (AC5). Whether the venue and equipment arrangements are settled is the
 * backend's call (AC1–AC4); when it refuses, each outstanding booking and
 * equipment item it names is listed here so the coordinator knows what to
 * chase.
 */
import { reactive, ref } from "vue";
import {
  SafetyReviewSubmitError,
  submitForSafetyReview,
  type EventSummary,
  type OutstandingArrangements,
  type SafetyNotes,
} from "../lib/eventsApi";

const props = defineProps<{ eventId: number }>();

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
    <p id="safety-review-title" class="body-default font-semibold sr-title">Safety Review</p>
    <p class="body-small muted">
      Once the venue is approved and all requested equipment is reserved, submit this event for the Safety
      Officer's Operational Safety Check. The event can't be edited while it's under review.
    </p>

    <button v-if="!formOpen" type="button" class="btn btn-primary sr-open" @click="openForm">
      Submit for safety review
    </button>

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
        <button type="submit" class="btn btn-primary" :disabled="submitting">
          {{ submitting ? "Submitting…" : "Submit for safety review" }}
        </button>
        <button type="button" class="btn btn-secondary" :disabled="submitting" @click="closeForm">Cancel</button>
      </div>
    </form>
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

.sr-panel {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-12);
}

.sr-title {
  color: var(--color-grey-900);
}

.sr-open {
  align-self: flex-start;
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

.btn-primary {
  background: var(--color-purple-600);
  color: var(--color-base-white);
}

.btn-primary:not(:disabled):hover {
  background: var(--color-purple-700, var(--color-purple-600));
}

.btn-secondary {
  background: var(--color-grey-75);
  color: var(--color-grey-900);
  border-color: var(--color-grey-200);
}

.btn-secondary:not(:disabled):hover {
  background: var(--color-grey-100);
}
</style>
