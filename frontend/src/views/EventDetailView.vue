<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { AccessDeniedError, fetchEventById, type EventSummary } from "../lib/eventsApi";

interface SubmittedEventDetails {
  name?: string;
  purpose?: string;
  description?: string;
  proposedDate?: string;
  startTime?: string;
  endTime?: string;
  expectedAttendance?: number;
}

const route = useRoute();
const event = ref<EventSummary | null>(null);
const loading = ref(true);
const accessDenied = ref(false);
const errorMessage = ref<string | null>(null);

function asSubmittedDetails(value: EventSummary["submitted_details"]): SubmittedEventDetails {
  return value as SubmittedEventDetails;
}

onMounted(async () => {
  const id = route.params.id as string;
  try {
    event.value = await fetchEventById(id);
  } catch (err) {
    if (err instanceof AccessDeniedError) {
      accessDenied.value = true;
    } else {
      errorMessage.value = "We couldn't load this event. Please try again.";
    }
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <!--
    Column mapping — Event Detail
    Desktop (12-col): outer container col 1-12 (grid-desktop-margin 80px); content col 3-10, centred.
    Tablet (6-col): content col 1-6, full width, grid-tablet-margin 32px.
    Mobile (4-col): content col 1-4, full width, grid-mobile-margin 6px.
  -->
  <div class="page">
    <div class="content">
      <RouterLink to="/" class="back-link">Back to my events</RouterLink>

      <p v-if="loading" class="body-default muted">Loading…</p>

      <div v-else-if="accessDenied" class="denied-panel">
        <p class="card-title">Access denied</p>
        <p class="body-default muted">
          This event doesn't belong to you, or it doesn't exist. This attempt has been recorded.
        </p>
      </div>

      <p v-else-if="errorMessage" class="body-default error-text">{{ errorMessage }}</p>

      <div v-else-if="event" class="detail-panel">
        <span class="badge">{{ event.status }}</span>
        <p class="card-title">Event #{{ event.id }}</p>

        <dl class="detail-list">
          <div class="detail-row">
            <dt class="body-small muted">Coordinator</dt>
            <dd class="body-default">{{ event.coordinator_id ?? "Not yet assigned" }}</dd>
          </div>
          <div class="detail-row">
            <dt class="body-small muted">Review outcome</dt>
            <dd class="body-default">{{ event.review_outcome ?? "Pending" }}</dd>
          </div>
        </dl>
      </div>

      <div v-if="event" class="detail-panel event-details-panel">
        <p class="card-title">Event details</p>

        <dl class="detail-list">
          <div class="detail-row">
            <dt class="body-small muted">Event name</dt>
            <dd class="body-default">{{ asSubmittedDetails(event.submitted_details).name || "—" }}</dd>
          </div>
          <div class="detail-row">
            <dt class="body-small muted">Purpose</dt>
            <dd class="body-default">{{ asSubmittedDetails(event.submitted_details).purpose || "—" }}</dd>
          </div>
          <div class="detail-row">
            <dt class="body-small muted">Description</dt>
            <dd class="body-default">{{ asSubmittedDetails(event.submitted_details).description || "—" }}</dd>
          </div>
          <div class="detail-row">
            <dt class="body-small muted">Proposed date</dt>
            <dd class="body-default">{{ asSubmittedDetails(event.submitted_details).proposedDate || "—" }}</dd>
          </div>
          <div class="detail-row">
            <dt class="body-small muted">Time</dt>
            <dd class="body-default">
              {{ asSubmittedDetails(event.submitted_details).startTime || "—" }}
              –
              {{ asSubmittedDetails(event.submitted_details).endTime || "—" }}
            </dd>
          </div>
          <div class="detail-row">
            <dt class="body-small muted">Expected attendance</dt>
            <dd class="body-default">{{ asSubmittedDetails(event.submitted_details).expectedAttendance ?? "—" }}</dd>
          </div>
        </dl>
      </div>
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
  grid-column: 3 / 11;
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
  display: inline-block;
  font-size: 0.875rem;
  font-weight: 700;
  margin-bottom: var(--spacing-24);
}

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

.card-title {
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
  margin: var(--spacing-12) 0 var(--spacing-4);
}

.badge {
  display: inline-block;
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  padding: var(--spacing-4) var(--spacing-8);
  border-radius: var(--radius-xs);
  background: var(--color-purple-100);
  color: var(--color-purple-800);
}

.denied-panel,
.detail-panel {
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
  padding: var(--spacing-32);
}

.denied-panel .card-title {
  color: var(--color-error-600);
}

.event-details-panel {
  margin-top: var(--spacing-24);
}

.detail-list {
  margin: var(--spacing-24) 0 0;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-16);
}

.detail-row dt {
  margin-bottom: var(--spacing-4);
}
</style>
