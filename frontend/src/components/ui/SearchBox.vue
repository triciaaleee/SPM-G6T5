<script setup lang="ts">
import { MagnifyingGlassIcon, XMarkIcon } from "@heroicons/vue/20/solid";
import IconButton from "./IconButton.vue";

/**
 * The app's one search box (Style.md 3.8): a magnifier, the field, and a clear button once there is text. It sits
 * in the page flow, so no shadow. The page decides its width (flex or grid placement) through a class on this
 * component.
 */
defineProps<{
  modelValue: string;
  placeholder?: string;
  /** Names the field for screen readers (its aria-label). */
  label: string;
}>();

const emit = defineEmits<{ "update:modelValue": [value: string]; clear: [] }>();

function clear() {
  emit("update:modelValue", "");
  emit("clear");
}
</script>

<template>
  <div class="search-box">
    <MagnifyingGlassIcon class="search-box__icon" aria-hidden="true" />
    <input
      :value="modelValue"
      type="search"
      class="search-box__input"
      :placeholder="placeholder"
      :aria-label="label"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
    <IconButton v-if="modelValue" label="Clear search" size="sm" @click="clear"><XMarkIcon aria-hidden="true" /></IconButton>
  </div>
</template>

<style scoped>
.search-box {
  display: flex;
  align-items: center;
  gap: var(--spacing-12);
  height: var(--spacing-48);
  padding: 0 var(--spacing-12) 0 var(--spacing-16);
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-xs);
}

.search-box:focus-within {
  border-color: var(--ring-brand);
  box-shadow: 0 0 0 4px var(--ring-light);
}

.search-box__icon {
  flex: none;
  width: var(--spacing-20);
  height: var(--spacing-20);
  color: var(--color-grey-700);
}

/* The wrapper draws the border and the focus ring, so the field itself is bare. */
.search-box__input {
  flex: 1;
  min-width: 0;
  height: 100%;
  min-height: 0;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-grey-900);
}

.search-box__input:focus-visible {
  outline: none;
  box-shadow: none;
}

.search-box__input::-webkit-search-cancel-button {
  display: none;
}
</style>
