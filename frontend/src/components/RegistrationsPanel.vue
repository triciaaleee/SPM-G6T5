<script setup lang="ts">
/**
 * E3-5 AC3: the event's registrations, read-only, for the owning organiser
 * and coordinators — so a Completed event's attendee list stays viewable.
 * Withdrawn registrations are listed too: they're part of the record.
 *
 * Column mapping: its own card in the event detail page's main column (the
 * 2fr of its 2fr/1fr desktop grid, full width once that collapses), like
 * the Venue Requests card. The list inside is a single column at every
 * breakpoint.
 */
import { computed, onMounted, ref } from "vue";
import { fetchEventRegistrations, type EventRegistration } from "../lib/registrationApi";
import { registrationBadgeClass } from "../lib/registrationStatus";

const props = defineProps<{ eventId: number }>();

const registrations = ref<EventRegistration[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);

const registeredCount = computed(() => registrations.value.filter((r) => r.status === "Registered").length);

function formatMoment(value: string): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  return at.toLocaleString("en-US", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

onMounted(async () => {
  try {
    registrations.value = await fetchEventRegistrations(props.eventId);
  } catch {
    loadError.value = "We couldn't load the registrations for this event.";
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="details-card registrations">
    <h2 class="section-title">Registrations</h2>
    <p v-if="loading" class="body-default muted">Loading registrations…</p>
    <p v-else-if="loadError" class="body-default error-text">{{ loadError }}</p>
    <p v-else-if="registrations.length === 0" class="body-default muted">No one has registered for this event.</p>
    <template v-else>
      <p class="body-small muted registrations__summary">
        {{ registeredCount }} registered{{
          registrations.length > registeredCount ? `, ${registrations.length - registeredCount} withdrawn` : ""
        }}
      </p>
      <ul class="registration-list">
        <li v-for="registration in registrations" :key="registration.registrationId" class="registration-row">
          <div>
            <p class="body-default registration-name">{{ registration.name ?? registration.userId }}</p>
            <p class="body-small muted">Registered {{ formatMoment(registration.createdAt) }}</p>
          </div>
          <span class="badge" :class="registrationBadgeClass(registration.status)">{{ registration.status }}</span>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
/* Same card as VenueRequestsPanel.vue. Style.md 3.3 surfaces, 7 radius, 6.1 spacing. */
.registrations {
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
  padding: var(--spacing-32);
}

.section-title {
  font-size: 1.125rem;
  font-weight: 700;
  color: var(--color-grey-900);
  margin-bottom: var(--spacing-16);
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
}

.registrations__summary {
  margin-bottom: var(--spacing-12);
}

.registration-list {
  display: grid;
  gap: var(--spacing-12);
  list-style: none;
  margin: 0;
  padding: 0;
}

.registration-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--spacing-16);
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-xs);
  padding: var(--spacing-16);
}

.registration-name {
  font-weight: 700;
  overflow-wrap: anywhere;
}

/* Registration badge colours, as in AttendeeEventsView.vue (Style.md 2.6/2.7). */
.badge {
  display: inline-block;
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  padding: var(--spacing-4) var(--spacing-8);
  border-radius: var(--radius-xs);
  white-space: nowrap;
}

.status-success {
  background: var(--color-success-200);
  color: var(--color-success-700);
}

.status-warning {
  background: var(--color-warning-100);
  color: var(--color-warning-900);
}

.status-error {
  background: var(--color-error-200);
  color: var(--color-error-600);
}
</style>
