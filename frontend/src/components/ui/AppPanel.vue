<script setup lang="ts">
/**
 * The app's one content panel (Style.md 3.7): Grey/50 fill, 1px Grey/100 border, radius-lg. `lg` (spacing-32
 * padding) is a page-level section; `md` (spacing-24) is a card inside a list or grid. Layout (flex, grid
 * placement, gaps) stays with the parent through its own class.
 */
withDefaults(
  defineProps<{
    /** The element to render, e.g. `section` or `li`. */
    as?: string;
    size?: "md" | "lg";
  }>(),
  { as: "div", size: "md" },
);
</script>

<template>
  <component :is="as" class="panel" :class="`panel--${size}`"><slot /></component>
</template>

<style scoped>
.panel {
  box-sizing: border-box;
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
}

.panel--md {
  padding: var(--spacing-24);
}

.panel--lg {
  padding: var(--spacing-32);
}
</style>
