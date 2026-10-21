<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ChevronDownIcon } from "@heroicons/vue/16/solid";
import type { StaffVenueOption } from "../../lib/venuesApi";

/**
 * E1-5: the venue filter shared by the schedule list and the calendar. `null`
 * means every venue (the default, so everything that needs a decision shows
 * at a glance); otherwise the chosen venue ids. Choosing a venue while on
 * "All venues" narrows to just that one; ticking every venue, or clearing
 * the last tick, goes back to all.
 */
const props = defineProps<{ venues: StaffVenueOption[]; modelValue: number[] | null }>();
const emit = defineEmits<{ "update:modelValue": [value: number[] | null] }>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);

const label = computed(() => {
  if (props.modelValue === null) return "All venues";
  if (props.modelValue.length === 1) return props.venues.find((v) => v.id === props.modelValue![0])?.name ?? "1 venue";
  return `${props.modelValue.length} venues`;
});

const isChecked = (id: number) => props.modelValue === null || props.modelValue.includes(id);

function choose(ids: number[]): void {
  emit("update:modelValue", ids.length === 0 || ids.length === props.venues.length ? null : ids);
}

function toggle(id: number): void {
  if (props.modelValue === null) {
    choose([id]);
    return;
  }
  choose(props.modelValue.includes(id) ? props.modelValue.filter((v) => v !== id) : [...props.modelValue, id]);
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
      <label v-for="venue in venues" :key="venue.id" class="picker__option">
        <input type="checkbox" class="picker__check" :checked="modelValue !== null && isChecked(venue.id)"
          @change="toggle(venue.id)" />
        {{ venue.name }}
      </label>
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

.picker__check {
  accent-color: var(--color-purple-600);
}
</style>
