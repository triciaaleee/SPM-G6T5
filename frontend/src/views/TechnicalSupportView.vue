<script setup lang="ts">
/**
 * E5-1 AC1: Technical Support Staff's view of every equipment request
 * Event Coordinators have recorded, newest first.
 *
 * E5-3: each card also lets Technical Support update that request's status
 * as arrangements are made (AC1), recording a note — and, for a partial
 * fulfilment, exactly how much of each item was handed out (AC2). That
 * per-item amount is what moves stock in equipment_catalog (migration
 * 0022), so the left-hand stock table reflects it as soon as it's saved.
 *
 * Layout: a 1/4-width stock table (current availability per equipment
 * type) alongside a 3/4-width requests panel, split into Requested /
 * Arranged / Partially Fulfilled tabs so Technical Support can see what
 * still needs attention without scanning every request.
 */
import { computed, reactive, onMounted, ref } from "vue";
import {
  EQUIPMENT_REQUEST_STATUSES,
  EquipmentRequestError,
  EquipmentValidationError,
  checkEquipmentAvailability,
  fetchAllEquipmentRequests,
  fetchEquipmentCatalog,
  updateEquipmentRequestStatus,
  type EquipmentAvailability,
  type EquipmentCatalogItem,
  type EquipmentItem,
  type EquipmentRequestStatus,
  type EquipmentRequestWithEvent,
} from "../lib/equipmentApi";

const requests = ref<EquipmentRequestWithEvent[]>([]);
const catalog = ref<EquipmentCatalogItem[]>([]);
const loading = ref(true);
const errorMessage = ref<string | null>(null);

const activeTab = ref<EquipmentRequestStatus>("Requested");

const requestsByTab = computed(() => {
  const groups: Record<EquipmentRequestStatus, EquipmentRequestWithEvent[]> = {
    Requested: [],
    Arranged: [],
    "Partially Fulfilled": [],
  };
  for (const r of requests.value) {
    const status = (r.status as EquipmentRequestStatus) in groups ? (r.status as EquipmentRequestStatus) : "Requested";
    groups[status].push(r);
  }
  return groups;
});

const visibleRequests = computed(() => requestsByTab.value[activeTab.value]);

interface EditState {
  expanded: boolean;
  status: EquipmentRequestStatus;
  saving: boolean;
  error: string | null;
  fieldErrors: Record<string, string>;
  notice: { text: string; warning: boolean } | null;
}

const edits = reactive<Record<number, EditState>>({});

function editFor(r: EquipmentRequestWithEvent): EditState {
  if (!edits[r.id]) {
    edits[r.id] = {
      expanded: false,
      status: (r.status as EquipmentRequestStatus) || "Requested",
      saving: false,
      error: null,
      fieldErrors: {},
      notice: null,
    };
  }
  return edits[r.id];
}

/** Opens the editor, resynced to the request's current status — discards any stale pick from last time. */
function openEditor(r: EquipmentRequestWithEvent): void {
  const edit = editFor(r);
  edit.status = (r.status as EquipmentRequestStatus) || "Requested";
  edit.error = null;
  edit.fieldErrors = {};
  edit.expanded = true;
}

function cancelEdit(r: EquipmentRequestWithEvent): void {
  editFor(r).expanded = false;
}

async function refreshCatalog(): Promise<void> {
  try {
    catalog.value = await fetchEquipmentCatalog();
  } catch {
    // Non-fatal: the stock table just keeps showing its last known values.
  }
}

/**
 * E5-4: "check whether enough suitable equipment is free for a date and
 * time so I do not over-commit" — run per item, against the request's own
 * event, before deciding how to arrange it.
 */
interface AvailabilityCheckState {
  loading: boolean;
  error: string | null;
  result: EquipmentAvailability | null;
}

const availabilityChecks = reactive<Record<number, AvailabilityCheckState>>({});

function availabilityFor(item: EquipmentItem): AvailabilityCheckState {
  if (!availabilityChecks[item.id]) {
    availabilityChecks[item.id] = { loading: false, error: null, result: null };
  }
  return availabilityChecks[item.id];
}

async function checkAvailability(r: EquipmentRequestWithEvent, item: EquipmentItem): Promise<void> {
  const state = availabilityFor(item);
  state.loading = true;
  state.error = null;
  try {
    state.result = await checkEquipmentAvailability(r.eventId, item.equipmentType, item.quantity);
  } catch (err) {
    state.error = err instanceof EquipmentRequestError ? err.message : "Couldn't check availability.";
  } finally {
    state.loading = false;
  }
}

