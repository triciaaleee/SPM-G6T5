<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from "vue";
import { ExclamationTriangleIcon, XMarkIcon } from "@heroicons/vue/20/solid";
import {
  VenueFormError,
  createVenue,
  fetchVenueFormOptions,
  previewVenueUpdate,
  updateVenue,
  type VenueChangeImpact,
  type VenueDraft,
  type VenueRecord,
  type VenueUpdateResult,
} from "../../lib/venuesApi";

/**
 * E4-1: venue staff create a venue record, or update one when `venue` is
 * passed. Accessibility, layouts and facilities are picked from the same
 * option lists coordinators filter by (plus anything typed in), so the
 * venue is findable the moment it's saved.
 *
 * When editing, a change to capacity, setup or turnaround is checked
 * against the venue's bookings before saving (as the block-out panel does):
 * events that would no longer fit (AC6) and bookings that would now overlap
 * (§3a change 1) are listed, and their coordinators are told on save.
 */
const props = defineProps<{ venue?: VenueRecord | null }>();
const emit = defineEmits<{
  close: [];
  created: [venue: VenueRecord];
  updated: [result: VenueUpdateResult];
}>();

const TIME_PATTERN = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/;
const WHOLE_NUMBER = /^\d+$/;
const PREVIEW_DELAY_MS = 400;

type OptionGroup = "accessibility" | "layouts" | "facilities";
/** Labels match the server's names for missing attributes (AC2). */
const GROUPS: { key: OptionGroup; label: string; missing: string; placeholder: string }[] = [
  { key: "layouts", label: "Supported layouts", missing: "supported layouts", placeholder: "e.g. Fishbowl" },
  { key: "facilities", label: "Facilities", missing: "facilities", placeholder: "e.g. Piano" },
  { key: "accessibility", label: "Accessibility features", missing: "accessibility features", placeholder: "e.g. Tactile paving" },
];

const editing = computed(() => Boolean(props.venue));

const form = reactive<VenueDraft>({
  name: props.venue?.name ?? "",
  location: props.venue?.location ?? "",
  description: props.venue?.description ?? "",
  capacity: props.venue ? String(props.venue.capacity) : "",
  accessibility: [...(props.venue?.accessibility ?? [])],
  // A saved venue with an empty list was saved as having none, so keep that choice.
  noAccessibilityFeatures: props.venue ? props.venue.accessibility.length === 0 : false,
  layouts: [...(props.venue?.layouts ?? [])],
  facilities: [...(props.venue?.facilities ?? [])],
  setupMinutes: String(props.venue?.setupMinutes ?? 0),
  turnaroundMinutes: String(props.venue?.turnaroundMinutes ?? 0),
  openingTime: props.venue?.openingTime ?? "08:00",
  closingTime: props.venue?.closingTime ?? "22:00",
});

const options = reactive<Record<OptionGroup | "locations", string[]>>({
  locations: [],
  accessibility: [],
  layouts: [],
  facilities: [],
});
const optionsError = ref<string | null>(null);
/** What's typed into each group's "add another" box. */
const extra = reactive<Record<OptionGroup, string>>({ accessibility: "", layouts: "", facilities: "" });

/** Every option offered in a group: the catalogue plus whatever this venue already has. */
function groupOptions(group: OptionGroup): string[] {
  const known = new Set(options[group].map((o) => o.toLowerCase()));
  return [...options[group], ...form[group].filter((v) => !known.has(v.toLowerCase()))];
}

const serverFields = ref<Record<string, string>>({});
const saveError = ref<string | null>(null);
const saving = ref(false);
/** Field errors show once the user has tried to save. */
const attempted = ref(false);

const firstField = ref<HTMLInputElement | null>(null);

