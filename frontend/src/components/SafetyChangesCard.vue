<script setup lang="ts">
/**
 * E3-14 AC3: the Safety Officer's change request on this event — who asked,
 * when, each flagged venue booking or equipment reservation with what must
 * change about it, and any general notes. A flag shows as changed once that arrangement has been
 * changed (released, rebooked, re-reserved…); venue-service and
 * equipment-service own the arrangements, and events-service compares them
 * with how they looked when flagged.
 *
 * The parent owns the data so it can refresh it whenever the event's
 * bookings or equipment reload — that's when a flag can clear.
 *
 * Column mapping: its own card in the event detail page's main column (the
 * 2fr of its 2fr/1fr desktop grid, full width once that collapses), like
 * the other coordinator cards; one column inside at every breakpoint.
 */
import { computed } from "vue";
import { CheckCircleIcon, ExclamationTriangleIcon } from "@heroicons/vue/20/solid";
import type { SafetyChangeRequest } from "../lib/eventsApi";

const props = defineProps<{ changeRequest: SafetyChangeRequest }>();

const openCount = computed(() => props.changeRequest.flags.filter((flag) => !flag.clearedAt).length);

function formatMoment(value: string): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  return at.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
</script>

<template>
  <section class="details-card changes" aria-labelledby="safety-changes-title">
    <div class="changes__head">
      <ExclamationTriangleIcon class="changes__icon" aria-hidden="true" />
      <div>
        <h2 id="safety-changes-title" class="section-title">Changes requested by the Safety Officer</h2>
        <p class="body-small muted">
          {{ changeRequest.officerName ?? "Safety Officer" }} · {{ formatMoment(changeRequest.requestedAt) }}
        </p>
      </div>
    </div>

    <p class="body-small muted">
      {{
        openCount === 0
          ? "Every flagged arrangement has been changed. Resubmit for safety review when you're ready."
          : `${openCount} of ${changeRequest.flags.length} flagged arrangement${changeRequest.flags.length === 1 ? "" : "s"} still to change.`
      }}
    </p>

    <ul class="flags">
      <li v-for="flag in changeRequest.flags" :key="`${flag.type}:${flag.id}`" class="flag">
        <div class="flag__head">
          <span>
            <span class="body-default flag__label">{{ flag.label }}</span>
            <span class="body-small muted"> · {{ flag.type === "venue_booking" ? "Venue booking" : "Equipment" }}</span>
          </span>
          <span v-if="flag.clearedAt" class="flag__state flag__state--done">
            <CheckCircleIcon class="flag__state-icon" aria-hidden="true" />Changed
          </span>
          <span v-else class="flag__state flag__state--open">Needs re-review</span>
        </div>
        <p class="body-small changes__notes">{{ flag.note }}</p>
      </li>
    </ul>

    <div v-if="changeRequest.generalNote" class="general">
      <p class="body-small flag__label">General notes</p>
      <p class="body-small changes__notes">{{ changeRequest.generalNote }}</p>
    </div>

    <p v-if="!changeRequest.arrangementsChecked" class="body-small muted">
      We couldn't check the current bookings and equipment just now, so this may not reflect your latest changes.
    </p>
  </section>
</template>

<style scoped>
/* Style.md 3.1 warning surface: something needs the coordinator's attention. */
.changes {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-12);
  padding: var(--spacing-24);
  border: 1px solid var(--color-warning-300);
  border-radius: var(--radius-lg);
  background: var(--color-warning-100);
}

.changes__head {
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-12);
}

.changes__icon {
  flex-shrink: 0;
  width: var(--spacing-24);
  height: var(--spacing-24);
  color: var(--color-warning-800);
}

.section-title {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
}

.body-default {
  margin: 0;
  font-size: 1rem;
  line-height: 1.25rem;
}

.body-small {
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.125rem;
}

.muted {
  color: var(--color-grey-600);
}

.general {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-4);
}

.changes__notes {
  padding: var(--spacing-8) var(--spacing-12);
  border-radius: var(--radius-xs);
  background: var(--color-base-white);
  color: var(--color-grey-900);
  white-space: pre-line;
}

.flags {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
  border-top: 1px solid var(--color-warning-300);
}

.flag {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-6);
  padding: var(--spacing-12) 0;
  border-bottom: 1px solid var(--color-warning-300);
}

.flag__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-12);
}

.flag__label {
  font-weight: 700;
  color: var(--color-grey-900);
}

.flag__state {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-4);
  flex-shrink: 0;
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
}

.flag__state-icon {
  width: var(--spacing-16);
  height: var(--spacing-16);
}

.flag__state--done {
  color: var(--color-success-600);
}

.flag__state--open {
  color: var(--color-warning-900);
}
</style>
