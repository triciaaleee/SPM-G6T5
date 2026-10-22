<script setup lang="ts">
import AppButton from "../components/ui/AppButton.vue";
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  AccessDeniedError,
  RegistrationRequestError,
  fetchAttendeeEventView,
  register,
  withdraw,
  type AttendeeEventView,
} from "../lib/registrationApi";
import { registrationBadgeClass } from "../lib/registrationStatus";
import { eventThumbnail, formatCardTimeRange, formatLongDate, slotsLabel } from "../lib/attendeeEvents";
import { getStoredUser, landingRouteForRole } from "../lib/auth";
import { requestNotificationsRefresh } from "../lib/notificationsApi";

/**
 * One event as an attendee sees it: name, description, date, time, venues,
 * the organiser's accessibility note and the attendee's own registration
 * status. Only what registration-service returns is shown; if it refuses the
 * event (not registered and not open) nothing about the event is rendered.
 */
const route = useRoute();
const router = useRouter();
const eventId = String(route.params.id);

/** Returns to wherever the user came from (Discover, My events, etc.)
 * rather than always landing on "My events". `history.state.back` is only
 * set once there's actual in-app navigation history to go back to — a
 * bookmarked/direct link here has none — so that case falls back to the
 * attendee's home page instead of leaving the back button a dead end. */
function goBack(): void {
  if (window.history.state?.back) {
    router.back();
  } else {
    router.push({ name: landingRouteForRole(getStoredUser()?.role) });
  }
}

const event = ref<AttendeeEventView | null>(null);
const loading = ref(true);
const accessDenied = ref(false);
const errorMessage = ref<string | null>(null);

const withdrawing = ref(false);
const withdrawError = ref<string | null>(null);

const registering = ref(false);
const registerError = ref<string | null>(null);
// Shown once a Register click succeeds; the bell notification is the lasting copy.
const registerSuccess = ref(false);

const paragraphs = computed(() =>
  (event.value?.description ?? "")
    .split(/\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean),
);

// E6-4: a place can be given up any time before the event starts — even
// inside the last 5 days, when registration itself has closed.
const canWithdraw = computed(
  () => event.value?.registrationStatus === "Registered" && event.value.hasStarted !== true,
);
const hasStartedWithPlace = computed(
  () => event.value?.registrationStatus === "Registered" && event.value.hasStarted === true,
);

// Withdrawing gives the place up at once, so it is confirmed first.
const confirmingWithdraw = ref(false);
const withdrawSuccess = ref(false);

// Registering lives here, not on the Discover cards. A withdrawn attendee may register again.
const canRegister = computed(
  () => event.value?.open === true && event.value.registrationStatus !== "Registered",
);

// No places left: the Register slot shows a disabled "Event full" instead.
const isFull = computed(() => event.value?.slotsLeft === 0);

/** Keeps the shown places in step with this attendee taking or giving one up. */
function adjustSlots(by: number): number | null {
  const slots = event.value?.slotsLeft;
  return slots == null ? null : Math.max(0, slots + by);
}

async function handleRegister() {
  if (!event.value || registering.value) return;
  registering.value = true;
  registerError.value = null;
  registerSuccess.value = false;
  withdrawSuccess.value = false;
  try {
    await register(eventId);
    event.value = { ...event.value, registrationStatus: "Registered", slotsLeft: adjustSlots(-1) };
    registerSuccess.value = true;
    requestNotificationsRefresh();
  } catch (err) {
    if (err instanceof RegistrationRequestError && err.code === "already_registered") {
      // Registered elsewhere (another tab): the page was just out of date.
      event.value = { ...event.value, registrationStatus: "Registered" };
    } else if (err instanceof RegistrationRequestError && (err.code === "not_open" || err.code === "closed")) {
      event.value = { ...event.value, open: false };
      registerError.value = "This event is no longer open for registration.";
    } else if (err instanceof RegistrationRequestError && err.code === "event_full") {
      // The last places went while this page was open.
      event.value = { ...event.value, slotsLeft: 0 };
      registerError.value = "This event is now full.";
    } else {
      registerError.value = err instanceof Error ? err.message : "Failed to register";
    }
  } finally {
    registering.value = false;
  }
}

function askToWithdraw() {
  withdrawError.value = null;
  confirmingWithdraw.value = true;
}

