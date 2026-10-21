<script setup lang="ts">
/**
 * E4-8 AC5: the venue requests made for one event and the state each one
 * is in, so a coordinator can see a request is pending without leaving the
 * event page. An event may have any number of bookings (AGENTS.md §3a
 * change 3), each decided on its own by Venue Staff, so they are listed
 * rather than summarised into a single "venue" field.
 *
 * E4-9: the assigned coordinator can withdraw a pending request/hold or
 * release a confirmed booking right from this list. Approving or rejecting
 * one is Venue Staff's (E4-10) and stays read-only here.
 *
 * Column mapping: its own card in the event detail page's main column (the
 * 2fr of its 2fr/1fr desktop grid, full width once that collapses), a
 * sibling of the venue recommendations card rather than part of it. The
 * list inside is a single column at every breakpoint.
 */
import AppButton from "../ui/AppButton.vue";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { RouteLocationRaw } from "vue-router";
import { CheckIcon, XCircleIcon } from "@heroicons/vue/16/solid";
import { EllipsisHorizontalIcon } from "@heroicons/vue/20/solid";
import {
  describeBookingFailure,
  describeSuitabilityReasons,
  purposeLabel,
  releaseVenueBooking,
  withdrawVenueBooking,
  type BookingSuitability,
  type EventVenueBooking,
} from "../../lib/venuesApi";
import { bookingStatusBadgeClass, bookingStatusLabel, isActiveBooking } from "../../lib/bookingStatus";

/**
 * The bookings are owned by the event page rather than fetched here: the
 * outstanding-arrangements line reads the same list, and both must refresh
 * together when a request is submitted from the recommendations above (or
 * withdrawn/released here).
 */
const props = defineProps<{
  /** Undefined while the first load is still in flight. */
  bookings: EventVenueBooking[] | undefined;
  loading: boolean;
  loadError: string | null;
  /** E4-9: only the event's assigned coordinator may withdraw or release a booking. */
  canWithdraw?: boolean;
  /** E4-17: each booking's purpose, headcount and suitability; left out, none is shown. */
  suitability?: BookingSuitability[];
  /** Where "Find replacement" goes: venue search pre-filled for this event. Left out, the button is hidden. */
  findReplacementTo?: RouteLocationRaw;
}>();

/** E4-17: suitability only matters for bookings still holding or asking for a venue. */
const SUITABILITY_STATUSES = new Set(["Requested", "On Hold", "Approved", "Replacement Required"]);

const suitabilityById = computed(() => new Map((props.suitability ?? []).map((s) => [s.bookingId, s])));

/** e.g. "Breakout, 60 people". */
function purposeAndHeadcount(booking: BookingSuitability): string {
  if (booking.headcount === null) return purposeLabel(booking);
  return `${purposeLabel(booking)}, ${booking.headcount} ${booking.headcount === 1 ? "person" : "people"}`;
}

const emit = defineEmits<{ changed: [] }>();

/**
 * "Find replacement" is offered on a booking that needs a new venue: one
 * flagged Replacement Required, or one the system Cancelled because its venue
 * became unavailable. A Cancelled booking only offers it while the event has
 * no other live booking, so it doesn't linger once a replacement is requested.
 */
function offersReplacement(booking: EventVenueBooking): boolean {
  if (booking.status === "Replacement Required") return true;
  if (booking.status !== "Cancelled") return false;
  return !(props.bookings ?? []).some((other) => other.id !== booking.id && isActiveBooking(other.status));
}

const bookings = computed(() => props.bookings ?? []);

/** "19 Oct 2026, 10:26 PM": day-first date, 12-hour time. */
function formatMoment(value: string | null): string {
  if (!value) return "";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  const date = at.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  // Newer ICU puts a narrow no-break space before AM/PM; use a plain space so it reads (and copies) normally.
  const time = at
    .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })
    .replace(/\u202f/g, " ");
  return `${date}, ${time}`;
}

/**
 * AC1 vs AC2: a pending request/hold is withdrawn; a confirmed one is
 * released. E4-15 AC3: a Replacement Required booking is also released,
 * once the coordinator has requested a replacement venue.
 */
