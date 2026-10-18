<script setup lang="ts">
/**
 * E5-1 AC3: the equipment inventory. Technical Support see every item with
 * its total and available stock and can correct either number, or add a new
 * item. Available stock can never be more than total stock; the backend
 * checks that and says which field is wrong. Request status changes keep
 * moving available stock on their own, so an edit here is a correction.
 */
import AppButton from "../components/ui/AppButton.vue";
import { computed, onMounted, reactive, ref } from "vue";
import {
  EquipmentRequestError,
  EquipmentValidationError,
  createCatalogItem,
  fetchEquipmentCatalog,
  updateCatalogItem,
  type EquipmentCatalogItem,
} from "../lib/equipmentApi";

const items = ref<EquipmentCatalogItem[]>([]);
const loading = ref(true);
const errorMessage = ref<string | null>(null);

interface RowDraft {
  total: string;
  available: string;
  saving: boolean;
  fieldErrors: Record<string, string>;
  error: string | null;
  saved: boolean;
}

const drafts = reactive<Record<number, RowDraft>>({});

function resetDraft(item: EquipmentCatalogItem): void {
  drafts[item.id] = {
    total: String(item.totalStock),
    available: String(item.availableStock),
    saving: false,
    fieldErrors: {},
    error: null,
    saved: false,
  };
}

function draftFor(item: EquipmentCatalogItem): RowDraft {
  if (!drafts[item.id]) resetDraft(item);
  return drafts[item.id];
}

/** A count field is a whole number, 0 or more. Blank or anything else is not saved. */
function parseCount(value: string): number | null {
  return /^\d+$/.test(value.trim()) ? Number(value.trim()) : null;
}

function isDirty(item: EquipmentCatalogItem): boolean {
  const draft = draftFor(item);
  return draft.total.trim() !== String(item.totalStock) || draft.available.trim() !== String(item.availableStock);
}

async function saveRow(item: EquipmentCatalogItem): Promise<void> {
  const draft = draftFor(item);
  draft.fieldErrors = {};
  draft.error = null;
  draft.saved = false;

  const total = parseCount(draft.total);
  const available = parseCount(draft.available);
  if (total === null) draft.fieldErrors.totalStock = "Whole number, 0 or more.";
  if (available === null) draft.fieldErrors.availableStock = "Whole number, 0 or more.";
  if (total !== null && available !== null && available > total) {
    draft.fieldErrors.availableStock = "Cannot be more than total stock.";
  }
  if (Object.keys(draft.fieldErrors).length > 0) return;

  draft.saving = true;
  try {
    const updated = await updateCatalogItem(item.id, { totalStock: total!, availableStock: available! });
    Object.assign(item, updated);
    resetDraft(item);
    drafts[item.id].saved = true;
  } catch (err) {
    if (err instanceof EquipmentValidationError) draft.fieldErrors = err.fields;
    else if (err instanceof EquipmentRequestError) draft.error = err.message;
    else draft.error = "We couldn't save that change. Please try again.";
  } finally {
    draft.saving = false;
  }
}

// Add item ------------------------------------------------------------------

const newName = ref("");
const newTotal = ref("0");
const adding = ref(false);
const addErrors = ref<Record<string, string>>({});
const addError = ref<string | null>(null);

const canAdd = computed(() => newName.value.trim() !== "" && !adding.value);

async function addItem(): Promise<void> {
  addErrors.value = {};
  addError.value = null;

  const total = parseCount(newTotal.value);
  if (total === null) {
    addErrors.value = { totalStock: "Whole number, 0 or more." };
    return;
  }

  adding.value = true;
  try {
    const created = await createCatalogItem(newName.value.trim(), total);
    items.value = [...items.value, created].sort((a, b) => a.name.localeCompare(b.name));
    newName.value = "";
    newTotal.value = "0";
  } catch (err) {
    if (err instanceof EquipmentValidationError) addErrors.value = err.fields;
    else if (err instanceof EquipmentRequestError) addError.value = err.message;
    else addError.value = "We couldn't add that item. Please try again.";
  } finally {
    adding.value = false;
  }
}

