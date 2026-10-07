<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { ExclamationTriangleIcon, XMarkIcon } from "@heroicons/vue/20/solid";
import {
  PeriodError,
  createUnavailability,
  previewUnavailability,
  updateUnavailability,
  type AffectedBooking,
  type CreatePeriodResult,
  type PeriodDraft,
  type UnavailabilityPeriod,
} from "../../lib/unavailabilityApi";

/**
 * E4-3: venue staff block out a period at a venue — or edit one, when
 * `period` is passed. One day or several; the whole day, or the same hours
 * on each day. Before anything is saved, live bookings (Requested or
 * Approved) the period would cut across are listed (AC2), checked against
 * each event's times widened by the venue's setup and turnaround, so staff
 * know whose plans they're about to change.
 */
const props = defineProps<{
  venueId: number;
  venueName: string;
  initialDate: string;
  period?: UnavailabilityPeriod | null;
}>();
const emit = defineEmits<{ close: []; saved: [result: CreatePeriodResult] }>();

const QUICK_REASONS = ["Maintenance", "Cleaning", "Private hire", "Renovation"];
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const PREVIEW_DELAY_MS = 400;

function todayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

const editing = computed(() => Boolean(props.period));

const today = todayKey();
const start = props.initialDate < today ? today : props.initialDate;
// An edited period may have started already; don't make its own dates unpickable.
const minDate = props.period && props.period.startDate < today ? props.period.startDate : today;

const form = reactive({
  startDate: props.period?.startDate ?? start,
  endDate: props.period?.endDate ?? start,
  allDay: props.period?.allDay ?? true,
  startTime: props.period?.startTime ?? "09:00",
  endTime: props.period?.endTime ?? "13:00",
  reason: props.period?.reason ?? "",
});

const serverFields = ref<Record<string, string>>({});
const saveError = ref<string | null>(null);
const saving = ref(false);
/** Field errors show once the user has tried to save. */
const attempted = ref(false);

const affected = ref<AffectedBooking[]>([]);
const buffers = ref({ setupMinutes: 0, turnaroundMinutes: 0 });
const previewLoading = ref(false);
const previewError = ref<string | null>(null);

const firstField = ref<HTMLInputElement | null>(null);

/** Client-side mirror of the server's rules, so mistakes show inline. */
const clientFields = computed(() => {
  const fields: Record<string, string> = {};
  if (!form.startDate) fields.startDate = "Enter a start date.";
  if (!form.endDate) fields.endDate = "Enter an end date.";
  else if (form.startDate && form.endDate < form.startDate) fields.endDate = "The end date must not be before the start date.";
  if (!form.allDay) {
    if (!TIME_PATTERN.test(form.startTime)) fields.startTime = "Enter a start time.";
    if (!TIME_PATTERN.test(form.endTime)) fields.endTime = "Enter an end time.";
    else if (!fields.startTime && form.endTime <= form.startTime) fields.endTime = "The end time must be after the start time.";
  }
  if (!form.reason.trim()) fields.reason = "Give a reason.";
  return fields;
});

const fieldErrors = computed(() => ({ ...(attempted.value ? clientFields.value : {}), ...serverFields.value }));

/** The period itself is checkable without a reason; the reason only matters for saving. */
const periodValid = computed(() => Object.keys(clientFields.value).every((key) => key === "reason"));

const draft = computed<PeriodDraft>(() => ({
  venueId: props.venueId,
  startDate: form.startDate,
  endDate: form.endDate,
  allDay: form.allDay,
  startTime: form.startTime,
  endTime: form.endTime,
  reason: form.reason.trim(),
}));

function formatDay(key: string, withYear = false): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    ...(withYear ? { year: "numeric" } : {}),
  });
}

const summary = computed(() => {
  if (!periodValid.value) return "";
  const days =
    form.startDate === form.endDate
      ? formatDay(form.startDate, true)
      : `${formatDay(form.startDate)} – ${formatDay(form.endDate, true)}`;
  if (form.allDay) return `${days}, all day`;
  return `${days}, ${form.startTime}–${form.endTime}${form.startDate === form.endDate ? "" : " each day"}`;
});

