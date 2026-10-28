<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ChevronDownIcon } from "@heroicons/vue/16/solid";
import type { StaffVenueOption } from "../../lib/venuesApi";
import { MAX_VENUES } from "../../lib/venueCalendar";

/**
 * E1-5: the venue filter shared by the schedule list and the calendar. `null`
 * means every venue (the default, so everything that needs a decision shows
 * at a glance in the list); otherwise the chosen venue ids, at most `max`
 * (four by default — the calendar only has four venue colours). Choosing a
 * venue while on "All venues" narrows to just that one; clearing the last tick
 * goes back to all. Ticking every venue stays an explicit choice: the calendar
 * draws nothing for "All venues", so it must not turn back into it.
 */
const props = withDefaults(defineProps<{ venues: StaffVenueOption[]; modelValue: number[] | null; max?: number }>(), {
  max: MAX_VENUES,
});
const emit = defineEmits<{ "update:modelValue": [value: number[] | null] }>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);

const label = computed(() => {
  if (props.modelValue === null) return `All venues (${props.venues.length})`;
  if (props.modelValue.length === 1) return props.venues.find((v) => v.id === props.modelValue![0])?.name ?? "1 venue";
  return `${props.modelValue.length} venues`;
});

const isChecked = (id: number) => props.modelValue !== null && props.modelValue.includes(id);
const atLimit = computed(() => props.modelValue !== null && props.modelValue.length >= props.max);
/** An unticked venue can't be added once the limit is reached; ticked ones can always be cleared. */
const isLocked = (id: number) => atLimit.value && !isChecked(id);

function choose(ids: number[]): void {
  emit("update:modelValue", ids.length === 0 ? null : ids);
}

function toggle(id: number): void {
  if (props.modelValue === null) {
    choose([id]);
    return;
  }
  if (props.modelValue.includes(id)) {
    choose(props.modelValue.filter((v) => v !== id));
  } else if (!atLimit.value) {
    choose([...props.modelValue, id]);
  }
}

function onDocumentClick(event: MouseEvent): void {
  if (open.value && root.value && !root.value.contains(event.target as Node)) open.value = false;
}

onMounted(() => document.addEventListener("click", onDocumentClick));
onBeforeUnmount(() => document.removeEventListener("click", onDocumentClick));
</script>

<template>
  <!-- A single venue has nothing to choose, so it is just a label. -->
  <p v-if="venues.length === 1" class="single">{{ venues[0].name }}</p>
  <div v-else ref="root" class="picker" @keydown.esc="open = false">
    <button type="button" class="picker__trigger" aria-haspopup="true" :aria-expanded="open" @click="open = !open">
      {{ label }}
      <ChevronDownIcon class="picker__chevron" aria-hidden="true" />
    </button>
    <div v-if="open" class="picker__popover" role="group" aria-label="Venues to show">
      <label class="picker__option">
        <input type="checkbox" class="picker__check" :checked="modelValue === null"
          @change="emit('update:modelValue', null)" />
        All venues
      </label>
      <label v-for="venue in venues" :key="venue.id" class="picker__option"
        :class="{ 'picker__option--locked': isLocked(venue.id) }">
        <input type="checkbox" class="picker__check" :checked="isChecked(venue.id)" :disabled="isLocked(venue.id)"
          @change="toggle(venue.id)" />
        {{ venue.name }}
      </label>
      <p class="picker__hint" data-testid="venue-picker-hint">
        Choose up to {{ max }} venues.
        <template v-if="atLimit"> You've picked {{ max }}: untick one to choose another.</template>
      </p>
    </div>
  </div>
</template>

<style scoped>
.single {
  margin: 0;
  font-size: 1rem;
  font-weight: 700;
  color: var(--color-grey-900);
}

.picker {
  position: relative;
}

.picker__trigger {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-8);
  height: 40px;
  padding: 0 var(--spacing-12);
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-xs);
  background: var(--color-base-white);
  color: var(--color-grey-900);
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  font-weight: 700;
  cursor: pointer;
}

.picker__trigger:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

.picker__chevron {
  width: var(--spacing-16);
  height: var(--spacing-16);
  color: var(--color-grey-500);
}

.picker__popover {
  position: absolute;
  top: calc(100% + var(--spacing-4));
  left: 0;
  z-index: 20;
  min-width: 260px;
  padding: var(--spacing-8);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-sm);
  background: var(--color-base-white);
  box-shadow: var(--shadow-popover);
}

.picker__option {
  display: flex;
  align-items: center;
  gap: var(--spacing-8);
  padding: var(--spacing-8);
  border-radius: var(--radius-xs);
  font-size: 0.875rem;
  color: var(--color-grey-900);
  cursor: pointer;
}

.picker__option:hover {
  background: var(--color-grey-75);
}

.picker__option--locked,
.picker__option--locked:hover {
  background: transparent;
  color: var(--color-grey-400);
  cursor: not-allowed;
}

.picker__hint {
  margin: var(--spacing-8) 0 0;
  padding: var(--spacing-8) var(--spacing-8) 0;
  border-top: 1px solid var(--color-grey-100);
  font-size: 0.75rem;
  line-height: 1rem;
  color: var(--color-grey-500);
}

.picker__check {
  accent-color: var(--color-purple-600);
}
</style>