/** Client-side mirror of the server's rules (venue-service lib/venueRecord.ts), so mistakes show inline. */
const validation = computed(() => {
  const fields: Record<string, string> = {};
  const missing: string[] = [];
  if (!form.name.trim()) {
    fields.name = "Enter the venue's name.";
    missing.push("name");
  }
  if (!form.location.trim()) {
    fields.location = "Enter where the venue is.";
    missing.push("location");
  }
  const capacity = form.capacity.trim();
  if (!capacity) {
    fields.capacity = "Enter the maximum capacity.";
    missing.push("maximum capacity");
  } else if (!WHOLE_NUMBER.test(capacity) || Number(capacity) < 1) {
    fields.capacity = "Capacity must be a whole number of at least 1.";
  }
  // AC4: blank means 0; anything else must be whole minutes.
  for (const key of ["setupMinutes", "turnaroundMinutes"] as const) {
    const value = form[key].trim();
    if (value && (!WHOLE_NUMBER.test(value) || Number(value) > 1440)) fields[key] = "Enter whole minutes, from 0 to 1440.";
  }
  if (!form.openingTime || !form.closingTime) missing.push("operating hours");
  if (!TIME_PATTERN.test(form.openingTime)) fields.openingTime = "Enter an opening time.";
  if (!TIME_PATTERN.test(form.closingTime)) fields.closingTime = "Enter a closing time.";
  else if (!fields.openingTime && form.closingTime <= form.openingTime) {
    fields.closingTime = "The closing time must be after the opening time.";
  }
  for (const group of GROUPS) {
    if (group.key === "accessibility" && form.noAccessibilityFeatures) continue;
    if (form[group.key].length === 0) {
      fields[group.key] = `Choose at least one of the ${group.label.toLowerCase()}.`;
      missing.push(group.missing);
    }
  }
  return { fields, missing };
});

const fieldErrors = computed(() => ({ ...(attempted.value ? validation.value.fields : {}), ...serverFields.value }));

/** AC2: names every missing mandatory attribute in one line above the buttons. */
const missingSummary = computed(() =>
  attempted.value && validation.value.missing.length > 0
    ? `Missing required details: ${validation.value.missing.join(", ")}.`
    : null,
);

function toggle(group: OptionGroup, value: string): void {
  const list = form[group];
  const index = list.indexOf(value);
  if (index === -1) list.push(value);
  else list.splice(index, 1);
  // Picking a feature undoes "No accessibility features" — the two can't both hold.
  if (group === "accessibility" && list.length > 0) form.noAccessibilityFeatures = false;
}

/** "No accessibility features" clears any features picked; picking a feature clears it (see toggle). */
function toggleNoAccessibility(): void {
  form.noAccessibilityFeatures = !form.noAccessibilityFeatures;
  if (form.noAccessibilityFeatures) form.accessibility.splice(0);
}

/** Adds a typed value to the group's options (unless it's already there) and selects it. */
function addExtra(group: OptionGroup): void {
  const value = extra[group].trim();
  if (!value) return;
  const existing = groupOptions(group).find((option) => option.toLowerCase() === value.toLowerCase());
  if (!existing) options[group].push(value);
  const chosen = existing ?? value;
  if (!form[group].includes(chosen)) form[group].push(chosen);
  if (group === "accessibility") form.noAccessibilityFeatures = false;
  extra[group] = "";
}

function draft(): VenueDraft {
  return {
    ...form,
    name: form.name.trim(),
    location: form.location.trim(),
    description: form.description.trim(),
    capacity: form.capacity.trim(),
    setupMinutes: form.setupMinutes.trim(),
    turnaroundMinutes: form.turnaroundMinutes.trim(),
  };
}

// ---- Edit only: what the change does to existing bookings -------------------

const impact = ref<VenueChangeImpact>({ capacityShortfalls: [], bufferOverlaps: [] });
const previewLoading = ref(false);
const previewError = ref<string | null>(null);
const hasImpact = computed(() => impact.value.capacityShortfalls.length + impact.value.bufferOverlaps.length > 0);

let previewTimer: number | undefined;
let previewAbort: AbortController | null = null;

/** Only these fields can affect bookings, so only they re-run the check. */
const impactInputs = computed(() => {
  if (!props.venue) return null;
  const changed =
    form.capacity.trim() !== String(props.venue.capacity) ||
    (form.setupMinutes.trim() || "0") !== String(props.venue.setupMinutes) ||
    (form.turnaroundMinutes.trim() || "0") !== String(props.venue.turnaroundMinutes);
  return changed ? [form.capacity, form.setupMinutes, form.turnaroundMinutes].join("|") : null;
});

