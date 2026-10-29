<script setup lang="ts">
/**
 * The app's one status badge (Style.md 3.7). The colour comes from a tone class
 * (`status-success`, `-warning`, `-attention`, `-error`, `-info`, `-neutral`), defined once in
 * src/style.css; the lib status helpers (lib/eventStatus.ts, bookingStatus.ts, ...) return that class.
 */
defineProps<{
  /** One of the status-* tone classes. */
  statusClass?: string;
}>();
</script>

<template>
  <span class="badge" :class="statusClass"><slot /></span>
</template>

<style scoped>
/* Small Text / Tag */
.badge {
  display: inline-block;
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  padding: var(--spacing-4) var(--spacing-8);
  border-radius: var(--radius-full);
}
</style>
