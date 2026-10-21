<script setup lang="ts">
/**
 * E4-17: what the next venue booking of this event is for — its purpose,
 * headcount and needs — so recommendations, search and the request itself
 * judge venues on that booking rather than the whole event (AC1, AC5).
 *
 * Pre-filled from the event's settled details (team decision Q1). The main
 * programme is booked first, for everyone, with no purpose to choose — so a
 * single-venue event behaves as before (AC6). Every later booking is for
 * part of the event: it picks a session purpose and starts with no
 * headcount, so a breakout isn't silently sized for the whole event (Q3).
 * If the main venue needs replacing, the next booking is the main
 * programme again (venue-service decides via `hasMainProgramme`).
 *
 * Emits the plan only while it's valid (null otherwise), debounced so
 * typing a headcount doesn't re-run recommendations on every keystroke.
 *
 * Column mapping: sits inside the event page's side-column venue card, so it
 * fills its parent's width at every breakpoint; fields stack in one column.
 */
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import {
  BOOKING_PURPOSES,
  type BookingPlan,
  type BookingPurpose,
  type EventSuitability,
  type FeatureGroup,
  type VenueFilterOptions,
} from "../../lib/venuesApi";

const props = defineProps<{
  defaults: EventSuitability["defaults"];
  /** Option lists for the needs chips; null while loading (selected needs still show). */
  options: VenueFilterOptions | null;
}>();

const emit = defineEmits<{ "update:plan": [plan: BookingPlan | null] }>();

const EMIT_DELAY_MS = 400;
const GROUPS: { key: FeatureGroup; label: string }[] = [
  { key: "layouts", label: "Layouts" },
  { key: "facilities", label: "Facilities" },
  { key: "accessibility", label: "Accessibility" },
];

const isFirst = !props.defaults.hasMainProgramme;

/** A later booking is for part of the event; an overflow hall uses Other. */
const SESSION_PURPOSES = BOOKING_PURPOSES.filter((p) => p !== "Main programme");

const form = reactive({
  purpose: (isFirst ? "Main programme" : "Breakout") as BookingPurpose,
  purposeDetail: "",
  headcount: isFirst && props.defaults.attendance !== null ? String(props.defaults.attendance) : "",
  layouts: [...props.defaults.requirements.layouts],
  facilities: [...props.defaults.requirements.facilities],
  accessibility: [...props.defaults.requirements.accessibility],
});

const editingNeeds = ref(false);

const attendance = computed(() => props.defaults.attendance);

/** Mirrors venue-service lib/bookingPlan.ts parseBookingPlan. */
const errors = computed(() => {
  const fields: Record<string, string> = {};
  if (form.purpose === "Other" && !form.purposeDetail.trim()) fields.purposeDetail = "Say what this venue is for.";
  const text = form.headcount.trim();
  if (!text) fields.headcount = "Enter how many people this venue is for.";
  else if (!/^\d+$/.test(text) || Number(text) < 1) fields.headcount = "Enter a whole number of at least 1.";
  else if (attendance.value !== null && Number(text) > attendance.value) {
    fields.headcount = `Can't be more than the event's ${attendance.value} expected.`;
  }
  return fields;
});

/** Errors show once a field has been touched, so a fresh breakout form isn't red. */
const touched = reactive({ headcount: false, purposeDetail: false });

const plan = computed<BookingPlan | null>(() => {
  if (Object.keys(errors.value).length > 0) return null;
  return {
    purpose: form.purpose,
    ...(form.purpose === "Other" ? { purposeDetail: form.purposeDetail.trim() } : {}),
    headcount: Number(form.headcount.trim()),
    layouts: [...form.layouts],
    facilities: [...form.facilities],
    accessibility: [...form.accessibility],
  };
});

let timer: ReturnType<typeof setTimeout> | undefined;
let first = true;
watch(
  () => JSON.stringify(plan.value),
  () => {
    clearTimeout(timer);
    // The starting plan goes out at once so recommendations don't wait on the debounce.
    if (first) {
      first = false;
      emit("update:plan", plan.value);
      return;
    }
    timer = setTimeout(() => emit("update:plan", plan.value), EMIT_DELAY_MS);
  },
  { immediate: true },
);
onBeforeUnmount(() => clearTimeout(timer));

function choosePurpose(purpose: BookingPurpose): void {
  form.purpose = purpose;
}

/** Every option for a group: the catalogue plus anything this booking already needs. */
function groupOptions(group: FeatureGroup): string[] {
  const known = props.options?.[group] ?? [];
  const lower = new Set(known.map((v) => v.toLowerCase()));
  return [...known, ...form[group].filter((v) => !lower.has(v.toLowerCase()))];
}

function toggleNeed(group: FeatureGroup, value: string): void {
  const list = form[group];
  const index = list.indexOf(value);
  if (index === -1) list.push(value);
  else list.splice(index, 1);
}

const allNeeds = computed(() => [...form.layouts, ...form.facilities, ...form.accessibility]);
</script>

