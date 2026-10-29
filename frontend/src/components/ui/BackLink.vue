<script setup lang="ts">
import { ChevronLeftIcon } from "@heroicons/vue/16/solid";
import type { RouteLocationRaw } from "vue-router";

/**
 * The app's one "back" control (Style.md 3.7): a left chevron and a label. A link when it goes to a fixed
 * page (`to`, or `href` for an address built elsewhere), a button when it goes back in history.
 */
defineProps<{
  to?: RouteLocationRaw;
  href?: string;
}>();
</script>

<template>
  <RouterLink v-if="to" :to="to" class="back-link">
    <ChevronLeftIcon class="back-link__icon" aria-hidden="true" />
    <slot />
  </RouterLink>
  <a v-else-if="href" :href="href" class="back-link">
    <ChevronLeftIcon class="back-link__icon" aria-hidden="true" />
    <slot />
  </a>
  <button v-else type="button" class="back-link">
    <ChevronLeftIcon class="back-link__icon" aria-hidden="true" />
    <slot />
  </button>
</template>

<style scoped>
.back-link {
  display: inline-flex;
  align-items: center;
  align-self: flex-start;
  justify-self: start;
  gap: var(--spacing-8);
  min-height: 44px;
  padding: 0;
  border: none;
  background: none;
  color: var(--color-purple-600);
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  text-decoration: none;
  cursor: pointer;
}

.back-link:hover {
  color: var(--color-purple-700);
}

.back-link__icon {
  flex: none;
  width: 1rem;
  height: 1rem;
}
</style>