onMounted(async () => {
  try {
    items.value = await fetchEquipmentCatalog();
  } catch {
    errorMessage.value = "We couldn't load the equipment inventory. Please try again.";
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <!--
    Column mapping — Equipment inventory
    Desktop (12-col, grid-desktop-margin 80px): header col 1-12; add-item card and inventory table col 1-12.
    Tablet (6-col, grid-tablet-margin 32px): everything col 1-6; the table scrolls inside its card.
    Mobile (4-col, grid-mobile-margin 6px): everything col 1-4; the add-item fields stack.
  -->
  <div class="page">
    <div class="page-header">
      <h1 class="h2">Equipment inventory</h1>
      <p class="subheading">Check what is in stock and correct the numbers when they change</p>
    </div>

    <p v-if="loading" class="full body-default muted">Loading the inventory…</p>
    <p v-else-if="errorMessage" class="full body-default error-text" role="alert">{{ errorMessage }}</p>

    <template v-else>
      <section class="card" aria-labelledby="add-title">
        <h2 id="add-title" class="h4">Add an item</h2>
        <form class="add-form" @submit.prevent="addItem">
          <div class="field field--grow">
            <label for="new-name" class="field-label">Name</label>
            <input id="new-name" v-model="newName" type="text" class="input" maxlength="100" autocomplete="off"
              :aria-invalid="!!addErrors.name" aria-describedby="new-name-error" />
            <p id="new-name-error" class="field-error" role="alert">{{ addErrors.name }}</p>
          </div>
          <div class="field">
            <label for="new-total" class="field-label">Total stock</label>
            <input id="new-total" v-model="newTotal" type="text" inputmode="numeric" class="input input--count"
              :aria-invalid="!!addErrors.totalStock" aria-describedby="new-total-error" />
            <p id="new-total-error" class="field-error" role="alert">{{ addErrors.totalStock }}</p>
          </div>
          <AppButton variant="primary" type="submit" class="add-button" :disabled="!canAdd">
            {{ adding ? "Adding…" : "Add item" }}
          </AppButton>
        </form>
        <p v-if="addError" class="field-error" role="alert">{{ addError }}</p>
      </section>

      <section class="card" aria-labelledby="stock-title">
        <h2 id="stock-title" class="h4">Items</h2>

        <p v-if="items.length === 0" class="body-default muted">No equipment has been added yet.</p>

        <div v-else class="table-wrap">
          <table class="stock-table">
            <thead>
              <tr>
                <th scope="col">Equipment</th>
                <th scope="col">Total stock</th>
                <th scope="col">Available</th>
                <th scope="col"><span class="visually-hidden">Save</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in items" :key="item.id">
                <th scope="row" class="item-name">{{ item.name }}</th>
                <td>
                  <input :id="`total-${item.id}`" v-model="draftFor(item).total" type="text" inputmode="numeric"
                    class="input input--count" :aria-label="`Total stock of ${item.name}`"
                    :aria-invalid="!!draftFor(item).fieldErrors.totalStock" @input="draftFor(item).saved = false" />
                  <p class="field-error" role="alert">{{ draftFor(item).fieldErrors.totalStock }}</p>
                </td>
                <td>
                  <input :id="`available-${item.id}`" v-model="draftFor(item).available" type="text"
                    inputmode="numeric" class="input input--count"
                    :class="{ 'input--low': item.availableStock === 0 }"
                    :aria-label="`Available stock of ${item.name}`"
                    :aria-invalid="!!draftFor(item).fieldErrors.availableStock" @input="draftFor(item).saved = false" />
                  <p class="field-error" role="alert">{{ draftFor(item).fieldErrors.availableStock }}</p>
                </td>
                <td class="row-actions">
                  <AppButton variant="outline" type="button" :aria-label="`Save ${item.name}`"
                    :disabled="!isDirty(item) || draftFor(item).saving" @click="saveRow(item)">
                    {{ draftFor(item).saving ? "Saving…" : "Save" }}
                  </AppButton>
                  <p v-if="draftFor(item).saved" class="row-note" role="status">Saved</p>
                  <p v-if="draftFor(item).error" class="field-error" role="alert">{{ draftFor(item).error }}</p>
                </td>
              </tr>
            </tbody>
          </table>
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
  padding: var(--spacing-40) var(--grid-desktop-margin) var(--spacing-80);
  align-content: start;
}

.page-header,
.full,
.card {
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
  .card {
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
  .card {
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

.h4 {
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
  margin: 0;
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
  margin: 0;
}

.muted {
  color: var(--color-grey-500);
}

.error-text {
  color: var(--color-error-600);
}

.card {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-16);
  padding: var(--spacing-24);
  box-sizing: border-box;
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
}

/* Add form ------------------------------------------------------------------ */

.add-form {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: var(--spacing-16);
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-4);
}

.field--grow {
  flex: 1 1 240px;
}

.field-label {
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  color: var(--color-grey-900);
}

.input {
  height: var(--spacing-48);
  padding: 0 var(--spacing-16);
  box-sizing: border-box;
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-xs);
  background: var(--color-base-white);
  color: var(--color-grey-900);
  font-family: var(--font-family-lato);
  font-size: 1rem;
  line-height: 1.25rem;
}

.input:hover {
  border-color: var(--color-grey-300);
}

.input:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

.input[aria-invalid="true"] {
  border-color: var(--color-error-600);
}

.input--count {
  width: 7.5rem;
}

/* Zero available: the same red the old stock table used. */
.input--low {
  color: var(--color-error-600);
  font-weight: 700;
}

/* Reserves a line so an error appearing doesn't push the layout around. */
.field-error {
  min-height: 1.125rem;
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-error-600);
}

/* Table --------------------------------------------------------------------- */

.table-wrap {
  overflow-x: auto;
}

.stock-table {
  width: 100%;
  border-collapse: collapse;
}

.stock-table th,
.stock-table td {
  padding: var(--spacing-12) var(--spacing-8);
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid var(--color-grey-100);
}

.stock-table thead th {
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  color: var(--color-grey-500);
  border-bottom-color: var(--color-grey-200);
}

.item-name {
  font-size: 1rem;
  font-weight: 700;
  line-height: 1.25rem;
  color: var(--color-grey-900);
  padding-top: calc(var(--spacing-12) + var(--spacing-12));
}

.row-actions {
  white-space: nowrap;
}

.row-note {
  margin: var(--spacing-4) 0 0;
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-success-700);
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

/* Add item is the one solid button; lined up with the inputs beside it (label height + gap). */
.add-button {
  align-self: flex-start;
  margin-top: calc(var(--spacing-20) + var(--spacing-4));
}

</style>
