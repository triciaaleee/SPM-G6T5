<script setup lang="ts">
import IconButton from "../ui/IconButton.vue";
import AppModal from "../ui/AppModal.vue";
import StatusBadge from "../ui/StatusBadge.vue";
/**
 * E5-1: the assigned coordinator records what equipment an event needs.
 * Lives in the event detail page's Equipment Requirements card, alongside
 * past requests already recorded for this event.
 *
 * E5-2: while the event is in Planning the coordinator can amend a request's
 * types and quantities (lowering a quantity below what Technical Support have
 * reserved releases the surplus back to inventory) or cancel it entirely
 * (everything reserved is released). Technical Support are notified either
 * way. A cancelled request stays in the list, greyed out, below the active
 * ones.
 *
 * AC2 (E5-1): there's no clean way to turn the Organiser's free-text equipment
 * note into structured items (type/quantity/requirements), so it's shown
 * as read-only reference text above a blank item row rather than guessed
 * at by parsing it.
 */
import AppButton from "../ui/AppButton.vue";
import DataTable from "../ui/DataTable.vue";
import { PlusIcon, XMarkIcon } from "@heroicons/vue/20/solid";
import { computed, onMounted, reactive, ref } from "vue";
import {
  CANCELLED_REQUEST_STATUS,
  EquipmentRequestError,
  EquipmentValidationError,
  amendEquipmentRequest,
  cancelEquipmentRequest,
  fetchEquipmentCatalog,
  fetchEquipmentRequestsForEvent,
  itemFulfilmentBadgeClass,
  itemFulfilmentState,
  submitEquipmentRequest,
  type EquipmentCatalogItem,
  type EquipmentItemInput,
  type EquipmentRequest,
} from "../../lib/equipmentApi";

const props = defineProps<{
  eventId: number;
  /** The Organiser's original free-text equipment note, if any (AC2). */
  organiserNote: string | null;
  /** Whether the viewer may submit, amend or cancel a request right now (assigned coordinator, event in Planning). */
  canSubmit: boolean;
}>();

/** E3-1 AC3: lets EventDetailView refresh its own copy of this event's
 * requests (used by the outstanding-arrangements line) once a new one lands
 * (`submitted`) or one is amended or cancelled (`changed`). */
const emit = defineEmits<{ submitted: []; changed: [] }>();

const requests = ref<EquipmentRequest[]>([]);
const loading = ref(true);
const catalog = ref<EquipmentCatalogItem[]>([]);

async function load(): Promise<void> {
  loading.value = true;
  try {
    const [loadedRequests, loadedCatalog] = await Promise.all([
      fetchEquipmentRequestsForEvent(props.eventId),
      fetchEquipmentCatalog(),
    ]);
    requests.value = loadedRequests;
    catalog.value = loadedCatalog;
  } catch {
    requests.value = [];
  } finally {
    loading.value = false;
  }
}

onMounted(load);

/** Active requests first; cancelled ones sink to the bottom, in their original order (the sort is stable). */
const sortedRequests = computed(() => [
  ...requests.value.filter((r) => r.status !== CANCELLED_REQUEST_STATUS),
  ...requests.value.filter((r) => r.status === CANCELLED_REQUEST_STATUS),
]);

/**
 * One table per request: the equipment component, how many were asked for and how many Technical Support have
 * reserved. The request has a single status, shown once in its header rather than as a column.
 */
const ITEM_COLUMNS = [
  { key: "equipment", label: "Equipment" },
  { key: "quantity", label: "Quantity" },
  { key: "reserved", label: "Reserved" },
];
const ITEM_COLUMN_WIDTHS = "minmax(0, 3fr) minmax(0, 1fr) minmax(0, 1fr)";

function isCancelled(r: EquipmentRequest): boolean {
  return r.status === CANCELLED_REQUEST_STATUS;
}

function blankItem(): EquipmentItemInput {
  return { equipmentCatalogId: "", quantity: "1" };
}

const formOpen = ref(false);
const formItems = reactive<EquipmentItemInput[]>([blankItem()]);
const fieldErrors = ref<Record<string, string>>({});
const generalError = ref<string | null>(null);
const submitting = ref(false);
const notice = ref<{ text: string; warning: boolean } | null>(null);

function openForm(): void {
  formItems.splice(0, formItems.length, blankItem());
  fieldErrors.value = {};
  generalError.value = null;
  notice.value = null;
  stopAmend();
  formOpen.value = true;
}

