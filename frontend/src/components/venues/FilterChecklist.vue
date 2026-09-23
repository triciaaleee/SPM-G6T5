<script setup lang="ts">
import { computed, ref } from "vue";

/**
 * Popover body for a multi-select filter: a search box, "Select all"
 * (scoped to whatever the search currently shows), and a scrolling
 * checkbox list under a section heading.
 */
const props = defineProps<{
  options: string[];
  modelValue: string[];
  heading: string;
  /** Explains how multiple selections combine, e.g. "Venues must have all selected". */
  hint: string;
  searchPlaceholder: string;
}>();

const emit = defineEmits<{ "update:modelValue": [value: string[]] }>();

const query = ref("");
const uid = Math.random().toString(36).slice(2, 8);

const visibleOptions = computed(() => {
  const needle = query.value.trim().toLowerCase();
  return needle ? props.options.filter((o) => o.toLowerCase().includes(needle)) : props.options;
});

const selected = computed(() => new Set(props.modelValue));

const allVisibleSelected = computed(
  () => visibleOptions.value.length > 0 && visibleOptions.value.every((o) => selected.value.has(o)),
);

function toggle(option: string): void {
  const next = new Set(props.modelValue);
  if (next.has(option)) next.delete(option);
  else next.add(option);
  emit("update:modelValue", props.options.filter((o) => next.has(o)));
}

function toggleAllVisible(): void {
  const next = new Set(props.modelValue);
  const select = !allVisibleSelected.value;
  for (const option of visibleOptions.value) {
    if (select) next.add(option);
    else next.delete(option);
  }
  emit("update:modelValue", props.options.filter((o) => next.has(o)));
}
</script>

<template>
  <div class="checklist">
    <input v-model="query" type="search" class="checklist__search" :placeholder="searchPlaceholder"
      :aria-label="searchPlaceholder" />

    <div class="checklist__toolbar">
      <label class="check">
        <input type="checkbox" :checked="allVisibleSelected" :disabled="visibleOptions.length === 0"
          @change="toggleAllVisible" />
        <span>Select all</span>
      </label>
      <span class="checklist__hint">{{ hint }}</span>
    </div>

    <hr class="checklist__divider" />

    <p :id="`checklist-heading-${uid}`" class="checklist__heading">{{ heading }}</p>
    <ul class="checklist__list" :aria-labelledby="`checklist-heading-${uid}`">
      <li v-for="option in visibleOptions" :key="option">
        <label class="check check--row" :class="{ 'check--selected': selected.has(option) }">
          <input type="checkbox" :checked="selected.has(option)" @change="toggle(option)" />
          <span>{{ option }}</span>
        </label>
      </li>
      <li v-if="visibleOptions.length === 0" class="checklist__empty">No matches for "{{ query }}"</li>
    </ul>
  </div>
</template>

<style scoped>
.checklist__search {
  width: 100%;
  height: 40px;
  padding: 0 var(--spacing-12);
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-xs);
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-700);
}

.checklist__search::placeholder {
  color: var(--color-grey-300);
}

.checklist__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-12);
  margin-top: var(--spacing-12);
}

.checklist__hint {
  font-size: 0.75rem;
  line-height: 1rem;
  color: var(--color-grey-500);
  text-align: right;
}

.checklist__divider {
  border: none;
  border-top: 1px solid var(--color-grey-100);
  margin: var(--spacing-12) 0;
}

.checklist__heading {
  margin: 0 0 var(--spacing-4);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  color: var(--color-grey-500);
}

.checklist__list {
  list-style: none;
  margin: 0 calc(var(--spacing-8) * -1);
  padding: 0;
  max-height: 240px;
  overflow-y: auto;
}

.checklist__empty {
  padding: var(--spacing-8);
  font-size: 0.875rem;
  color: var(--color-grey-500);
}

.check {
  display: flex;
  align-items: center;
  gap: var(--spacing-8);
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-700);
  cursor: pointer;
}

.check--row {
  padding: var(--spacing-8);
  border-radius: var(--radius-xs);
  font-size: 1rem;
  line-height: 1.25rem;
}

.check--row:hover {
  background: var(--color-grey-50);
}

.check--selected {
  background: var(--color-grey-50);
}

.check input {
  width: 18px;
  height: 18px;
  margin: 0;
  accent-color: var(--color-purple-600);
  cursor: pointer;
}

.check input:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
  box-shadow: none;
}
</style>