/**
 * Only meaningful before Technical Support has acted: once a request is
 * Arranged or Partially Fulfilled, the decision is already made, so the
 * check no longer applies. Runs every Requested item in parallel.
 */
async function checkAllAvailability(targetRequests: EquipmentRequestWithEvent[]): Promise<void> {
  const requested = targetRequests.filter((r) => r.status === "Requested");
  await Promise.all(requested.flatMap((r) => r.items.map((item) => checkAvailability(r, item))));
}

/**
 * Auto-generates what remains outstanding from the fulfilled-quantity
 * inputs, rather than asking Technical Support to type it out separately —
 * the per-item numbers already say exactly what's short.
 */
/**
 * No manual entry at all: fulfilled = however much is actually free right
 * now (equipment_catalog.available_stock, the same number the stock table
 * on the left shows), capped at what was requested.
 */
function fulfilledQuantityFor(item: EquipmentItem): number {
  const available = catalog.value.find((c) => c.name === item.equipmentType)?.availableStock ?? 0;
  return Math.min(item.quantity, Math.max(0, available));
}

function outstandingSummary(r: EquipmentRequestWithEvent): string {
  const parts = r.items
    .map((item) => {
      const remaining = item.quantity - fulfilledQuantityFor(item);
      return remaining > 0 ? `${remaining} ${item.equipmentType}` : null;
    })
    .filter((part): part is string => part !== null);
  return parts.length > 0 ? `${parts.join(", ")} outstanding` : "All requested items have been fulfilled";
}

async function saveStatus(r: EquipmentRequestWithEvent): Promise<void> {
  const edit = editFor(r);
  edit.saving = true;
  edit.error = null;
  edit.fieldErrors = {};
  edit.notice = null;
  try {
    const fulfillments =
      edit.status === "Partially Fulfilled"
        ? r.items.map((item) => ({ itemId: item.id, fulfilledQuantity: fulfilledQuantityFor(item) }))
        : undefined;
    const note = edit.status === "Partially Fulfilled" ? outstandingSummary(r) : undefined;
    const { equipmentRequest, notified } = await updateEquipmentRequestStatus(r.id, edit.status, note, fulfillments);
    Object.assign(r, equipmentRequest);
    edit.expanded = false;
    edit.notice = notified
      ? { text: "Status updated. The coordinator has been notified.", warning: false }
      : { text: "Status updated, but we couldn't notify the coordinator — please follow up directly.", warning: true };
    // The save may have moved stock (Arranged/Partially Fulfilled take
    // items off the shelf, moving away from either returns them) — refresh
    // so the stock table on the left never shows a stale count.
    await refreshCatalog();
    if (r.status === "Requested") {
      void checkAllAvailability([r]);
    } else {
      // The decision is made — clear any stale check so it can't reappear
      // (e.g. re-opening the editor) once the request has moved on.
      for (const item of r.items) {
        const state = availabilityFor(item);
        state.loading = false;
        state.error = null;
        state.result = null;
      }
    }
  } catch (err) {
    if (err instanceof EquipmentValidationError) {
      edit.fieldErrors = err.fields;
      edit.error = err.fields.note ?? err.fields.status ?? null;
    } else if (err instanceof EquipmentRequestError) {
      edit.error = err.message;
    } else {
      edit.error = "We couldn't update this request. Please try again.";
    }
  } finally {
    edit.saving = false;
  }
}

/** Colour-codes the status badge, same red/amber/green convention as event statuses elsewhere. */
function statusBadgeClass(status: string): string {
  if (status === "Arranged") return "status-success";
  if (status === "Partially Fulfilled") return "status-warning";
  return "status-neutral"; // Requested
}

onMounted(async () => {
  try {
    const [loadedRequests, loadedCatalog] = await Promise.all([fetchAllEquipmentRequests(), fetchEquipmentCatalog()]);
    requests.value = loadedRequests;
    catalog.value = loadedCatalog;
    // Progressive: the list renders first, each item's availability fills
    // in as its own check resolves rather than blocking the whole page.
    void checkAllAvailability(loadedRequests);
  } catch {
    errorMessage.value = "We couldn't load equipment requests. Please try again.";
  } finally {
    loading.value = false;
  }
});

