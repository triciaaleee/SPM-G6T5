<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { ChevronDownIcon } from "@heroicons/vue/16/solid";

/**
 * Searchable venue dropdown (ARIA combobox). Type to filter by name or
 * location, or open the list and pick. Arrow keys move through matches,
 * Enter picks, Escape closes and restores the current venue's name.
 */

interface VenueOption {
  id: number;
  name: string;
  location: string;
  capacity: number;
}

const props = defineProps<{
  venues: VenueOption[];
  modelValue: number | null;
  inputId?: string;
}>();
const emit = defineEmits<{ "update:modelValue": [value: number] }>();

const listId = `${props.inputId ?? "venue-picker"}-list`;
const query = ref("");
const open = ref(false);
const activeIndex = ref(0);
const listEl = ref<HTMLUListElement | null>(null);

const selected = computed(() => props.venues.find((v) => v.id === props.modelValue) ?? null);

// Show the chosen venue's name whenever the list isn't being searched.
watch(selected, (venue) => {
  if (!open.value) query.value = venue?.name ?? "";
}, { immediate: true });

/** While the text still equals the chosen venue's name, show every venue rather than one match. */
const matches = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q || q === selected.value?.name.toLowerCase()) return props.venues;
  return props.venues.filter((v) => v.name.toLowerCase().includes(q) || v.location.toLowerCase().includes(q));
});

function openList(): void {
  if (open.value) return;
  open.value = true;
  const index = matches.value.findIndex((v) => v.id === props.modelValue);
  activeIndex.value = Math.max(index, 0);
}

function close(): void {
  open.value = false;
  query.value = selected.value?.name ?? "";
}

function pick(venue: VenueOption): void {
  emit("update:modelValue", venue.id);
  open.value = false;
  query.value = venue.name;
}

function onInput(): void {
  openList();
  activeIndex.value = 0;
}

async function move(step: 1 | -1): Promise<void> {
  if (!open.value) {
    openList();
    return;
  }
  const count = matches.value.length;
  if (count === 0) return;
  activeIndex.value = (activeIndex.value + step + count) % count;
  await nextTick();
  listEl.value?.querySelector(`[data-index="${activeIndex.value}"]`)?.scrollIntoView({ block: "nearest" });
}

function onEnter(): void {
  const venue = matches.value[activeIndex.value];
  if (open.value && venue) pick(venue);
}

function onBlur(event: FocusEvent): void {
  // Clicking an option moves focus into the list first; let the click land.
  if (listEl.value?.contains(event.relatedTarget as Node | null)) return;
  close();
}

function optionId(index: number): string {
  return `${listId}-${index}`;
}
</script>

<template>
  <div class="picker">
    <div class="picker__field">
      <input
        :id="inputId"
        v-model="query"
        type="text"
        class="picker__input"
        role="combobox"
        autocomplete="off"
        placeholder="Search venues"
        :aria-expanded="open"
        :aria-controls="listId"
        aria-autocomplete="list"
        :aria-activedescendant="open && matches.length > 0 ? optionId(activeIndex) : undefined"
        @focus="($event.target as HTMLInputElement).select()"
        @click="openList"
        @input="onInput"
        @keydown.down.prevent="move(1)"
        @keydown.up.prevent="move(-1)"
        @keydown.enter.prevent="onEnter"
        @keydown.esc="close"
        @blur="onBlur"
      />
      <ChevronDownIcon class="picker__icon" aria-hidden="true" />
    </div>

    <ul v-show="open" :id="listId" ref="listEl" class="picker__list" role="listbox" aria-label="Venues">
      <li
        v-for="(venue, index) in matches"
        :id="optionId(index)"
        :key="venue.id"
        :data-index="index"
        role="option"
        tabindex="-1"
        class="picker__option"
        :class="{ 'is-active': index === activeIndex, 'is-selected': venue.id === modelValue }"
        :aria-selected="venue.id === modelValue"
        @mousedown.prevent="pick(venue)"
        @mouseenter="activeIndex = index"
      >
        <span class="picker__name">{{ venue.name }}</span>
        <span class="picker__meta">{{ venue.location }} · {{ venue.capacity }} capacity</span>
      </li>
      <li v-if="matches.length === 0" class="picker__empty">No venues match "{{ query }}".</li>
    </ul>
  </div>
</template>

<style scoped>
.picker {
  position: relative;
}

.picker__field {
  position: relative;
  display: flex;
  align-items: center;
}

.picker__input {
  width: 100%;
  height: 40px;
  padding: 0 var(--spacing-40) 0 var(--spacing-16);
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-xs);
  background: var(--color-base-white);
  color: var(--color-grey-900);
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  line-height: 1.125rem;
}

.picker__input::placeholder {
  color: var(--color-grey-300);
}

.picker__input:focus {
  outline: none;
  border-color: var(--ring-brand);
  box-shadow: 0 0 0 4px var(--ring-light);
}

.picker__icon {
  position: absolute;
  right: var(--spacing-12);
  width: var(--spacing-16);
  height: var(--spacing-16);
  color: var(--color-grey-700);
  pointer-events: none;
}

.picker__list {
  position: absolute;
  z-index: 20;
  top: calc(100% + var(--spacing-4));
  left: 0;
  right: 0;
  max-height: 320px;
  overflow-y: auto;
  margin: 0;
  padding: var(--spacing-4) 0;
  list-style: none;
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-popover);
}

.picker__option {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-2);
  padding: var(--spacing-8) var(--spacing-16);
  cursor: pointer;
}

.picker__option.is-active {
  background: var(--color-grey-75);
}

.picker__option.is-selected {
  background: var(--color-purple-100);
}

.picker__name {
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  color: var(--color-grey-900);
}

.picker__option.is-selected .picker__name {
  color: var(--color-purple-800);
}

.picker__meta {
  font-size: 0.75rem;
  line-height: 1rem;
  color: var(--color-grey-500);
}

.picker__empty {
  padding: var(--spacing-12) var(--spacing-16);
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-500);
}
</style>
