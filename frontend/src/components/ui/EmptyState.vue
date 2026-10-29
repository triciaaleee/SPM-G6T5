<script setup lang="ts">
/**
 * The app's one empty state (Style.md 3.7): the panel shell with centred text, for "nothing here yet" and
 * "no results". Put the message (and an optional action) in the slot.
 */
</script>

<template>
  <div class="empty-state"><slot /></div>
</template>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  box-sizing: border-box;
  padding: var(--spacing-40) var(--spacing-24);
  text-align: center;
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
}
</style>