function closeForm(): void {
  formOpen.value = false;
}

function addItem(): void {
  formItems.push(blankItem());
}

function removeItem(index: number): void {
  if (formItems.length > 1) formItems.splice(index, 1);
}

async function submit(): Promise<void> {
  submitting.value = true;
  generalError.value = null;
  fieldErrors.value = {};
  try {
    const { equipmentRequest, notified } = await submitEquipmentRequest(props.eventId, formItems);
    requests.value = [equipmentRequest, ...requests.value];
    emit("submitted");
    formOpen.value = false;
    notice.value = notified
      ? { text: "Equipment request submitted. Technical Support has been notified.", warning: false }
      : { text: "Equipment request submitted, but we couldn't notify Technical Support — please follow up directly.", warning: true };
  } catch (err) {
    if (err instanceof EquipmentValidationError) {
      fieldErrors.value = err.fields;
    } else {
      generalError.value = err instanceof EquipmentRequestError ? err.message : "We couldn't submit this request. Please try again.";
    }
  } finally {
    submitting.value = false;
  }
}

// --- E5-2: amend ------------------------------------------------------------

/** One editable row of the request being amended. `reserved` is what Technical Support have already reserved of it. */
interface AmendRow {
  itemId?: number;
  equipmentCatalogId: number | string;
  quantity: number | string;
  reserved: number;
  originalCatalogId: number | null;
}

const amendingId = ref<number | null>(null);
const amendRows = reactive<AmendRow[]>([]);
const amendErrors = ref<Record<string, string>>({});
const amendError = ref<string | null>(null);
const amending = ref(false);
/** Reserved equipment released just by removing a row, listed so the coordinator sees it before saving. */
const removedReserved = ref<string[]>([]);

/** Arranged is fully fulfilled: it can't be amended, only cancelled and raised again. */
function canAmend(r: EquipmentRequest): boolean {
  return props.canSubmit && (r.status === "Requested" || r.status === "Partially Fulfilled");
}

function canCancel(r: EquipmentRequest): boolean {
  return props.canSubmit && !isCancelled(r);
}

function startAmend(r: EquipmentRequest): void {
  formOpen.value = false;
  notice.value = null;
  amendErrors.value = {};
  amendError.value = null;
  removedReserved.value = [];
  amendRows.splice(
    0,
    amendRows.length,
    ...r.items.map((item) => ({
      itemId: item.id,
      equipmentCatalogId: item.equipmentCatalogId ?? "",
      quantity: String(item.quantity),
      reserved: item.quantityFulfilled,
      originalCatalogId: item.equipmentCatalogId ?? null,
    })),
  );
  amendingId.value = r.id;
}

function stopAmend(): void {
  amendingId.value = null;
  amendRows.splice(0, amendRows.length);
  amendErrors.value = {};
  amendError.value = null;
  removedReserved.value = [];
}

function addAmendRow(): void {
  amendRows.push({ equipmentCatalogId: "", quantity: "1", reserved: 0, originalCatalogId: null });
}

function catalogName(id: number | string): string {
  return catalog.value.find((entry) => entry.id === Number(id))?.name ?? "this item";
}

function removeAmendRow(index: number): void {
  if (amendRows.length <= 1) return;
  const [row] = amendRows.splice(index, 1);
  if (row.itemId !== undefined && row.reserved > 0) {
    removedReserved.value.push(`${row.reserved}× ${catalogName(row.originalCatalogId ?? "")} reserved will be released.`);
  }
}

/** What saving would release for this row, shown beside it so the coordinator isn't surprised by AC2. */
function releaseNote(row: AmendRow): string | null {
  if (row.itemId === undefined || row.reserved <= 0) return null;
  if (Number(row.equipmentCatalogId) !== row.originalCatalogId) {
    return `All ${row.reserved} reserved will be released back to inventory.`;
  }
  const surplus = row.reserved - Number(row.quantity);
  return surplus > 0 ? `${surplus} of the ${row.reserved} reserved will be released back to inventory.` : null;
}