function formatDate(value: string | null): string {
  if (!value) return "Date not set";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

function formatTimeRange(start: string | null, end: string | null): string {
  return start && end ? `${start} – ${end}` : "Time not specified";
}

function formatSubmitted(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}
</script>

<template>
  <div class="page">
    <div class="page-header full-row">
      <h1 class="h2">Equipment requests</h1>
      <p class="subheading">Requests Event Coordinators have recorded, newest first</p>
    </div>

    <p v-if="loading" class="body-default muted full-row">Loading equipment requests…</p>
    <p v-else-if="errorMessage" class="body-default error-text full-row">{{ errorMessage }}</p>

    <template v-else>
      <!-- Left 1/4: current stock, read straight from equipment_catalog. -->
      <section class="stock-col" aria-labelledby="stock-title">
        <h2 id="stock-title" class="h3">Equipment stock</h2>
        <table v-if="catalog.length > 0" class="stock-table">
          <thead>
            <tr>
              <th scope="col">Equipment</th>
              <th scope="col">Available</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in catalog" :key="item.id">
              <td>{{ item.name }}</td>
              <td :class="{ 'stock-low': item.availableStock === 0 }">{{ item.availableStock }}</td>
            </tr>
          </tbody>
        </table>
        <p v-else class="body-small muted">No equipment catalog recorded yet.</p>
      </section>

      <!-- Right 3/4: incoming requests, split by status so the queue that needs action is obvious. -->
      <section class="requests-col">
        <div class="tabs" role="tablist" aria-label="Request status">
          <button
            v-for="tabStatus in EQUIPMENT_REQUEST_STATUSES"
            :key="tabStatus"
            type="button"
            role="tab"
            :aria-selected="activeTab === tabStatus"
            class="tab"
            :class="{ 'tab--active': activeTab === tabStatus }"
            @click="activeTab = tabStatus"
          >
            {{ tabStatus }}
            <span class="tab-count">{{ requestsByTab[tabStatus].length }}</span>
          </button>
        </div>

        <div v-if="visibleRequests.length === 0" class="empty-state">
          <p class="empty-state__title">Nothing here yet</p>
          <p class="body-default muted">No requests are currently {{ activeTab.toLowerCase() }}.</p>
        </div>

        <ul v-else class="request-list">
          <li v-for="r in visibleRequests" :key="r.id" class="request-card">
            <div class="request-card__header">
              <!-- Not a link: events-service's full event detail is organiser/coordinator-only,
                   same as venue_staff's schedule (VenueStaff.vue) — technical_support can't open it. -->
              <p class="card-title">{{ r.event?.name || `Event #${r.eventId}` }}</p>
              <span class="badge" :class="statusBadgeClass(r.status)">{{ r.status }}</span>
            </div>
            <p class="body-small muted">
              {{ formatDate(r.event?.proposedDate ?? null) }} · {{ formatTimeRange(r.event?.startTime ?? null, r.event?.endTime ?? null) }}
            </p>
            <p class="body-small muted request-card__submitted">Submitted {{ formatSubmitted(r.createdAt) }}</p>

            <ul class="item-list">
              <li v-for="item in r.items" :key="item.id" class="body-default item-row">
                <div class="item-row__main">
                  <strong>
                    <template v-if="r.status === 'Partially Fulfilled'">{{ item.quantityFulfilled }} of {{ item.quantity }}</template>
                    <template v-else>{{ item.quantity }}&times;</template>
                    {{ item.equipmentType }}
                  </strong>
                </div>

                <!-- E5-4: checked automatically against the event's own date/time —
                     green when enough is free, red with the shortfall otherwise. Only
                     meaningful before a decision has been made on the request. -->
                <template v-if="r.status === 'Requested'">
                  <p v-if="availabilityFor(item).loading" class="body-small muted">Checking availability…</p>
                  <p v-else-if="availabilityFor(item).error" class="body-small error-text">{{ availabilityFor(item).error }}</p>
                  <p v-else-if="availabilityFor(item).result" class="body-small availability-result"
                    :class="{ 'availability-result--short': availabilityFor(item).result!.shortfall > 0 }">
                    <template v-if="availabilityFor(item).result!.shortfall > 0">
                      Unavailable — need {{ availabilityFor(item).result!.shortfall }} more
                    </template>
                    <template v-else>Available</template>
                  </p>
                </template>
              </li>
            </ul>

            <p v-if="r.fulfillmentNote" class="body-small muted request-card__note">
              Outstanding: {{ r.fulfillmentNote }}
            </p>

            <!-- E5-3: update this request's status as arrangements are made -->
            <div class="status-editor">
              <button
                v-if="!editFor(r).expanded"
                type="button"
                class="btn btn-secondary"
                @click="openEditor(r)"
              >
                Update status
              </button>

              <div v-else class="status-form">
                <div class="status-pills" role="radiogroup" aria-label="Status">
                  <button
                    v-for="option in EQUIPMENT_REQUEST_STATUSES"
                    :key="option"
                    type="button"
                    role="radio"
                    :aria-checked="editFor(r).status === option"
                    class="status-pill"
                    :class="{ 'status-pill--active': editFor(r).status === option }"
                    @click="editFor(r).status = option"
                  >
                    {{ option }}
                  </button>
                </div>

                <!-- AC2: what remains outstanding, computed automatically from current
                     stock (equipment_catalog.available_stock) — nothing to type. -->
                <div v-if="editFor(r).status === 'Partially Fulfilled'" class="fulfilled-items">
                  <div class="field">
                    <p class="body-small muted mb-1">Outstanding</p>
                    <p class="body-small outstanding-preview">{{ outstandingSummary(r) }}</p>
                  </div>
                </div>

                <p v-if="editFor(r).error" class="body-small error-text">{{ editFor(r).error }}</p>

                <div class="status-form-actions">
                  <button type="button" class="btn btn-primary" :disabled="editFor(r).saving" @click="saveStatus(r)">
                    {{ editFor(r).saving ? "Saving…" : "Save" }}
                  </button>
                  <button type="button" class="btn btn-secondary" :disabled="editFor(r).saving" @click="cancelEdit(r)">
                    Cancel
                  </button>
                </div>
              </div>

              <p
                v-if="editFor(r).notice"
                class="body-small status-notice"
                :class="{ 'status-notice--warning': editFor(r).notice?.warning }"
                role="status"
              >
                {{ editFor(r).notice?.text }}
              </p>
            </div>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<style scoped>
.page {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: var(--spacing-24) var(--grid-desktop-gutter);
  padding: var(--spacing-40) var(--grid-desktop-margin);
  align-content: start;
}

.page-header,
.full-row {
  grid-column: 1 / 13;
}

.stock-col {
  grid-column: 1 / 4;
}

.requests-col {
  grid-column: 4 / 13;
}

@media (max-width: 1024px) {
  .page {
    grid-template-columns: repeat(6, 1fr);
    padding: var(--spacing-32) var(--grid-tablet-margin);
  }

  .page-header,
  .full-row,
  .stock-col,
  .requests-col {
    grid-column: 1 / 7;
  }
}

@media (max-width: 640px) {
  .page {
    grid-template-columns: repeat(4, 1fr);
    padding: var(--spacing-24) var(--grid-mobile-margin);
  }

  .page-header,
  .full-row,
  .stock-col,
  .requests-col {
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

.h3 {
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
  margin: 0 0 var(--spacing-12);
}

.subheading {
  font-size: 1.125rem;
  font-weight: 400;
  line-height: 1.375rem;
  color: var(--color-grey-500);
  margin: var(--spacing-8) 0 0;
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

/* Stock table ----------------------------------------------------------- */

.stock-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
}

.stock-table th {
  text-align: left;
  color: var(--color-grey-500);
  font-weight: 700;
  padding: var(--spacing-8);
  border-bottom: 1px solid var(--color-grey-200);
}

.stock-table td {
  padding: var(--spacing-8);
  border-bottom: 1px solid var(--color-grey-100);
  color: var(--color-grey-900);
}

.stock-low {
  color: var(--color-error-600);
  font-weight: 700;
}

/* Tabs -------------------------------------------------------------------- */

.tabs {
  display: flex;
  gap: var(--spacing-8);
  margin-bottom: var(--spacing-16);
  border-bottom: 1px solid var(--color-grey-100);
}

.tab {
  font-family: var(--font-family-lato);
  font-size: 0.9375rem;
  font-weight: 700;
  color: var(--color-grey-500);
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  padding: var(--spacing-8) var(--spacing-4) var(--spacing-12);
  margin-bottom: -1px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-8);
}

.tab:hover {
  color: var(--color-grey-900);
}

.tab--active {
  color: var(--color-purple-600);
  border-bottom-color: var(--color-purple-600);
}

.tab-count {
  font-size: 0.75rem;
  font-weight: 700;
  padding: 0 var(--spacing-8);
  border-radius: 999px;
  background: var(--color-grey-100);
  color: var(--color-grey-700, var(--color-grey-900));
}

.tab--active .tab-count {
  background: var(--color-purple-100);
  color: var(--color-purple-800);
}

/* Request list ------------------------------------------------------------ */

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: var(--spacing-40) var(--spacing-24);
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-sm);
}

