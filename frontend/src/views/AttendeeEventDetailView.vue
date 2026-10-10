<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import {
  AccessDeniedError,
  RegistrationRequestError,
  fetchAttendeeEventView,
  withdraw,
  type AttendeeEventView,
} from "../lib/registrationApi";
import { registrationBadgeClass } from "../lib/registrationStatus";
import { formatCardTimeRange, formatLongDate } from "../lib/attendeeEvents";

/**
 * One event as an attendee sees it: name, description, date, time, venues,
 * the organiser's accessibility note and the attendee's own registration
 * status. Only what registration-service returns is shown; if it refuses the
 * event (not registered and not open) nothing about the event is rendered.
 */
const route = useRoute();
const eventId = String(route.params.id);

const event = ref<AttendeeEventView | null>(null);
const loading = ref(true);
const accessDenied = ref(false);
const errorMessage = ref<string | null>(null);

const withdrawing = ref(false);
const withdrawError = ref<string | null>(null);

const paragraphs = computed(() =>
  (event.value?.description ?? "")
    .split(/\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean),
);

const canWithdraw = computed(() => event.value?.registrationStatus === "Registered");

async function handleWithdraw() {
  if (!event.value || withdrawing.value) return;
  withdrawing.value = true;
  withdrawError.value = null;
  try {
    await withdraw(eventId);
    event.value = { ...event.value, registrationStatus: "Withdrawn" };
  } catch (err) {
    if (err instanceof RegistrationRequestError && err.code === "already_withdrawn") {
      // Withdrawn elsewhere (another tab): the page was just out of date.
      event.value = { ...event.value, registrationStatus: "Withdrawn" };
    } else {
      withdrawError.value = err instanceof Error ? err.message : "Failed to withdraw";
    }
  } finally {
    withdrawing.value = false;
  }
}

