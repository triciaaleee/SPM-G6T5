<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import {
  AccessDeniedError,
  NotAwaitingSafetyCheckError,
  NotFoundError,
  fetchSafetyCheck,
  type EventSummary,
  type SafetyNotes,
} from "../lib/eventsApi";
import { formatEventDate } from "../lib/eventStatus";
import { fetchEventVenueBookings, type EventVenueBooking } from "../lib/venuesApi";
import { fetchEquipmentRequestsForEvent, type EquipmentRequest } from "../lib/equipmentApi";

/**
 * E1-10: the Safety Officer's Operational Safety Check view. Read-only
 * (AC4): nothing here edits the event, its venues or its equipment. The
 * Safety Officer's decisions — approve, reject, request changes — are
 * E3-12, E3-13 and E3-14, and belong in the "Decision" slot marked below.
 */

const route = useRoute();

const event = ref<EventSummary | null>(null);
const safetyNotes = ref<SafetyNotes | null>(null);
const loading = ref(true);
const pageError = ref<"denied" | "not-found" | "not-awaiting" | "failed" | null>(null);

const bookings = ref<EventVenueBooking[]>([]);
const bookingsError = ref<string | null>(null);
const equipment = ref<EquipmentRequest[]>([]);
const equipmentError = ref<string | null>(null);

/** Bookings no longer in play (§3a end states) aren't part of the arrangements under review. */
const INACTIVE_BOOKING_STATUSES = new Set(["Rejected", "Expired", "Withdrawn"]);

const details = computed(() => (event.value?.submitted_details ?? {}) as Record<string, unknown>);

function text(key: string): string | null {
  const value = details.value[key];
  if (typeof value === "number") return String(value);
  return typeof value === "string" && value.trim() ? value : null;
}

const expectedAttendance = computed(() => {
  const value = Number(details.value.expectedAttendance);
  return Number.isFinite(value) && value > 0 ? value : null;
});

const eventTime = computed(() => {
  const start = text("startTime");
  const end = text("endTime");
  return start && end ? `${start}–${end}` : start ?? "Not given";
});

const activeBookings = computed(() => bookings.value.filter((b) => !INACTIVE_BOOKING_STATUSES.has(b.status)));

/** Attendance above a venue's capacity — flagged for the officer, not decided for them. */
function overCapacity(booking: EventVenueBooking): boolean {
  const capacity = booking.venue?.capacity;
  return expectedAttendance.value !== null && typeof capacity === "number" && expectedAttendance.value > capacity;
}

/** Every requested item with how much of it is reserved, across the event's requests. */
const equipmentItems = computed(() =>
  equipment.value.flatMap((request) =>
    request.items.map((item) => ({ ...item, requestStatus: request.status })),
  ),
);

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

onMounted(async () => {
  const id = route.params.id as string;
  try {
    const result = await fetchSafetyCheck(id);
    event.value = result.event;
    safetyNotes.value = result.safetyNotes;
  } catch (err) {
    pageError.value =
      err instanceof AccessDeniedError
        ? "denied"
        : err instanceof NotFoundError
          ? "not-found"
          : err instanceof NotAwaitingSafetyCheckError
            ? "not-awaiting"
            : "failed";
    loading.value = false;
    return;
  }

  await Promise.all([
    fetchEventVenueBookings(event.value!.id)
      .then((rows) => (bookings.value = rows))
      .catch(() => (bookingsError.value = "We couldn't load this event's venue bookings.")),
    fetchEquipmentRequestsForEvent(event.value!.id)
      .then((rows) => (equipment.value = rows))
      .catch(() => (equipmentError.value = "We couldn't load this event's equipment.")),
  ]);
  loading.value = false;
});
</script>