async function saveAmendment(r: EquipmentRequest): Promise<void> {
  amending.value = true;
  amendError.value = null;
  amendErrors.value = {};
  try {
    const result = await amendEquipmentRequest(
      r.id,
      amendRows.map((row) => ({ itemId: row.itemId, equipmentCatalogId: row.equipmentCatalogId, quantity: row.quantity })),
    );
    requests.value = requests.value.map((existing) => (existing.id === r.id ? result.equipmentRequest : existing));
    stopAmend();
    emit("changed");
    const released =
      result.released > 0
        ? ` ${result.released} reserved ${result.released === 1 ? "item was" : "items were"} released back to inventory.`
        : "";
    if (result.changes.length === 0) {
      notice.value = { text: "No changes were made.", warning: false };
    } else if (result.notified) {
      notice.value = {
        text: `Equipment request amended. Technical Support has been notified of what changed.${released}`,
        warning: false,
      };
    } else {
      notice.value = {
        text: `Equipment request amended, but we couldn't notify Technical Support — please follow up directly.${released}`,
        warning: true,
      };
    }
  } catch (err) {
    if (err instanceof EquipmentValidationError) {
      amendErrors.value = err.fields;
    } else {
      amendError.value = err instanceof EquipmentRequestError ? err.message : "We couldn't amend this request. Please try again.";
    }
  } finally {
    amending.value = false;
  }
}

// --- E5-2: cancel -----------------------------------------------------------

const cancelTarget = ref<EquipmentRequest | null>(null);
const cancelling = ref(false);
const cancelError = ref<string | null>(null);

function reservedCount(r: EquipmentRequest): number {
  return r.items.reduce((sum, item) => sum + item.quantityFulfilled, 0);
}

function askToCancel(r: EquipmentRequest): void {
  cancelError.value = null;
  cancelTarget.value = r;
}

function keepRequest(): void {
  if (!cancelling.value) cancelTarget.value = null;
}

