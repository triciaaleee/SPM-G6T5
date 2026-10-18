<script setup lang="ts">
import { computed } from "vue";
import type { RouteLocationRaw } from "vue-router";

/**
 * The app's one button (Style.md 3.4, "Button component"). Renders a
 * <button>, or a RouterLink styled as one when `to` is given. Extra
 * attributes (`form`, `aria-*`, `@click`) fall through to that root element.
 */
const props = withDefaults(
  defineProps<{
    /** primary: the view's one solid action; outline/ghost: lower emphasis; danger*: destructive. */
    variant?: "primary" | "outline" | "ghost" | "danger" | "danger-solid";
    /** md is the 44px touch target; sm (36px) is for dense toolbars only; xl is a larger, wider call to action. */
    size?: "md" | "sm" | "xl";
    /** Stretch to the full width of its container. */
    block?: boolean;
    /** Navigate instead of acting: renders a RouterLink. */
    to?: RouteLocationRaw;
    disabled?: boolean;
    type?: "button" | "submit" | "reset";
  }>(),
  { variant: "primary", size: "md", block: false, disabled: false, type: "button" },
);

// A link can't be disabled natively, so a disabled link is inert (aria-disabled, tabindex -1, no pointer events).
const classes = computed(() => [
  "btn",
  `btn--${props.variant}`,
  `btn--${props.size}`,
  { "btn--block": props.block, "btn--disabled": props.disabled },
]);
</script>

<template>
  <RouterLink v-if="to" :to="to" :class="classes" :aria-disabled="disabled || undefined" :tabindex="disabled ? -1 : undefined">
    <slot />
  </RouterLink>
  <button v-else :type="type" :class="classes" :disabled="disabled">
    <slot />
  </button>
</template>

<style scoped>
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-8);
  box-sizing: border-box;
  border: 1px solid transparent;
  border-radius: var(--radius-xs);
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  text-decoration: none;
  white-space: nowrap;
  cursor: pointer;
}

.btn--md {
  min-height: 44px; /* touch-target minimum */
  padding: 0 var(--spacing-24);
}

/* xl: the page's main call to action (e.g. Register), taller, wider and in larger type. */
.btn--xl {
  min-height: 52px;
  min-width: 12.5rem;
  padding: 0 var(--spacing-48);
  font-size: 1rem;
  line-height: 1.25rem;
}

.btn--sm {
  min-height: 36px;
  padding: 0 var(--spacing-16);
}

.btn--block {
  width: 100%;
}

.btn:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

/* primary */
.btn--primary {
  background: var(--color-purple-600);
  color: var(--color-base-white);
}

.btn--primary:hover:not(:disabled):not(.btn--disabled) {
  background: var(--color-purple-700);
}

/* outline */
.btn--outline {
  background: transparent;
  border-color: var(--color-purple-300);
  color: var(--color-purple-600);
}

.btn--outline:hover:not(:disabled):not(.btn--disabled) {
  background: var(--color-purple-100);
}

/* ghost */
.btn--ghost {
  background: transparent;
  color: var(--color-purple-600);
}

.btn--ghost:hover:not(:disabled):not(.btn--disabled) {
  background: var(--color-purple-100);
}

/* danger */
.btn--danger {
  background: transparent;
  border-color: var(--color-error-300);
  color: var(--color-error-600);
}

.btn--danger:hover:not(:disabled):not(.btn--disabled) {
  background: var(--color-error-200);
}

.btn--danger:focus-visible {
  border-color: var(--color-error-600);
  outline: 2px solid var(--ring-error);
  outline-offset: 2px;
}

/* danger-solid: modal confirmations only */
.btn--danger-solid {
  background: var(--color-error-600);
  color: var(--color-base-white);
}

.btn--danger-solid:hover:not(:disabled):not(.btn--disabled) {
  filter: brightness(0.9);
}

.btn--danger-solid:focus-visible {
  outline: 2px solid var(--ring-error);
  outline-offset: 2px;
}

/* Style.md 3.1 disabled: Grey/25 fill, Grey/100 border, Grey/300 text. */
.btn:disabled,
.btn--disabled {
  background: var(--color-grey-25);
  border-color: var(--color-grey-100);
  color: var(--color-grey-300);
  cursor: not-allowed;
  pointer-events: none;
}
</style>
