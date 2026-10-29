<script setup lang="ts">
/**
 * The app's one icon-only button (Style.md 3.7): square, `radius-xs`, 32px (`sm`) or 40px (`md`). The icon goes
 * in the slot; `label` becomes the `aria-label`. `disabled`, `title` and `@click` fall through to the button.
 */
withDefaults(
  defineProps<{
    /** What the button does, read by screen readers (there is no visible text). */
    label: string;
    size?: "sm" | "md";
    /** `brand` draws the icon in Purple Primary/600 instead of Grey/700. */
    tone?: "default" | "brand";
  }>(),
  { size: "md", tone: "default" },
);
</script>

<template>
  <button type="button" class="icon-button" :class="[`icon-button--${size}`, `icon-button--${tone}`]" :aria-label="label">
    <slot />
  </button>
</template>

<style scoped>
.icon-button {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  cursor: pointer;
}

.icon-button--sm {
  width: 32px;
  height: 32px;
}

.icon-button--md {
  width: 40px;
  height: 40px;
}

.icon-button--default {
  color: var(--color-grey-700);
}

.icon-button--brand {
  color: var(--color-purple-600);
}

.icon-button:hover:not(:disabled) {
  background: var(--color-grey-75);
}

.icon-button:disabled {
  color: var(--color-grey-300);
  cursor: not-allowed;
}

.icon-button--sm :slotted(svg) {
  width: 1rem;
  height: 1rem;
}

.icon-button--md :slotted(svg) {
  width: 1.25rem;
  height: 1.25rem;
}
</style>