async function confirmCancel(): Promise<void> {
  const target = cancelTarget.value;
  if (!target || cancelling.value) return;
  cancelling.value = true;
  cancelError.value = null;
  try {
    const result = await cancelEquipmentRequest(target.id);
    requests.value = requests.value.map((existing) => (existing.id === target.id ? result.equipmentRequest : existing));
    if (amendingId.value === target.id) stopAmend();
    cancelTarget.value = null;
    emit("changed");
    const released = result.released.reduce((sum, item) => sum + item.quantity, 0);
    const releasedText = released > 0 ? ` ${released} reserved ${released === 1 ? "item was" : "items were"} released back to inventory.` : "";
    notice.value = result.notified
      ? { text: `Equipment request cancelled. Technical Support has been notified.${releasedText}`, warning: false }
      : { text: `Equipment request cancelled, but we couldn't notify Technical Support — please follow up directly.${releasedText}`, warning: true };
  } catch (err) {
    cancelError.value = err instanceof EquipmentRequestError ? err.message : "We couldn't cancel this request. Please try again.";
  } finally {
    cancelling.value = false;
  }
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

/** Colour-codes the status badge so "Arranged" reads as resolved at a glance — same convention as TechnicalSupportView.vue. */
function statusBadgeClass(status: string): string {
  if (status === "Arranged") return "status-success";
  if (status === "Partially Fulfilled") return "status-warning";
  if (status === CANCELLED_REQUEST_STATUS) return "status-cancelled";
  return "status-neutral"; // Requested
}
</script>

<template>
  <section class="eq-panel" aria-labelledby="equipment-requests-title">
    <p id="equipment-requests-title" class="body-default font-bold eq-title">Equipment Requirements</p>

    <p v-if="loading" class="body-small muted">Loading equipment requests…</p>

    <template v-else>
      <ul v-if="requests.length > 0" class="eq-list">
        <li
          v-for="r in sortedRequests"
          :key="r.id"
          class="eq-request"
          :class="{ 'eq-request--cancelled': isCancelled(r) }"
          :data-testid="`eq-request-${r.id}`"
        >
          <div class="eq-request__header">
            <StatusBadge :status-class="statusBadgeClass(r.status)">{{ r.status }}</StatusBadge>
            <p class="body-small muted">Submitted {{ formatDate(r.createdAt) }}</p>
          </div>
          <!-- E5-3 AC1/AC2: Technical Support's status updates, and what's left outstanding, as they happen -->
          <p v-if="r.fulfillmentNote && !isCancelled(r)" class="body-small muted eq-outstanding">Outstanding: {{ r.fulfillmentNote }}</p>

          <template v-if="amendingId !== r.id">
            <div class="eq-items">
              <DataTable
                :columns="ITEM_COLUMNS"
                :column-widths="ITEM_COLUMN_WIDTHS"
                :rows="r.items"
                :row-key="(item) => item.id"
              >
                <template #cell-equipment="{ row }">
                  <span class="eq-equipment">
                    <strong class="eq-equipment__name">{{ row.equipmentType }}</strong>
                    <!-- E5-5 / E5-6 AC3: the reservation no longer holds (e.g. a reserved unit is now unusable). -->
                    <span v-if="row.reservationFlag?.flagged && !isCancelled(r)" class="eq-flag" data-testid="reservation-flag"
                      role="alert">
                      {{ row.reservationFlag.reason }}
                    </span>
                  </span>
                </template>
                <template #cell-quantity="{ row }">{{ row.quantity }}</template>
                <template #cell-reserved="{ row }">
                  <template v-if="isCancelled(r)">&mdash;</template>
                  <template v-else>
                    {{ row.quantityFulfilled }} of {{ row.quantity }}
                    <span
                      v-if="r.status !== 'Requested'"
                      class="eq-item-state"
                      :class="itemFulfilmentBadgeClass(row.quantityFulfilled, row.quantity, 'status-neutral')"
                      data-testid="item-status"
                    >{{ itemFulfilmentState(row.quantityFulfilled, row.quantity) }}</span>
                  </template>
                </template>
              </DataTable>
            </div>

            <div v-if="canAmend(r) || canCancel(r)" class="eq-request__actions">
              <AppButton v-if="canAmend(r)" variant="outline" size="sm" type="button" data-testid="amend-request" @click="startAmend(r)">
                Amend
              </AppButton>
              <AppButton v-if="canCancel(r)" variant="danger" size="sm" type="button" data-testid="cancel-request" @click="askToCancel(r)">
                Cancel request
              </AppButton>
            </div>
            <p v-if="props.canSubmit && r.status === 'Arranged'" class="body-small muted eq-hint" data-testid="arranged-hint">
              Fully arranged. To change it, cancel it and record a new request.
            </p>
          </template>

          <!-- E5-2 AC1/AC2: amend types and quantities in place -->
          <div v-else class="eq-form eq-form--amend" data-testid="amend-form">
            <p v-if="amendError" class="body-small error-text">{{ amendError }}</p>
            <p v-if="amendErrors.items" class="body-small error-text">{{ amendErrors.items }}</p>

            <div v-for="(row, index) in amendRows" :key="row.itemId ?? `new-${index}`" class="eq-amend-row">
              <div class="eq-item-row">
                <div class="field">
                  <label :for="`amend-type-${index}`" class="body-small muted mb-1">Equipment type</label>
                  <select :id="`amend-type-${index}`" v-model="row.equipmentCatalogId" class="eq-input">
                    <option value="" disabled>Select…</option>
                    <option v-for="catalogItem in catalog" :key="catalogItem.id" :value="catalogItem.id">
                      {{ catalogItem.name }}
                    </option>
                  </select>
                  <p v-if="amendErrors[`items[${index}].equipmentCatalogId`]" class="body-small error-text">
                    {{ amendErrors[`items[${index}].equipmentCatalogId`] }}
                  </p>
                </div>
                <div class="field eq-field-qty">
                  <label :for="`amend-qty-${index}`" class="body-small muted mb-1">Quantity</label>
                  <input :id="`amend-qty-${index}`" v-model="row.quantity" type="number" min="1" class="eq-input" />
                  <p v-if="amendErrors[`items[${index}].quantity`]" class="body-small error-text">
                    {{ amendErrors[`items[${index}].quantity`] }}
                  </p>
                </div>
                <IconButton label="Remove item" size="sm" class="eq-remove" :disabled="amendRows.length === 1" @click="removeAmendRow(index)"><XMarkIcon aria-hidden="true" /></IconButton>
              </div>
              <p v-if="releaseNote(row)" class="body-small eq-release-note" data-testid="release-note">{{ releaseNote(row) }}</p>
            </div>

            <p v-for="note in removedReserved" :key="note" class="body-small eq-release-note" data-testid="removed-note">{{ note }}</p>

            <AppButton variant="link" class="eq-add" @click="addAmendRow">+ Add another item</AppButton>

            <div class="eq-form-actions">
              <AppButton variant="primary" type="button" :disabled="amending" data-testid="save-amendment" @click="saveAmendment(r)">
                {{ amending ? "Saving…" : "Save changes" }}
              </AppButton>
              <AppButton variant="outline" type="button" :disabled="amending" @click="stopAmend">Cancel</AppButton>
            </div>
          </div>
        </li>
      </ul>
      <p v-else class="body-small muted">No equipment requirements recorded yet.</p>

      <p v-if="notice && !formOpen" class="body-small eq-notice" :class="{ 'eq-notice--warning': notice.warning }" role="status">
        {{ notice.text }}
      </p>

      <div v-if="canSubmit" class="eq-action">
        <AppButton v-if="!formOpen" variant="ghost" type="button" class="eq-new-request" data-testid="request-new-equipment"
          @click="openForm">
          <PlusIcon class="eq-new-request__plus" aria-hidden="true" />
          Add Equipment Request
        </AppButton>

        <div v-else class="eq-form">
          <p v-if="organiserNote" class="body-small muted eq-reference">
            Organiser's stated equipment needs (reference): "{{ organiserNote }}"
          </p>
          <p v-if="generalError" class="body-small error-text">{{ generalError }}</p>
          <p v-if="fieldErrors.items" class="body-small error-text">{{ fieldErrors.items }}</p>

          <div v-for="(item, index) in formItems" :key="index" class="eq-item-row">
            <div class="field">
              <label :for="`eq-type-${index}`" class="body-small muted mb-1">Equipment type</label>
              <select :id="`eq-type-${index}`" v-model="item.equipmentCatalogId" class="eq-input">
                <option value="" disabled>Select…</option>
                <option v-for="catalogItem in catalog" :key="catalogItem.id" :value="catalogItem.id">
                  {{ catalogItem.name }}
                </option>
              </select>
              <p v-if="fieldErrors[`items[${index}].equipmentCatalogId`]" class="body-small error-text">
                {{ fieldErrors[`items[${index}].equipmentCatalogId`] }}
              </p>
            </div>
            <div class="field eq-field-qty">
              <label :for="`eq-qty-${index}`" class="body-small muted mb-1">Quantity</label>
              <input :id="`eq-qty-${index}`" v-model="item.quantity" type="number" min="1" class="eq-input" />
              <p v-if="fieldErrors[`items[${index}].quantity`]" class="body-small error-text">
                {{ fieldErrors[`items[${index}].quantity`] }}
              </p>
            </div>
            <IconButton label="Remove item" size="sm" class="eq-remove" :disabled="formItems.length === 1" @click="removeItem(index)"><XMarkIcon aria-hidden="true" /></IconButton>
          </div>

          <AppButton variant="link" class="eq-add" @click="addItem">+ Add another item</AppButton>

          <div class="eq-form-actions">
            <AppButton variant="primary" type="button" :disabled="submitting" @click="submit">
              {{ submitting ? "Submitting…" : "Submit request" }}
            </AppButton>
            <AppButton variant="outline" type="button" :disabled="submitting" @click="closeForm">Cancel</AppButton>
          </div>
        </div>

        <p v-if="notice && formOpen" class="body-small eq-notice" :class="{ 'eq-notice--warning': notice.warning }" role="status">
          {{ notice.text }}
        </p>
      </div>
    </template>

    <!-- E5-2 AC3: cancelling releases everything reserved at once, so confirm first. -->
    <AppModal v-if="cancelTarget" role="alertdialog" :dismissible="!cancelling" described-by="cancel-eq-body" @close="keepRequest">
      <template #title>Cancel this equipment request?</template>
        <p id="cancel-eq-body" class="body-default muted">
          <template v-if="reservedCount(cancelTarget) > 0">
            {{ reservedCount(cancelTarget) }} reserved {{ reservedCount(cancelTarget) === 1 ? "item" : "items" }} will be
            released back to inventory.
          </template>
          Technical Support will be notified.
        </p>
        <p v-if="cancelError" class="body-small error-text" role="alert">{{ cancelError }}</p>
      <template #actions>
          <AppButton variant="outline" :disabled="cancelling" @click="keepRequest">Keep request</AppButton>
          <AppButton variant="danger-solid" :disabled="cancelling" data-testid="confirm-cancel" @click="confirmCancel">
            {{ cancelling ? "Cancelling…" : "Cancel request" }}
          </AppButton>
      </template>
    </AppModal>
  </section>
</template>

<style scoped>
.muted {
  color: var(--color-grey-600);
}

.error-text {
  color: var(--color-error-600);
}

.eq-panel {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-12);
}

