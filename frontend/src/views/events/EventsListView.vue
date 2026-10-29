<script setup lang="ts">
import UnderlineTabs from "../../components/ui/UnderlineTabs.vue";
import AppModal from "../../components/ui/AppModal.vue";
import AppButton from "../../components/ui/AppButton.vue";
import EventCard, { type CardFact } from "../../components/ui/EventCard.vue";
import PaginationBar from "../../components/ui/PaginationBar.vue";
import { computed, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { deleteDraft, fetchMyEvents, getCurrentUser, type EventSummary } from "../../lib/eventsApi";
import { statusBadgeClass, statusLabel } from "../../lib/eventStatus";
import { eventThumbnail, formatCardDate, formatCardTimeRange } from "../../lib/attendeeEvents";

const route = useRoute();
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
  { key: "submitted", label: "Submitted Requests" },
  { key: "drafts", label: "Drafts" },
];

// E2-4: after saving a draft, the form redirects here with ?tab=drafts so
// the Drafts tab is what the organiser lands on, instead of Submitted Requests.
const activeTab = ref<EventsTab>(route.query.tab === "drafts" ? "drafts" : "submitted");

const filteredEvents = computed(() => {
  if (activeTab.value === "drafts") return events.value.filter((event) => event.status === "Draft");
  return events.value.filter((event) => event.status !== "Draft");
});

// Client-side paging: 12 cards a page divides evenly into the grid's 3, 2 and 1 columns.
const PAGE_SIZE = 12;
const page = ref(1);
const currentPage = computed(() => Math.min(page.value, Math.max(1, Math.ceil(filteredEvents.value.length / PAGE_SIZE))));
const pagedEvents = computed(() =>
  filteredEvents.value.slice((currentPage.value - 1) * PAGE_SIZE, currentPage.value * PAGE_SIZE),
);
watch(activeTab, () => {
  page.value = 1;
});

const cardsRoot = ref<HTMLElement | null>(null);
function changePage(next: number) {
  page.value = next;
  cardsRoot.value?.scrollIntoView?.({ block: "start" });
}

function isRegistrationRequired(event: EventSummary): boolean {
  return event.submitted_details?.registrationNeeded === true;
}

function formatCreatedDate(value: string): string {
  const date = new Date(value);
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${date.getFullYear()}`;
}

/** Organiser-only flag: a coordinator has asked a clarification question
 * on this event and it's still awaiting the Organiser's reply. */
function needsClarificationReply(event: EventSummary): boolean {
  return !isCoordinator.value && event.status === "Clarification Requested";
}

interface SubmittedEventDetails {
  name?: string;
  proposedDate?: string;
  startTime?: string;
  endTime?: string;
}

function eventName(event: EventSummary): string {
  const details = event.submitted_details as SubmittedEventDetails;
  return details?.name || `Event #${event.id}`;
}

function eventDateLabel(event: EventSummary): string {
  const details = event.submitted_details as SubmittedEventDetails;
  return formatCardDate(details?.proposedDate);
}

/** Date and time each get their own line on the card. */
function cardFacts(event: EventSummary): CardFact[] {
  return [
    { icon: "calendar", text: eventDateLabel(event) },
    { icon: "clock", text: eventTimeLabel(event) },
  ];
}

