<script setup lang="ts">
/**
 * The equipment inventory. Technical Support see every item with its total and
 * available stock and can add a new item. The date above the table shows the
 * stock on any day: how many units events hold that day, how many are out of
 * use and how many are left, so they can see what each day's events leave free.
 *
 * Available stock is calculated — from the units, their bookings and their
 * out-of-use periods — so it is read-only here. Total stock changes only
 * through "Add stock" and "Remove stock", each with a quantity and a required
 * reason and a confirmation; the unit rows are created or removed to match, and
 * only free units (not reserved, not out of use) can be removed. Every change is
 * recorded and listed under the item (who, when, how much, why).
 *
 * E5-5: below the stock table, equipment can be marked damaged or under
 * maintenance for a period so it stops being offered to events.
 */
import { ExclamationTriangleIcon } from "@heroicons/vue/16/solid";
import AppButton from "../components/ui/AppButton.vue";
import DataTable from "../components/ui/DataTable.vue";
import EquipmentUnitsPanel from "../components/equipment/EquipmentUnitsPanel.vue";
import { computed, onMounted, reactive, ref } from "vue";
import {
  EquipmentRequestError,
  EquipmentValidationError,
  changeStock,
  createCatalogItem,
  fetchEquipmentCatalog,
  fetchStockHistory,
  type EquipmentCatalogItem,
  type StockChange,
} from "../lib/equipmentApi";

/** Today's calendar date in Singapore (UTC+8), YYYY-MM-DD — the same reading events use. */
function todaySingapore(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const items = ref<EquipmentCatalogItem[]>([]);
const selectedDate = ref(todaySingapore());
const dateLoading = ref(false);
const dateError = ref<string | null>(null);
const isToday = computed(() => selectedDate.value === todaySingapore());
const loading = ref(true);
const errorMessage = ref<string | null>(null);
const notice = ref<string | null>(null);

/**
 * Marking or clearing units changes what is available, so re-read the numbers.
 * The page keeps what it has if that fails.
 */
async function refreshCatalog(): Promise<void> {
  try {
    items.value = await fetchEquipmentCatalog(selectedDate.value);
  } catch {
    // The numbers are only stale until the next load.
  }
}

/** Shows the stock for the chosen day. If it can't be read the table keeps the day it had. */
async function showDate(date: string): Promise<void> {
  if (!date) return;
  const previous = selectedDate.value;
  selectedDate.value = date;
  dateLoading.value = true;
  dateError.value = null;
  try {
    items.value = await fetchEquipmentCatalog(date);
  } catch {
    selectedDate.value = previous;
    dateError.value = "We couldn't load the stock for that day. Please try again.";
  } finally {
    dateLoading.value = false;
  }
}

function showToday(): Promise<void> {
  return showDate(todaySingapore());
}

function formatDay(value: string): string {
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).replace(",", "");
}

const TABLE_COLUMNS = [
  { key: "equipment", label: "Equipment" },
  { key: "total", label: "Total stock" },
  { key: "booked", label: "Booked by events" },
  { key: "outOfUse", label: "Out of use" },
  { key: "available", label: "Available" },
  { key: "actions", label: "Actions" },
];
// `auto` here would size this column from each row's own content — and since every row in this
// DataTable lays out as its own independent CSS Grid, the header row's short "Actions" label would
// then resolve to a narrower track than the body rows' three buttons, throwing the fr-sized columns
// before it out of alignment between the header and the body. A fixed width keeps every row identical.
const TABLE_COLUMN_WIDTHS = "14rem 0.8fr 1fr 0.8fr 0.8fr 22rem";

// Change stock -----------------------------------------------------------------

const change = reactive({
  itemId: null as number | null,
  direction: "add" as "add" | "remove",
  quantity: "1",
  reason: "",
  fieldErrors: {} as Record<string, string>,
  error: null as string | null,
  confirming: false,
  saving: false,
});

const changingItem = computed(() => items.value.find((item) => item.id === change.itemId) ?? null);

function startChange(item: EquipmentCatalogItem, direction: "add" | "remove"): void {
  notice.value = null;
  Object.assign(change, { itemId: item.id, direction, quantity: "1", reason: "", fieldErrors: {}, error: null, confirming: false, saving: false });
}

function cancelChange(): void {
  if (change.saving) return;
  change.itemId = null;
  change.confirming = false;
}

