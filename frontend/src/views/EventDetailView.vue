<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { AccessDeniedError, fetchEventById, type EventSummary } from "../lib/eventsApi";
import { supabase } from "../lib/supabase";

const NOT_PROVIDED = "Not provided";

const route = useRoute();
const event = ref<EventSummary | null>(null);
const loading = ref(true);
const accessDenied = ref(false);
const errorMessage = ref<string | null>(null);
const currentUserId = ref<string | null>(null);

const isAssignedCoordinator = computed(
  () => !!event.value?.coordinator_id && event.value.coordinator_id === currentUserId.value
);

function detailString(key: string): string {
  const value = event.value?.submitted_details?.[key];
  return value === undefined || value === null || value === "" ? NOT_PROVIDED : String(value);
}

function formatDate(value: string | undefined | null): string {
  if (!value) return NOT_PROVIDED;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" });
}

const eventTitle = computed(() => detailString("name") !== NOT_PROVIDED ? detailString("name") : `Event ${event.value?.id.slice(0, 8) ?? ""}`);
const purpose = computed(() => detailString("purpose"));
const description = computed(() => detailString("description"));
const expectedAttendance = computed(() => detailString("expectedAttendance"));
const proposedDate = computed(() => formatDate(event.value?.submitted_details?.proposedDate as string | undefined));
const startTime = computed(() => detailString("startTime"));
const endTime = computed(() => detailString("endTime"));
const submittedDate = computed(() => formatDate(event.value?.created_at));
const eventRequestor = computed(() => NOT_PROVIDED);
const venueRequirements = computed(() => NOT_PROVIDED);
const equipmentRequirements = computed(() => NOT_PROVIDED);
const accessibilityNeeds = computed(() => NOT_PROVIDED);
const registrationNeeds = computed(() => NOT_PROVIDED);
const coordinator = computed(() => event.value?.coordinator_id ?? "Not yet assigned");

function statusClass(status: string | undefined): string {
  if (status === "approved") return "status-success";
  if (status === "rejected") return "status-error";
  return "status-warning";
}

function statusLabel(status: string | undefined): string {
  if (status === "approved") return "Approved";
  if (status === "rejected") return "Rejected";
  return "Pending review";
}