onMounted(async () => {
  try {
    event.value = await fetchAttendeeEventView(eventId);
  } catch (err) {
    if (err instanceof AccessDeniedError) accessDenied.value = true;
    else errorMessage.value = "We couldn't load this event. Please try again.";
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <!--
    Column mapping — Attendee event details
    Desktop (12-col): outer container col 1-12 (grid-desktop-margin 80px); back link, title row and "When and where" card col 1-12; description col 1-8.
    Tablet (6-col): everything col 1-6 full width, grid-tablet-margin 32px; description col 1-6.
    Mobile (4-col): everything col 1-4 full width, grid-mobile-margin 6px; title row stacks, Withdraw button full width.
  -->
  <div class="page">
    <div class="back">
      <RouterLink :to="{ name: 'attendee-events' }" class="back-link">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15.75 19.5 8.25 12l7.5-7.5" /></svg>
        Back to my events
      </RouterLink>
    </div>

    <p v-if="loading" class="full body-default muted">Loading event…</p>

    <section v-else-if="accessDenied" class="full denied" role="alert">
      <h1 class="h3">You don't have access to this event</h1>
      <p class="body-default muted">It isn't open for registration and you aren't registered for it.</p>
    </section>

    <p v-else-if="errorMessage || !event" class="full body-default error-text" role="alert">
      {{ errorMessage ?? "We couldn't load this event. Please try again." }}
    </p>

    <template v-else>
      <div class="title-row">
        <div class="title-block">
          <span v-if="event.registrationStatus" class="badge" :class="registrationBadgeClass(event.registrationStatus)">
            {{ event.registrationStatus }}
          </span>
          <h1 class="h2">{{ event.name || `Event #${event.id}` }}</h1>
        </div>

        <div v-if="canWithdraw" class="actions">
          <button type="button" class="btn-withdraw" :disabled="withdrawing" @click="handleWithdraw">
            {{ withdrawing ? "Withdrawing…" : "Withdraw registration" }}
          </button>
        </div>
      </div>
      <p v-if="withdrawError" class="full body-small error-text" role="alert">{{ withdrawError }}</p>

      <div v-if="paragraphs.length > 0" class="description">
        <p v-for="(paragraph, index) in paragraphs" :key="index" class="body-default">{{ paragraph }}</p>
      </div>

      <section class="details" aria-label="When and where">
        <h2 class="h4">When and where</h2>

        <div class="detail-row">
          <svg class="detail-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5" /></svg>
          <div class="detail-text">
            <span class="detail-label">Date</span>
            <span class="detail-value">{{ formatLongDate(event.proposedDate) }}</span>
          </div>
        </div>
        <hr class="divider" />

        <div class="detail-row">
          <svg class="detail-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>
          <div class="detail-text">
            <span class="detail-label">Time</span>
            <span class="detail-value">{{ formatCardTimeRange(event.startTime, event.endTime) }}</span>
          </div>
        </div>
        <hr class="divider" />

        <div class="detail-row">
          <svg class="detail-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" /><path d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z" /></svg>
          <div class="detail-text">
            <span class="detail-label">{{ event.venues.length > 1 ? "Venues" : "Venue" }}</span>
            <span v-if="event.venues.length === 0" class="detail-value">Venue to be confirmed</span>
            <span v-for="venue in event.venues" :key="venue" class="detail-value">{{ venue }}</span>
          </div>
        </div>

        <template v-if="event.accessibility">
          <hr class="divider" />
          <div class="detail-row">
            <svg class="detail-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="4.5" r="1.75" /><path d="M5.5 8.5 12 10l6.5-1.5M12 10v4.5m0 0-3 6m3-6 3 6" /></svg>
            <div class="detail-text">
              <span class="detail-label">Accessibility</span>
              <span class="detail-value">{{ event.accessibility }}</span>
            </div>
          </div>
        </template>
      </section>
    </template>
  </div>
</template>

<style scoped>
.page {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: var(--spacing-24) var(--grid-desktop-gutter);
  padding: var(--spacing-40) var(--grid-desktop-margin) var(--spacing-80);
  align-content: start;
  min-height: 100vh;
}

.back,
.full,
.title-row,
.details {
  grid-column: 1 / 13;
}

.description {
  grid-column: 1 / 9;
  max-width: 45rem;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-16);
}

@media (max-width: 1024px) {
  .page {
    grid-template-columns: repeat(6, 1fr);
    gap: var(--spacing-24) var(--grid-tablet-gutter);
    padding: var(--spacing-40) var(--grid-tablet-margin) var(--spacing-80);
  }
  .back,
  .full,
  .title-row,
  .details,
  .description {
    grid-column: 1 / 7;
  }
}

@media (max-width: 640px) {
  .page {
    grid-template-columns: repeat(4, 1fr);
    gap: var(--spacing-24) var(--grid-mobile-gutter);
    padding: var(--spacing-24) var(--grid-mobile-margin) var(--spacing-48);
  }
  .back,
  .full,
  .title-row,
  .details,
  .description {
    grid-column: 1 / 5;
  }
  .title-row {
    flex-direction: column;
    align-items: stretch;
  }
  .btn-withdraw {
    width: 100%;
  }
}

.back-link {
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

.title-row {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--spacing-32);
}

.title-block {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--spacing-16);
}

.h2 {
  margin: 0;
  font-size: 2.25rem;
  font-weight: 700;
  line-height: 2.625rem;
  color: var(--color-grey-900);
}

.h3 {
  margin: 0 0 var(--spacing-8);
  font-size: 2rem;
  font-weight: 700;
  line-height: 2.5rem;
  color: var(--color-grey-900);
}

.h4 {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
}

.body-default {
  margin: 0;
  font-size: 1rem;
  line-height: 1.25rem;
  color: var(--color-grey-700);
}

.body-small {
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.125rem;
}

.muted {
  color: var(--color-grey-500);
}

.error-text {
  color: var(--color-error-600);
}

.denied {
  padding: var(--spacing-24);
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
}

/* Status badge — no leading dot. */
.badge {
  display: inline-flex;
  align-items: center;
  height: var(--spacing-24);
  padding: 0 var(--spacing-12);
  border-radius: var(--radius-full);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
}

.status-success {
  background: var(--color-success-200);
  color: var(--color-success-700);
}

.status-warning {
  background: var(--color-warning-100);
  color: var(--color-warning-900);
}

/* Withdraw: outline in Red Error 300, label in Red Error 600; hover tints, focus rings. */
.btn-withdraw {
  flex: none;
  min-height: 44px;
  padding: 0 var(--spacing-24);
  border: 1px solid var(--color-error-300);
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--color-error-600);
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  cursor: pointer;
}

.btn-withdraw:hover:not(:disabled) {
  background: var(--color-error-200);
}

.btn-withdraw:focus-visible {
  border-color: var(--color-error-600);
  outline: 2px solid var(--color-error-200);
  outline-offset: 2px;
}

.btn-withdraw:disabled {
  border-color: var(--color-grey-100);
  background: var(--color-grey-25);
  color: var(--color-grey-300);
  cursor: not-allowed;
}

.details {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-16);
  padding: var(--spacing-24);
  box-sizing: border-box;
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
}

.detail-row {
  display: flex;
  gap: var(--spacing-12);
}

.detail-icon {
  flex: none;
  margin-top: 1px;
  color: var(--color-grey-500);
}

.detail-text {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-4);
}

.detail-label {
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  color: var(--color-grey-600);
}

.detail-value {
  font-size: 1rem;
  line-height: 1.25rem;
  color: var(--color-grey-700);
}

.divider {
  margin: 0;
  border: none;
  border-top: 1px solid var(--color-grey-100);
}
</style>