/** A stock quantity is a whole number, 1 or more. */
function parseQuantity(value: string): number | null {
  return /^\d+$/.test(value.trim()) && Number(value) >= 1 ? Number(value.trim()) : null;
}

function reviewChange(): void {
  change.fieldErrors = {};
  change.error = null;
  if (parseQuantity(change.quantity) === null) change.fieldErrors.quantity = "Enter a whole number, 1 or more.";
  if (change.reason.trim() === "") change.fieldErrors.reason = "A reason is required.";
  if (Object.keys(change.fieldErrors).length > 0) return;
  change.confirming = true;
}

/** What the total would become if the change went through. */
const totalAfter = computed(() => {
  const item = changingItem.value;
  const quantity = parseQuantity(change.quantity);
  if (!item || quantity === null) return null;
  return change.direction === "add" ? item.totalStock + quantity : item.totalStock - quantity;
});

async function applyChange(): Promise<void> {
  const item = changingItem.value;
  const quantity = parseQuantity(change.quantity);
  if (!item || quantity === null) return;

  change.saving = true;
  change.error = null;
  try {
    const updated = await changeStock(item.id, { direction: change.direction, quantity, reason: change.reason.trim() });
    const verb = change.direction === "add" ? "Added" : "Removed";
    Object.assign(item, updated);
    // The reply is worked out for today; on another day only the total carries over, so re-read the rest.
    if (!isToday.value) await refreshCatalog();
    notice.value = `${verb} ${quantity} ${item.name}. Total stock is now ${updated.totalStock}.`;
    change.itemId = null;
    change.confirming = false;
    if (histories[item.id]) await loadHistory(item.id);
  } catch (err) {
    // Back to the form, where the problem is shown.
    change.confirming = false;
    if (err instanceof EquipmentValidationError) change.fieldErrors = err.fields;
    else change.error = err instanceof EquipmentRequestError ? err.message : "We couldn't change the stock. Please try again.";
  } finally {
    change.saving = false;
  }
}

// History ------------------------------------------------------------------------

interface HistoryState {
  status: "loading" | "ready" | "error";
  changes: StockChange[];
}

const histories = reactive<Record<number, HistoryState>>({});
const openHistory = reactive(new Set<number>());

/** Whether this row's Add/Remove form or its history is open, so DataTable knows to render the detail row. */
function isRowDetailOpen(item: EquipmentCatalogItem): boolean {
  return change.itemId === item.id || openHistory.has(item.id);
}

async function loadHistory(id: number): Promise<void> {
  histories[id] = { status: "loading", changes: histories[id]?.changes ?? [] };
  try {
    histories[id] = { status: "ready", changes: await fetchStockHistory(id) };
  } catch {
    histories[id] = { status: "error", changes: [] };
  }
}

async function toggleHistory(item: EquipmentCatalogItem): Promise<void> {
  if (openHistory.has(item.id)) {
    openHistory.delete(item.id);
    return;
  }
  openHistory.add(item.id);
  await loadHistory(item.id);
}

