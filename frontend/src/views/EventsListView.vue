<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { deleteDraft, fetchMyEvents, getCurrentUser, type EventSummary } from "../lib/eventsApi";
import { statusBadgeClass, statusLabel } from "../lib/eventStatus";

const events = ref<EventSummary[]>([]);
const loading = ref(true);
const errorMessage = ref<string | null>(null);
const isCoordinator = ref(false);

/**
 * E2-5.1 AC1: drafts and submitted requests are kept in one list but
 * distinctly separated via tabs, rather than mixed together. Coordinators
 * never see drafts at all (AC2, enforced server-side), so the tab bar is
 * organiser-only.
 */
type EventsTab = "drafts" | "submitted";

const tabs: { key: EventsTab; label: string }[] = [
  { key: "drafts", label: "Drafts" },
  { key: "submitted", label: "Submitted Requests" },
];

const activeTab = ref<EventsTab>("submitted");

const filteredEvents = computed(() => {
  if (activeTab.value === "drafts") return events.value.filter((event) => event.status === "Draft");
  return events.value.filter((event) => event.status !== "Draft");
});

function isRegistrationRequired(event: EventSummary): boolean {
  return event.submitted_details?.registrationNeeded === true;
}

function formatCreatedDate(value: string): string {
  const date = new Date(value);
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${date.getFullYear()}`;
}

function coordinatorInitial(event: EventSummary): string {
  return event.coordinator?.name?.charAt(0).toUpperCase() ?? "";
}

/** Organiser-only flag: a coordinator has asked a clarification question
 * on this event and it's still awaiting the Organiser's reply. */
function needsClarificationReply(event: EventSummary): boolean {
  return !isCoordinator.value && event.status === "Clarification Requested";
}

interface SubmittedEventDetails {
  name?: string;
}

function eventName(event: EventSummary): string {
  const details = event.submitted_details as SubmittedEventDetails;
  return details?.name || `Event #${event.id}`;
}

/** E2-4 AC2: opening a draft resumes editing it in the same form used to
 * create it, rather than the read-mostly event detail page. */
function eventLink(event: EventSummary) {
  if (event.status === "Draft") {
    return { name: "edit-draft", params: { id: event.id } };
  }
  return { name: "event-detail", params: { id: event.id } };
}

/**
 * E2-5.2 AC1: deleting a draft asks for confirmation first. The card
 * itself is a RouterLink, so the delete button stops the click from
 * navigating before opening the confirm dialog.
 */
const pendingDelete = ref<EventSummary | null>(null);
const deleting = ref(false);
const deleteError = ref<string | null>(null);

function requestDeleteDraft(event: EventSummary, domEvent: Event) {
  domEvent.preventDefault();
  domEvent.stopPropagation();
  deleteError.value = null;
  pendingDelete.value = event;
}

function cancelDeleteDraft() {
  if (deleting.value) return;
  pendingDelete.value = null;
  deleteError.value = null;
}

async function confirmDeleteDraft() {
  if (!pendingDelete.value) return;
  const target = pendingDelete.value;
  deleting.value = true;
  deleteError.value = null;
  try {
    await deleteDraft(target.id);
    events.value = events.value.filter((event) => event.id !== target.id);
    pendingDelete.value = null;
  } catch (err) {
    deleteError.value = err instanceof Error ? err.message : "Failed to delete draft";
  } finally {
    deleting.value = false;
  }
}

onMounted(async () => {
  try {
    const [eventsData, user] = await Promise.all([fetchMyEvents(), getCurrentUser()]);
    events.value = eventsData;
    isCoordinator.value = user.role === "coordinator";
  } catch (err) {
    errorMessage.value = "We couldn't load your events. Please try again.";
  } finally {
    loading.value = false;

    console.log(events);
  }
});

</script>