function eventTimeLabel(event: EventSummary): string {
  const details = event.submitted_details as SubmittedEventDetails;
  return formatCardTimeRange(details?.startTime, details?.endTime);
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
  } catch {
    errorMessage.value = "We couldn't load your events. Please try again.";
  } finally {
    loading.value = false;
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
        <AppButton v-if="!isCoordinator" variant="primary" :to="{ name: 'new-event-request' }" class="shrink-0">
          New event request
        </AppButton>
        <AppButton v-else variant="primary" :to="{ name: 'venue-search' }" class="shrink-0">
          Find venues
        </AppButton>
      </div>

      <UnderlineTabs v-if="!isCoordinator && !loading && !errorMessage" v-model="activeTab" class="tabs" :tabs="tabs"
        aria-label="My events" />

      <p v-if="loading" class="body-default muted">Loading events…</p>
      <p v-else-if="errorMessage" class="body-default error-text">{{ errorMessage }}</p>
      <p v-else-if="events.length === 0" class="body-default muted">
        {{ isCoordinator ? "No events in the system yet." : "You haven't submitted any events yet." }}
      </p>
      <p v-else-if="filteredEvents.length === 0" class="body-default muted">
        {{ activeTab === "drafts" ? "You don't have any drafts." : "You don't have any submitted requests." }}
      </p>

      <div v-else ref="cardsRoot">
      <div class="card-grid">
        <div v-for="event in pagedEvents" :key="event.id" class="card-cell">
          <EventCard
            :to="eventLink(event)"
            :thumbnail="eventThumbnail(event.id)"
            :title="eventName(event)"
            :status-label="statusLabel(event.status)"
            :status-class="statusBadgeClass(event.status)"
            :extra-badges="isRegistrationRequired(event) ? ['Registration Required'] : []"
            :facts="cardFacts(event)"
            person-label="Coordinator"
            :person-name="event.coordinator?.name"
            person-empty="Unassigned"
            :meta="`Submitted: ${formatCreatedDate(event.created_at)}`"
          >
            <template v-if="needsClarificationReply(event) || event.status === 'Draft'" #footer-actions>
              <span v-if="needsClarificationReply(event)" class="reply-action">Reply Needed</span>
              <AppButton variant="danger" size="sm" class="delete-draft-action" v-if="event.status === 'Draft'" 
        @click="requestDeleteDraft(event, $event)">
                Delete
              </AppButton>
            </template>
          </EventCard>
        </div>
      </div>

      <PaginationBar :page="currentPage" :page-size="PAGE_SIZE" :total="filteredEvents.length" noun="events"
        @update:page="changePage" />
      </div>
    </div>

    <AppModal v-if="pendingDelete" role="alertdialog" :dismissible="!deleting" @close="cancelDeleteDraft">
      <template #title>Delete draft?</template>
        <p class="body-default muted">
          "{{ eventName(pendingDelete) }}" will be permanently removed. This cannot be undone.
        </p>
        <p v-if="deleteError" class="body-small error-text">{{ deleteError }}</p>
      <template #actions>
          <AppButton variant="outline" type="button" :disabled="deleting"
            @click="cancelDeleteDraft">
            Cancel
          </AppButton>
          <AppButton variant="danger-solid" type="button" :disabled="deleting"
            @click="confirmDeleteDraft">
            {{ deleting ? "Deleting…" : "Delete" }}
          </AppButton>
      </template>
    </AppModal>
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
  margin: 0;
}

.subheading {
  color: var(--color-grey-600);
  margin: var(--spacing-8) 0 var(--spacing-32);
}

.muted {
  color: var(--color-grey-600);
}

.error-text {
  color: var(--color-error-600);
}

.tabs {
  margin-bottom: var(--spacing-32);
}

.card-grid {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
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

/* Each card sits in a cell that carries the 12/6/4 column spans. */
.card-cell {
  grid-column: span 4;
}

@media (max-width: 1024px) {
  /* 6 columns / span 3 = 2 per row, matching desktop's 12/4 split. */
  .card-cell {
    grid-column: span 3;
  }
}

@media (max-width: 640px) {
  .card-cell {
    grid-column: span 4;
  }
}

@media (max-width: 1024px) {
  /* 6 columns / span 3 = 2 per row, matching desktop's 8/4 split instead
     of the mismatched span 4 leaving a gap on every row at this width. */
  
}

.reply-action {
  flex-shrink: 0;
  color: var(--color-warning-600);
  font-size: 14px;
  line-height: 1.125rem;
  font-weight: 700;
  white-space: nowrap;
  padding-bottom: var(--spacing-2);
}

</style>