.empty-state__title {
  margin: 0 0 var(--spacing-8);
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
}

.request-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-16);
  list-style: none;
  margin: 0;
  padding: 0;
}

.request-card {
  padding: var(--spacing-24);
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-sm);
}

.request-card__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-12);
}

.card-title {
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
  margin: 0;
}

.request-card__submitted {
  margin-bottom: var(--spacing-12);
}

.badge {
  display: inline-block;
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  padding: var(--spacing-4) var(--spacing-8);
  border-radius: var(--radius-xs);
  flex-shrink: 0;
}

.status-neutral {
  background: var(--color-purple-100);
  color: var(--color-purple-800);
}

.status-success {
  background: #e5eee5;
  color: var(--color-success-700);
}

.status-warning {
  background: #fef5e7;
  color: var(--color-warning-600);
}

.item-list {
  margin: 0;
  padding-top: var(--spacing-12);
  border-top: 1px solid var(--color-grey-100);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-4);
  list-style: none;
}

.item-row {
  color: var(--color-grey-900);
  padding: var(--spacing-4) 0;
}

.item-row__main {
  display: flex;
  align-items: center;
  gap: var(--spacing-8);
}

.availability-result {
  margin: var(--spacing-4) 0 0;
  color: var(--color-success-700);
}

.availability-result--short {
  color: var(--color-error-600);
}