<template>
  <section class="plan" aria-label="Plan a venue booking">
    <div v-if="isFirst" class="field">
      <span class="field__label">Purpose</span>
      <p class="body-small purpose-fixed">Main programme <span class="muted">· the venue for everyone</span></p>
    </div>

    <div v-else class="field">
      <span class="field__label" id="plan-purpose-label">What is this venue for?</span>
      <p class="field__hint">Another venue for part of the event. Size it for its own session.</p>
      <div class="chips" role="group" aria-labelledby="plan-purpose-label">
        <button v-for="purpose in SESSION_PURPOSES" :key="purpose" type="button" class="chip"
          :class="{ 'chip--selected': form.purpose === purpose }" :aria-pressed="form.purpose === purpose"
          @click="choosePurpose(purpose)">
          {{ purpose }}
        </button>
      </div>
      <template v-if="form.purpose === 'Other'">
        <input v-model="form.purposeDetail" type="text" class="input" maxlength="80" placeholder="e.g. Press room"
          aria-label="What this venue is for" :aria-invalid="touched.purposeDetail && Boolean(errors.purposeDetail)"
          @blur="touched.purposeDetail = true" />
        <span v-if="touched.purposeDetail && errors.purposeDetail" class="field__error">{{ errors.purposeDetail }}</span>
      </template>
    </div>

    <label class="field">
      <span class="field__label">Headcount</span>
      <span class="headcount">
        <input v-model="form.headcount" type="text" inputmode="numeric" class="input headcount__input"
          :placeholder="attendance ? `1 to ${attendance}` : 'e.g. 40'"
          :aria-invalid="touched.headcount && Boolean(errors.headcount)" @blur="touched.headcount = true" />
        <span v-if="attendance !== null" class="body-small muted">of {{ attendance }} expected</span>
      </span>
      <span v-if="touched.headcount && errors.headcount" class="field__error">{{ errors.headcount }}</span>
      <span v-else-if="!form.headcount.trim()" class="field__hint">Enter a headcount to see venues for this booking.</span>
    </label>

    <div class="field">
      <div class="needs__header">
        <span class="field__label">Needs</span>
        <button type="button" class="link-btn" :aria-expanded="editingNeeds" @click="editingNeeds = !editingNeeds">
          {{ editingNeeds ? "Done" : "Change" }}
        </button>
      </div>
      <template v-if="!editingNeeds">
        <div v-if="allNeeds.length > 0" class="tags">
          <span v-for="need in allNeeds" :key="need" class="tag">{{ need }}</span>
        </div>
        <p v-else class="body-small muted">No specific layout, facility or accessibility needs.</p>
      </template>
      <template v-else>
        <div v-for="group in GROUPS" :key="group.key" class="needs__group">
          <span class="field__hint">{{ group.label }}</span>
          <div class="chips">
            <button v-for="option in groupOptions(group.key)" :key="option" type="button" class="chip chip--small"
              :class="{ 'chip--selected': form[group.key].includes(option) }"
              :aria-pressed="form[group.key].includes(option)" @click="toggleNeed(group.key, option)">
              {{ option }}
            </button>
          </div>
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.plan {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-24);
  padding-bottom: var(--spacing-24);
  margin-bottom: var(--spacing-24);
  border-bottom: 1px solid var(--color-grey-100);
}

.purpose-fixed {
  font-weight: 700;
  color: var(--color-grey-900);
}

.purpose-fixed .muted {
  font-weight: 400;
}

.plan__title {
  margin: 0;
  color: var(--color-grey-900);
}

.body-default {
  margin: 0;
  font-size: 1rem;
  line-height: 1.25rem;
}

.body-small {
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.125rem;
}

.font-semibold {
  font-weight: 700;
}

.muted {
  color: var(--color-grey-500);
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
  min-width: 0;
}

.field__label {
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  color: var(--color-grey-600);
}

.field__hint {
  font-size: 0.75rem;
  line-height: 1rem;
  color: var(--color-grey-500);
}

.field__error {
  font-size: 0.75rem;
  line-height: 1rem;
  color: var(--color-error-600);
}

.input {
  height: 44px;
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

.headcount {
  display: flex;
  align-items: center;
  gap: var(--spacing-8);
}

.headcount__input {
  width: 120px;
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-8);
}

/* Same corner radius as the app's buttons (--radius-xs), at a comfortable touch size. */
.chip {
  min-height: 40px;
  padding: 0 var(--spacing-16);
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-xs);
  background: var(--color-base-white);
  color: var(--color-grey-700);
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  cursor: pointer;
}

.chip--small {
  min-height: 0;
  padding: var(--spacing-2) var(--spacing-8);
  font-size: 0.75rem;
  line-height: 1rem;
}

.chip:hover {
  background: var(--color-grey-75);
}

.chip--selected,
.chip--selected:hover {
  background: var(--color-purple-100);
  border-color: var(--color-purple-300);
  color: var(--color-purple-800);
}

.chip:focus-visible,
.link-btn:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

.needs__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.needs__group {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
}

/* Ghost purple, Style.md 3.4 — lowest-emphasis action. */
.link-btn {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-purple-600);
  font-family: var(--font-family-lato);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  cursor: pointer;
}

.link-btn:hover {
  text-decoration: underline;
}

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-4);
}

.tag {
  padding: var(--spacing-2) var(--spacing-8);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-xs);
  background: var(--color-base-white);
  color: var(--color-grey-700);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
}
</style>