function actionFor(status: string): "withdraw" | "release" | null {
  if (status === "Requested" || status === "On Hold") return "withdraw";
  if (status === "Approved" || status === "Replacement Required") return "release";
  return null;
}

/** The text of a row's menu item: what choosing it does. */
function actionLabel(status: string): string {
  return actionFor(status) === "withdraw" ? "Withdraw request" : "Release venue";
}

/**
 * The ··· menu on a row: one open at a time. It closes on an outside click or Escape (focus goes back to the
 * button that opened it), like the account menu in App.vue.
 */
const openMenuId = ref<number | null>(null);
const menuTriggers = new Map<number, HTMLElement>();

function setMenuTrigger(id: number, el: unknown): void {
  if (el instanceof HTMLElement) menuTriggers.set(id, el);
  else menuTriggers.delete(id);
}

function toggleMenu(id: number): void {
  openMenuId.value = openMenuId.value === id ? null : id;
}

function closeMenu(returnFocus = false): void {
  const id = openMenuId.value;
  openMenuId.value = null;
  if (returnFocus && id !== null) menuTriggers.get(id)?.focus();
}

function onDocumentPointerDown(event: PointerEvent): void {
  if (openMenuId.value === null) return;
  if (!(event.target instanceof Element) || !event.target.closest("[data-row-menu]")) closeMenu();
}

function onDocumentKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && openMenuId.value !== null) closeMenu(true);
}

onMounted(() => {
  document.addEventListener("pointerdown", onDocumentPointerDown);
  document.addEventListener("keydown", onDocumentKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onDocumentPointerDown);
  document.removeEventListener("keydown", onDocumentKeydown);
});

/** Choosing the menu item closes the menu and opens the confirm modal. */
function chooseAction(booking: EventVenueBooking): void {
  closeMenu();
  requestAction(booking);
}

// One action at a time, with the outcome shown on the row it came from —
// same pattern as venue recommendations' per-card request state.
const actingId = ref<number | null>(null);
const actionErrorId = ref<number | null>(null);
const actionError = ref("");

/** The booking awaiting confirmation in the modal below; null when it's closed. */
const pendingAction = ref<EventVenueBooking | null>(null);

const pendingActionKind = computed(() => (pendingAction.value ? actionFor(pendingAction.value.status) : null));

const pendingActionCopy = computed(() => {
  const venueName = pendingAction.value?.venue?.name ?? "this venue";
  if (pendingActionKind.value === "release") {
    const body =
      pendingAction.value?.status === "Replacement Required"
        ? `${venueName} is no longer available for this event. Releasing it clears the booking now that a replacement has been requested — this cannot be undone.`
        : `${venueName} is Approved for this event. Releasing it frees the venue for other requests — this cannot be undone.`;
    return { title: "Release this booking?", body, confirmLabel: "Release" };
  }
  return {
    title: "Withdraw this request?",
    body: `Venue Staff will be notified and stop working on ${venueName} for this event. You can request another venue afterwards.`,
    confirmLabel: "Withdraw",
  };
});

/** Opens the confirm modal for `booking`'s withdraw/release action. */
function requestAction(booking: EventVenueBooking): void {
  if (!actionFor(booking.status)) return;
  pendingAction.value = booking;
}

function cancelAction(): void {
  pendingAction.value = null;
}

async function confirmAction(): Promise<void> {
  const booking = pendingAction.value;
  const action = booking ? actionFor(booking.status) : null;
  if (!booking || !action) return;

  actingId.value = booking.id;
  actionErrorId.value = null;
  actionError.value = "";
  try {
    if (action === "withdraw") await withdrawVenueBooking(booking.id);
    else await releaseVenueBooking(booking.id);
    pendingAction.value = null;
    emit("changed");
  } catch (err) {
    pendingAction.value = null;
    actionErrorId.value = booking.id;
    actionError.value = describeBookingFailure(err, `Failed to ${action} this booking`);
  } finally {
    actingId.value = null;
  }
}
</script>

