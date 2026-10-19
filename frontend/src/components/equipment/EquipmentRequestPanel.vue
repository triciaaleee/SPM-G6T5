<script setup lang="ts">
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
import { computed, onMounted, reactive, ref } from "vue";
import {
  CANCELLED_REQUEST_STATUS,
  EquipmentRequestError,
  EquipmentValidationError,
  amendEquipmentRequest,
  cancelEquipmentRequest,
  fetchEquipmentCatalog,
  fetchEquipmentRequestsForEvent,
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
    <p id="equipment-requests-title" class="body-default font-semibold eq-title">Equipment Requirements</p>

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
            <span class="badge" :class="statusBadgeClass(r.status)">{{ r.status }}</span>
            <p class="body-small muted">Submitted {{ formatDate(r.createdAt) }}</p>
          </div>
          <!-- E5-3 AC1/AC2: Technical Support's status updates, and what's left outstanding, as they happen -->
          <p v-if="r.fulfillmentNote && !isCancelled(r)" class="body-small muted eq-outstanding">Outstanding: {{ r.fulfillmentNote }}</p>

          <template v-if="amendingId !== r.id">
            <ul class="eq-items">
              <li v-for="item in r.items" :key="item.id" class="body-small">
                <strong>{{ item.quantity }}&times; {{ item.equipmentType }}</strong>
                <span v-if="item.quantityFulfilled > 0 && !isCancelled(r)" class="muted">
                  · {{ item.quantityFulfilled }} reserved</span>
                <!-- E5-5 / E5-6 AC3: the reservation no longer holds (e.g. a reserved unit is now unusable). -->
                <p v-if="item.reservationFlag?.flagged && !isCancelled(r)" class="eq-flag" data-testid="reservation-flag" role="alert">
                  {{ item.reservationFlag.reason }}
                </p>
              </li>
            </ul>

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
                <button
                  type="button"
                  class="eq-remove"
                  :disabled="amendRows.length === 1"
                  aria-label="Remove item"
                  @click="removeAmendRow(index)"
                >
                  &times;
                </button>
              </div>
              <p v-if="releaseNote(row)" class="body-small eq-release-note" data-testid="release-note">{{ releaseNote(row) }}</p>
            </div>

            <p v-for="note in removedReserved" :key="note" class="body-small eq-release-note" data-testid="removed-note">{{ note }}</p>

            <button type="button" class="eq-add" @click="addAmendRow">+ Add another item</button>

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
        <AppButton variant="outline" v-if="!formOpen" type="button" @click="openForm">
          Record equipment requirements
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
            <button
              type="button"
              class="eq-remove"
              :disabled="formItems.length === 1"
              aria-label="Remove item"
              @click="removeItem(index)"
            >
              &times;
            </button>
          </div>

          <button type="button" class="eq-add" @click="addItem">+ Add another item</button>

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
    <div v-if="cancelTarget" class="modal-overlay" @click.self="keepRequest" @keydown.esc="keepRequest">
      <div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="cancel-eq-title" aria-describedby="cancel-eq-body">
        <p id="cancel-eq-title" class="modal-title">Cancel this equipment request?</p>
        <p id="cancel-eq-body" class="body-default muted">
          <template v-if="reservedCount(cancelTarget) > 0">
            {{ reservedCount(cancelTarget) }} reserved {{ reservedCount(cancelTarget) === 1 ? "item" : "items" }} will be
            released back to inventory.
          </template>
          Technical Support will be notified.
        </p>
        <p v-if="cancelError" class="body-small error-text" role="alert">{{ cancelError }}</p>
        <div class="modal-actions">
          <AppButton variant="outline" :disabled="cancelling" @click="keepRequest">Keep request</AppButton>
          <AppButton variant="danger-solid" :disabled="cancelling" data-testid="confirm-cancel" @click="confirmCancel">
            {{ cancelling ? "Cancelling…" : "Cancel request" }}
          </AppButton>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
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
  color: var(--color-grey-500);
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

.badge {
  display: inline-block;
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  padding: var(--spacing-4) var(--spacing-8);
  border-radius: var(--radius-xs);
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

.eq-items {
  margin: 0;
  padding-left: var(--spacing-16);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-2);
}

.eq-action {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
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
  font-family: var(--font-family-lato);
  font-size: 0.9375rem;
  color: var(--color-grey-900);
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-xs);
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
  width: 32px;
  height: 32px;
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-xs);
  background: var(--color-base-white);
  color: var(--color-error-600);
  cursor: pointer;
}

.eq-remove:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.eq-add {
  align-self: flex-start;
  background: none;
  border: none;
  padding: 0;
  color: var(--color-purple-600);
  font-size: 0.875rem;
  font-weight: 700;
  cursor: pointer;
}

.eq-add:hover {
  text-decoration: underline;
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
</style>