function formatWhen(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** A count field is a whole number, 0 or more. Blank or anything else is not saved. */
function parseCount(value: string): number | null {
  return /^\d+$/.test(value.trim()) ? Number(value.trim()) : null;
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

        <div class="stock-header">
          <div class="stock-header__controls">
            <div class="field">
              <label for="stock-date" class="field-label">Stock on</label>
              <input id="stock-date" type="date" class="input" :value="selectedDate" :disabled="dateLoading"
                data-testid="stock-date" @change="showDate(($event.target as HTMLInputElement).value)" />
            </div>
            <AppButton variant="outline" size="sm" type="button" :disabled="dateLoading || isToday" data-testid="stock-today"
              @click="showToday">
              Today
            </AppButton>
          </div>
          <p class="body-small muted stock-header__summary" data-testid="stock-day">
            {{ dateLoading ? "Loading…" : `${formatDay(selectedDate)} · ${items.length} item${items.length === 1 ? "" : "s"}` }}
          </p>
        </div>
        <p class="body-small muted stock-note">
          Available = total stock, minus units booked by events, minus units out of use, for the day shown.
        </p>
        <p v-if="dateError" class="field-error" role="alert" data-testid="stock-date-error">{{ dateError }}</p>

        <p v-if="items.length === 0" class="body-default muted">No equipment has been added yet.</p>

        <p v-if="notice" class="body-small notice" role="status" data-testid="stock-notice">{{ notice }}</p>

        <DataTable v-if="items.length > 0" :columns="TABLE_COLUMNS" :column-widths="TABLE_COLUMN_WIDTHS"
          column-gap="var(--spacing-48)" :rows="items" :row-key="(item) => item.id" :row-detail="isRowDetailOpen"
          :row-test-id="(item) => `item-${item.id}`">
          <template #cell-equipment="{ row: item }">
            <span class="item-name">{{ item.name }}</span>
          </template>

          <template #cell-total="{ row: item }">
            <span class="count" data-testid="total">{{ item.totalStock }}</span>
          </template>

          <template #cell-booked="{ row: item }">
            <span class="count" data-testid="booked">{{ item.bookedCount ?? 0 }}</span>
          </template>

          <template #cell-outOfUse="{ row: item }">
            <span v-if="(item.unusableNow ?? 0) > 0" class="out-of-use-badge" data-testid="out-of-use">
              <ExclamationTriangleIcon class="out-of-use-badge__icon" aria-hidden="true" />
              {{ item.unusableNow }}
            </span>
            <span v-else class="count" data-testid="out-of-use">0</span>
          </template>

          <template #cell-available="{ row: item }">
            <span class="count" :class="{ 'count--low': item.availableStock === 0 }" data-testid="available">
              {{ item.availableStock }}
            </span>
          </template>

          <template #cell-actions="{ row: item }">
            <div class="row-actions">
              <AppButton variant="outline" size="sm" type="button" :aria-label="`Add stock of ${item.name}`"
                data-testid="add-stock" @click="startChange(item, 'add')">
                Add stock
              </AppButton>
              <AppButton variant="outline" size="sm" type="button" :aria-label="`Remove stock of ${item.name}`"
                data-testid="remove-stock" @click="startChange(item, 'remove')">
                Remove stock
              </AppButton>
              <AppButton variant="ghost" size="sm" type="button" :aria-expanded="openHistory.has(item.id)"
                :aria-label="`History of ${item.name}`" data-testid="toggle-history" @click="toggleHistory(item)">
                History
              </AppButton>
            </div>
          </template>

          <template #row-detail="{ row: item }">
            <form v-if="change.itemId === item.id" class="change-form" data-testid="change-form" @submit.prevent="reviewChange">
              <p class="body-small"><strong>{{ change.direction === "add" ? "Add stock" : "Remove stock" }}</strong> — {{ item.name }}</p>
              <p v-if="change.direction === 'remove'" class="body-small muted">
                Only free units can be removed: ones reserved for an event, out of use, or held by a request stay.
              </p>
              <p v-if="change.error" class="field-error" role="alert">{{ change.error }}</p>
              <div class="change-fields">
                <div class="field">
                  <label :for="`qty-${item.id}`" class="field-label">Quantity</label>
                  <input :id="`qty-${item.id}`" v-model="change.quantity" type="text" inputmode="numeric"
                    class="input input--count" :aria-invalid="!!change.fieldErrors.quantity" />
                  <p class="field-error" role="alert">{{ change.fieldErrors.quantity }}</p>
                </div>
                <div class="field field--grow">
                  <label :for="`reason-${item.id}`" class="field-label">Reason</label>
                  <input :id="`reason-${item.id}`" v-model="change.reason" type="text" class="input" maxlength="500"
                    placeholder="Why is the stock changing?" :aria-invalid="!!change.fieldErrors.reason" />
                  <p class="field-error" role="alert">{{ change.fieldErrors.reason }}</p>
                </div>
              </div>
              <div class="change-actions">
                <AppButton variant="primary" type="submit" data-testid="review-change">Review</AppButton>
                <AppButton variant="outline" type="button" @click="cancelChange">Cancel</AppButton>
              </div>
            </form>

            <template v-if="openHistory.has(item.id)">
              <p v-if="histories[item.id]?.status === 'loading'" class="body-small muted">Loading the history…</p>
              <p v-else-if="histories[item.id]?.status === 'error'" class="body-small error-text" role="alert">
                We couldn't load the history. Please try again.
              </p>
              <p v-else-if="histories[item.id]?.changes.length === 0" class="body-small muted">No stock changes recorded yet.</p>
              <ul v-else class="history" :aria-label="`${item.name} stock history`">
                <li v-for="entry in histories[item.id].changes" :key="entry.id" class="history__row body-small" data-testid="history-entry">
                  <span class="history__what">
                    {{ entry.changeType }} {{ entry.quantity }}
                    <span class="muted">({{ entry.totalBefore }} → {{ entry.totalAfter }})</span>
                  </span>
                  <span class="history__reason">{{ entry.reason }}</span>
                  <span class="muted">{{ formatWhen(entry.createdAt) }}<template v-if="entry.changedBy"> · {{ entry.changedBy }}</template></span>
                </li>
              </ul>
            </template>
          </template>
        </DataTable>
      </section>

      <EquipmentUnitsPanel class="card" @changed="refreshCatalog" />
    </template>

    <!-- Changing stock adds or removes real units, so confirm first. -->
    <div v-if="change.confirming && changingItem" class="modal-overlay" @click.self="change.confirming = false">
      <div class="modal" role="alertdialog" aria-modal="true" aria-labelledby="stock-confirm-title" aria-describedby="stock-confirm-body">
        <p id="stock-confirm-title" class="modal-title">
          {{ change.direction === "add" ? "Add" : "Remove" }} {{ parseQuantity(change.quantity) }} {{ changingItem.name }}?
        </p>
        <p id="stock-confirm-body" class="body-default muted">
          Total stock goes from {{ changingItem.totalStock }} to {{ totalAfter }}. Reason: {{ change.reason.trim() }}
        </p>
        <div class="modal-actions">
          <AppButton variant="outline" :disabled="change.saving" @click="change.confirming = false">Back</AppButton>
          <AppButton :variant="change.direction === 'add' ? 'primary' : 'danger-solid'" :disabled="change.saving"
            data-testid="confirm-change" @click="applyChange">
            {{ change.saving ? "Saving…" : change.direction === "add" ? "Add stock" : "Remove stock" }}
          </AppButton>
        </div>
      </div>
    </div>
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
  font-size: 1.75rem;
  font-weight: 700;
  line-height: 2.25rem;
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

/* Calculated counts: plain numbers, not inputs. Zero available is the same red the old stock table used. */
.count {
  font-size: 1rem;
  line-height: 1.25rem;
  color: var(--color-grey-900);
}

.count--low {
  color: var(--color-error-600);
  font-weight: 700;
}

/* Out of use: a warning pill once there is at least one unit, like SafetyReviewPanel's "Needs action" badge. */
.out-of-use-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-4);
  padding: var(--spacing-2) var(--spacing-8);
  border-radius: var(--radius-xs);
  background: var(--color-warning-200);
  color: var(--color-warning-900);
  font-size: 0.875rem;
  font-weight: 700;
}