.eq-title {
  color: var(--color-grey-900);
}

.eq-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
  margin: 0;
  padding: 0;
  list-style: none;
}

.eq-request {
  padding: var(--spacing-12);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-xs);
  background: var(--color-base-white);
}

/* E5-2: a cancelled request stays as history, greyed out below the active ones. */
.eq-request--cancelled {
  background: var(--color-grey-50);
}

.eq-request--cancelled .eq-items,
.eq-request--cancelled .eq-items strong {
  color: var(--color-grey-600);
  opacity: 0.8;
}

.eq-request__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-8);
  margin-bottom: var(--spacing-4);
}

.eq-request__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-8);
  margin-top: var(--spacing-12);
}

.eq-hint {
  margin: var(--spacing-8) 0 0;
}

/* One item's own progress inside the table; the request's single status stays the header .badge. */
.eq-item-state {
  display: inline-block;
  margin-left: var(--spacing-8);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  padding: var(--spacing-4) var(--spacing-8);
  border-radius: var(--radius-xs);
}

/* Cancelled: neutral grey, like a finished event's badge (EventCard's status-over). */
.status-cancelled {
  background: var(--color-grey-200);
  color: var(--color-grey-900);
}

.eq-flag {
  margin: var(--spacing-4) 0 0;
  padding: var(--spacing-4) var(--spacing-8);
  border-radius: var(--radius-xs);
  background: var(--color-warning-100);
  color: var(--color-warning-900);
  font-size: 0.875rem;
  line-height: 1.125rem;
}