const submitLabel = computed(() => {
  if (saving.value) return "Saving…";
  if (affected.value.length > 0) return editing.value ? "Save & notify coordinators" : "Block out & notify coordinators";
  return editing.value ? "Save changes" : "Block out time";
});

/** e.g. "30 min setup and 20 min turnaround" — null when the venue needs neither. */
const buffersText = computed(() => {
  const parts = [];
  if (buffers.value.setupMinutes > 0) parts.push(`${buffers.value.setupMinutes} min setup`);
  if (buffers.value.turnaroundMinutes > 0) parts.push(`${buffers.value.turnaroundMinutes} min turnaround`);
  return parts.length > 0 ? parts.join(" and ") : null;
});

// Live AC2 check: re-run (debounced) whenever the period changes. A newer
// check aborts the one in flight so results can't land out of order.
let previewTimer: number | undefined;
let previewAbort: AbortController | null = null;

watch(
  () => [form.startDate, form.endDate, form.allDay, form.startTime, form.endTime],
  () => {
    serverFields.value = {};
    window.clearTimeout(previewTimer);
    previewAbort?.abort();
    if (!periodValid.value) {
      affected.value = [];
      previewError.value = null;
      previewLoading.value = false;
      return;
    }
    previewLoading.value = true;
    previewTimer = window.setTimeout(runPreview, PREVIEW_DELAY_MS);
  },
  { immediate: true },
);

watch(
  () => form.reason,
  () => {
    if (serverFields.value.reason) serverFields.value = { ...serverFields.value, reason: "" };
  },
);

async function runPreview(): Promise<void> {
  const controller = new AbortController();
  previewAbort = controller;
  try {
    // The preview shares the create endpoint's validation, which requires a
    // reason; the reason doesn't change which bookings are affected, so a
    // placeholder lets the check run before one is typed.
    const preview = await previewUnavailability({ ...draft.value, reason: draft.value.reason || "-" }, controller.signal);
    affected.value = preview.affected;
    buffers.value = { setupMinutes: preview.setupMinutes, turnaroundMinutes: preview.turnaroundMinutes };
    previewError.value = null;
  } catch {
    if (controller.signal.aborted) return;
    affected.value = [];
    previewError.value = "We couldn't check this venue's bookings. You can still try saving.";
  } finally {
    if (!controller.signal.aborted) previewLoading.value = false;
  }
}

function formatAffected(booking: AffectedBooking): string {
  if (!booking.startTime || !booking.endTime) return `${formatDay(booking.date)} · times not set`;
  const times = `${booking.startTime}–${booking.endTime}`;
  const widened = booking.occupiedStart !== booking.startTime || booking.occupiedEnd !== booking.endTime;
  return `${formatDay(booking.date)} · ${times}${widened ? ` (venue needed ${booking.occupiedStart}–${booking.occupiedEnd})` : ""}`;
}

function statusLabel(booking: AffectedBooking): string {
  if (booking.status === "Requested") return "Pending request";
  if (booking.status === "On Hold") return "On hold";
  return "Approved";
}

const flaggedCount = computed(() => affected.value.filter((b) => b.replacementRequired).length);
const pendingCount = computed(() => affected.value.length - flaggedCount.value);

async function submit(): Promise<void> {
  attempted.value = true;
  saveError.value = null;
  if (Object.keys(clientFields.value).length > 0) return;

  saving.value = true;
  try {
    const result = props.period
      ? await updateUnavailability(props.period.id, draft.value)
      : await createUnavailability(draft.value);
    emit("saved", result);
  } catch (err) {
    if (err instanceof PeriodError && Object.keys(err.fields).length > 0) {
      serverFields.value = err.fields;
    } else {
      saveError.value = err instanceof Error ? err.message : "Failed to save the block-out.";
    }
  } finally {
    saving.value = false;
  }
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape" && !saving.value) emit("close");
}

