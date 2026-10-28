<script setup lang="ts">
import { onMounted, ref } from "vue";
import { fetchUnassignedQueue, type EventSummary } from "../../lib/eventsApi";
import { formatEventDate, statusBadgeClass, statusLabel } from "../../lib/eventStatus";
import { eventName, eventOrganiser } from "../../lib/leadAssignments";
import DataTable from "../../components/ui/DataTable.vue";

/**
 * E1-8: the Event Coordinator Lead's unassigned queue — every submitted
 * request still waiting for a coordinator, longest-waiting first (the
 * backend's order). Opening one is how the Lead assigns it (E2-13).
 */
const queue = ref<EventSummary[]>([]);
const loading = ref(true);
const errorMessage = ref<string | null>(null);

function eventDate(event: EventSummary): string | null {
  const date = (event.submitted_details as Record<string, unknown>)?.proposedDate;
  return typeof date === "string" && date ? date : null;
}

const COLUMNS = [
  { key: "event", label: "Event" },
  { key: "date", label: "Event date", hideOnNarrow: true },
  { key: "submitted", label: "Submitted", hideOnNarrow: true },
  { key: "organiser", label: "Requested by", hideOnNarrow: true },
  { key: "status", label: "Status" },
];

// Same proportions approach as LeadEventTable: shrinkable fractions, fixed Status so rows line up.
const COLUMN_WIDTHS = "minmax(0, 18fr) minmax(0, 10fr) minmax(0, 10fr) minmax(0, 12fr) 10rem";

onMounted(async () => {
  try {
    queue.value = await fetchUnassignedQueue();
  } catch {
    errorMessage.value = "We couldn't load the events. Please try again.";
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <!--
    Column mapping — Event Coordinator Lead unassigned queue
    Desktop (12-col): outer container col 1-12, grid-desktop-margin 80px; back link, heading and card list col 1-12.
    Tablet (6-col):   content col 1-6, full width, grid-tablet-margin 32px.
    Mobile (4-col):   content col 1-4, full width, grid-mobile-margin 6px.
    The request list is a DataTable filling the content width; it drops the date and requester columns on
    narrow screens and shows the dates under the event name.
  -->
  <div class="page">
    <div class="content">
      <RouterLink :to="{ name: 'lead-dashboard' }" class="back-link">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M15.75 19.5 8.25 12l7.5-7.5" />
        </svg>
        Back to overview
      </RouterLink>

      <div>
        <h1 class="h2">Unassigned queue</h1>
        <p class="subheading">Requests waiting for a coordinator, longest-waiting first. Open one to assign it.</p>
      </div>

      <p v-if="loading" class="body-default muted">Loading events…</p>
      <p v-else-if="errorMessage" class="body-default error-text" role="alert">{{ errorMessage }}</p>
      <p v-else-if="queue.length === 0" class="body-default muted">No requests are waiting for a coordinator.</p>

      <!-- E1-8 AC1: event name, event date and submission date for each request -->
      <DataTable
        v-else
        :columns="COLUMNS"
        :column-widths="COLUMN_WIDTHS"
        column-gap="var(--spacing-80)"
        :rows="queue"
        :row-key="(event) => event.id"
        :row-to="(event) => ({ name: 'event-detail', params: { id: event.id } })"
        :row-test-id="(event) => `queue-row-${event.id}`"
      >
        <template #cell-event="{ row }">
          <span class="cell-event">
            <span class="cell-event__name">{{ eventName(row) }}</span>
            <!-- Narrow screens drop the date columns; the dates sit under the name instead. -->
            <span class="cell-event__sub">
              Event {{ formatEventDate(eventDate(row)) }} · Submitted {{ formatEventDate(row.created_at) }}
            </span>
          </span>
        </template>
        <template #cell-date="{ row }">{{ formatEventDate(eventDate(row)) }}</template>
        <template #cell-submitted="{ row }">{{ formatEventDate(row.created_at) }}</template>
        <template #cell-organiser="{ row }">
          <span :class="{ 'cell--empty': !eventOrganiser(row) }">{{ eventOrganiser(row) ?? "Unknown" }}</span>
        </template>
        <template #cell-status="{ row }">
          <span class="badge" :class="statusBadgeClass(row.status)">{{ statusLabel(row.status) }}</span>
        </template>
      </DataTable>
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
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: var(--spacing-24);
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
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-8);
  min-height: 44px;
  color: var(--color-purple-600);
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  text-decoration: none;
}

.back-link:hover {
  color: var(--color-purple-700);
}

.back-link:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

/* H2 */
.h2 {
  font-size: 2.25rem;
  font-weight: 700;
  line-height: 2.625rem;
  color: var(--color-grey-900);
  margin: 0;
}

/* Subheading */
.subheading {
  font-size: 1.125rem;
  font-weight: 400;
  line-height: 1.375rem;
  color: var(--color-grey-500);
  margin: var(--spacing-8) 0 0;
}

/* Body Default / Body Small / Small Text */
.body-default {
  font-size: 1rem;
  line-height: 1.25rem;
  margin: 0;
}

.body-small {
  font-size: 0.875rem;
  line-height: 1.125rem;
  margin: 0;
}

.small-text {
  font-size: 0.75rem;
  line-height: 1rem;
}

.muted {
  color: var(--color-grey-500);
}

.error-text {
  color: var(--color-error-600);
}

/* Table cells, same treatment as LeadEventTable */
.cell--empty {
  color: var(--color-grey-500);
}

.cell-event {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-2);
}

.cell-event__name {
  font-size: 1rem;
  font-weight: 700;
  line-height: 1.25rem;
  color: var(--color-grey-900);
}

.cell-event__sub {
  display: none;
}

@media (max-width: 640px) {
  .cell-event__sub {
    display: block;
    font-size: 0.875rem;
    line-height: 1.125rem;
    color: var(--color-grey-600);
  }
}

/* Small Text / Tag */
.badge {
  display: inline-block;
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  padding: var(--spacing-4) var(--spacing-8);
  border-radius: var(--radius-full);
}

.status-success {
  background: var(--color-success-200);
  color: var(--color-success-700);
}

.status-warning {
  background: var(--color-warning-200);
  color: var(--color-warning-900);
}

.status-error {
  background: var(--color-error-200);
  color: var(--color-error-600);
}

.status-info {
  background: var(--color-warning-100);
  color: var(--color-warning-800);
}
</style>
