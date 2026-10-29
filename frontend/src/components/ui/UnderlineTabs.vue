<script setup lang="ts" generic="K extends string">
/**
 * The app's one set of underline tabs (Style.md 3.5b, 3.7): unselected `Grey/500`, hover `Grey/900`, selected
 * `Secondary Blue/700` with a 2px `Secondary Blue/600` underline, and an optional count. Arrow keys, Home and
 * End move between tabs (WAI-ARIA tabs pattern); only the selected tab is in the Tab order.
 *
 * Column mapping: the tab row fills the width of whatever holds it; the page decides that container's
 * margins and grid span through a class on this component.
 */
export interface TabItem<T extends string = string> {
  key: T;
  label: string;
  /** Shown beside the label (a pill, or "(n)" with `count-style="inline"`). Leave out for no count. */
  count?: number | string;
  /** Replaces the spoken name when the visible text isn't enough. */
  ariaLabel?: string;
  /** `data-testid` for the count pill. */
  countTestId?: string;
  /** Colour the count pill as needing attention (Orange Warning) instead of neutral. */
  attention?: boolean;
}

const props = withDefaults(
  defineProps<{
    tabs: TabItem<K>[];
    modelValue: K;
    ariaLabel?: string;
    /** When set, each tab gets `id="<idPrefix>-<key>"`, so a panel can name its tab with aria-labelledby. */
    idPrefix?: string;
    /** `id` of the panel the tabs control (aria-controls). */
    panelId?: string;
    /** `md` is Body Default, `sm` is Body Small (the guest pages). */
    size?: "md" | "sm";
    countStyle?: "pill" | "inline";
  }>(),
  { size: "md", countStyle: "pill" },
);

const emit = defineEmits<{ "update:modelValue": [key: K] }>();

function select(key: K) {
  if (key !== props.modelValue) emit("update:modelValue", key);
}

function onKeydown(event: KeyboardEvent) {
  const current = props.tabs.findIndex((t) => t.key === props.modelValue);
  const last = props.tabs.length - 1;
  const next =
    event.key === "ArrowRight" ? (current === last ? 0 : current + 1)
    : event.key === "ArrowLeft" ? (current <= 0 ? last : current - 1)
    : event.key === "Home" ? 0
    : event.key === "End" ? last
    : null;
  if (next === null) return;
  event.preventDefault();
  select(props.tabs[next].key);
  (event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>("[role='tab']")[next]?.focus();
}
</script>

<template>
  <div class="tabs" role="tablist" :aria-label="ariaLabel" :class="`tabs--${size}`" @keydown="onKeydown">
    <button
      v-for="tab in tabs"
      :id="idPrefix ? `${idPrefix}-${tab.key}` : undefined"
      :key="tab.key"
      type="button"
      role="tab"
      class="tab"
      :class="{ 'tab--active': modelValue === tab.key }"
      :aria-selected="modelValue === tab.key"
      :aria-controls="panelId"
      :aria-label="tab.ariaLabel"
      :tabindex="modelValue === tab.key ? 0 : -1"
      @click="select(tab.key)"
    >
      {{ tab.label }}
      <template v-if="tab.count !== undefined">
        <span v-if="countStyle === 'inline'"> ({{ tab.count }})</span>
        <span
          v-else
          class="tab__count tab-count"
          :class="{ 'tab__count--attention': tab.attention }"
          :data-testid="tab.countTestId"
        >{{ tab.count }}</span>
      </template>
    </button>
  </div>
</template>

<style scoped>
.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-32);
  border-bottom: 1px solid var(--color-grey-100);
}

.tab {
  appearance: none;
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-8);
  flex-shrink: 0;
  margin-bottom: -1px;
  padding: var(--spacing-12) var(--spacing-4);
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  font-family: var(--font-family-lato);
  font-size: 1rem;
  line-height: 1.25rem;
  font-weight: 700;
  color: var(--color-grey-600);
  cursor: pointer;
}

.tabs--sm .tab {
  font-size: 0.875rem;
  line-height: 1.125rem;
}

.tab:hover {
  color: var(--color-grey-900);
}

.tab--active,
.tab--active:hover {
  color: var(--color-blue-700);
  border-bottom-color: var(--color-blue-600);
}

.tab__count {
  min-width: 1.25rem;
  padding: 0 var(--spacing-8);
  border-radius: var(--radius-full);
  background: var(--color-grey-75);
  color: var(--color-grey-600);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  text-align: center;
}

.tab--active .tab__count {
  background: var(--color-blue-100);
  color: var(--color-blue-800);
}

.tab .tab__count--attention {
  background: var(--color-warning-200);
  color: var(--color-warning-900);
}
</style>
