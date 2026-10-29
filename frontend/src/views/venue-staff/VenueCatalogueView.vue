<script setup lang="ts">
import StatusBadge from "../../components/ui/StatusBadge.vue";
/**
 * Venue staff's catalogue: every venue they look after in one table, with a
 * button to add a new one. Adding goes through the same VenueFormPanel the
 * schedule uses, so a new venue is described with the same options and is
 * bookable by coordinators straight away (E4-1).
 */
import { PlusIcon } from "@heroicons/vue/20/solid";
import AppButton from "../../components/ui/AppButton.vue";
import DataTable from "../../components/ui/DataTable.vue";
import BlockOutPanel from "../../components/venues/BlockOutPanel.vue";
import VenueFormPanel from "../../components/venues/VenueFormPanel.vue";
import { onMounted, ref } from "vue";
import { fetchMyVenues, type VenueRecord, type VenueUpdateResult } from "../../lib/venuesApi";
import { describeBlockOutResult, type CreatePeriodResult } from "../../lib/unavailabilityApi";
import { toKey } from "../../lib/venueCalendar";

const TABLE_COLUMNS = [
  { key: "venue", label: "Venue" },
  { key: "location", label: "Location" },
  { key: "capacity", label: "Capacity" },
  { key: "hours", label: "Opening hours" },
  { key: "status", label: "Status" },
  { key: "actions", label: "" },
];
const TABLE_COLUMN_WIDTHS = "1.4fr 1fr 0.7fr 1fr 0.8fr 13rem";

const venues = ref<VenueRecord[]>([]);
const loading = ref(true);
const errorMessage = ref<string | null>(null);
const notice = ref<{ text: string; warning: boolean } | null>(null);
/** The venue whose block-out form is open. */
const blockOutVenue = ref<VenueRecord | null>(null);
const formOpen = ref(false);
/** The venue being edited; null while adding a new one. */
const editingVenue = ref<VenueRecord | null>(null);

async function loadVenues(): Promise<void> {
  try {
    venues.value = await fetchMyVenues();
    errorMessage.value = null;
  } catch {
    errorMessage.value = "We couldn't load the venues. Please try again.";
  } finally {
    loading.value = false;
  }
}

function openAdd(): void {
  notice.value = null;
  editingVenue.value = null;
  formOpen.value = true;
}

function openEdit(venue: VenueRecord): void {
  notice.value = null;
  editingVenue.value = venue;
  formOpen.value = true;
}

function closeForm(): void {
  formOpen.value = false;
  editingVenue.value = null;
}

function openBlockOut(venue: VenueRecord): void {
  notice.value = null;
  blockOutVenue.value = venue;
}

function closeBlockOut(): void {
  blockOutVenue.value = null;
}

function onBlockedOut(result: CreatePeriodResult): void {
  closeBlockOut();
  notice.value = describeBlockOutResult(result, "Period blocked out.");
}

async function onCreated(venue: VenueRecord): Promise<void> {
  closeForm();
  notice.value = { text: `${venue.name} added. Coordinators can find and book it straight away.`, warning: false };
  await loadVenues();
}

async function onUpdated(result: VenueUpdateResult): Promise<void> {
  const shortfalls = result.capacityShortfalls.length;
  const overlaps = result.bufferOverlaps.length;
  const parts: string[] = [];
  if (shortfalls > 0) parts.push(`${shortfalls} confirmed event${shortfalls === 1 ? "" : "s"} no longer fit the capacity`);
  if (overlaps > 0) parts.push(`${overlaps} pair${overlaps === 1 ? "" : "s"} of bookings now overlap`);
  let text = `${result.venue.name} updated.`;
  if (parts.length > 0) {
    const notified = result.notificationsFailed
      ? "but we couldn't notify the coordinators — please let them know directly."
      : `${result.coordinatorsNotified} coordinator${result.coordinatorsNotified === 1 ? "" : "s"} notified.`;
    text += ` ${parts.join("; ")}; ${notified}`;
  }
  closeForm();
  notice.value = { text, warning: result.notificationsFailed };
  await loadVenues();
}

onMounted(loadVenues);
</script>