.out-of-use-badge__icon {
  width: 0.875rem;
  height: 0.875rem;
}

.body-small {
  font-size: 0.875rem;
  line-height: 1.125rem;
  margin: 0;
}

.notice {
  padding: var(--spacing-8) var(--spacing-12);
  border-radius: var(--radius-xs);
  background: var(--color-success-200);
  color: var(--color-success-700);
}

.change-form {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
}

.change-fields {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-16);
}

.change-actions {
  display: flex;
  gap: var(--spacing-8);
}

.history {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
}

.history__row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-8) var(--spacing-16);
}

.history__what {
  font-weight: 700;
  color: var(--color-grey-900);
}

.history__reason {
  flex: 1 1 12rem;
  color: var(--color-grey-700);
}

/* Confirmation: same modal as the attendee's withdraw dialog, over the Drawer scrim (Style.md 3.5). */
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

/* Reserves a line so an error appearing doesn't push the layout around. */
.field-error {
  min-height: 1.125rem;
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-error-600);
}

/* Table --------------------------------------------------------------------- */

/* "Stock on" + Today on the left, the day's full name and item count top-right. */
.stock-header {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--spacing-16);
}

.stock-header__controls {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: var(--spacing-16);
}

.stock-header__summary {
  white-space: nowrap;
}

.stock-note {
  margin: var(--spacing-4) 0 var(--spacing-16);
}

.item-name {
  font-size: 1rem;
  font-weight: 700;
  line-height: 1.25rem;
  color: var(--color-grey-900);
}

.row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-8);
}

.row-note {
  margin: var(--spacing-4) 0 0;
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-success-700);
}

/* Add item is the one solid button; lined up with the inputs beside it (label height + gap). */
.add-button {
  align-self: flex-start;
  margin-top: calc(var(--spacing-20) + var(--spacing-4));
}

</style>