watch(impactInputs, (inputs) => {
  window.clearTimeout(previewTimer);
  previewAbort?.abort();
  const { fields } = validation.value;
  if (inputs === null || Object.keys(validation.value.fields).length > 0) {
    // Nothing changed that matters, or the form isn't valid enough to check yet.
    impact.value = { capacityShortfalls: [], bufferOverlaps: [] };
    previewError.value = null;
    previewLoading.value = false;
    if (inputs !== null && !fields.capacity && !fields.setupMinutes && !fields.turnaroundMinutes) {
      previewError.value = "Fill in the rest of the form to check this venue's bookings.";
    }
    return;
  }
  previewLoading.value = true;
  previewTimer = window.setTimeout(runPreview, PREVIEW_DELAY_MS);
});

async function runPreview(): Promise<void> {
  if (!props.venue) return;
  const controller = new AbortController();
  previewAbort = controller;
  try {
    impact.value = await previewVenueUpdate(props.venue.id, draft(), controller.signal);
    previewError.value = null;
  } catch {
    if (controller.signal.aborted) return;
    impact.value = { capacityShortfalls: [], bufferOverlaps: [] };
    previewError.value = "We couldn't check this venue's bookings. You can still save.";
  } finally {
    if (!controller.signal.aborted) previewLoading.value = false;
  }
}