onMounted(async () => {
  const id = route.params.id as string;
  try {
    const { data } = await supabase.auth.getSession();
    currentUserId.value = data.session?.user?.id ?? null;
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
      <RouterLink :to="{ name: 'events-list' }" class="back-link">&larr; Event requests</RouterLink>

      <p v-if="loading" class="body-default muted">Loading…</p>

      <div v-else-if="accessDenied" class="denied-panel">
        <p class="card-title">Access denied</p>
        <p class="body-default muted">
          This event doesn't belong to you, or it doesn't exist. This attempt has been recorded.
        </p>
      </div>

      <p v-else-if="errorMessage" class="body-default error-text">{{ errorMessage }}</p>

      <div v-else-if="event">
        <span class="badge" :class="statusClass(event.status)">{{ statusLabel(event.status) }}</span>
        <h1 class="h2">{{ eventTitle }}</h1>
        <p class="body-default muted event-id">Event {{ event.id.slice(0, 8) }}</p>

        <div class="detail-grid">
          <div class="detail-grid-col">
          <div class="details-card">
            <h2 class="section-title">Event Request details</h2>

            <div class="field-row field-row-3">
              <div class="field">
                <p class="body-small muted mb-1">Event Requestor</p>
                <p class="body-default field-value">{{ eventRequestor }}</p>
              </div>
              <div class="field">
                <p class="body-small muted mb-1">Submitted date (optional)</p>
                <p class="body-default field-value">{{ submittedDate }}</p>
              </div>
              <div class="field">
                <p class="body-small muted mb-1">Status</p>
                <span class="badge" :class="statusClass(event.status)">{{ statusLabel(event.status) }}</span>
              </div>
            </div>

            <hr class="divider" />

            <div class="field-row field-row-3">
              <div class="field">
                <p class="body-small muted mb-1">Title</p>
                <p class="body-default field-value">{{ eventTitle }}</p>
              </div>
              <div class="field">
                <p class="body-small muted mb-1">Purpose</p>
                <span class="badge badge-neutral">{{ purpose }}</span>
              </div>
              <div class="field">
                <p class="body-small muted mb-1">Expected attendance</p>
                <p class="body-default field-value">{{ expectedAttendance }} people</p>
              </div>
            </div>

            <div class="field-row field-row-3">
              <div class="field">
                <p class="body-small muted mb-1">Proposed date</p>
                <p class="body-default field-value">{{ proposedDate }}</p>
              </div>
              <div class="field">
                <p class="body-small muted mb-1">Start Time</p>
                <p class="body-default field-value">{{ startTime }}</p>
              </div>
              <div class="field">
                <p class="body-small muted mb-1">End Time</p>
                <p class="body-default field-value">{{ endTime }}</p>
              </div>
            </div>

            <div class="field">
              <p class="body-small muted mb-1">Event Description</p>
              <p class="body-default field-value">{{ description }}</p>
            </div>
          </div>

          <div class="details-card">
            <h2 class="section-title">Event Requirements</h2>
            <div class="field-row">
              <div class="field">
                <p class="body-small muted mb-1">Venue Requirements</p>
                <p class="body-default field-value">{{ venueRequirements }}</p>
              </div>
              <div class="field">
                <p class="body-small muted mb-1">Equipment Requirements</p>
                <p class="body-default field-value">{{ equipmentRequirements }}</p>
              </div>
            </div>

            <div class="field-row">
              <div class="field">
                <p class="body-small muted mb-1">Accessibility Needs</p>
                <p class="body-default field-value">{{ accessibilityNeeds }}</p>
              </div>
              <div class="field">
                <p class="body-small muted mb-1">Registration Needs (Where relevant)</p>
                <p class="body-default field-value">{{ registrationNeeds }}</p>
              </div>
            </div>

          </div>
          </div>

          <div class="detail-grid-col">
          <div class="coordinator-card">
            <h2 class="section-title">Coordinator</h2>
            <p class="body-default field-value">{{ coordinator }}</p>
          </div>
          <div v-if="isAssignedCoordinator" class="coordinator-card">
            <h2 class="section-title">Coordinator Actions</h2>
            <div class="action-buttons">
              <button type="button" class="btn btn-approve">Approve</button>
              <button type="button" class="btn btn-reject">Reject</button>
            </div>
          </div>
          </div>

        </div>
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

.mb-1 {
  margin-bottom: var(--spacing-4);
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

.h2 {
  font-size: 2.25rem;
  font-weight: 700;
  line-height: 2.625rem;
  color: var(--color-grey-900);
  margin: var(--spacing-12) 0 var(--spacing-4);
}

.event-id {
  margin-bottom: var(--spacing-24);
}

.badge {
  display: inline-block;
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  padding: var(--spacing-4) var(--spacing-8);
  border-radius: var(--radius-xs);
}

.badge-neutral {
  background: var(--color-purple-100);
  color: var(--color-purple-800);
}

.status-success {
  background: var(--color-success-200);
  color: var(--color-success-600);
}

.status-warning {
  background: #FEF5E7;
  color: var(--color-warning-600);
}

.status-error {
  background: var(--color-error-200);
  color: var(--color-error-600);
}

.denied-panel {
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
  padding: var(--spacing-32);
}

.denied-panel .card-title {
  color: var(--color-error-600);
}

.detail-grid {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 24px;
  align-items: start;
}

.detail-grid-col {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

@media (max-width: 1024px) {
  .detail-grid {
    grid-template-columns: 1fr;
  }
}

.details-card,
.coordinator-card {
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
  margin: 0 0 var(--spacing-24);
}

.field-row {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--spacing-24);
  margin-bottom: var(--spacing-24);
}

.field-row-3 {
  grid-template-columns: repeat(3, 1fr);
}

@media (max-width: 640px) {

  .field-row,
  .field-row-3 {
    grid-template-columns: 1fr;
  }
}

.field {
  min-width: 0;
}

.field-value {
  color: var(--color-grey-900);
  font-weight: 00;
}

.divider {
  border: none;
  border-top: 1px solid var(--color-grey-100);
  margin: 0 0 var(--spacing-24);
}

.action-buttons {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-12);
}

.btn {
  width: 100%;
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  padding: var(--spacing-12) var(--spacing-16);
  border-radius: var(--radius-sm);
  cursor: pointer;
}

.btn-approve {
  background: var(--color-purple-600);
  border: none;
  color: var(--color-base-white);
}

.btn-approve:hover {
  background: var(--color-purple-700);
}

.btn-reject {
  background: transparent;
  border: 1px solid var(--color-purple-300);
  color: var(--color-purple-600);
}

.btn-reject:hover {
  background: var(--color-purple-100);
}
</style>
