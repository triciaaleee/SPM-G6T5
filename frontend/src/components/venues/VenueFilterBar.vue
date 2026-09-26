<script setup lang="ts">
import { computed, ref } from "vue";
import {
  clearCriterion,
  emptyVenueFilters,
  timeWindowError,
  type CriterionKey,
  type VenueFilterOptions,
  type VenueFilters,
} from "../../lib/venuesApi";
import CalendarPicker from "./CalendarPicker.vue";
import FilterChecklist from "./FilterChecklist.vue";
import FilterChip from "./FilterChip.vue";
import VenueIcon from "./VenueIcon.vue";

/**
 * Search box + filter chips for venue search. Edits the parent's filters
 * object in place (v-model); the parent decides when to search.
 * Expected attendance is expressed through Capacity's minimum (the view
 * pre-fills it from the event) rather than a separate chip.
 */
const filters = defineModel<VenueFilters>({ required: true });
defineProps<{ options: VenueFilterOptions | null }>();

type ChipKey = "availability" | "capacity" | "accessibility" | "layouts" | "facilities";
const openChip = ref<ChipKey | null>(null);

function setOpen(key: ChipKey, open: boolean): void {
  openChip.value = open ? key : openChip.value === key ? null : openChip.value;
}

function clear(key: CriterionKey): void {
  clearCriterion(filters.value, key);
}

function clearAll(): void {
  Object.assign(filters.value, emptyVenueFilters());
  openChip.value = null;
}

function summariseList(values: string[]): string | null {
  if (values.length === 0) return null;
  return `${values[0]}${values.length > 1 ? ` +${values.length - 1}` : ""}`;
}

function formatDay(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

const timeError = computed(() => timeWindowError(filters.value));

const availabilityLabel = computed(() => {
  const { date, startTime, endTime } = filters.value;
  if (!date) return null;
  const window = startTime && endTime && !timeError.value ? `${startTime}–${endTime}` : "All day";
  return `${formatDay(date)} · ${window}`;
});

const capacityLabel = computed(() => {
  const { capacityMin: min, capacityMax: max } = filters.value;
  if (min && max) return `Capacity ${min}–${max}`;
  if (min) return `Capacity ${min}+`;
  if (max) return `Capacity up to ${max}`;
  return null;
});

const capacityError = computed(() => {
  const { capacityMin: min, capacityMax: max } = filters.value;
  return min && max && min > max ? "Maximum must be at least the minimum." : null;
});

const hasAnyFilter = computed(() => {
  const f = filters.value;
  return (
    !!f.q.trim() ||
    !!f.date ||
    !!f.capacityMin ||
    !!f.capacityMax ||
    f.accessibility.length + f.layouts.length + f.facilities.length > 0
  );
});

/** Blank number inputs come through v-model.number as "" — store null instead. */
function setNumber(key: "capacityMin" | "capacityMax", raw: string): void {
  const value = Number(raw);
  filters.value[key] = raw === "" || !Number.isFinite(value) || value <= 0 ? null : Math.floor(value);
}
</script>

<template>
  <div class="filter-bar">
    <div class="search-box">
      <VenueIcon name="search" :size="20" class="search-box__icon" />
      <input v-model="filters.q" type="search" class="search-box__input" placeholder="Search venues by name or keyword"
        aria-label="Search venues" />
      <button v-if="filters.q" type="button" class="search-box__clear" aria-label="Clear search" @click="clear('q')">
        <VenueIcon name="close" :size="20" />
      </button>
    </div>

    <div class="chips" role="group" aria-label="Venue filters">
      <FilterChip label="Date & time" icon="calendar" :active-label="availabilityLabel"
        :open="openChip === 'availability'" :popover-width="320" @update:open="setOpen('availability', $event)"
        @clear="clear('availability')">
        <CalendarPicker v-model="filters.date" />
        <div class="field-row">
          <label class="field">
            <span class="field__label">Start time</span>
            <input v-model="filters.startTime" type="time" class="field__input" :disabled="!filters.date" />
          </label>
          <label class="field">
            <span class="field__label">End time</span>
            <input v-model="filters.endTime" type="time" class="field__input" :disabled="!filters.date" />
          </label>
        </div>
        <p v-if="timeError" class="field__error" role="alert">{{ timeError }}</p>
        <p v-else class="field__hint">
          {{ filters.date ? "Venues already booked in this window are hidden. Leave times empty to check the whole day." : "Pick a date to check availability." }}
        </p>
        <div class="popover-actions">
          <button type="button" class="btn btn--ghost" @click="clear('availability')">Clear</button>
          <button type="button" class="btn btn--solid" @click="openChip = null">Done</button>
        </div>
      </FilterChip>

      <FilterChip label="Capacity" icon="capacity" :active-label="capacityLabel" :open="openChip === 'capacity'"
        :popover-width="300" @update:open="setOpen('capacity', $event)" @clear="clear('capacity')">
        <div class="field-row">
          <label class="field">
            <span class="field__label">Min seats</span>
            <input :value="filters.capacityMin ?? ''" type="number" min="1" inputmode="numeric" class="field__input"
              :placeholder="options?.capacity ? String(options.capacity.min) : ''"
              @input="setNumber('capacityMin', ($event.target as HTMLInputElement).value)" />
          </label>
          <label class="field">
            <span class="field__label">Max seats</span>
            <input :value="filters.capacityMax ?? ''" type="number" min="1" inputmode="numeric" class="field__input"
              :placeholder="options?.capacity ? String(options.capacity.max) : ''"
              @input="setNumber('capacityMax', ($event.target as HTMLInputElement).value)" />
          </label>
        </div>
        <p v-if="capacityError" class="field__error" role="alert">{{ capacityError }}</p>
        <div class="popover-actions">
          <button type="button" class="btn btn--ghost" @click="clear('capacity')">Clear</button>
          <button type="button" class="btn btn--solid" @click="openChip = null">Done</button>
        </div>
      </FilterChip>

      <FilterChip label="Accessibility" icon="accessibility" :active-label="summariseList(filters.accessibility)"
        :open="openChip === 'accessibility'" @update:open="setOpen('accessibility', $event)"
        @clear="clear('accessibility')">
        <FilterChecklist v-model="filters.accessibility" :options="options?.accessibility ?? []"
          heading="Accessibility" hint="Must have all selected" search-placeholder="Search accessibility features" />
      </FilterChip>

      <FilterChip label="Layout" icon="layout" :active-label="summariseList(filters.layouts)"
        :open="openChip === 'layouts'" @update:open="setOpen('layouts', $event)" @clear="clear('layouts')">
        <FilterChecklist v-model="filters.layouts" :options="options?.layouts ?? []" heading="Layout"
          hint="Must support all selected" search-placeholder="Search layouts" />
      </FilterChip>

      <FilterChip label="Facilities" icon="facilities" :active-label="summariseList(filters.facilities)"
        :open="openChip === 'facilities'" @update:open="setOpen('facilities', $event)" @clear="clear('facilities')">
        <FilterChecklist v-model="filters.facilities" :options="options?.facilities ?? []" heading="Facilities"
          hint="Must have all selected" search-placeholder="Search facilities" />
      </FilterChip>

      <button v-if="hasAnyFilter" type="button" class="btn btn--ghost chips__clear-all" @click="clearAll">
        Clear all
      </button>
    </div>
  </div>
</template>

<style scoped>
.filter-bar {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-16);
}