<template>
  <div class="details-card venue-requests">
    <h2 class="section-title">Venue Requests</h2>

    <p v-if="loading || !props.bookings" class="body-default muted">Loading venue requests…</p>
    <p v-else-if="loadError" class="body-default error-text">{{ loadError }}</p>
    <p v-else-if="bookings.length === 0" class="body-default muted">
      No venue has been requested for this event yet.
    </p>

    <ul v-else class="request-list">
      <li v-for="booking in bookings" :key="booking.id" class="request-row">
        <div class="request-venue">
          <p v-if="booking.venue" class="request-location">{{ booking.venue.location }}</p>
          <p class="request-name">{{ booking.venue?.name ?? "Venue unavailable" }}</p>
          <!-- E4-17: what this venue is for, and whether it suits that (AC2–AC4). Only a mismatch is called out. -->
          <template v-if="suitabilityById.get(booking.id)">
            <p class="request-purpose">{{ purposeAndHeadcount(suitabilityById.get(booking.id)!) }}</p>
            <p v-if="SUITABILITY_STATUSES.has(booking.status) && suitabilityById.get(booking.id)!.suitability
              && !suitabilityById.get(booking.id)!.suitability!.suitable" class="body-small suitability suitability--bad">
              <XCircleIcon class="suitability__icon" aria-hidden="true" />Unsuitable:
              {{ describeSuitabilityReasons(suitabilityById.get(booking.id)!.suitability!.reasons).join("; ") }}
            </p>
          </template>
          <p v-if="booking.status === 'On Hold' && booking.holdExpiresAt" class="body-small muted">
            Hold expires {{ formatMoment(booking.holdExpiresAt) }}
          </p>
          <!-- E4-10 AC4: Venue Staff must record why they refused, and the
               coordinator is told it. -->
          <p v-if="(booking.status === 'Rejected' || booking.status === 'Cancelled') && booking.decisionReason"
            class="body-small reason">
            Reason: {{ booking.decisionReason }}
          </p>
          <p v-if="booking.status === 'Cancelled' && offersReplacement(booking)" class="body-small reason">
            This booking was cancelled automatically. Find a replacement venue for the event.
          </p>
          <p v-if="booking.status === 'Replacement Required'" class="body-small reason">
            This venue is no longer available. Find a replacement, then release this booking.
          </p>
          <p v-if="actionErrorId === booking.id" class="body-small error-text" role="alert">
            {{ actionError }}
          </p>
          <p class="request-requested">Requested {{ formatMoment(booking.createdAt) }}</p>
        </div>
        <div class="request-status">
          <span class="badge" :class="bookingStatusBadgeClass(booking.status)">
            <CheckIcon v-if="booking.status === 'Approved'" class="badge__icon" aria-hidden="true" />
            {{ bookingStatusLabel(booking.status) }}
          </span>
          <AppButton v-if="canWithdraw && findReplacementTo && offersReplacement(booking)"
            variant="primary" size="sm" class="action-btn" :to="findReplacementTo">
            Find replacement
          </AppButton>
          <!-- E4-9: withdraw a pending request/hold, or release an Approved booking, from a ··· menu.
               Approving/rejecting stays Venue Staff's (E4-10). -->
          <div v-if="canWithdraw && actionFor(booking.status)" class="row-menu" data-row-menu>
            <button type="button" class="menu-trigger" aria-haspopup="menu" :aria-expanded="openMenuId === booking.id"
              :aria-label="`More actions for ${booking.venue?.name ?? 'this venue'}`" :disabled="actingId === booking.id"
              :ref="(el) => setMenuTrigger(booking.id, el)" @click="toggleMenu(booking.id)">
              <EllipsisHorizontalIcon class="menu-trigger__icon" aria-hidden="true" />
            </button>
            <div v-if="openMenuId === booking.id" class="menu" role="menu">
              <button type="button" role="menuitem" class="menu-item" @click="chooseAction(booking)">
                {{ actionLabel(booking.status) }}
              </button>
            </div>
          </div>
        </div>
      </li>
    </ul>

    <!-- Under the list once it has loaded: the page puts "Request another venue" here. -->
    <slot v-if="!loading && props.bookings && !loadError" name="actions" />

    <!-- E4-9: a small confirm dialog in place of the browser's native confirm(). -->
    <div v-if="pendingAction" class="modal-overlay" @click.self="cancelAction">
      <div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="withdraw-confirm-title">
        <p id="withdraw-confirm-title" class="modal-title">{{ pendingActionCopy.title }}</p>
        <p class="body-default muted">{{ pendingActionCopy.body }}</p>
        <div class="modal-actions">
          <AppButton variant="outline" type="button" :disabled="actingId !== null"
            @click="cancelAction">
            Cancel
          </AppButton>
          <AppButton variant="danger-solid" type="button" :disabled="actingId !== null"
            @click="confirmAction">
            {{ actingId !== null ? "Working…" : pendingActionCopy.confirmLabel }}
          </AppButton>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.venue-requests {
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
  padding: var(--spacing-32);
}

