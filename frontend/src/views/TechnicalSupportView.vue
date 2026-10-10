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
  fetchAllEquipmentRequests,
  fetchEquipmentCatalog,
  updateEquipmentRequestStatus,
  type EquipmentCatalogItem,
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
  note: string;
  /** itemId -> fulfilled quantity, as a text input value (Partially Fulfilled only). */
  fulfilled: Record<number, string>;
  saving: boolean;
  error: string | null;
  fieldErrors: Record<string, string>;
  notice: { text: string; warning: boolean } | null;
}

const edits = reactive<Record<number, EditState>>({});

function defaultFulfilled(r: EquipmentRequestWithEvent): Record<number, string> {
  const out: Record<number, string> = {};
  for (const item of r.items) {
    // Already partly recorded -> keep it; otherwise assume the full amount
    // and let Technical Support lower whichever items came up short.
    out[item.id] = String(r.status === "Partially Fulfilled" ? item.quantityFulfilled : item.quantity);
  }
  return out;
}

function editFor(r: EquipmentRequestWithEvent): EditState {
  if (!edits[r.id]) {
    edits[r.id] = {
      expanded: false,
      status: (r.status as EquipmentRequestStatus) || "Requested",
      note: r.fulfillmentNote ?? "",
      fulfilled: defaultFulfilled(r),
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
  edit.note = r.fulfillmentNote ?? "";
  edit.fulfilled = defaultFulfilled(r);
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

async function saveStatus(r: EquipmentRequestWithEvent): Promise<void> {
  const edit = editFor(r);
  edit.saving = true;
  edit.error = null;
  edit.fieldErrors = {};
  edit.notice = null;
  try {
    const fulfillments =
      edit.status === "Partially Fulfilled"
        ? r.items.map((item) => ({ itemId: item.id, fulfilledQuantity: edit.fulfilled[item.id] }))
        : undefined;
    const { equipmentRequest, notified } = await updateEquipmentRequestStatus(r.id, edit.status, edit.note, fulfillments);
    Object.assign(r, equipmentRequest);
    edit.note = equipmentRequest.fulfillmentNote ?? "";
    edit.expanded = false;
    edit.notice = notified
      ? { text: "Status updated. The coordinator has been notified.", warning: false }
      : { text: "Status updated, but we couldn't notify the coordinator — please follow up directly.", warning: true };
    // The save may have moved stock (Arranged/Partially Fulfilled take
    // items off the shelf, moving away from either returns them) — refresh
    // so the stock table on the left never shows a stale count.
    await refreshCatalog();
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
                <strong>
                  <template v-if="r.status === 'Partially Fulfilled'">{{ item.quantityFulfilled }} of {{ item.quantity }}</template>
                  <template v-else>{{ item.quantity }}&times;</template>
                  {{ item.equipmentType }}
                </strong>
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

                <!-- AC2: exactly how much of each item was handed out — drives both the
                     note's premise and the stock released back to the shelf. -->
                <div v-if="editFor(r).status === 'Partially Fulfilled'" class="fulfilled-items">
                  <div v-for="item in r.items" :key="item.id" class="fulfilled-item">
                    <label :for="`fulfilled-${r.id}-${item.id}`" class="body-small muted">
                      {{ item.equipmentType }} (requested {{ item.quantity }})
                    </label>
                    <input
                      :id="`fulfilled-${r.id}-${item.id}`"
                      v-model="editFor(r).fulfilled[item.id]"
                      type="number"
                      min="0"
                      :max="item.quantity"
                      class="fulfilled-input"
                    />
                    <p v-if="editFor(r).fieldErrors[`fulfillments[${item.id}]`]" class="body-small error-text">
                      {{ editFor(r).fieldErrors[`fulfillments[${item.id}]`] }}
                    </p>
                  </div>

                  <div class="field">
                    <label :for="`note-${r.id}`" class="body-small muted mb-1">What remains outstanding</label>
                    <textarea :id="`note-${r.id}`" v-model="editFor(r).note" class="status-note" rows="2"></textarea>
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

.fulfilled-item {
  display: grid;
  grid-template-columns: 1fr 100px;
  align-items: center;
  gap: var(--spacing-8);
}

.fulfilled-input {
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  color: var(--color-grey-900);
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-xs);
  padding: var(--spacing-8) var(--spacing-12);
  width: 100%;
}

.status-note {
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  color: var(--color-grey-900);
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-xs);
  padding: var(--spacing-8) var(--spacing-12);
  width: 100%;
  resize: vertical;
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
