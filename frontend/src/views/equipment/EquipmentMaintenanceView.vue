<script setup lang="ts">
/**
 * E5-5: Technical Support mark equipment damaged or under maintenance for a
 * period, so it stops being offered to events, and return it to use. This used
 * to be a tab of the equipment inventory; it is its own page now, reached from
 * the navbar. The stock numbers on the Inventory page re-read themselves when
 * that page is opened, so nothing here needs to tell it about a change.
 */
import EquipmentUnitsPanel from "../components/equipment/EquipmentUnitsPanel.vue";
</script>

<template>
  <!--
    Column mapping — Equipment maintenance
    Desktop (12-col, grid-desktop-margin 80px): header and out-of-use panel col 1-12.
    Tablet (6-col, grid-tablet-margin 32px): everything col 1-6.
    Mobile (4-col, grid-mobile-margin 6px): everything col 1-4.
  -->
  <div class="page">
    <div class="page-header">
      <h1 class="h2">Equipment maintenance</h1>
      <p class="subheading">Mark equipment damaged or under maintenance, and return it to use</p>
    </div>

    <!-- The panel's own root spans a fixed 12 columns, so it sits in a wrapper that follows the page grid. -->
    <div class="panel-wrap">
      <EquipmentUnitsPanel />
    </div>
  </div>
</template>

<style scoped>
.page {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: var(--spacing-24) var(--grid-desktop-gutter);
  padding: var(--spacing-40) var(--grid-desktop-margin) var(--spacing-80);
  align-content: start;
}

.page-header,
.panel-wrap {
  grid-column: 1 / 13;
}

@media (max-width: 1024px) {
  .page {
    grid-template-columns: repeat(6, 1fr);
    gap: var(--spacing-24) var(--grid-tablet-gutter);
    padding: var(--spacing-32) var(--grid-tablet-margin) var(--spacing-48);
  }

  .page-header,
  .panel-wrap {
    grid-column: 1 / 7;
  }
}

@media (max-width: 640px) {
  .page {
    grid-template-columns: repeat(4, 1fr);
    gap: var(--spacing-24) var(--grid-mobile-gutter);
    padding: var(--spacing-24) var(--grid-mobile-margin) var(--spacing-48);
  }

  .page-header,
  .panel-wrap {
    grid-column: 1 / 5;
  }
}

.h2 {
  font-size: 2.25rem;
  font-weight: 700;
  line-height: 2.625rem;
  color: var(--color-grey-900);
  margin: 0;
}

.subheading {
  font-size: 1.125rem;
  font-weight: 400;
  line-height: 1.375rem;
  color: var(--color-grey-500);
  margin: var(--spacing-8) 0 0;
}
</style>