.search-box {
  display: flex;
  align-items: center;
  gap: var(--spacing-12);
  height: 56px;
  padding: 0 var(--spacing-16) 0 var(--spacing-24);
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-popover);
}

.search-box:focus-within {
  border-color: var(--ring-brand);
  box-shadow: 0 0 0 4px var(--ring-light);
}

.search-box__icon {
  color: var(--color-grey-700);
}

.search-box__input {
  flex: 1;
  min-width: 0;
  height: 100%;
  border: none;
  background: transparent;
  font-family: var(--font-family-lato);
  font-size: 1.125rem;
  line-height: 1.375rem;
  color: var(--color-grey-900);
}

.search-box__input::placeholder {
  color: var(--color-grey-300);
}

/* The wrapper carries the focus treatment (Style.md 8.2) for the whole box. */
.search-box__input:focus-visible {
  outline: none;
  box-shadow: none;
}

.search-box__input::-webkit-search-cancel-button {
  display: none;
}

.search-box__clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-grey-700);
  cursor: pointer;
}

.search-box__clear:hover {
  background: var(--color-grey-75);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--spacing-8);
}

.chips__clear-all {
  margin-left: var(--spacing-4);
}

.field-row {
  display: grid;
  /* minmax(0, …): number/time inputs have an intrinsic min width that
     would otherwise push the second column past the popover edge. */
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-content: start;
  gap: var(--spacing-12);
  margin-top: var(--spacing-16);
}

/* Spacing is only there to separate the row from the calendar above it. */
.field-row:first-child {
  margin-top: 0;
}

.field {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: var(--spacing-4);
}

.field__label {
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  color: var(--color-grey-700);
}

.field__input {
  width: 100%;
  min-width: 0;
  height: 40px;
  padding: 0 var(--spacing-12);
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-xs);
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-700);
  background: var(--color-base-white);
}

.field__input::placeholder {
  color: var(--color-grey-300);
}

.field__input:disabled {
  background: var(--color-grey-25);
  border-color: var(--color-grey-100);
  color: var(--color-grey-300);
}

.field__hint,
.field__error {
  margin: var(--spacing-8) 0 0;
  font-size: 0.75rem;
  line-height: 1rem;
}

.field__hint {
  color: var(--color-grey-500);
}

.field__error {
  color: var(--color-error-600);
}

.popover-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--spacing-8);
  margin-top: var(--spacing-16);
}

.btn {
  height: 36px;
  padding: 0 var(--spacing-16);
  border-radius: var(--radius-xs);
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  cursor: pointer;
}

.btn--solid {
  border: none;
  background: var(--color-purple-600);
  color: var(--color-base-white);
}

.btn--solid:hover {
  background: var(--color-purple-500);
}

.btn--ghost {
  border: none;
  background: transparent;
  color: var(--color-error-600);
}

.btn--ghost:hover {
  background: var(--color-error-200);
}
</style>
