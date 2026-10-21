<script setup lang="ts">
/**
 * E3-1: Event tracking status bar.
 * AC1 — shows the current status and the date it last changed.
 * AC3 — while the event is in Planning, shows which arrangements (venue,
 * equipment) are still outstanding.
 *
 * The timeline is five columns, one per lifecycle stage (AGENTS.md section 3):
 * Requested -> Planning -> Safety Review -> Confirmed -> Completed. Each shows
 * a circle (a tick when done, a ringed dot for the current step, a number when
 * not started), a connector line to the next stage, the stage name and a
 * caption ("Done, 1 Oct 2026", "Current step", "Not started"). Stage 2 reads
 * "Clarification Requested" while the organiser's answer is awaited, and
 * Rejected ends the line at a "Rejected" step. Confirmed is reached when the
 * Safety Officer approves (E3-12) and Completed when the coordinator closes
 * the event after it has run (E3-5).
 */
import { computed } from "vue";
import type { EventVenueBooking } from "../lib/venuesApi";
import type { EquipmentRequest } from "../lib/equipmentApi";

const props = withDefaults(
  defineProps<{
    status: string;
    lastChangedAt: string;
    reviewOutcome: string | null;
    title?: string;
    /** Show the stepper and status note (bare, no card). */
    showTimeline?: boolean;
    /** When the request was submitted; shown under the first step once it is done. */
    submittedAt?: string | null;
    /** Show the "Outstanding arrangements" list (only ever rendered while Planning). */
    showOutstanding?: boolean;
    /**
     * This event's venue bookings, so AC3's venue line says what is actually
     * true. Undefined while they are still loading, or when the caller has no
     * way to read them.
     */
    venueBookings?: EventVenueBooking[];
    /**
     * This event's equipment requests, so AC3's equipment line says what is
     * actually true. Undefined while they are still loading, or when the
     * caller has no way to read them.
     */
    equipmentRequests?: EquipmentRequest[];
  }>(),
  {
    title: "Event Status",
    showTimeline: true,
    submittedAt: null,
    showOutstanding: true,
    venueBookings: undefined,
    equipmentRequests: undefined,
  },
);

/**
 * E3-1 AC3, venue half. An event may have several venue bookings and each
 * is decided on its own (AGENTS.md §3a), so the venue counts as arranged
 * only once at least one is `Approved` and none is still awaiting a
 * decision — a second venue still sitting with Venue Staff is an
 * outstanding arrangement even though the first is confirmed.
 */
const venueArrangement = computed<{ done: boolean; label: string }>(() => {
  const bookings = props.venueBookings;
  if (!bookings) return { done: false, label: "Venue — checking…" };

  const approved = bookings.filter((booking) => booking.status === "Approved");
  // Matches what blocks submitting for safety review (E3-4 AC2).
  const pending = bookings.filter(
    (booking) =>
      booking.status === "Requested" || booking.status === "On Hold" || booking.status === "Replacement Required",
  );

  if (approved.length > 0 && pending.length === 0) {
    const names = approved.map((booking) => booking.venue?.name).filter(Boolean);
    return { done: true, label: `Venue — ${names.length > 0 ? names.join(", ") : `${approved.length} booked`}` };
  }
  if (pending.length > 0) {
    const replacements = pending.filter((booking) => booking.status === "Replacement Required").length;
    if (replacements > 0) return { done: false, label: `Venue — ${replacements} needs a replacement` };
    const held = pending.filter((booking) => booking.status === "On Hold").length;
    const detail = held > 0 ? `${held} on hold` : `${pending.length} awaiting Venue Staff`;
    return { done: false, label: `Venue — ${detail}` };
  }
  return { done: false, label: "Venue — not yet booked" };
});

/**
 * E3-1 AC3, equipment half. An event may accumulate more than one equipment
 * request (E5-1, same as venue_bookings allowing several venues); it counts
 * as arranged only once every request on it is "Arranged" — one still sat
 * at "Requested" or "Partially Fulfilled" keeps this outstanding even if
 * another request for the same event is already fully arranged. A request the
 * coordinator cancelled (E5-2) holds nothing and is left out entirely.
 */
const equipmentArrangement = computed<{ done: boolean; label: string }>(() => {
  const requests = props.equipmentRequests?.filter((r) => r.status !== "Cancelled");
  if (!requests) return { done: false, label: "Equipment — checking…" };
  if (requests.length === 0) return { done: false, label: "Equipment — not yet requested" };

  const outstanding = requests.filter((r) => r.status !== "Arranged");
  if (outstanding.length === 0) {
    return { done: true, label: "Equipment — arranged" };
  }
  return { done: false, label: `Equipment — ${outstanding.length} awaiting Technical Support` };
});