.section-title {
  font-size: 1.125rem;
  font-weight: 700;
  color: var(--color-grey-900);
  margin-bottom: var(--spacing-16);
}

.body-default {
  font-size: 0.875rem;
  color: var(--color-grey-900);
}

.body-small {
  font-size: 0.75rem;
}

.muted {
  color: var(--color-grey-500);
}

.error-text {
  color: var(--color-error-600);
}

.reason {
  color: var(--color-error-600);
}

/* E4-17: Style.md 3.1 error text for the unsuitable line. */
.suitability {
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-4);
}

.suitability__icon {
  flex-shrink: 0;
  width: var(--spacing-16);
  height: var(--spacing-16);
  margin-top: var(--spacing-2);
}

.suitability--ok {
  color: var(--color-success-600);
}

.suitability--bad {
  color: var(--color-error-600);
}

.request-list {
  display: grid;
  gap: var(--spacing-12);
  list-style: none;
  margin: 0;
  padding: 0;
}

.request-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--spacing-16);
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-xs);
  padding: var(--spacing-24);
}

.request-venue {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-4);
}

.request-venue p {
  margin: 0;
}

.request-location {
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-500);
}

.request-name {
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
  overflow-wrap: anywhere;
}

.request-purpose {
  font-size: 1rem;
  line-height: 1.5rem;
  color: var(--color-grey-700);
}

/* A clear gap before the timestamp, as in the design. */
.request-requested {
  margin-top: var(--spacing-24);
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-500);
}

.badge {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-8);
  font-size: 1rem;
  font-weight: 700;
  line-height: 1.25rem;
  padding: var(--spacing-8) var(--spacing-16);
  border-radius: var(--radius-xs);
  white-space: nowrap;
}

.badge__icon {
  width: 1rem;
  height: 1rem;
  flex-shrink: 0;
}

/* Status badge, then the ··· menu, on one row. */
.request-status {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: var(--spacing-16);
}

.row-menu {
  position: relative;
}

.menu-trigger {
  appearance: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: var(--radius-xs);
  color: var(--color-grey-600);
  cursor: pointer;
}

.menu-trigger:hover:not(:disabled) {
  background: var(--color-grey-50);
  color: var(--color-grey-900);
}

.menu-trigger:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.menu-trigger:focus-visible,
.menu-item:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

.menu-trigger__icon {
  width: 1.25rem;
  height: 1.25rem;
}

.menu {
  position: absolute;
  top: calc(100% + var(--spacing-4));
  right: 0;
  z-index: 20;
  min-width: 10rem;
  padding: var(--spacing-4);
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-xs);
  box-shadow: var(--shadow-card);
}

.menu-item {
  appearance: none;
  display: block;
  width: 100%;
  padding: var(--spacing-8) var(--spacing-12);
  background: transparent;
  border: none;
  border-radius: var(--radius-xs);
  font-family: inherit;
  font-size: 0.875rem;
  font-weight: 700;
  text-align: left;
  white-space: nowrap;
  color: var(--color-error-600);
  cursor: pointer;
}

.menu-item:hover {
  background: var(--color-grey-50);
}

@media (max-width: 640px) {
  .request-row {
    flex-direction: column;
    padding: var(--spacing-24);
  }

  .request-status {
    align-self: flex-start;
  }
}

.status-success {
  background: #e5eee5;
  color: var(--color-success-700);
}

.status-warning {
  background: #fef5e7;
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

</style>
