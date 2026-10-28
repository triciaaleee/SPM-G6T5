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

/** A row's section, for an optional divider rendered before the first row of each new one. */
interface RowGroup {
  key: string;
  label: string;
  count: number;
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
  /** When given, extra class(es) applied to the row element (e.g. to flag a row needing attention). */
  rowClass?: (row: T) => string | Record<string, boolean>;
  /** When given, sets `data-testid` on the row element. */
  rowTestId?: (row: T) => string;
  /**
   * When given, groups rows under a divider rendered via the `group-header` slot,
   * right before the first row of each new group. `rows` must already be sorted so
   * each group's rows are contiguous; returning null/undefined skips the divider.
   */
  rowGroup?: (row: T) => RowGroup | null | undefined;
  /** When given, an extra full-width `row-detail` slot renders right after a row for which this returns true. */
  rowDetail?: (row: T) => boolean;
}>();

const gridStyle = computed(() => ({
  "--table-columns": props.columnWidths,
  ...(props.columnGap ? { "--table-gap": props.columnGap } : {}),
}));

/** Each row, paired with its group header (only on the first row of that group). */
const rowEntries = computed(() => {
  let lastKey: string | null = null;
  return props.rows.map((row) => {
    const group = props.rowGroup?.(row) ?? null;
    const header = group && group.key !== lastKey ? group : null;
    if (group) lastKey = group.key;
    return { row, header };
  });
});
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
    <template v-for="entry in rowEntries" :key="rowKey(entry.row)">
      <li v-if="entry.header" class="row-group-header">
        <slot name="group-header" :group="entry.header" />
      </li>
      <li class="row-item">
        <component
          :is="rowTo ? 'RouterLink' : 'div'"
          :to="rowTo?.(entry.row)"
          class="row"
          :class="[{ 'row--link': rowTo }, rowClass?.(entry.row)]"
          :data-testid="rowTestId?.(entry.row)"
        >
          <span
            v-for="column in columns"
            :key="column.key"
            class="cell"
            :class="[`cell--${column.key}`, { 'cell--narrow-hidden': column.hideOnNarrow }]"
          >
            <slot :name="`cell-${column.key}`" :row="entry.row" />
          </span>
        </component>
      </li>
      <li v-if="rowDetail?.(entry.row)" class="row-detail">
        <slot name="row-detail" :row="entry.row" />
      </li>
    </template>
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
  padding: var(--spacing-20) var(--spacing-24);
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
  padding-top: var(--spacing-16);
  padding-bottom: var(--spacing-16);
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
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  min-width: 0;
  font-size: 0.875rem;
  color: var(--color-grey-600);
  overflow-wrap: anywhere;
  gap: 8px;
}

.row-group-header {
  border-top: 1px solid var(--color-grey-100);
}

.row-detail {
  padding: var(--spacing-20) var(--spacing-24);
  border-top: 1px solid var(--color-grey-100);
  background: var(--color-base-white);
}

@media (max-width: 640px) {
  .cell--narrow-hidden {
    display: none;
  }
}
</style>