function cancelWithdraw() {
  if (!withdrawing.value) confirmingWithdraw.value = false;
}

async function handleWithdraw() {
  if (!event.value || withdrawing.value) return;
  withdrawing.value = true;
  withdrawError.value = null;
  registerSuccess.value = false;
  withdrawSuccess.value = false;
  try {
    await withdraw(eventId);
    event.value = { ...event.value, registrationStatus: "Withdrawn", slotsLeft: adjustSlots(1) };
    withdrawSuccess.value = true;
    requestNotificationsRefresh();
  } catch (err) {
    if (err instanceof RegistrationRequestError && err.code === "already_withdrawn") {
      // Withdrawn elsewhere (another tab): the page was just out of date.
      event.value = { ...event.value, registrationStatus: "Withdrawn" };
    } else if (err instanceof RegistrationRequestError && err.code === "event_started") {
      event.value = { ...event.value, hasStarted: true };
      withdrawError.value = "This event has already started, so you can no longer withdraw.";
    } else if (err instanceof RegistrationRequestError && err.code === "event_cancelled") {
      event.value = { ...event.value, registrationStatus: "Cancelled" };
    } else {
      withdrawError.value = err instanceof Error ? err.message : "Failed to withdraw";
    }
  } finally {
    withdrawing.value = false;
    confirmingWithdraw.value = false;
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
    Desktop (12-col): outer container col 1-12 (grid-desktop-margin 80px); back link, banner, title row and the "When and where" info strip col 1-12; description col 1-8. The strip's items (date, time, venue) sit side by side.
    Tablet (6-col): everything col 1-6 full width, grid-tablet-margin 32px; description col 1-6.
    Mobile (4-col): everything col 1-4 full width, grid-mobile-margin 6px; title row stacks, Withdraw button full width, strip items stack.
  -->
  <div class="page">
    <div class="back">
      <button type="button" class="back-link" @click="goBack">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M15.75 19.5 8.25 12l7.5-7.5" />
        </svg>
        Back
      </button>
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
      <!-- The event's thumbnail as a full-width banner, same picture as on its cards. -->
      <img :src="eventThumbnail(event.id)" alt="" class="banner" decoding="async" />

      <div class="title-row">
        <div class="title-block">
          <span v-if="event.registrationStatus" class="badge" :class="registrationBadgeClass(event.registrationStatus)">
            {{ event.registrationStatus }}
          </span>
          <h1 class="h2">{{ event.name || `Event #${event.id}` }}</h1>
        </div>

        <div v-if="canRegister && isFull" class="actions">
          <AppButton variant="primary" size="xl" class="action-button" disabled>Event full</AppButton>
        </div>
        <div v-else-if="canRegister" class="actions">
          <AppButton variant="primary" size="xl" class="action-button" :disabled="registering" @click="handleRegister">
            {{ registering ? "Registering…" : "Register" }}
          </AppButton>
        </div>
        <p v-else-if="event.registrationStatus === 'Cancelled'" class="body-default muted" data-testid="event-cancelled">
          The organiser cancelled this event
        </p>
        <p v-else-if="hasStartedWithPlace" class="body-default muted" data-testid="event-started">
          This event has started
        </p>
        <p v-else-if="!canWithdraw && event.open === false" class="body-default muted" data-testid="registration-closed">
          {{ event.registrationState === "NOT_OPEN" ? "Registration hasn't opened yet" : "Registration is closed" }}
        </p>
        <div v-else-if="canWithdraw" class="actions">
          <AppButton variant="danger" class="action-button" :disabled="withdrawing" @click="askToWithdraw">
            {{ withdrawing ? "Withdrawing…" : "Withdraw registration" }}
          </AppButton>
        </div>
      </div>
      <p v-if="registerError" class="full body-small error-text" role="alert">{{ registerError }}</p>
      <p v-if="registerSuccess" class="full body-small success-text" role="status" data-testid="register-success">
        You're registered. A confirmation has been sent to your notifications.
      </p>
      <p v-if="withdrawError" class="full body-small error-text" role="alert">{{ withdrawError }}</p>
      <p v-if="withdrawSuccess" class="full body-small success-text" role="status" data-testid="withdraw-success">
        You've withdrawn from this event. A confirmation has been sent to your notifications.
      </p>

      <!-- E6-4: withdrawing frees the place at once (it may be taken), so confirm first. -->
      <div v-if="confirmingWithdraw" class="modal-overlay" @click.self="cancelWithdraw" @keydown.esc="cancelWithdraw">
        <div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="withdraw-title" aria-describedby="withdraw-body">
          <p id="withdraw-title" class="modal-title">Withdraw from this event?</p>
          <p id="withdraw-body" class="body-default muted">
            Your place at "{{ event.name || `Event #${event.id}` }}" will be released straight away.
          </p>
          <div class="modal-actions">
            <AppButton variant="outline" :disabled="withdrawing" @click="cancelWithdraw">Keep my place</AppButton>
            <AppButton variant="danger-solid" :disabled="withdrawing" data-testid="confirm-withdraw" @click="handleWithdraw">
              {{ withdrawing ? "Withdrawing…" : "Withdraw" }}
            </AppButton>
          </div>
        </div>
      </div>

      <div v-if="paragraphs.length > 0" class="description">
        <p v-for="(paragraph, index) in paragraphs" :key="index" class="body-default">{{ paragraph }}</p>
      </div>

      <!-- When and where: an info strip between two rules. Date/Time/Venue
           share one space-between row. -->
      <section class="details" aria-label="When and where">
        <div class="details-row">
          <div class="detail-item">
            <span class="detail-icon-chip">
              <svg class="detail-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path
                  d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5" />
              </svg>
            </span>
            <div class="detail-text">
              <span class="detail-label">Date</span>
              <span class="detail-value">{{ formatLongDate(event.proposedDate) }}</span>
            </div>
          </div>

          <div class="detail-item">
            <span class="detail-icon-chip">
              <svg class="detail-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 6v6h4.5m4.5 0a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
              </svg>
            </span>
            <div class="detail-text">
              <span class="detail-label">Time</span>
              <span class="detail-value">{{ formatCardTimeRange(event.startTime, event.endTime) }}</span>
            </div>
          </div>

          <div class="detail-item">
            <span class="detail-icon-chip">
              <svg class="detail-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z" />
                <path d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z" />
              </svg>
            </span>
            <div class="detail-text">
              <span class="detail-label">{{ event.venues.length > 1 ? "Venues" : "Venue" }}</span>
              <span v-if="event.venues.length === 0" class="detail-value detail-value--muted">Venue to be
                confirmed</span>
              <span v-for="venue in event.venues" :key="venue" class="detail-value">{{ venue }}</span>
            </div>
          </div>

          <div v-if="event.slotsLeft != null" class="detail-item" data-testid="slots-left">
            <span class="detail-icon-chip">
              <svg class="detail-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path
                  d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z" />
              </svg>
            </span>
            <div class="detail-text">
              <span class="detail-label">Availability</span>
              <span class="detail-value" :class="{ 'detail-value--full': event.slotsLeft === 0 }">
                {{ slotsLabel(event.slotsLeft) }}
              </span>
            </div>
          </div>
        </div>
      </section>

      <!-- One full-width container below the strip, items stacked in a column: Accessibility first, any
           further event info below it (same markup, class "info-item"). The wrapper's v-if should also
           cover any future item. -->
      <section v-if="event.accessibility" class="info-rows" aria-label="More about this event">
        <div class="info-item accessibility-note">
          <span class="detail-icon-chip">
            <svg class="detail-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="4.5" r="1.75" />
              <path d="M5.5 8.5 12 10l6.5-1.5M12 10v4.5m0 0-3 6m3-6 3 6" />
            </svg>
          </span>
          <div class="detail-text">
            <span class="detail-label">Accessibility</span>
            <span class="detail-value">{{ event.accessibility }}</span>
          </div>
        </div>
      </section>
    </template>
  </div>
</template>

<style scoped>
.page {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: var(--spacing-24) var(--grid-desktop-gutter);
  padding: var(--spacing-40) 180px var(--spacing-80);
  align-content: start;
  min-height: 100vh;
}

.back,
.full,
.banner,
.title-row,
.details,
.info-rows {
  grid-column: 1 / 13;
}

/* Banner: wide and short on desktop, taller on small screens so the picture isn't a thin strip. */
.banner {
  display: block;
  width: 100%;
  aspect-ratio: 3.5 / 1;
  object-fit: cover;
  border-radius: var(--radius-lg);
  margin-bottom: var(--spacing-16)
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
  .banner,
  .title-row,
  .details,
  .info-rows,
  .description {
    grid-column: 1 / 7;
  }
}

@media (max-width: 640px) {
  .banner {
    aspect-ratio: 2 / 1;
  }

  .page {
    grid-template-columns: repeat(4, 1fr);
    gap: var(--spacing-24) var(--grid-mobile-gutter);
    padding: var(--spacing-24) var(--grid-mobile-margin) var(--spacing-48);
  }

  .back,
  .full,
  .banner,
  .title-row,
  .details,
  .info-rows,
  .description {
    grid-column: 1 / 5;
  }

  .title-row {
    flex-direction: column;
    align-items: stretch;
  }

  .action-button {
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
  background: none;
  border: none;
  padding: 0;
  font-family: inherit;
  cursor: pointer;
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

/* Style.md 3.2: success text is Green Success/600. */
.success-text {
  color: var(--color-success-600);
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

.status-error {
  background: var(--color-error-200);
  color: var(--color-error-600);
}

/* Withdraw confirmation: same modal as the organiser's delete-draft dialog, over the Drawer scrim (Style.md 3.5). */
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-24);
  background: var(--color-grey-alpha-40-dark);
}

.modal {
  width: 100%;
  max-width: 400px;
  padding: var(--spacing-24);
  background: var(--color-base-white);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-popover);
}

/* Subheading, bold */
.modal-title {
  margin: 0 0 var(--spacing-8);
  font-size: 1.125rem;
  line-height: 1.375rem;
  font-weight: 700;
  color: var(--color-grey-900);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--spacing-8);
  margin-top: var(--spacing-24);
}

/* Register: the page's one solid button (Style.md 3.4). */

/* Withdraw: outline in Red Error 300, label in Red Error 600; hover tints, focus rings. */

/* Info strip: no card, just a rule above and below; rows stack vertically,
   each row's items spread across the full width. */
.details {
  border-top: 1px solid var(--color-grey-100);
  border-bottom: 1px solid var(--color-grey-100);
}

/* Padding on the row so the items sit clear of the rules above and below. */
.details-row {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-start;
  gap: var(--spacing-16) 200px;
  padding: var(--spacing-24) var(--spacing-24);
}

/* Info rows: one full-width container below the strip, its items stacked in a column (Accessibility
   first). Any further event info is another .info-item inside it. Body copy: normal weight, 16px.
   No borders of its own. */
.info-rows {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-16);
  width: 100%;
  box-sizing: border-box;
  /* No top padding: the page grid's 24px row gap is the only space between the strip and this block. */
  padding: 0 var(--spacing-24) var(--spacing-24);
}

