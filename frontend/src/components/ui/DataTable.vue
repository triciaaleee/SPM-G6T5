<script setup lang="ts" generic="T">
import { computed } from "vue";
import type { RouteLocationRaw } from "vue-router";

/**
 * The app's list-style table: a white bordered box, a grey uppercase
 * header row and one row per item, laid out on a left-aligned column grid.
 * Used by the Technical Support queue and the Lead's assignment overview.
 *
 * The caller owns what goes in each cell: pass a `cell-<key>` slot per
 * column (it receives `{ row }`), so cell-specific styles (badges, emphasis)
 * stay with the page that uses them. Pass `rowTo` to make each row a link.
 */
interface Column {
  key: string;
  label: string;
  /** Hide this column (header and cells) on narrow screens, 640px and below. */
  hideOnNarrow?: boolean;
}

const props = defineProps<{
  columns: Column[];
  /** The `grid-template-columns` value, so each page keeps its own widths. */
  columnWidths: string;
  /** Space between columns (a CSS length or token); defaults to spacing-32. */
  columnGap?: string;
  rows: T[];
  rowKey: (row: T) => string | number;
  /** When given, each row is a link to this location. */
  rowTo?: (row: T) => RouteLocationRaw;
}>();

const gridStyle = computed(() => ({
  "--table-columns": props.columnWidths,
  ...(props.columnGap ? { "--table-gap": props.columnGap } : {}),
}));
</script>

<template>
  <ul class="rows" :style="gridStyle">
    <li class="row row--header" aria-hidden="true">
      <span
        v-for="column in columns"
        :key="column.key"
        class="cell-header"
        :class="{ 'cell--narrow-hidden': column.hideOnNarrow }"
      >
        {{ column.label }}
      </span>
    </li>
    <li v-for="row in rows" :key="rowKey(row)" class="row-item">
      <component :is="rowTo ? 'RouterLink' : 'div'" :to="rowTo?.(row)" class="row" :class="{ 'row--link': rowTo }">
        <span
          v-for="column in columns"
          :key="column.key"
          class="cell"
          :class="{ 'cell--narrow-hidden': column.hideOnNarrow }"
        >
          <slot :name="`cell-${column.key}`" :row="row" />
        </span>
      </component>
    </li>
  </ul>
</template>

<style scoped>
.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

/* Left-aligned columns (not stretched), so a column sits at the same x-position in every table on a page. */
.row {
  display: grid;
  grid-template-columns: var(--table-columns);
  justify-content: start;
  column-gap: var(--table-gap, var(--spacing-32));
  align-items: center;
  padding: var(--spacing-16) var(--spacing-20);
  border-bottom: 1px solid var(--color-grey-100);
}

.row-item:last-child > .row {
  border-bottom: none;
}

.row--link {
  color: inherit;
  text-decoration: none;
}

.row--link:hover {
  background: var(--color-grey-50);
}

.row--link:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: -2px;
}

/* Column header row: same grid as the data rows, so labels line up. */
.row--header {
  background: var(--color-grey-50);
  padding-top: var(--spacing-12);
  padding-bottom: var(--spacing-12);
}

.cell-header {
  min-width: 0;
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  color: var(--color-grey-500);
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.cell {
  min-width: 0;
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-600);
  overflow-wrap: anywhere;
}

@media (max-width: 640px) {
  .cell--narrow-hidden {
    display: none;
  }
}
</style>
