<script setup lang="ts">
/**
 * E3-1: Event tracking status bar.
 * AC1 — shows the current status and the date it last changed.
 * AC3 — while the event is in Planning, shows which arrangements (venue,
 * equipment) are still outstanding.
 *
 * Four stages, per the story: Requested -> (Planning | Rejected |
 * Clarification Requested) -> Confirmed -> Completed. Stage 2 is a single
 * slot whose label and colour switch to whichever of the three outcomes
 * actually applies. Confirmed/Completed aren't statuses the backend can
 * set yet (no story has built that transition), so those two stages will
 * always render as upcoming/pending for now — they're shown anyway so the
 * bar depicts the whole lifecycle, and will light up once that work lands.
 */
import { computed } from "vue";
import { formatEventDate, statusBadgeClass } from "../lib/eventStatus";

const props = defineProps<{
  status: string;
  lastChangedAt: string;
  reviewOutcome: string | null;
}>();

type StepVariant = "neutral" | "success" | "info" | "error";

const STATUS_STEP_INDEX: Record<string, number> = {
  Requested: 0,
  Unassigned: 0,
  Planning: 1,
  Rejected: 1,
  "Clarification Requested": 1,
  Confirmed: 2,
  Completed: 3,
};

const STAGE_TWO_VARIANT: Record<string, StepVariant> = {
  Planning: "success",
  Rejected: "error",
  "Clarification Requested": "info",
};

const currentIndex = computed(() => STATUS_STEP_INDEX[props.status] ?? 0);

const stage2Label = computed(() => {
  if (props.status === "Rejected") return "Rejected";
  if (props.status === "Clarification Requested") return "Clarification Requested";
  return "Planning";
});

const steps = computed(() => [
  { key: "requested", label: "Requested", variant: "neutral" as StepVariant },
  { key: "stage2", label: stage2Label.value, variant: STAGE_TWO_VARIANT[props.status] ?? "neutral" },
  { key: "confirmed", label: "Confirmed", variant: "neutral" as StepVariant },
  { key: "completed", label: "Completed", variant: "neutral" as StepVariant },
]);

function stepState(index: number): "complete" | "current" | "pending" {
  if (index < currentIndex.value) return "complete";
  if (index === currentIndex.value) return "current";
  return "pending";
}
</script>

<template>
  <div class="details-card status-card">
    <h2 class="section-title">Event Status</h2>

    <div class="status-summary">
      <span class="badge" :class="statusBadgeClass(status)">{{ status }}</span>
      <p class="body-small muted status-summary__date">Last updated {{ formatEventDate(lastChangedAt) }}</p>
    </div>

    <div class="status-tracker" role="list" aria-label="Event progress">
      <template v-for="(step, index) in steps" :key="step.key">
        <div
          class="status-tracker__step"
          role="listitem"
          :data-state="stepState(index)"
          :data-variant="stepState(index) === 'current' ? step.variant : 'neutral'"
          :aria-current="stepState(index) === 'current' ? 'step' : undefined"
        >
          <span class="status-tracker__dot" />
          <span class="body-small status-tracker__label">{{ step.label }}</span>
          <span v-if="stepState(index) === 'current'" class="status-tracker__here">You are here</span>
        </div>
        <div
          v-if="index < steps.length - 1"
          class="status-tracker__connector"
          :data-filled="index < currentIndex"
        />
      </template>
    </div>

    <p v-if="status === 'Clarification Requested'" class="body-small status-note status-note--info">
      Clarification has been requested from you. This request is on hold until you respond.
    </p>
    <p v-else-if="status === 'Rejected'" class="body-small status-note status-note--error">
      This request was rejected{{ reviewOutcome ? `: ${reviewOutcome}` : "." }}
    </p>

    <div v-if="status === 'Planning'" class="outstanding">
      <p class="body-small muted mb-1">Outstanding arrangements</p>
      <ul class="outstanding__list">
        <li class="outstanding__item">
          <span class="outstanding__dot" />
          Venue — not yet booked
        </li>
        <li class="outstanding__item">
          <span class="outstanding__dot" />
          Equipment — not yet arranged
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
  background: var(--color-blue-100);
  color: var(--color-blue-600);
}

.status-summary {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--spacing-12);
  margin-bottom: var(--spacing-32);
}

.status-summary__date {
  margin: 0;
}

.status-tracker {
  display: flex;
  align-items: flex-start;
}

.status-tracker__step {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--spacing-8);
  min-width: 5.5rem;
  text-align: center;
  position: relative;
}

.status-tracker__dot {
  width: 1.125rem;
  height: 1.125rem;
  border-radius: 50%;
  border: 2px solid var(--color-grey-200);
  background: var(--color-base-white);
  transition: all 0.15s ease;
}

.status-tracker__label {
  color: var(--color-grey-500);
}

.status-tracker__here {
  font-size: 0.6875rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--color-purple-600);
}

/* Completed steps: always green, regardless of which branch got there. */
.status-tracker__step[data-state="complete"] .status-tracker__dot {
  border-color: var(--color-success-600);
  background: var(--color-success-600);
}

.status-tracker__step[data-state="complete"] .status-tracker__label {
  color: var(--color-grey-900);
  font-weight: 700;
}

/* Current step: bold label plus a coloured ring so the active stage reads
   clearly even for someone who can't distinguish the variant colours. */
.status-tracker__step[data-state="current"] .status-tracker__label {
  color: var(--color-grey-900);
  font-weight: 700;
}

.status-tracker__step[data-state="current"] .status-tracker__dot {
  box-shadow: 0 0 0 4px var(--ring-color, var(--color-purple-100));
  border-color: var(--dot-color, var(--color-purple-600));
  background: var(--dot-color, var(--color-purple-600));
}

.status-tracker__step[data-state="current"][data-variant="neutral"] {
  --dot-color: var(--color-purple-600);
  --ring-color: var(--color-purple-100);
}

.status-tracker__step[data-state="current"][data-variant="success"] {
  --dot-color: var(--color-success-600);
  --ring-color: #e5eee5;
}

.status-tracker__step[data-state="current"][data-variant="info"] {
  --dot-color: var(--color-blue-600);
  --ring-color: var(--color-blue-100);
}

.status-tracker__step[data-state="current"][data-variant="error"] {
  --dot-color: var(--color-error-600);
  --ring-color: var(--color-error-200);
}

.status-tracker__step[data-state="current"][data-variant="error"] .status-tracker__here {
  color: var(--color-error-600);
}

.status-tracker__step[data-state="current"][data-variant="info"] .status-tracker__here {
  color: var(--color-blue-600);
}

.status-tracker__step[data-state="current"][data-variant="success"] .status-tracker__here {
  color: var(--color-success-700);
}

.status-tracker__connector {
  flex: 1;
  height: 2px;
  background: var(--color-grey-200);
  margin-top: 0.5625rem;
}

.status-tracker__connector[data-filled="true"] {
  background: var(--color-success-600);
}

.status-note {
  margin: var(--spacing-16) 0 0;
  padding: var(--spacing-12) var(--spacing-16);
  border-radius: var(--radius-xs);
  border: 1px solid;
}

.status-note--info {
  background: var(--color-blue-100);
  border-color: var(--color-blue-300);
  color: var(--color-blue-700);
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

.outstanding__dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--color-warning-400);
  flex-shrink: 0;
}

@media (max-width: 640px) {
  .status-tracker__step {
    min-width: 4rem;
  }

  .status-tracker__label {
    font-size: 0.75rem;
  }
}
</style>
