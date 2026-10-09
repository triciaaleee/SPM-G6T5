<script setup lang="ts">
/**
 * E5-1 AC1: Technical Support Staff's view of every equipment request
 * Event Coordinators have recorded, newest first.
 *
 * E5-3: each card also lets Technical Support update that request's status
 * as arrangements are made (AC1), recording a note on what remains
 * outstanding when only partly fulfilled (AC2). The assigned coordinator is
 * notified by the backend either way.
 */
import { reactive, onMounted, ref } from "vue";
import {
  EQUIPMENT_REQUEST_STATUSES,
  EquipmentRequestError,
  EquipmentValidationError,
  fetchAllEquipmentRequests,
  updateEquipmentRequestStatus,
  type EquipmentRequestStatus,
  type EquipmentRequestWithEvent,
} from "../lib/equipmentApi";

const requests = ref<EquipmentRequestWithEvent[]>([]);
const loading = ref(true);
const errorMessage = ref<string | null>(null);

interface EditState {
  expanded: boolean;
  status: EquipmentRequestStatus;
  note: string;
  saving: boolean;
  error: string | null;
  notice: { text: string; warning: boolean } | null;
}

const edits = reactive<Record<number, EditState>>({});

function editFor(r: EquipmentRequestWithEvent): EditState {
  if (!edits[r.id]) {
    edits[r.id] = {
      expanded: false,
      status: (r.status as EquipmentRequestStatus) || "Requested",
      note: r.fulfillmentNote ?? "",
      saving: false,
      error: null,
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
  edit.error = null;
  edit.expanded = true;
}

function cancelEdit(r: EquipmentRequestWithEvent): void {
  editFor(r).expanded = false;
}

async function saveStatus(r: EquipmentRequestWithEvent): Promise<void> {
  const edit = editFor(r);
  edit.saving = true;
  edit.error = null;
  edit.notice = null;
  try {
    const { equipmentRequest, notified } = await updateEquipmentRequestStatus(r.id, edit.status, edit.note);
    Object.assign(r, equipmentRequest);
    edit.note = equipmentRequest.fulfillmentNote ?? "";
    edit.expanded = false;
    edit.notice = notified
      ? { text: "Status updated. The coordinator has been notified.", warning: false }
      : { text: "Status updated, but we couldn't notify the coordinator — please follow up directly.", warning: true };
  } catch (err) {
    edit.error =
      err instanceof EquipmentValidationError
        ? err.fields.note ?? err.fields.status ?? "Please check the status and note."
        : err instanceof EquipmentRequestError
          ? err.message
          : "We couldn't update this request. Please try again.";
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
    requests.value = await fetchAllEquipmentRequests();
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
    <div class="page-header">
      <h1 class="h2">Equipment requests</h1>
      <p class="subheading">Requests Event Coordinators have recorded, newest first</p>
    </div>

    <p v-if="loading" class="body-default muted full-row">Loading equipment requests…</p>
    <p v-else-if="errorMessage" class="body-default error-text full-row">{{ errorMessage }}</p>

    <div v-else-if="requests.length === 0" class="empty-state full-row">
      <p class="empty-state__title">Nothing here yet</p>
      <p class="body-default muted">No equipment requests have been recorded.</p>
    </div>

    <ul v-else class="request-list full-row">
      <li v-for="r in requests" :key="r.id" class="request-card">
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
            <strong>{{ item.quantity }}&times; {{ item.equipmentType }}</strong>
            <span v-if="item.technicalRequirements" class="muted"> — {{ item.technicalRequirements }}</span>
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

            <div v-if="editFor(r).status === 'Partially Fulfilled'" class="field">
              <label :for="`note-${r.id}`" class="body-small muted mb-1">What remains outstanding</label>
              <textarea :id="`note-${r.id}`" v-model="editFor(r).note" class="status-note" rows="2"></textarea>
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

@media (max-width: 1024px) {
  .page {
    grid-template-columns: repeat(6, 1fr);
    padding: var(--spacing-32) var(--grid-tablet-margin);
  }

  .page-header,
  .full-row {
    grid-column: 1 / 7;
  }
}

@media (max-width: 640px) {
  .page {
    grid-template-columns: repeat(4, 1fr);
    padding: var(--spacing-24) var(--grid-mobile-margin);
  }

  .page-header,
  .full-row {
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