// Safety Review is its own column now (E3-4), between Planning and Confirmed.
const STATUS_STEP_INDEX: Record<string, number> = {
  Requested: 0,
  Unassigned: 0,
  Planning: 1,
  Rejected: 1,
  "Clarification Requested": 1,
  "Safety Review": 2,
  Confirmed: 3,
  "Needs Review": 3,
  Completed: 4,
};

const currentIndex = computed(() => STATUS_STEP_INDEX[props.status] ?? 0);

/** Completed is the end of the line: every step, the last included, is done. */
const allDone = computed(() => props.status === "Completed");

const stage2Label = computed(() => {
  if (props.status === "Rejected") return "Rejected";
  if (props.status === "Clarification Requested") return "Clarification Requested";
  return "Planning";
});

/** Rejected is terminal — nothing after it can happen, so only the two stages that occurred are shown.
 * Cancelled (E3-6) is terminal too, but — unlike Rejected — it can happen from any active stage
 * (AGENTS.md §3) and nothing here records which one, so there's no honest step to highlight; the
 * stepper is hidden entirely and the status note below carries the reason instead. */
const steps = computed(() => {
  if (props.status === "Cancelled") return [];

  const requested = { key: "requested", label: "Requested" };
  const stage2 = { key: "stage2", label: stage2Label.value };

  if (props.status === "Rejected") return [requested, stage2];

  return [
    requested,
    stage2,
    { key: "safety-review", label: "Safety Review" },
    // Needs Review shares Confirmed's slot: the event is past safety approval but something changed.
    { key: "confirmed", label: props.status === "Needs Review" ? "Needs Review" : "Confirmed" },
    { key: "completed", label: "Completed" },
  ];
});

function stepState(index: number): "complete" | "current" | "pending" {
  if (allDone.value || index < currentIndex.value) return "complete";
  if (index === currentIndex.value) return "current";
  return "pending";
}

/** "1 Oct 2026"; empty when the value isn't a date. */
function shortDate(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** The small line under a step's name. Only dates we actually know are shown. */
function stepCaption(index: number): string {
  const state = stepState(index);
  if (state === "current") return "Current step";
  if (state === "pending") return "Not started";
  const date =
    index === 0 ? shortDate(props.submittedAt) : allDone.value && index === steps.value.length - 1 ? shortDate(props.lastChangedAt) : "";
  return date ? `Done, ${date}` : "Done";
}
</script>

<template>
  <div v-if="showTimeline" class="timeline">
    <ol v-if="steps.length > 0" class="status-tracker" aria-label="Event progress" :data-status="status"
      :style="{ '--steps': steps.length }">
      <li v-for="(step, index) in steps" :key="step.key" class="status-tracker__step" :data-state="stepState(index)"
        :aria-current="stepState(index) === 'current' ? 'step' : undefined">
        <div class="status-tracker__marker">
          <span class="status-tracker__dot">
            <svg v-if="stepState(index) === 'complete'" class="status-tracker__tick" viewBox="0 0 20 20" fill="none"
              stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="m5 10.5 3.25 3.25L15 7" />
            </svg>
            <span v-else-if="stepState(index) === 'current'" class="status-tracker__inner" />
            <template v-else>{{ index + 1 }}</template>
          </span>
          <span v-if="index < steps.length - 1" class="status-tracker__line" />
        </div>
        <span class="status-tracker__label">{{ step.label }}</span>
        <span class="status-tracker__caption">{{ stepCaption(index) }}</span>
      </li>
    </ol>

    <p v-if="status === 'Clarification Requested'" class="body-default pt-8">
      Clarification has been requested from you. This request is on hold until you respond.
    </p>
    <p v-else-if="status === 'Rejected'" class="body-small status-note status-note--error">
      This request was rejected{{ reviewOutcome ? `: ${reviewOutcome}` : "." }}
    </p>
    <p v-else-if="status === 'Cancelled'" class="body-small status-note status-note--error">
      This event was cancelled{{ reviewOutcome ? `: ${reviewOutcome}` : "." }}
    </p>
    <p v-else-if="status === 'Needs Review'" class="body-small muted pt-8">
      Something this event was approved on has changed (its venue, equipment or a change request). It returns to
      Confirmed once everything is settled.
    </p>
    <p v-else-if="status === 'Safety Review'" class="body-small muted pt-8">
      Submitted for the Safety Officer's Operational Safety Check. The event can't be edited while it's under review.
    </p>
  </div>

  <div v-if="showOutstanding && (status === 'Planning' || !showTimeline)" class="details-card status-card">
    <h2 class="section-title">{{ title }}</h2>

    <div v-if="(status === 'Planning' || status === 'Needs Review') && showOutstanding" class="outstanding">
      <p class="body-small muted mb-1">Outstanding arrangements</p>
      <ul class="outstanding__list">
        <li class="outstanding__item" :class="{ 'outstanding__item--done': venueArrangement.done }">
          <span class="outstanding__dot" :class="{ 'outstanding__dot--done': venueArrangement.done }" />
          {{ venueArrangement.label }}
        </li>
        <li v-if="!equipmentArrangement.done" class="outstanding__item">
          <span class="outstanding__dot" />
          {{ equipmentArrangement.label }}
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.status-card {
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
  padding: var(--spacing-32);
}

.section-title {
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
  margin: 0 0 var(--spacing-12);
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

/* The timeline sits bare on the page (no card). Five equal columns: each step is a circle with a
   connector line running on to the next column, then the stage name and a caption below. */
.timeline {
  margin-bottom: var(--spacing-32);
}

.status-tracker {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(var(--steps), minmax(0, 1fr));
}

.status-tracker__step {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-2);
  min-width: 0;
}

.status-tracker__marker {
  display: flex;
  align-items: center;
  gap: var(--spacing-12);
  margin-bottom: var(--spacing-8);
}

.status-tracker__dot {
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
  color: var(--color-grey-600);
  font-size: 0.75rem;
  font-weight: 700;
}

/* The line to the next step: grey until the step before it is done. */
.status-tracker__line {
  flex: 1;
  height: 2px;
  margin-right: var(--spacing-12);
  background: var(--color-grey-200);
}

.status-tracker__step[data-state="complete"] .status-tracker__line {
  background: var(--color-purple-600);
}

.status-tracker__tick {
  width: 1rem;
  height: 1rem;
}

.status-tracker__inner {
  width: 0.625rem;
  height: 0.625rem;
  border-radius: 50%;
  background: var(--color-purple-600);
}

.status-tracker__label {
  font-size: 1rem;
  font-weight: 700;
  line-height: 1.25rem;
  color: var(--color-grey-900);
}

.status-tracker__caption {
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-500);
}

