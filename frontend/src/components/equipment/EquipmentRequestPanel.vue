<script setup lang="ts">
/**
 * E5-1: the assigned coordinator records what equipment an event needs.
 * Lives in the event detail page's Equipment Requirements card, alongside
 * past requests already recorded for this event.
 *
 * AC2: there's no clean way to turn the Organiser's free-text equipment
 * note into structured items (type/quantity/requirements), so it's shown
 * as read-only reference text above a blank item row rather than guessed
 * at by parsing it.
 */
import { onMounted, reactive, ref } from "vue";
import {
  EquipmentRequestError,
  EquipmentValidationError,
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
  /** Whether the viewer may submit a new request right now. */
  canSubmit: boolean;
}>();

/** E3-1 AC3: lets EventDetailView refresh its own copy of this event's
 * requests (used by the outstanding-arrangements line) once a new one lands. */
const emit = defineEmits<{ submitted: [] }>();

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

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString();
}

/** Colour-codes the status badge so "Arranged" reads as resolved at a glance — same convention as TechnicalSupportView.vue. */
function statusBadgeClass(status: string): string {
  if (status === "Arranged") return "status-success";
  if (status === "Partially Fulfilled") return "status-warning";
  return "status-neutral"; // Requested
}
</script>

<template>
  <section class="eq-panel" aria-labelledby="equipment-requests-title">
    <p id="equipment-requests-title" class="body-default font-semibold eq-title">Equipment Requirements</p>

    <p v-if="loading" class="body-small muted">Loading equipment requests…</p>

    <template v-else>
      <ul v-if="requests.length > 0" class="eq-list">
        <li v-for="r in requests" :key="r.id" class="eq-request">
          <div class="eq-request__header">
            <span class="badge" :class="statusBadgeClass(r.status)">{{ r.status }}</span>
            <p class="body-small muted">Submitted {{ formatDate(r.createdAt) }}</p>
          </div>
          <!-- E5-3 AC1/AC2: Technical Support's status updates, and what's left outstanding, as they happen -->
          <p v-if="r.fulfillmentNote" class="body-small muted eq-outstanding">Outstanding: {{ r.fulfillmentNote }}</p>
          <ul class="eq-items">
            <li v-for="item in r.items" :key="item.id" class="body-small">
              <strong>{{ item.quantity }}&times; {{ item.equipmentType }}</strong>
            </li>
          </ul>
        </li>
      </ul>
      <p v-else class="body-small muted">No equipment requirements recorded yet.</p>

      <div v-if="canSubmit" class="eq-action">
        <button v-if="!formOpen" type="button" class="btn btn-secondary" @click="openForm">
          Record equipment requirements
        </button>

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
            <button type="button" class="btn btn-primary" :disabled="submitting" @click="submit">
              {{ submitting ? "Submitting…" : "Submit request" }}
            </button>
            <button type="button" class="btn btn-secondary" :disabled="submitting" @click="closeForm">Cancel</button>
          </div>
        </div>

        <p v-if="notice" class="body-small eq-notice" :class="{ 'eq-notice--warning': notice.warning }" role="status">
          {{ notice.text }}
        </p>
      </div>
    </template>
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

.eq-request__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-8);
  margin-bottom: var(--spacing-4);
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

.btn {
  border-radius: var(--radius-xs);
  padding: var(--spacing-12) var(--spacing-16);
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

.eq-notice {
  padding: var(--spacing-8) var(--spacing-12);
  border-radius: var(--radius-xs);
  background: var(--color-grey-75);
}

.eq-notice--warning {
  background: var(--color-warning-100);
  color: var(--color-warning-900);
}
</style>
