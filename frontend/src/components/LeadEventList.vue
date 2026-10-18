<script setup lang="ts">
import type { EventSummary } from "../lib/eventsApi";
import { statusBadgeClass, statusLabel } from "../lib/eventStatus";
import { eventDateLabel, eventName, eventVenue } from "../lib/leadAssignments";

/**
 * A coordinator's active events as a plain list: the event's name over a grey
 * line with its date and venue, and the status badge at the right. Each row is
 * a link that opens the event, where the Lead reassigns it (E2-12).
 */
defineProps<{ events: EventSummary[] }>();
</script>

<template>
  <ul class="rows">
    <li v-for="event in events" :key="event.id">
      <RouterLink :to="{ name: 'event-detail', params: { id: event.id } }" class="row row--link">
        <span class="row__text">
          <span class="cell-event__name">{{ eventName(event) }}</span>
          <span class="row__details">
            {{ eventDateLabel(event) ?? "—" }}<span aria-hidden="true"> · </span>
            <span :class="{ 'row__details--empty': !eventVenue(event) }">{{ eventVenue(event) ?? "Not set" }}</span>
          </span>
        </span>
        <span class="badge" :class="statusBadgeClass(event.status)">{{ statusLabel(event.status) }}</span>
      </RouterLink>
    </li>
  </ul>
</template>

<style scoped>
/* No box and no columns: rows separated by thin dividers. */
.rows {
  list-style: none;
  margin: 0;
  padding: 0;
}

.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-16);
  padding: var(--spacing-12) var(--spacing-8);
  border-bottom: 1px solid var(--color-grey-100);
  border-radius: var(--radius-xs);
  color: inherit;
  text-decoration: none;
}

li:last-child > .row {
  border-bottom: none;
}

.row:hover {
  background: var(--color-grey-50);
}

.row:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: -2px;
}

.row__text {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-2);
}

.cell-event__name {
  font-size: 1rem;
  font-weight: 700;
  line-height: 1.25rem;
  color: var(--color-grey-900);
  overflow-wrap: anywhere;
}

.row__details {
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-600);
  overflow-wrap: anywhere;
}

.row__details--empty {
  color: var(--color-grey-500);
}

/* Small Text / Tag */
.badge {
  flex: none;
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
  background: var(--color-warning-100);
  color: var(--color-warning-900);
}

.status-error {
  background: var(--color-error-200);
  color: var(--color-error-600);
}

/* "Awaiting Clarification": the Secondary Blue badge pair, as on the event cards. */
.status-info {
  background: var(--color-blue-200);
  color: var(--color-blue-800);
}
</style>
