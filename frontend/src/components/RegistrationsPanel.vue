<script setup lang="ts">
/**
 * E3-5 AC3 / E6-5: the event's registrations, read-only, for the owning
 * organiser and coordinators — so a Completed event's attendee list stays
 * viewable. A title and the registered count against capacity (with the places
 * left), then two tables behind a tab switch: Registered (the default) and
 * Withdrawn. A Cancelled registration means the organiser cancelled the whole
 * event, which they already know, so it isn't counted as registered; it is
 * listed under Withdrawn, with its own badge, so the record stays complete.
 *
 * Column mapping: the content of the event detail page's Registrations tab,
 * full width (col 1-12 desktop, 1-6 tablet, 1-4 mobile), with no card behind it.
 * The tables are the shared DataTable; narrow screens drop the "Registered on"
 * column.
 */
import { computed, onMounted, ref } from "vue";
import DataTable from "./ui/DataTable.vue";
import { fetchEventRegistrations, type EventRegistration } from "../lib/registrationApi";
import { registrationBadgeClass } from "../lib/registrationStatus";

const props = defineProps<{
  eventId: number;
  /** How many may register (the event's expected attendance); omit or null for no cap. */
  capacity?: number | null;
}>();

/** Tells the event page how many are registered, for the tab label. */
const emit = defineEmits<{ loaded: [registeredCount: number] }>();

const COLUMNS = [
  { key: "name", label: "Name" },
  { key: "registeredOn", label: "Registered on", hideOnNarrow: true },
  { key: "status", label: "Status" },
];
const COLUMN_WIDTHS = "minmax(0, 3fr) minmax(0, 2fr) 8rem";

type RosterTab = "registered" | "withdrawn";
const activeTab = ref<RosterTab>("registered");

const registrations = ref<EventRegistration[]>([]);
const loading = ref(true);
const loadError = ref<string | null>(null);

const registered = computed(() => registrations.value.filter((r) => r.status === "Registered"));
// Withdrawn first, then cancelled; oldest first within each (the sort is stable).
const withdrawn = computed(() =>
  registrations.value
    .filter((r) => r.status !== "Registered")
    .sort((a, b) => Number(a.status === "Cancelled") - Number(b.status === "Cancelled")),
);
const registeredCount = computed(() => registered.value.length);

const tabs = computed(() => [
  { key: "registered" as const, label: `Registered (${registered.value.length})` },
  { key: "withdrawn" as const, label: `Withdrawn (${withdrawn.value.length})` },
]);

const rows = computed(() => (activeTab.value === "registered" ? registered.value : withdrawn.value));
const emptyMessage = computed(() =>
  activeTab.value === "registered" ? "No one is registered yet." : "No one has withdrawn.",
);

const cap = computed(() =>
  typeof props.capacity === "number" && Number.isInteger(props.capacity) && props.capacity > 0 ? props.capacity : null,
);
const placesLeft = computed(() => (cap.value === null ? null : Math.max(0, cap.value - registeredCount.value)));

function formatMoment(value: string): string {
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  return at.toLocaleString("en-US", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

onMounted(async () => {
  try {
    registrations.value = await fetchEventRegistrations(props.eventId);
    emit("loaded", registeredCount.value);
  } catch {
    loadError.value = "We couldn't load the registrations for this event.";
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <section class="registrations">
    <div class="registrations__header">
      <h2 class="section-title">Registrations</h2>
      <div v-if="!loading && !loadError" class="view-toggle" role="group" aria-label="Show registrations">
        <button v-for="tab in tabs" :key="tab.key" type="button" class="toggle-btn"
          :class="{ 'toggle-btn--active': activeTab === tab.key }" :aria-pressed="activeTab === tab.key"
          @click="activeTab = tab.key">
          {{ tab.label }}
        </button>
      </div>
    </div>
    <p v-if="loading" class="body-default muted">Loading registrations…</p>
    <p v-else-if="loadError" class="body-default error-text">{{ loadError }}</p>
    <template v-else>
      <div class="summary">
        <p class="summary__count" data-testid="registered-count">
          <template v-if="cap !== null">{{ registeredCount }} of {{ cap }} registered</template>
          <template v-else>{{ registeredCount }} registered</template>
        </p>
        <p v-if="cap !== null" class="body-small muted" data-testid="places-left">
          {{ placesLeft === 0 ? "Full" : `${placesLeft} ${placesLeft === 1 ? "place" : "places"} left` }}
        </p>
      </div>

      <p v-if="rows.length === 0" class="body-default muted empty">{{ emptyMessage }}</p>
      <DataTable
        v-else
        :columns="COLUMNS"
        :column-widths="COLUMN_WIDTHS"
        :rows="rows"
        :row-key="(registration) => registration.registrationId"
      >
        <template #cell-name="{ row }">
          <span class="registration-name" :class="{ 'registration-name--inactive': row.status !== 'Registered' }">
            {{ row.name ?? row.userId }}
          </span>
        </template>
        <template #cell-registeredOn="{ row }">{{ formatMoment(row.createdAt) }}</template>
        <template #cell-status="{ row }">
          <span class="badge" :class="registrationBadgeClass(row.status)">{{ row.status }}</span>
        </template>
      </DataTable>
    </template>
  </section>
</template>

<style scoped>
/* Title on the left, the Registered / Withdrawn toggle at the end of the same row. */
.registrations__header {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  flex-wrap: wrap;
  gap: var(--spacing-16);
  margin-bottom: var(--spacing-16);
}

.section-title {
  font-size: 24px;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
  margin: 0;
}

.body-default {
  font-size: 0.875rem;
  color: var(--color-grey-900);
}

.body-small {
  font-size: 14px;
}

.muted {
  color: var(--color-grey-500);
}

.error-text {
  color: var(--color-error-600);
}

.empty {
  margin: 0;
}

.summary {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-4);
  margin-bottom: var(--spacing-24);
}

/* Subheading, bold */
.summary__count {
  margin: 0;
  font-size: 16px;
  font-weight: 400;
  color: var(--color-grey-900);
}

.summary .body-small {
  margin: 0;
}

/* Segmented toggle, as on the coordinator page before it was split — in Secondary Blue (Style.md 2.8). */
.view-toggle {
  display: inline-flex;
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-xs);
  overflow: hidden;
}

.toggle-btn {
  appearance: none;
  background: var(--color-base-white);
  border: none;
  border-right: 1px solid var(--color-grey-200);
  cursor: pointer;
  padding: var(--spacing-8) var(--spacing-16);
  font-family: inherit;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--color-grey-600);
  transition: background 0.1s, color 0.1s;
}

.toggle-btn:last-child {
  border-right: none;
}

.toggle-btn:hover:not(.toggle-btn--active) {
  background: var(--color-grey-50);
  color: var(--color-grey-900);
}

.toggle-btn:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: -2px;
}

.toggle-btn--active {
  background: var(--color-blue-600);
  color: var(--color-base-white);
}

/* Withdrawn and cancelled people read as no longer attending. */
.registration-name {
  font-weight: 700;
  overflow-wrap: anywhere;
}

.registration-name--inactive {
  color: var(--color-grey-500);
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
