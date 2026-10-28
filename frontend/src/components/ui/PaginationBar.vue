<script setup lang="ts">
import { computed } from "vue";
import AppButton from "./AppButton.vue";

/**
 * Pages a long table or list (Style.md 3.4, "Pagination bar"): "Showing 21–40
 * of 47" on the left, Previous / page numbers / Next on the right. The caller
 * owns the page and slices its own rows; this only shows and changes it.
 * Nothing renders when everything fits on one page.
 */
/** `noun` names what is being counted ("events"), for lists whose unit isn't a plain row. */
const props = defineProps<{ page: number; pageSize: number; total: number; noun?: string }>();
const emit = defineEmits<{ "update:page": [page: number] }>();

type PageItem = { type: "page"; page: number } | { type: "gap"; key: string };

const totalPages = computed(() => Math.max(1, Math.ceil(props.total / props.pageSize)));
const current = computed(() => Math.min(Math.max(1, props.page), totalPages.value));
const first = computed(() => (current.value - 1) * props.pageSize + 1);
const last = computed(() => Math.min(current.value * props.pageSize, props.total));

/** First, last and the pages either side of the current one; a single hidden page is shown rather than "…". */
const items = computed<PageItem[]>(() => {
  const keep = new Set<number>([1, totalPages.value]);
  for (let p = current.value - 1; p <= current.value + 1; p++) {
    if (p >= 1 && p <= totalPages.value) keep.add(p);
  }
  const pages = [...keep].sort((a, b) => a - b);
  const result: PageItem[] = [];
  pages.forEach((p, i) => {
    const previous = pages[i - 1];
    if (previous !== undefined) {
      if (p - previous === 2) result.push({ type: "page", page: previous + 1 });
      else if (p - previous > 2) result.push({ type: "gap", key: `gap-${previous}` });
    }
    result.push({ type: "page", page: p });
  });
  return result;
});

function go(page: number): void {
  if (page < 1 || page > totalPages.value || page === current.value) return;
  emit("update:page", page);
}
</script>

<template>
  <nav v-if="total > pageSize" class="pagination" aria-label="Pagination">
    <p class="pagination__summary" aria-live="polite" data-testid="pagination-summary">
      Showing {{ first }}–{{ last }} of {{ total }}{{ noun ? ` ${noun}` : "" }}
    </p>
    <div class="pagination__controls">
      <AppButton variant="outline" size="sm" type="button" :disabled="current <= 1" data-testid="pagination-prev"
        @click="go(current - 1)">
        Previous
      </AppButton>
      <template v-for="item in items" :key="item.type === 'page' ? item.page : item.key">
        <span v-if="item.type === 'gap'" class="pagination__gap" aria-hidden="true">…</span>
        <button v-else type="button" class="pagination__page"
          :class="{ 'pagination__page--current': item.page === current }"
          :aria-current="item.page === current ? 'page' : undefined" :aria-label="`Page ${item.page}`"
          @click="go(item.page)">
          {{ item.page }}
        </button>
      </template>
      <AppButton variant="outline" size="sm" type="button" :disabled="current >= totalPages" data-testid="pagination-next"
        @click="go(current + 1)">
        Next
      </AppButton>
    </div>
  </nav>
</template>

<style scoped>
.pagination {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-12) var(--spacing-16);
  margin-top: var(--spacing-24);
}

.pagination__summary {
  margin: 0;
  font-size: 0.75rem;
  line-height: 1rem;
  color: var(--color-grey-500);
}

.pagination__controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--spacing-4);
}

.pagination__controls > :first-child {
  margin-right: var(--spacing-8);
}

.pagination__controls > :last-child {
  margin-left: var(--spacing-8);
}

.pagination__page {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--color-grey-700);
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  font-weight: 700;
  cursor: pointer;
}

.pagination__page:hover {
  background: var(--color-grey-75);
}

.pagination__page:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

.pagination__page--current,
.pagination__page--current:hover {
  background: var(--color-purple-100);
  border-color: var(--color-purple-300);
  color: var(--color-purple-800);
}

.pagination__gap {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  color: var(--color-grey-500);
}
</style>