.status-tracker__step[data-state="complete"] .status-tracker__dot {
  border-color: var(--color-purple-600);
  background: var(--color-purple-600);
  color: var(--color-base-white);
}

.status-tracker__step[data-state="current"] .status-tracker__dot {
  border-color: var(--color-purple-600);
}

.status-tracker__step[data-state="current"] .status-tracker__label {
  color: var(--color-purple-600);
}

/* Rejected is a terminal, negative outcome — its step switches from the brand purple to red. */
.status-tracker[data-status="Rejected"] .status-tracker__step[data-state="current"] .status-tracker__dot {
  border-color: var(--color-error-600);
}

.status-tracker[data-status="Rejected"] .status-tracker__step[data-state="current"] .status-tracker__inner {
  background: var(--color-error-600);
}

.status-tracker[data-status="Rejected"] .status-tracker__step[data-state="current"] .status-tracker__label {
  color: var(--color-error-600);
}

.status-tracker[data-status="Rejected"] .status-tracker__step[data-state="complete"] .status-tracker__line {
  background: var(--color-error-600);
}

@media (max-width: 640px) {
  /* Narrow screens: drop the captions and shrink the names so five columns still fit. */
  .status-tracker__label {
    font-size: 0.75rem;
    line-height: 1rem;
  }

  .status-tracker__caption {
    display: none;
  }
}

.status-note {
  margin: var(--spacing-16) 0 0;
  padding: var(--spacing-12) var(--spacing-16);
  border-radius: var(--radius-xs);
  border: 1px solid;
}

.status-note--info {
  background: var(--color-warning-200);
  border-color: var(--color-warning-400);
  color: var(--color-warning-800);
}

.status-note--error {
  background: var(--color-error-200);
  border-color: var(--color-error-600);
  color: var(--color-error-600);
}

.outstanding {
  margin-top: var(--spacing-24);
}

.outstanding__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
}

.outstanding__item {
  display: flex;
  align-items: center;
  gap: var(--spacing-8);
  font-size: 1rem;
  color: var(--color-grey-900);
}

.outstanding__item--done {
  color: var(--color-success-700);
}

.outstanding__dot--done {
  background: var(--color-success-700);
}

.outstanding__dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--color-warning-400);
  flex-shrink: 0;
}

@media (max-width: 640px) {
  .status-tracker__label {
    font-size: 0.75rem;
  }
}
</style>