<template>
  <!--
    Column mapping — Operational Safety Check
    Desktop (12-col): outer container col 1-12, grid-desktop-margin 80px; content col 1-12, full width.
      Nested: event, venues and equipment col 1-8; safety notes col 9-12.
    Tablet (6-col):   content col 1-6, full width, grid-tablet-margin 32px; sections stack, col 1-6.
    Mobile (4-col):   content col 1-4, full width, grid-mobile-margin 6px; sections stack, col 1-4.
  -->
  <div class="page">
    <div class="content">
      <RouterLink :to="{ name: 'safety-queue' }" class="back-link">&larr; Back to queue</RouterLink>

      <p v-if="loading" class="body-default muted">Loading…</p>

      <div v-else-if="pageError" class="message-panel">
        <p class="panel-title" :class="{ 'panel-title--error': pageError === 'denied' }">
          {{
            pageError === "denied"
              ? "Access denied"
              : pageError === "not-found"
                ? "Event not found"
                : pageError === "not-awaiting"
                  ? "Not awaiting a safety check"
                  : "Something went wrong"
          }}
        </p>
        <p class="body-default muted">
          {{
            pageError === "denied"
              ? "Only the Safety Officer can open the Operational Safety Check. This attempt has been recorded."
              : pageError === "not-found"
                ? "This event does not exist."
                : pageError === "not-awaiting"
                  ? "This event is no longer in Safety Review."
                  : "We couldn't load this safety check. Please try again."
          }}
        </p>
      </div>

      <template v-else-if="event">
        <span class="badge badge--review">Safety Review</span>
        <h1 class="h2">{{ text("name") ?? `Event #${event.id}` }}</h1>
        <p class="body-default muted">
          Event #{{ event.id }} · Coordinator {{ event.coordinator?.name ?? "not assigned" }} · Requested by
          {{ event.organiser?.name ?? "unknown" }}
        </p>
        <p class="body-small muted read-only-note">
          This check is read-only. Event, venue and equipment details can't be changed from here.
        </p>

        <div class="check-grid">
          <div class="check-col">
            <!-- AC2: expected attendance and accessibility requirements -->
            <section class="card" aria-labelledby="event-heading">
              <h2 id="event-heading" class="section-title">Event</h2>
              <dl class="facts">
                <div>
                  <dt class="body-small muted">Date</dt>
                  <dd class="body-default">{{ formatEventDate(text("proposedDate")) }}</dd>
                </div>
                <div>
                  <dt class="body-small muted">Time</dt>
                  <dd class="body-default">{{ eventTime }}</dd>
                </div>
                <div>
                  <dt class="body-small muted">Expected attendance</dt>
                  <dd class="body-default">{{ expectedAttendance ?? "Not given" }}</dd>
                </div>
              </dl>
              <div class="field">
                <p class="body-small muted">Accessibility requirements</p>
                <p class="body-default value">{{ text("accessibility") ?? "None stated" }}</p>
              </div>
            </section>

            <!-- AC2: each venue booking with that venue's capacity and layout -->
            <section class="card" aria-labelledby="venues-heading">
              <h2 id="venues-heading" class="section-title">Venues</h2>
              <p v-if="bookingsError" class="body-small error-text">{{ bookingsError }}</p>
              <p v-else-if="activeBookings.length === 0" class="body-small muted">This event has no venue booking.</p>
              <ul v-else class="list">
                <li v-for="booking in activeBookings" :key="booking.id" class="list__item">
                  <div class="list__head">
                    <p class="body-default value strong">{{ booking.venue?.name ?? "Unknown venue" }}</p>
                    <span class="badge badge--neutral">{{ booking.status }}</span>
                  </div>
                  <p class="body-small muted">{{ booking.venue?.location }}</p>
                  <dl class="facts">
                    <div>
                      <dt class="body-small muted">Capacity</dt>
                      <dd class="body-default">{{ booking.venue?.capacity ?? "Not recorded" }}</dd>
                    </div>
                    <div>
                      <dt class="body-small muted">Layouts</dt>
                      <dd class="chips">
                        <span v-for="layout in booking.venue?.layouts ?? []" :key="layout" class="chip">{{ layout }}</span>
                        <span v-if="!booking.venue?.layouts?.length" class="body-default">Not recorded</span>
                      </dd>
                    </div>
                  </dl>
                  <p v-if="overCapacity(booking)" class="body-small capacity-warning" role="note">
                    Expected attendance ({{ expectedAttendance }}) is above this venue's capacity
                    ({{ booking.venue?.capacity }}).
                  </p>
                </li>
              </ul>
            </section>

            <!-- AC2: the reserved equipment -->
            <section class="card" aria-labelledby="equipment-heading">
              <h2 id="equipment-heading" class="section-title">Equipment</h2>
              <p v-if="equipmentError" class="body-small error-text">{{ equipmentError }}</p>
              <p v-else-if="equipmentItems.length === 0" class="body-small muted">
                No equipment was requested for this event.
              </p>
              <table v-else class="equipment-table">
                <thead>
                  <tr>
                    <th scope="col" class="body-small muted">Item</th>
                    <th scope="col" class="body-small muted">Requested</th>
                    <th scope="col" class="body-small muted">Reserved</th>
                    <th scope="col" class="body-small muted">Status</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="item in equipmentItems" :key="item.id">
                    <td class="body-default value">{{ item.equipmentType }}</td>
                    <td class="body-default">{{ item.quantity }}</td>
                    <td class="body-default">{{ item.quantityFulfilled }}</td>
                    <td class="body-small">{{ item.requestStatus }}</td>
                  </tr>
                </tbody>
              </table>
            </section>
          </div>

          <div class="check-col">
            <!-- AC2: the coordinator's safety notes (E3-4) -->
            <section class="card" aria-labelledby="notes-heading">
              <h2 id="notes-heading" class="section-title">Coordinator's safety notes</h2>
              <p v-if="!safetyNotes" class="body-small muted">No safety notes were recorded for this submission.</p>
              <template v-else>
                <div class="field">
                  <p class="body-small muted">Equipment placement</p>
                  <p class="body-default value">{{ safetyNotes.equipmentPlacement }}</p>
                </div>
                <div class="field">
                  <p class="body-small muted">Crowd movement</p>
                  <p class="body-default value">{{ safetyNotes.crowdMovement }}</p>
                </div>
                <div class="field">
                  <p class="body-small muted">Emergency access</p>
                  <p class="body-default value">{{ safetyNotes.emergencyAccess }}</p>
                </div>
                <div class="field">
                  <p class="body-small muted">Known venue restrictions</p>
                  <p class="body-default value">{{ safetyNotes.venueRestrictions }}</p>
                </div>
                <p class="small-text muted">
                  Submitted {{ formatTimestamp(safetyNotes.submittedAt) }}
                  <template v-if="safetyNotes.submittedBy"> by {{ safetyNotes.submittedBy }}</template>
                </p>
              </template>
            </section>

            <!-- Decision: E3-12 (approve), E3-13 (reject) and E3-14 (request
                 changes) add the Safety Officer's only actions here (AC4). -->
          </div>
        </div>
      </template>
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