.info-item {
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-12);
}

/* 6px between the eyebrow label and the text (the strip's 2px plus 4px). */
.info-item .detail-text {
  flex: 1;
  gap: var(--spacing-6);
}

/* Colors/Base/Black: the default body-text colour (Style.md 2.1). */
.info-item .detail-value {
  font-size: 1rem;
  font-weight: 400;
  line-height: 1.25rem;
  color: var(--color-base-black);
}

.detail-item {
  display: flex;
  align-items: center;
  gap: var(--spacing-12);
  min-width: 0;
}

/* Tinted icon chip: Style.md 2.6/2.9 — Purple Primary/100 tinted background
   behind Purple Primary/600 icons (licensed "text links and icons" use). */
.detail-icon-chip {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: var(--spacing-40);
  height: var(--spacing-40);
  border-radius: var(--radius-sm);
  background: var(--color-purple-100);
}

.detail-icon {
  flex: none;
  color: var(--color-purple-600);
}

.detail-text {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-2);
  min-width: 0;
}

.detail-label {
  font-size: 0.75rem;
  font-weight: 400;
  line-height: 1rem;
  color: var(--color-grey-700);
}

.detail-value {
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
}

/* No places left: the error text colour (Style.md UI state). */
.detail-value--full {
  color: var(--color-error-600);
}

/* "Venue to be confirmed" reads as a placeholder, not a fact. */
.detail-value--muted {
  color: var(--color-grey-500);
}

@media (max-width: 640px) {
  .details-row {
    flex-direction: column;
    align-items: stretch;
    gap: var(--spacing-16);
    padding: var(--spacing-16);
  }

  .info-rows {
    padding: 0 var(--spacing-16) var(--spacing-16);
  }
}
</style>