<template>
  <!--
    Column mapping — Events List
    Desktop (12-col): outer container col 1-12 (grid-desktop-margin 80px); content col 1-12, full width.
    Tablet (6-col): content col 1-6, full width, grid-tablet-margin 32px.
    Mobile (4-col): content col 1-4, full width, grid-mobile-margin 6px.
    Nested grid: card list uses a local grid matching the content area's column count (8 desktop / 6 tablet / 4 mobile).
  -->
  <div class="page">
    <div class="content">
      <div class="flex items-start justify-between gap-4">
        <div>
          <h1 class="h2">{{ isCoordinator ? "All events" : "My events" }}</h1>
          <p class="subheading">
            {{ isCoordinator ? "All events in the pipeline." : "Only events you created appear here." }}
          </p>
        </div>
        <RouterLink v-if="!isCoordinator" :to="{ name: 'new-event-request' }"
          class="shrink-0 rounded-xs bg-purple-600 px-6 py-3 text-sm font-bold text-base-white hover:bg-purple-700">
          New event request
        </RouterLink>
        <RouterLink v-else :to="{ name: 'venue-search' }"
          class="shrink-0 rounded-xs bg-purple-600 px-6 py-3 text-sm font-bold text-base-white hover:bg-purple-700">
          Find venues
        </RouterLink>
      </div>

      <div v-if="!isCoordinator && !loading && !errorMessage" class="tabs" role="tablist">
        <button v-for="tab in tabs" :key="tab.key" type="button" role="tab" class="tab"
          :class="{ 'tab--active': activeTab === tab.key }" :aria-selected="activeTab === tab.key"
          @click="activeTab = tab.key">
          {{ tab.label }}
        </button>
      </div>

      <p v-if="loading" class="body-default muted">Loading events…</p>
      <p v-else-if="errorMessage" class="body-default error-text">{{ errorMessage }}</p>
      <p v-else-if="events.length === 0" class="body-default muted">
        {{ isCoordinator ? "No events in the system yet." : "You haven't submitted any events yet." }}
      </p>
      <p v-else-if="filteredEvents.length === 0" class="body-default muted">
        {{ activeTab === "drafts" ? "You don't have any drafts." : "You don't have any submitted requests." }}
      </p>

      <div v-else class="card-grid">
        <RouterLink v-for="event in filteredEvents" :key="event.id" :to="eventLink(event)"
          class="event-card">
          <div class="card-header">
            <span class="badge badge-dot" :class="statusBadgeClass(event.status)">
              <span class="badge__dot" />
              {{ statusLabel(event.status) }}
            </span>
            <span v-if="isRegistrationRequired(event)" class="badge badge-registration">Registration Required</span>
          </div>
          <p class="card-title">{{ eventName(event) }}</p>
          <p class="body-small muted">Created {{ formatCreatedDate(event.created_at) }}</p>

          <hr class="card-divider" />

          <div class="card-footer">
            <div class="card-footer__coordinator">
              <span v-if="event.coordinator?.name" class="coordinator-avatar">{{ coordinatorInitial(event) }}</span>
              <span class="body-small  muted">Coordinator: {{ event.coordinator?.name ?? "Unassigned" }}</span>
            </div>
            <div class="card-footer__action">

              <span v-if="needsClarificationReply(event)" class="reply-action">Reply Needed</span>
              <button v-if="event.status === 'Draft'" type="button" class="delete-draft-action"
                @click="requestDeleteDraft(event, $event)">
                Delete
              </button>
              <svg class="card-chevron" :class="{ 'card-chevron--reply': needsClarificationReply(event) }"
                viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                <path fill-rule="evenodd"
                  d="M7.21 14.77a.75.75 0 0 1 .02-1.06L11.168 10 7.23 6.29a.75.75 0 1 1 1.04-1.08l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 0 1-1.06-.02Z"
                  clip-rule="evenodd" />
              </svg>

            </div>
          </div>
        </RouterLink>
      </div>
    </div>

    <div v-if="pendingDelete" class="modal-overlay" @click.self="cancelDeleteDraft">
      <div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="delete-draft-title">
        <p id="delete-draft-title" class="modal-title">Delete draft?</p>
        <p class="body-default muted">
          "{{ eventName(pendingDelete) }}" will be permanently removed. This cannot be undone.
        </p>
        <p v-if="deleteError" class="body-small error-text">{{ deleteError }}</p>
        <div class="modal-actions">
          <button type="button" class="modal-button modal-button--secondary" :disabled="deleting"
            @click="cancelDeleteDraft">
            Cancel
          </button>
          <button type="button" class="modal-button modal-button--danger" :disabled="deleting"
            @click="confirmDeleteDraft">
            {{ deleting ? "Deleting…" : "Delete" }}
          </button>
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
  grid-column: 1 / 13;
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