/* Nested 12-col grid: col 1-8 and col 9-12 on desktop, stacked below. */
.check-grid {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  gap: var(--grid-desktop-gutter);
  align-content: start;
  margin-top: var(--spacing-32);
}

.check-col {
  display: flex;
  flex-direction: column;
  gap: var(--grid-desktop-gutter);
  min-width: 0;
}

.check-col:first-child {
  grid-column: 1 / 9;
}

.check-col:last-child {
  grid-column: 9 / 13;
}

@media (max-width: 1024px) {
  .check-grid {
    grid-template-columns: repeat(6, minmax(0, 1fr));
  }

  .check-col:first-child,
  .check-col:last-child {
    grid-column: 1 / 7;
  }
}

@media (max-width: 640px) {
  .check-grid {
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: var(--grid-mobile-gutter);
  }

  .check-col:first-child,
  .check-col:last-child {
    grid-column: 1 / 5;
  }
}

.back-link {
  display: inline-block;
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  color: var(--color-purple-600);
  margin-bottom: var(--spacing-24);
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
  margin: var(--spacing-12) 0 var(--spacing-4);
}

/* H6 */
.section-title,
.panel-title {
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
  margin: 0 0 var(--spacing-16);
}

.panel-title--error {
  color: var(--color-error-600);
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
  margin: 0;
}

.muted {
  color: var(--color-grey-500);
}

.value {
  color: var(--color-grey-900);
}

.strong {
  font-weight: 700;
}

.error-text {
  color: var(--color-error-600);
}

.read-only-note {
  margin-top: var(--spacing-8);
}

.card,
.message-panel {
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
  padding: var(--spacing-24);
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-4);
  margin-bottom: var(--spacing-16);
}

.facts {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-16) var(--spacing-32);
  margin: 0 0 var(--spacing-16);
}

.facts dd {
  margin: var(--spacing-4) 0 0;
  color: var(--color-grey-900);
}

.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.list__item {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
  padding: var(--spacing-16) 0;
  border-top: 1px solid var(--color-grey-100);
}

.list__item:first-child {
  border-top: none;
  padding-top: 0;
}

.list__item .facts {
  margin: var(--spacing-4) 0 0;
}

.list__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-12);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-4);
}

/* Small Text / Tag, radius-xs chip — Style.md 2.4 tinted tag background. */
.chip {
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  padding: var(--spacing-2) var(--spacing-8);
  border-radius: var(--radius-xs);
  background: var(--color-purple-100);
  color: var(--color-purple-800);
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

.badge--review {
  background: var(--color-warning-200);
  color: var(--color-warning-900);
}

.badge--neutral {
  background: var(--color-grey-100);
  color: var(--color-grey-700);
}

/* Style.md 2.6: worth the officer's attention, not an error. */
.capacity-warning {
  background: var(--color-warning-100);
  border: 1px solid var(--color-warning-300);
  border-radius: var(--radius-xs);
  color: var(--color-warning-900);
  padding: var(--spacing-8) var(--spacing-12);
}

.equipment-table {
  width: 100%;
  border-collapse: collapse;
}

.equipment-table th {
  text-align: left;
  font-weight: 700;
  padding: 0 var(--spacing-8) var(--spacing-8) 0;
  border-bottom: 1px solid var(--color-grey-100);
}

.equipment-table td {
  padding: var(--spacing-8) var(--spacing-8) var(--spacing-8) 0;
  border-bottom: 1px solid var(--color-grey-100);
}

.equipment-table tr:last-child td {
  border-bottom: none;
}
</style>