.request-card__note {
  margin-top: var(--spacing-8);
  padding: var(--spacing-8) var(--spacing-12);
  border-radius: var(--radius-xs);
  background: var(--color-warning-100);
  color: var(--color-warning-900);
}

.status-editor {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--spacing-8);
  margin-top: var(--spacing-12);
  padding-top: var(--spacing-12);
  border-top: 1px solid var(--color-grey-100);
}

.status-form {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-12);
  width: 100%;
}

.status-pills {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-8);
}

.status-pill {
  font-family: var(--font-family-lato);
  font-size: 0.8125rem;
  font-weight: 700;
  color: var(--color-grey-700, var(--color-grey-900));
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-200);
  border-radius: 999px;
  padding: var(--spacing-8) var(--spacing-16);
  cursor: pointer;
}

.status-pill:hover {
  border-color: var(--color-purple-300, var(--color-purple-600));
}

.status-pill--active {
  background: var(--color-purple-600);
  border-color: var(--color-purple-600);
  color: var(--color-base-white);
}

.fulfilled-items {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-12);
  padding: var(--spacing-12);
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-xs);
}

.outstanding-preview {
  font-family: var(--font-family-lato);
  color: var(--color-grey-900);
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-xs);
  padding: var(--spacing-8) var(--spacing-12);
  margin: 0;
  width: 100%;
}

.field {
  min-width: 0;
  width: 100%;
}

.mb-1 {
  margin-bottom: var(--spacing-8);
}

.status-form-actions {
  display: flex;
  gap: var(--spacing-8);
}

.btn {
  border-radius: var(--radius-xs);
  padding: var(--spacing-8) var(--spacing-16);
  font-size: 0.875rem;
  font-weight: 700;
  border: 1px solid transparent;
  cursor: pointer;
}

.btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.btn-primary {
  background: var(--color-purple-600);
  color: var(--color-base-white);
}

.btn-primary:not(:disabled):hover {
  background: var(--color-purple-700, var(--color-purple-600));
}

.btn-secondary {
  background: var(--color-grey-75);
  color: var(--color-grey-900);
  border-color: var(--color-grey-200);
}

.btn-secondary:not(:disabled):hover {
  background: var(--color-grey-100);
}

.status-notice {
  padding: var(--spacing-8) var(--spacing-12);
  border-radius: var(--radius-xs);
  background: var(--color-grey-75);
}

.status-notice--warning {
  background: var(--color-warning-100);
  color: var(--color-warning-900);
}
</style>
