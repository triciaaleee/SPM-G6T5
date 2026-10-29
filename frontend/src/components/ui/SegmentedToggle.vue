<script setup lang="ts" generic="K extends string">
import type { Component } from "vue";

/**
 * The app's one segmented toggle (Style.md 3.7): a joined row of buttons that switches how the same content is
 * shown (calendar or list, registered or withdrawn). One segment is pressed at a time. Selected is
 * `Purple Primary/100` with `Purple Primary/800` text (Style.md 3.1).
 */
export interface Segment<T extends string = string> {
  key: T;
  label: string;
  /** An optional leading icon component (a heroicon). */
  icon?: Component;
  testId?: string;
}

defineProps<{
  options: Segment<K>[];
  modelValue: K;
  ariaLabel?: string;
}>();

defineEmits<{ "update:modelValue": [key: K] }>();
</script>

<template>
  <div class="view-toggle" role="group" :aria-label="ariaLabel">
    <button
      v-for="option in options"
      :key="option.key"
      type="button"
      class="toggle-btn"
      :class="{ 'toggle-btn--active': modelValue === option.key }"
      :aria-pressed="modelValue === option.key"
      :data-testid="option.testId"
      @click="$emit('update:modelValue', option.key)"
    >
      <component :is="option.icon" v-if="option.icon" class="toggle-btn__icon" aria-hidden="true" />
      {{ option.label }}
    </button>
  </div>
</template>

<style scoped>
.view-toggle {
  display: inline-flex;
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-xs);
  overflow: hidden;
}

.toggle-btn {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-8);
  height: 40px;
  padding: 0 var(--spacing-16);
  border: none;
  border-right: 1px solid var(--color-grey-200);
  background: var(--color-base-white);
  color: var(--color-grey-600);
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  cursor: pointer;
}

.toggle-btn:last-child {
  border-right: none;
}

.toggle-btn:hover:not(.toggle-btn--active) {
  background: var(--color-grey-50);
  color: var(--color-grey-900);
}

.toggle-btn:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: -2px;
}

.toggle-btn--active {
  background: var(--color-purple-100);
  color: var(--color-purple-800);
}

.toggle-btn__icon {
  width: var(--spacing-16);
  height: var(--spacing-16);
}
</style>