onMounted(async () => {
  document.addEventListener("keydown", onKeydown);
  await nextTick();
  firstField.value?.focus();
});

onBeforeUnmount(() => {
  document.removeEventListener("keydown", onKeydown);
  window.clearTimeout(previewTimer);
  previewAbort?.abort();
});
</script>

<template>
  <!--
    Column mapping — Block out time panel
    An overlay drawer outside the page grid: desktop and tablet it docks to the right edge at a fixed
    440px; mobile (≤640px) it spans the full width.
    Nested grid: the form uses a local 2-col grid — the date pair and the time pair span 1 col each;
    every other field spans both.
  -->
  <div class="overlay" @click.self="!saving && emit('close')">
    <aside class="panel" role="dialog" aria-modal="true" aria-labelledby="block-out-title">
      <header class="panel__header">
        <div>
          <h2 id="block-out-title" class="h6">{{ editing ? "Edit block-out" : "Block out time" }}</h2>
          <p class="body-small muted panel__venue">{{ venueName }}</p>
        </div>
        <button type="button" class="icon-button" aria-label="Close" :disabled="saving" @click="emit('close')">
          <XMarkIcon class="icon-button__icon" aria-hidden="true" />
        </button>
      </header>

      <form class="form" novalidate @submit.prevent="submit">
        <label class="field">
          <span class="field__label">From</span>
          <input ref="firstField" v-model="form.startDate" type="date" class="input" :min="minDate"
            :aria-invalid="Boolean(fieldErrors.startDate)" @change="form.endDate < form.startDate && (form.endDate = form.startDate)" />
          <span v-if="fieldErrors.startDate" class="field__error">{{ fieldErrors.startDate }}</span>
        </label>

        <label class="field">
          <span class="field__label">To</span>
          <input v-model="form.endDate" type="date" class="input" :min="form.startDate || minDate"
            :aria-invalid="Boolean(fieldErrors.endDate)" />
          <span v-if="fieldErrors.endDate" class="field__error">{{ fieldErrors.endDate }}</span>
        </label>

        <label class="checkbox field--full">
          <input v-model="form.allDay" type="checkbox" class="checkbox__input" />
          <span>
            <span class="checkbox__label">Block the full day</span>
            <span class="field__hint">Untick to block only certain hours.</span>
          </span>
        </label>

        <template v-if="!form.allDay">
          <label class="field">
            <span class="field__label">Start time</span>
            <input v-model="form.startTime" type="time" class="input" :aria-invalid="Boolean(fieldErrors.startTime)" />
            <span v-if="fieldErrors.startTime" class="field__error">{{ fieldErrors.startTime }}</span>
          </label>
          <label class="field">
            <span class="field__label">End time</span>
            <input v-model="form.endTime" type="time" class="input" :aria-invalid="Boolean(fieldErrors.endTime)" />
            <span v-if="fieldErrors.endTime" class="field__error">{{ fieldErrors.endTime }}</span>
          </label>
          <p v-if="form.startDate !== form.endDate" class="field__hint field--full hours-hint">
            These hours are blocked on every day from the start date to the end date.
          </p>
        </template>

        <div class="field field--full">
          <label class="field__label" for="block-out-reason">Reason</label>
          <div class="chips" role="group" aria-label="Common reasons">
            <button v-for="reason in QUICK_REASONS" :key="reason" type="button" class="chip"
              :class="{ 'chip--selected': form.reason === reason }" :aria-pressed="form.reason === reason"
              @click="form.reason = reason">
              {{ reason }}
            </button>
          </div>
          <input id="block-out-reason" v-model="form.reason" type="text" class="input" maxlength="200"
            placeholder="e.g. Floor resurfacing" :aria-invalid="Boolean(fieldErrors.reason)" />
          <span v-if="fieldErrors.reason" class="field__error">{{ fieldErrors.reason }}</span>
        </div>

        <p v-if="summary" class="summary field--full">
          <span class="summary__label">Unavailable</span> {{ summary }}
        </p>

        <section class="impact field--full" aria-live="polite">
          <p v-if="previewLoading" class="body-small muted">Checking bookings…</p>
          <p v-else-if="previewError" class="body-small muted">{{ previewError }}</p>
          <div v-else-if="affected.length > 0" class="warning">
            <ExclamationTriangleIcon class="warning__icon" aria-hidden="true" />
            <div>
              <p class="warning__title">
                {{ affected.length }} booking{{ affected.length === 1 ? "" : "s" }} clash{{ affected.length === 1 ? "es" : "" }}
                with this period
              </p>
              <ul class="warning__list">
                <li v-for="booking in affected" :key="booking.bookingId">
                  <strong>{{ booking.eventName || "Untitled event" }}</strong>
                  <span class="status-tag">{{ statusLabel(booking) }}</span>
                  <br />{{ formatAffected(booking) }}
                  <span v-if="!booking.hasCoordinator" class="muted"> (no coordinator assigned)</span>
                </li>
              </ul>
              <p class="warning__body">
                <template v-if="flaggedCount > 0">
                  Approved bookings will be marked Replacement Required and their coordinators told to find another
                  venue.
                </template>
                <template v-if="pendingCount > 0">
                  Pending ones keep their status, but their coordinators are told the slot can't be honoured.
                </template>
                The events themselves are not changed.
              </p>
            </div>
          </div>
          <p v-else-if="periodValid" class="body-small muted">No bookings clash with this period.</p>
          <p v-if="buffersText && periodValid && !previewLoading" class="field__hint buffers-hint">
            Includes this venue's {{ buffersText }} around each event.
          </p>
        </section>

        <p v-if="saveError" class="body-small error-text field--full" role="alert">{{ saveError }}</p>

        <div class="actions field--full">
          <button type="button" class="btn btn--outline" :disabled="saving" @click="emit('close')">Cancel</button>
          <button type="submit" class="btn btn--solid" :disabled="saving">{{ submitLabel }}</button>
        </div>
      </form>
    </aside>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  justify-content: flex-end;
  background: var(--color-grey-alpha-40-dark);
}

