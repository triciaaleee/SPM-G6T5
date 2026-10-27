<script setup lang="ts">
/**
 * E6: when registration opens, its current state (not open, open, full, closed) and when it closes by itself, shown
 * read-only to the owning organiser. Only the assigned coordinator sets the open date or opens and closes
 * registration by hand, so this card has no controls; it mirrors what events-service derives on every read
 * (lib/registrationPeriod.ts).
 */
import { computed } from "vue";
import { formatEventDate } from "../lib/eventStatus";
import {
  REGISTRATION_CUTOFF_DAYS,
  REGISTRATION_OVERVIEW_LABEL,
  registrationClosesAt,
  registrationOverview,
  type RegistrationOverride,
} from "../lib/registrationPeriod";

const props = defineProps<{
  status: string;
  details: Record<string, unknown>;
  openDate?: string | null;
  override?: RegistrationOverride | null;
  registeredCount: number;
  now: Date;
}>();

const overview = computed(() =>
  registrationOverview(props.status, props.details, props.openDate, props.override, props.registeredCount, props.now),
);

const closesAtLabel = computed(() => {
  const closesAt = registrationClosesAt(props.details);
  if (closesAt === null) return null;
  const options = { timeZone: "Asia/Singapore" } as const;
  const date = closesAt.toLocaleDateString("en-US", { ...options, day: "numeric", month: "long", year: "numeric" });
  const time = closesAt.toLocaleTimeString("en-GB", { ...options, hour: "2-digit", minute: "2-digit" });
  return `${date} at ${time}`;
});

const manual = computed(() => (props.override && props.override !== "NONE" ? props.override : null));

/** The line that says why registration is in this state, for the stages before it can open. */
const stageNote = computed(() => {
  if (props.status === "Needs Review") return "Registration is closed while the event is under review.";
  if (props.status === "Planning" || props.status === "Safety Review") {
    return "Registration can open once the event is Confirmed.";
  }
  return null;
});
</script>

<template>
  <div class="details-card registration-period" data-testid="registration-period">
    <h2 class="section-title">Registration</h2>
    <p class="body-default">
      Status: <strong data-testid="registration-period-state">{{ REGISTRATION_OVERVIEW_LABEL[overview] }}</strong>
      <span v-if="manual" class="muted">
        (the coordinator has manually {{ manual === "FORCE_OPEN" ? "opened" : "closed" }} registration)
      </span>
    </p>
    <p v-if="stageNote" class="body-small muted" data-testid="registration-period-note">{{ stageNote }}</p>
    <p class="body-small muted" data-testid="registration-period-opens">
      <template v-if="openDate">
        Registration opens on <strong>{{ formatEventDate(openDate) }}</strong>.
      </template>
      <template v-else>Your coordinator hasn't set a registration open date yet.</template>
    </p>
    <p class="body-small muted" data-testid="registration-period-closes">
      <template v-if="closesAtLabel">
        It closes automatically on <strong>{{ closesAtLabel }}</strong> ({{ REGISTRATION_CUTOFF_DAYS }} days before the
        event), or earlier if it fills, and always stops when the event starts.
      </template>
      <template v-else>It closes automatically {{ REGISTRATION_CUTOFF_DAYS }} days before the event, or when it is full.</template>
    </p>
  </div>
</template>

<style scoped>
/* The card's own box comes from the event page's .details-card, applied to this root. */
.registration-period {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
}

.section-title {
  font-size: 24px;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
  margin: 0;
}

.body-default {
  font-size: 18px;
  color: var(--color-grey-900);
  margin: 0;
}

.body-small {
  font-size: 0.875rem;
  margin: 0;
}

.muted {
  color: var(--color-grey-500);
}
</style>