<template>
  <!--
    Column mapping — Venue catalogue
    Desktop (12-col, grid-desktop-margin 80px): header col 1-12; venue table col 1-12.
    Tablet (6-col, grid-tablet-margin 32px): everything col 1-6; the table scrolls inside its card.
    Mobile (4-col, grid-mobile-margin 6px): everything col 1-4.
  -->
  <div class="page">
    <div class="page-header">
      <div>
        <h1 class="h2">Venue catalogue</h1>
        <p class="subheading">Every venue you look after, and the details coordinators search by</p>
      </div>
      <AppButton variant="primary" size="xl" type="button" class="add-venue-button" data-testid="open-add-venue"
        @click="openAdd">
        <PlusIcon class="add-venue-button__icon" aria-hidden="true" />
        Add venue
      </AppButton>
    </div>

    <p v-if="loading" class="full body-default muted">Loading the venues…</p>
    <p v-else-if="errorMessage" class="full body-default error-text" role="alert">{{ errorMessage }}</p>

    <section v-else class="catalogue" aria-label="Venues">
      <p v-if="notice" class="body-small notice" :class="{ 'notice--warning': notice.warning }" role="status"
        data-testid="venue-notice">
        {{ notice.text }}
      </p>
      <p v-if="venues.length === 0" class="body-default muted">No venues have been added yet.</p>

      <DataTable v-else :columns="TABLE_COLUMNS" :column-widths="TABLE_COLUMN_WIDTHS" column-gap="var(--spacing-24)"
        :rows="venues" :row-key="(venue) => venue.id" :row-test-id="(venue) => `venue-${venue.id}`">
        <template #cell-venue="{ row: venue }">
          <span class="venue-name">{{ venue.name }}</span>
        </template>

        <template #cell-location="{ row: venue }">
          <span class="cell-text">{{ venue.location }}</span>
        </template>

        <template #cell-capacity="{ row: venue }">
          <span class="cell-text" data-testid="venue-capacity">{{ venue.capacity }}</span>
        </template>

        <template #cell-hours="{ row: venue }">
          <span class="cell-text">{{ venue.openingTime }} – {{ venue.closingTime }}</span>
        </template>

        <template #cell-status="{ row: venue }">
          <StatusBadge :status-class="venue.status === 'Available' ? 'status-success' : 'status-neutral'">{{ venue.status }}</StatusBadge>
        </template>

        <template #cell-actions="{ row: venue }">
          <div class="row-actions">
            <AppButton variant="outline" size="sm" type="button" :aria-label="`Edit ${venue.name}`"
              data-testid="edit-venue" @click="openEdit(venue)">
              Edit
            </AppButton>
            <AppButton variant="danger" size="sm" type="button" :aria-label="`Block out ${venue.name}`"
              data-testid="block-out-venue" @click="openBlockOut(venue)">
              Block out
            </AppButton>
          </div>
        </template>
      </DataTable>
    </section>

    <VenueFormPanel v-if="formOpen" :key="editingVenue?.id ?? 'new'" :venue="editingVenue" @close="closeForm"
      @created="onCreated" @updated="onUpdated" />

    <BlockOutPanel v-if="blockOutVenue" :key="blockOutVenue.id" :venue-id="blockOutVenue.id" :venues="[blockOutVenue]"
      :initial-date="toKey(new Date())" @close="closeBlockOut" @saved="onBlockedOut" />
  </div>
</template>

<style scoped>
.page {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: var(--spacing-24) var(--grid-desktop-gutter);
  padding: var(--spacing-40) var(--grid-desktop-margin) var(--spacing-80);
  align-content: start;
}

.page-header,
.full,
.catalogue {
  grid-column: 1 / 13;
}

@media (max-width: 1024px) {
  .page {
    grid-template-columns: repeat(6, 1fr);
    gap: var(--spacing-24) var(--grid-tablet-gutter);
    padding: var(--spacing-32) var(--grid-tablet-margin) var(--spacing-48);
  }

  .page-header,
  .full,
  .catalogue {
    grid-column: 1 / 7;
  }
}

@media (max-width: 640px) {
  .page {
    grid-template-columns: repeat(4, 1fr);
    gap: var(--spacing-24) var(--grid-mobile-gutter);
    padding: var(--spacing-24) var(--grid-mobile-margin) var(--spacing-48);
  }

  .page-header,
  .full,
  .catalogue {
    grid-column: 1 / 5;
  }
}

.h2 {
  margin: 0;
}

.subheading {
  color: var(--color-grey-600);
  margin: var(--spacing-8) 0 0;
}

/* Title on the left, "Add venue" top-aligned with it on the right. */
.page-header {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--spacing-16);
}

.add-venue-button {
  flex-shrink: 0;
}

.add-venue-button__icon {
  width: 1.25rem;
  height: 1.25rem;
}

.catalogue {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-16);
}

.body-default {
  margin: 0;
}

.body-small {
  margin: 0;
}

.muted {
  color: var(--color-grey-600);
}

.error-text {
  color: var(--color-error-600);
}

.notice {
  padding: var(--spacing-8) var(--spacing-12);
  border-radius: var(--radius-xs);
  background: var(--color-success-200);
  color: var(--color-success-700);
}

.notice--warning {
  background: var(--color-warning-100);
  color: var(--color-warning-900);
}

.venue-name {
  font-size: 1rem;
  font-weight: 700;
  line-height: 1.25rem;
  color: var(--color-grey-900);
}

.cell-text {
  font-size: 1rem;
  line-height: 1.25rem;
  color: var(--color-grey-900);
}

.row-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--spacing-8);
}

</style>