function formatDay(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

const submitLabel = computed(() => {
  if (saving.value) return "Saving…";
  if (!editing.value) return "Add venue";
  return hasImpact.value ? "Save & notify coordinators" : "Save changes";
});

async function submit(): Promise<void> {
  attempted.value = true;
  saveError.value = null;
  serverFields.value = {};
  if (Object.keys(validation.value.fields).length > 0) return;

  saving.value = true;
  try {
    if (props.venue) emit("updated", await updateVenue(props.venue.id, draft()));
    else emit("created", await createVenue(draft()));
  } catch (err) {
    if (err instanceof VenueFormError && Object.keys(err.fields).length > 0) serverFields.value = err.fields;
    saveError.value = err instanceof Error ? err.message : "Failed to save the venue.";
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
  try {
    Object.assign(options, await fetchVenueFormOptions());
  } catch {
    optionsError.value = "We couldn't load the usual options. You can still type your own below.";
  }
});

onBeforeUnmount(() => {
  document.removeEventListener("keydown", onKeydown);
  window.clearTimeout(previewTimer);
  previewAbort?.abort();
});
</script>

<template>
  <!--
    Column mapping — Add / Edit venue panel
    An overlay drawer outside the page grid: desktop and tablet it docks to the right edge at a fixed
    440px; mobile (≤640px) it spans the full width.
    Nested grid: the form uses a local 2-col grid — location/capacity, opening/closing and
    setup/turnaround pairs span 1 col each; every other field spans both.
  -->
  <div class="overlay" @click.self="!saving && emit('close')">
    <aside class="panel" role="dialog" aria-modal="true" aria-labelledby="venue-form-title">
      <header class="panel__header">
        <div>
          <h2 id="venue-form-title" class="h6">{{ editing ? "Edit venue" : "Add new venue" }}</h2>
          <p class="body-small muted panel__subtitle">
            {{ editing ? venue!.name : "It's added to your venues and can be booked straight away." }}
          </p>
        </div>
        <button type="button" class="icon-button" aria-label="Close" :disabled="saving" @click="emit('close')">
          <XMarkIcon class="icon-button__icon" aria-hidden="true" />
        </button>
      </header>

      <form class="form" novalidate @submit.prevent="submit">
        <label class="field field--full">
          <span class="field__label">Venue name</span>
          <input ref="firstField" v-model="form.name" type="text" class="input" maxlength="120"
            placeholder="e.g. Courtyard Pavilion" :aria-invalid="Boolean(fieldErrors.name)" />
          <span v-if="fieldErrors.name" class="field__error">{{ fieldErrors.name }}</span>
        </label>

        <label class="field">
          <span class="field__label">Location</span>
          <input v-model="form.location" type="text" class="input" list="venue-locations"
            placeholder="e.g. North Campus" :aria-invalid="Boolean(fieldErrors.location)" />
          <datalist id="venue-locations">
            <option v-for="location in options.locations" :key="location" :value="location" />
          </datalist>
          <span v-if="fieldErrors.location" class="field__error">{{ fieldErrors.location }}</span>
        </label>

        <!-- Text, not type="number": a number box hands back "" for "abc", which would hide the mistake (AC4/AC5). -->
        <label class="field">
          <span class="field__label">Maximum capacity</span>
          <input v-model="form.capacity" type="text" inputmode="numeric" class="input" placeholder="e.g. 120"
            :aria-invalid="Boolean(fieldErrors.capacity)" />
          <span v-if="fieldErrors.capacity" class="field__error">{{ fieldErrors.capacity }}</span>
        </label>

        <label class="field field--full">
          <span class="field__label">Description <span class="field__optional">(optional)</span></span>
          <textarea v-model="form.description" class="input textarea" rows="3" maxlength="1000"
            placeholder="e.g. Covered courtyard beside the cafeteria" :aria-invalid="Boolean(fieldErrors.description)" />
          <span v-if="fieldErrors.description" class="field__error">{{ fieldErrors.description }}</span>
        </label>

        <label class="field">
          <span class="field__label">Opens at</span>
          <input v-model="form.openingTime" type="time" class="input" :aria-invalid="Boolean(fieldErrors.openingTime)" />
          <span v-if="fieldErrors.openingTime" class="field__error">{{ fieldErrors.openingTime }}</span>
        </label>

        <label class="field">
          <span class="field__label">Closes at</span>
          <input v-model="form.closingTime" type="time" class="input" :aria-invalid="Boolean(fieldErrors.closingTime)" />
          <span v-if="fieldErrors.closingTime" class="field__error">{{ fieldErrors.closingTime }}</span>
        </label>

        <label class="field">
          <span class="field__label">Setup (minutes)</span>
          <input v-model="form.setupMinutes" type="text" inputmode="numeric" class="input" placeholder="0"
            :aria-invalid="Boolean(fieldErrors.setupMinutes)" />
          <span v-if="fieldErrors.setupMinutes" class="field__error">{{ fieldErrors.setupMinutes }}</span>
        </label>

        <label class="field">
          <span class="field__label">Turnaround (minutes)</span>
          <input v-model="form.turnaroundMinutes" type="text" inputmode="numeric" class="input" placeholder="0"
            :aria-invalid="Boolean(fieldErrors.turnaroundMinutes)" />
          <span v-if="fieldErrors.turnaroundMinutes" class="field__error">{{ fieldErrors.turnaroundMinutes }}</span>
        </label>
        <p class="field__hint field--full buffers-hint">
          Reserved before and after every event here, and used in every availability and conflict check.
        </p>

        <p v-if="optionsError" class="body-small muted field--full">{{ optionsError }}</p>

        <fieldset v-for="group in GROUPS" :key="group.key" class="field field--full group">
          <legend class="field__label">
            {{ group.label }}
            <span v-if="form[group.key].length > 0" class="field__optional">({{ form[group.key].length }} selected)</span>
          </legend>
          <div class="chips">
            <button v-if="group.key === 'accessibility'" type="button" class="chip chip--none"
              :class="{ 'chip--selected': form.noAccessibilityFeatures }" :aria-pressed="form.noAccessibilityFeatures"
              @click="toggleNoAccessibility">
              No accessibility features
            </button>
            <button v-for="option in groupOptions(group.key)" :key="option" type="button" class="chip"
              :class="{ 'chip--selected': form[group.key].includes(option) }"
              :aria-pressed="form[group.key].includes(option)" @click="toggle(group.key, option)">
              {{ option }}
            </button>
          </div>
          <div class="add-row">
            <input v-model="extra[group.key]" type="text" class="input add-row__input" maxlength="60"
              :placeholder="group.placeholder" :aria-label="`Add another option to ${group.label.toLowerCase()}`"
              @keydown.enter.prevent="addExtra(group.key)" />
            <button type="button" class="btn btn--ghost" :disabled="!extra[group.key].trim()" @click="addExtra(group.key)">
              Add
            </button>
          </div>
          <span v-if="fieldErrors[group.key]" class="field__error">{{ fieldErrors[group.key] }}</span>
        </fieldset>

        <section v-if="editing" class="impact field--full" aria-live="polite">
          <p v-if="previewLoading" class="body-small muted">Checking bookings…</p>
          <p v-else-if="previewError" class="body-small muted">{{ previewError }}</p>
          <template v-else>
            <div v-if="impact.capacityShortfalls.length > 0" class="warning">
              <ExclamationTriangleIcon class="warning__icon" aria-hidden="true" />
              <div>
                <p class="warning__title">
                  {{ impact.capacityShortfalls.length }} confirmed event{{ impact.capacityShortfalls.length === 1 ? "" : "s" }}
                  won't fit the new capacity
                </p>
                <ul class="warning__list">
                  <li v-for="s in impact.capacityShortfalls" :key="s.bookingId">
                    <strong>{{ s.eventName || "Untitled event" }}</strong> · {{ formatDay(s.date) }} ·
                    expects {{ s.expectedAttendance }}
                    <span v-if="!s.hasCoordinator" class="muted"> (no coordinator assigned)</span>
                  </li>
                </ul>
                <p class="warning__body">Their coordinators will be notified. The bookings themselves are not changed.</p>
              </div>
            </div>
            <div v-if="impact.bufferOverlaps.length > 0" class="warning">
              <ExclamationTriangleIcon class="warning__icon" aria-hidden="true" />
              <div>
                <p class="warning__title">
                  {{ impact.bufferOverlaps.length }} pair{{ impact.bufferOverlaps.length === 1 ? "" : "s" }} of bookings
                  would overlap with the new setup/turnaround
                </p>
                <ul class="warning__list">
                  <li v-for="o in impact.bufferOverlaps" :key="`${o.first.bookingId}-${o.second.bookingId}`">
                    <strong>{{ o.first.eventName || "Untitled event" }}</strong> ({{ o.first.window }})
                    and <strong>{{ o.second.eventName || "Untitled event" }}</strong> ({{ o.second.window }})
                  </li>
                </ul>
                <p class="warning__body">Both coordinators will be notified. Neither booking is removed.</p>
              </div>
            </div>
          </template>
        </section>

        <p v-if="missingSummary" class="body-small error-text field--full" role="alert">{{ missingSummary }}</p>
        <p v-else-if="saveError" class="body-small error-text field--full" role="alert">{{ saveError }}</p>

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

.panel__subtitle {
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

.group {
  margin: 0;
  padding: 0;
  border: none;
}

.group legend {
  padding: 0;
  margin-bottom: var(--spacing-4);
}

.field__label {
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  color: var(--color-grey-600);
}

.field__optional {
  font-weight: 400;
  color: var(--color-grey-500);
}

.field__hint {
  display: block;
  font-size: 0.75rem;
  line-height: 1rem;
  color: var(--color-grey-500);
}

.buffers-hint {
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

.textarea {
  height: auto;
  padding: var(--spacing-8) var(--spacing-12);
  resize: vertical;
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

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-8);
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

/* Set apart from the features it excludes. */
.chip--none {
  border-style: dashed;
}

.chip--none.chip--selected {
  border-style: solid;
}

.chip:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

.add-row {
  display: flex;
  gap: var(--spacing-8);
  margin-top: var(--spacing-4);
}

.add-row__input {
  flex: 1;
  min-width: 0;
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

.btn--ghost {
  border: none;
  background: transparent;
  color: var(--color-purple-600);
}

.btn--ghost:hover:not(:disabled) {
  background: var(--color-purple-100);
}

/* Booking impact of an edit — same warning treatment as BlockOutPanel. */
.impact {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-12);
}

.impact:empty {
  display: none;
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

.warning__body {
  margin: 0;
  font-size: 0.75rem;
  line-height: 1rem;
  color: var(--color-grey-700);
}
</style>
