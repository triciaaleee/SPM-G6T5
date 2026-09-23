<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import VenueIcon, { type VenueIconName } from "./VenueIcon.vue";

/**
 * One pill in the filter bar. Inactive, it reads "Label ⌄"; once a value
 * is set it switches to the selected treatment and shows `activeLabel`
 * with an × that clears just this filter. Clicking the pill opens its
 * popover (the default slot). Only one popover is open at a time — the
 * parent owns that via `open`/`update:open`.
 */
const props = defineProps<{
  label: string;
  icon: VenueIconName;
  /** Summary of the current value, e.g. "In North Campus +1"; null when unset. */
  activeLabel: string | null;
  open: boolean;
  /** Popover width in px — wide enough for a calendar, narrower for a number. */
  popoverWidth?: number;
}>();

const emit = defineEmits<{
  "update:open": [value: boolean];
  clear: [];
}>();

const root = ref<HTMLElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
const popover = ref<HTMLElement | null>(null);
const alignRight = ref(false);

function toggle(): void {
  emit("update:open", !props.open);
}

function close(returnFocus = false): void {
  emit("update:open", false);
  if (returnFocus) trigger.value?.focus();
}

function onDocumentPointerDown(e: PointerEvent): void {
  if (root.value && !root.value.contains(e.target as Node)) close();
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.stopPropagation();
    close(true);
  }
}

watch(
  () => props.open,
  async (isOpen) => {
    if (isOpen) {
      document.addEventListener("pointerdown", onDocumentPointerDown);
      // Flip to right-aligned when a left-aligned popover would run off
      // the viewport (chips near the end of a wrapped row).
      const rect = trigger.value?.getBoundingClientRect();
      const width = props.popoverWidth ?? 320;
      alignRight.value = !!rect && rect.left + width > window.innerWidth - 16 && rect.right - width >= 16;
      await nextTick();
      popover.value?.querySelector<HTMLElement>("input, button, [tabindex]")?.focus();
    } else {
      document.removeEventListener("pointerdown", onDocumentPointerDown);
    }
  },
);

onBeforeUnmount(() => document.removeEventListener("pointerdown", onDocumentPointerDown));
</script>

<template>
  <div ref="root" class="filter-chip" @keydown="onKeydown">
    <div class="chip" :class="{ 'chip--active': activeLabel, 'chip--open': open }">
      <button ref="trigger" type="button" class="chip__trigger" :aria-expanded="open" aria-haspopup="dialog"
        @click="toggle">
        <VenueIcon :name="icon" />
        <span class="chip__text">{{ activeLabel ?? label }}</span>
        <VenueIcon v-if="!activeLabel" name="chevron-down" :size="16" class="chip__chevron" />
      </button>
      <button v-if="activeLabel" type="button" class="chip__clear" :aria-label="`Clear ${label} filter`"
        @click="emit('clear')">
        <VenueIcon name="close" :size="16" />
      </button>
    </div>

    <div v-if="open" ref="popover" class="popover" :class="{ 'popover--right': alignRight }" role="dialog"
      :aria-label="`${label} filter`" :style="{ width: `${popoverWidth ?? 320}px` }">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.filter-chip {
  position: relative;
}

.chip {
  display: inline-flex;
  align-items: center;
  height: 40px;
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-full);
  background: var(--color-base-white);
  color: var(--color-grey-700);
}

.chip:hover {
  background: var(--color-grey-75);
  color: var(--color-grey-800);
}

.chip--open {
  border-color: var(--color-purple-600);
}

/* Style.md 3.1 "Selected" */
.chip--active,
.chip--active:hover {
  background: var(--color-purple-100);
  border-color: var(--color-purple-300);
  color: var(--color-purple-800);
}

.chip__trigger {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-8);
  height: 100%;
  padding: 0 var(--spacing-16);
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  color: inherit;
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  cursor: pointer;
  white-space: nowrap;
}

.chip--active .chip__trigger {
  padding-right: var(--spacing-4);
}

.chip__text {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chip__chevron {
  margin-right: calc(var(--spacing-4) * -1);
}

.chip__clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  margin-right: var(--spacing-8);
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.chip__clear:hover {
  background: var(--color-purple-200);
}

.popover {
  position: absolute;
  top: calc(100% + var(--spacing-8));
  left: 0;
  z-index: 20;
  max-width: calc(100vw - 2 * var(--spacing-16));
  padding: var(--spacing-16);
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-popover);
}

.popover--right {
  left: auto;
  right: 0;
}
</style>