.panel {
  display: flex;
  flex-direction: column;
  width: 440px;
  max-width: 100%;
  height: 100%;
  overflow-y: auto;
  background: var(--color-base-white);
  box-shadow: var(--shadow-popover);
}

@media (max-width: 640px) {
  .panel {
    width: 100%;
  }
}

.panel__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--spacing-16);
  padding: var(--spacing-24);
  border-bottom: 1px solid var(--color-grey-100);
}

.panel__venue {
  margin: var(--spacing-4) 0 0;
}

.h6 {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
}

.body-small {
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.125rem;
}

.muted {
  color: var(--color-grey-500);
}

.error-text {
  color: var(--color-error-600);
}

.icon-button {
  display: inline-flex;
  padding: var(--spacing-4);
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--color-grey-500);
  cursor: pointer;
}

.icon-button:hover:not(:disabled) {
  background: var(--color-grey-75);
  color: var(--color-grey-800);
}

.icon-button:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

.icon-button__icon {
  width: var(--spacing-24);
  height: var(--spacing-24);
}

/* Local 2-col grid (see column mapping). */
.form {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  align-content: start;
  gap: var(--spacing-16);
  padding: var(--spacing-24);
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-4);
  min-width: 0;
}

.field--full {
  grid-column: 1 / 3;
}

.field__label {
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  color: var(--color-grey-600);
}

.field__hint {
  display: block;
  font-size: 0.75rem;
  line-height: 1rem;
  color: var(--color-grey-500);
}

.hours-hint {
  margin: calc(-1 * var(--spacing-8)) 0 0;
}