.eq-outstanding {
  margin: 0 0 var(--spacing-4);
  padding: var(--spacing-4) var(--spacing-8);
  border-radius: var(--radius-xs);
  background: var(--color-warning-100);
  color: var(--color-warning-900);
}

/* The request's table (shared DataTable); the flag message sits under the item's name in its cell. */
.eq-items {
  margin-top: var(--spacing-8);
}

.eq-equipment {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-4);
  min-width: 0;
}

.eq-equipment__name {
  font-weight: 700;
}

.eq-action {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
}

/* Same ghost button as "Request another venue": + icon, no horizontal padding, 5px in from the card edge, and only the text darkens on hover. */
.eq-action .eq-new-request {
  align-self: flex-start;
  padding-left: 0;
  padding-right: 0;
  margin-left: var(--spacing-6);
}

.eq-action .eq-new-request:hover:not(:disabled):not(.btn--disabled) {
  background: transparent;
  color: var(--color-purple-700);
}

.eq-new-request__plus {
  width: 1.25rem;
  height: 1.25rem;
  flex-shrink: 0;
}

.eq-form {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-12);
  padding: var(--spacing-12);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-xs);
  background: var(--color-base-white);
}

/* The amend form sits inside the request's own card, so it needs no second border. */
.eq-form--amend {
  padding: var(--spacing-8) 0 0;
  border: none;
}

.eq-reference {
  padding: var(--spacing-8) var(--spacing-12);
  border-radius: var(--radius-xs);
  background: var(--color-grey-75);
}

.eq-item-row {
  display: grid;
  grid-template-columns: 1fr 100px auto;
  gap: var(--spacing-8);
  align-items: start;
}

@media (max-width: 640px) {
  .eq-item-row {
    grid-template-columns: 1fr;
  }
}

.eq-amend-row {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-4);
}

/* What saving would release back to inventory (Warning set, the "needs your attention" role). */
.eq-release-note {
  margin: 0;
  padding: var(--spacing-4) var(--spacing-8);
  border-radius: var(--radius-xs);
  background: var(--color-warning-100);
  color: var(--color-warning-900);
}

.eq-input {
  width: 100%;
  font-size: 1rem;
  line-height: 1.25rem;
  padding: var(--spacing-8) var(--spacing-12);
}

.field {
  min-width: 0;
}

.mb-1 {
  margin-bottom: var(--spacing-8);
}

.eq-remove {
  align-self: center;
  margin-top: var(--spacing-24);
}

.eq-form-actions {
  display: flex;
  gap: var(--spacing-8);
}

.eq-notice {
  padding: var(--spacing-8) var(--spacing-12);
  border-radius: var(--radius-xs);
  background: var(--color-grey-75);
}

.eq-notice--warning {
  background: var(--color-warning-100);
  color: var(--color-warning-900);
}

/* Cancel confirmation: same modal as the attendee's withdraw dialog, over the Drawer scrim (Style.md 3.5). */
/* Subheading, bold */
</style>
