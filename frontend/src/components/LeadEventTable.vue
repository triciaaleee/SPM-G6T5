<script setup lang="ts">
import type { EventSummary } from "../lib/eventsApi";
import { statusBadgeClass, statusLabel } from "../lib/eventStatus";
import { eventDateLabel, eventName, eventOrganiser, eventTimeLabel, eventVenue, eventWhen } from "../lib/leadAssignments";
import DataTable from "./ui/DataTable.vue";

/**
 * A coordinator's active events as a table: event, date, venue and status.
 * Each row opens the event, where the Lead reassigns it (E2-12).
 */
defineProps<{
  events: EventSummary[];
  /** Which who-acts-next group a row sits under, with that group's full count; none for a flat list. */
  groupOf?: (event: EventSummary) => { key: string; label: string; count: number } | null;
}>();

const COLUMNS = [
  { key: "event", label: "Event" },
  { key: "date", label: "Date", hideOnNarrow: true },
  { key: "time", label: "Time", hideOnNarrow: true },
  { key: "venue", label: "Venue", hideOnNarrow: true },
  { key: "organiser", label: "Organiser", hideOnNarrow: true },
  { key: "status", label: "Status" },
];

// The first five columns share the full width in these proportions (minmax(0, …) lets them shrink and wrap
// rather than overflow). Status is a fixed width — not `auto` — so every row's columns line up exactly.
const COLUMN_WIDTHS = "minmax(0, 18fr) minmax(0, 6fr) minmax(0, 9.5fr) minmax(0, 11fr) minmax(0, 10fr) 10rem";
</script>

<template>
  <DataTable
    :columns="COLUMNS"
    :column-widths="COLUMN_WIDTHS"
    column-gap="var(--spacing-80)"
    :rows="events"
    :row-key="(event) => event.id"
    :row-to="(event) => ({ name: 'event-detail', params: { id: event.id } })"
    :row-group="groupOf"
  >
    <template #cell-event="{ row }">
      <span class="cell-event">
        <span class="cell-event__name">{{ eventName(row) }}</span>
        <!-- Narrow screens drop the Date and Venue columns; the same info sits under the name. -->
        <span class="cell-event__sub">{{ eventWhen(row) }}</span>
      </span>
    </template>
    <template #cell-date="{ row }">{{ eventDateLabel(row) ?? "—" }}</template>
    <template #cell-time="{ row }">{{ eventTimeLabel(row) ?? "—" }}</template>
    <template #cell-venue="{ row }">
      <span :class="{ 'cell--empty': !eventVenue(row) }">{{ eventVenue(row) ?? "Not set" }}</span>
    </template>
    <template #cell-organiser="{ row }">
      <span :class="{ 'cell--empty': !eventOrganiser(row) }">{{ eventOrganiser(row) ?? "Unknown" }}</span>
    </template>
    <template #cell-status="{ row }">
      <span class="badge" :class="statusBadgeClass(row.status)">{{ statusLabel(row.status) }}</span>
    </template>
    <template #group-header="{ group }">
      <div class="group-header" :class="`group-header--${group.key}`">
        <span class="group-header__title">{{ group.label }}</span>
        <span class="group-header__badge">{{ group.count }}</span>
      </div>
    </template>
  </DataTable>
</template>

<style scoped>
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

/* Who-acts-next subheaders, inline in the table; same treatment as the Coordinator dashboard. */
.group-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-12);
  padding: var(--spacing-12) var(--spacing-20);
}

.group-header__title {
  margin: 0;
  font-size: 1rem;
  font-weight: 700;
  color: var(--color-grey-900);
}

.group-header__badge {
  padding: 2px var(--spacing-8);
  border-radius: var(--radius-full);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
}

.group-header--action {
  background: var(--color-warning-100);
}
.group-header--action .group-header__badge {
  background: var(--color-warning-900);
  color: var(--color-base-white);
}

.group-header--wait {
  background: var(--color-grey-50);
}
.group-header--wait .group-header__badge {
  background: var(--color-grey-700);
  color: var(--color-base-white);
}

.group-header--ontrack {
  background: var(--color-success-100);
}
.group-header--ontrack .group-header__badge {
  background: var(--color-success-700);
  color: var(--color-base-white);
}

@media (max-width: 640px) {
  .cell-event__sub {
    display: block;
    font-size: 0.875rem;
    line-height: 1.125rem;
    color: var(--color-grey-600);
  }
}
</style>