.field__error {
  font-size: 0.75rem;
  line-height: 1rem;
  color: var(--color-error-600);
}

.input {
  height: 40px;
  padding: 0 var(--spacing-12);
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-xs);
  background: var(--color-base-white);
  color: var(--color-grey-900);
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  line-height: 1.125rem;
}

.input::placeholder {
  color: var(--color-grey-300);
}

.input:focus {
  outline: none;
  border-color: var(--ring-brand);
  box-shadow: 0 0 0 4px var(--ring-light);
}

.input[aria-invalid="true"] {
  border-color: var(--color-error-600);
}

.checkbox {
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-8);
  padding: var(--spacing-12);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-xs);
  background: var(--color-grey-50);
  cursor: pointer;
}

.checkbox__input {
  width: var(--spacing-16);
  height: var(--spacing-16);
  margin: var(--spacing-2) 0 0;
  accent-color: var(--color-purple-600);
}

.checkbox__input:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

.checkbox__label {
  display: block;
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  color: var(--color-grey-900);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-8);
  margin-bottom: var(--spacing-4);
}

.chip {
  padding: var(--spacing-4) var(--spacing-12);
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-full);
  background: var(--color-base-white);
  color: var(--color-grey-700);
  font-family: var(--font-family-lato);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  cursor: pointer;
}

.chip:hover {
  background: var(--color-grey-75);
  border-color: var(--color-grey-200);
}

.chip--selected,
.chip--selected:hover {
  background: var(--color-purple-100);
  border-color: var(--color-purple-300);
  color: var(--color-purple-800);
}

.chip:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

/* Style.md 3.5: pattern-unavailable, as a preview of how the block will show. */
.summary {
  margin: 0;
  padding: var(--spacing-12);
  border: 1px solid var(--color-grey-300);
  border-radius: var(--radius-xs);
  background: repeating-linear-gradient(135deg,
      var(--color-grey-200) 0 var(--spacing-4),
      var(--color-grey-50) var(--spacing-4) var(--spacing-8));
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-900);
}

.summary__label {
  font-weight: 700;
}

.impact {
  min-height: 1.125rem;
}

.warning {
  display: flex;
  gap: var(--spacing-12);
  padding: var(--spacing-16);
  border: 1px solid var(--color-warning-300);
  border-radius: var(--radius-xs);
  background: var(--color-warning-100);
}

.warning__icon {
  flex-shrink: 0;
  width: var(--spacing-24);
  height: var(--spacing-24);
  color: var(--color-warning-800);
}

.warning__title {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  color: var(--color-warning-900);
}

.warning__list {
  margin: var(--spacing-8) 0;
  padding-left: var(--spacing-16);
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-900);
}

.warning__list li + li {
  margin-top: var(--spacing-8);
}

.status-tag {
  display: inline-block;
  margin-left: var(--spacing-8);
  padding: 0 var(--spacing-8);
  border: 1px solid var(--color-warning-300);
  border-radius: var(--radius-full);
  background: var(--color-base-white);
  color: var(--color-warning-900);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
}

.buffers-hint {
  margin: var(--spacing-8) 0 0;
}

.warning__body {
  margin: 0;
  font-size: 0.75rem;
  line-height: 1rem;
  color: var(--color-grey-700);
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--spacing-12);
  padding-top: var(--spacing-8);
}

.btn {
  height: 40px;
  padding: 0 var(--spacing-16);
  border-radius: var(--radius-xs);
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  cursor: pointer;
}

.btn:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

.btn:disabled {
  cursor: default;
  opacity: 0.6;
}

.btn--solid {
  border: none;
  background: var(--color-purple-600);
  color: var(--color-base-white);
}

.btn--solid:hover:not(:disabled) {
  background: var(--color-purple-500);
}

.btn--outline {
  border: 1px solid var(--color-purple-300);
  background: transparent;
  color: var(--color-purple-600);
}

.btn--outline:hover:not(:disabled) {
  background: var(--color-purple-100);
}
</style>