.h2 {
  font-size: 2.25rem;
  font-weight: 700;
  line-height: 2.625rem;
  color: var(--color-grey-900);
  margin: 0;
}

.subheading {
  font-size: 1.125rem;
  font-weight: 400;
  line-height: 1.375rem;
  color: var(--color-grey-500);
  margin: var(--spacing-8) 0 var(--spacing-32);
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

.tabs {
  display: flex;
  gap: var(--spacing-24);
  margin-bottom: var(--spacing-32);
  border-bottom: 1px solid var(--color-grey-100);
}

.tab {
  appearance: none;
  background: none;
  border: none;
  cursor: pointer;
  padding: var(--spacing-12) var(--spacing-4);
  margin-bottom: -1px;
  font-size: 1rem;
  font-weight: 600;
  color: var(--color-grey-500);
  border-bottom: 2px solid transparent;
}

.tab:hover {
  color: var(--color-grey-900);
}

.tab--active {
  color: var(--color-purple-600);
  border-bottom-color: var(--color-purple-600);
}

.card-grid {
  display: grid;
  grid-template-columns: repeat(8, 1fr);
  gap: var(--grid-desktop-gutter);
  align-content: start;
}

@media (max-width: 1024px) {
  .card-grid {
    grid-template-columns: repeat(6, 1fr);
  }
}

@media (max-width: 640px) {
  .card-grid {
    grid-template-columns: repeat(4, 1fr);
  }
}

.event-card {
  position: relative;
  grid-column: span 4;
  display: block;
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
  padding: var(--spacing-24);
  color: inherit;
}

.event-card:hover {
  background: var(--color-grey-75);
  border-color: var(--color-grey-200);
}

@media (max-width: 640px) {
  .event-card {
    grid-column: span 4;
  }
}

.card-title {
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
  margin: var(--spacing-12) 0 var(--spacing-4);
}

.card-header {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--spacing-8);
}

.badge {
  display: inline-block;
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  padding: var(--spacing-4) var(--spacing-8);
  border-radius: var(--radius-full);
}

.badge-dot {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-4);
}


.badge__dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  background: currentColor;
  flex-shrink: 0;
}

.badge-registration {
  background: var(--color-purple-100);
  color: var(--color-purple-700);
  white-space: nowrap;
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
  background: var(--color-warning-200);
  color: var(--color-warning-700);
}

.card-divider {
  border: none;
  border-top: 1px solid var(--color-grey-100);
  margin: 40px 0 16px 0;
}

.card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-8);
}

.card-footer__coordinator {
  display: flex;
  align-items: center;
  gap: var(--spacing-8);
  min-width: 0;
}

.coordinator-avatar {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--color-purple-200);
  color: var(--color-purple-600);
  font-size: 0.75rem;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}

.reply-action {
  flex-shrink: 0;
  color: var(--color-warning-600);
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  padding-bottom: 2px;
}

.card-footer__action {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: var(--spacing-4);
}

.card-chevron {
  width: 20px;
  height: 20px;
  color: var(--color-grey-400);
  flex-shrink: 0;
}

.card-chevron--reply {
  color: var(--color-warning-600);
}

.delete-draft-action {
  appearance: none;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--color-error-600);
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  padding: 0 0 2px;
}

.delete-draft-action:hover {
  text-decoration: underline;
}

.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 40%);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-24);
  z-index: 50;
}

.modal {
  background: var(--color-base-white);
  border-radius: var(--radius-lg);
  padding: var(--spacing-24);
  max-width: 400px;
  width: 100%;
}

.modal-title {
  font-size: 1.125rem;
  font-weight: 700;
  color: var(--color-grey-900);
  margin: 0 0 var(--spacing-8);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--spacing-8);
  margin-top: var(--spacing-24);
}

.modal-button {
  appearance: none;
  border: none;
  cursor: pointer;
  border-radius: var(--radius-xs);
  padding: var(--spacing-8) var(--spacing-16);
  font-size: 0.875rem;
  font-weight: 700;
}

.modal-button:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.modal-button--secondary {
  background: var(--color-grey-100);
  color: var(--color-grey-900);
}

.modal-button--secondary:hover:not(:disabled) {
  background: var(--color-grey-200);
}

.modal-button--danger {
  background: var(--color-error-600);
  color: var(--color-base-white);
}

.modal-button--danger:hover:not(:disabled) {
  filter: brightness(0.9);
}
</style>
