<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useId } from "vue";

/**
 * The app's one modal (Style.md 3.7). Scrim and panel live here; a view supplies the content.
 *
 * Column mapping: a fixed overlay centred in the viewport; the panel is `sm` 400px, `md` 600px or `lg` 800px
 * wide (full width minus the overlay padding on small screens).
 *
 * Closes (emits `close`) on a click on the scrim and on Escape, unless `dismissible` is false (an action is
 * running). Confirmations use role "alertdialog"; forms use "dialog". Not teleported, so the markup stays inside
 * the component that opened it.
 */
const props = withDefaults(
  defineProps<{
    size?: "sm" | "md" | "lg";
    role?: "dialog" | "alertdialog";
    /** Scrim click and Escape close it. Pass `!saving` so a running request can't be dismissed. */
    dismissible?: boolean;
    /** Padding inside the panel; off when the content brings its own header and form (the big forms). */
    padded?: boolean;
    /** `id` of an element in the content that names the dialog, when the `title` slot isn't used. */
    labelledBy?: string;
    describedBy?: string;
  }>(),
  { size: "sm", role: "dialog", dismissible: true, padded: true },
);

const emit = defineEmits<{ close: [] }>();

const titleId = useId();
const panel = ref<HTMLElement | null>(null);

function requestClose() {
  if (props.dismissible) emit("close");
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") requestClose();
}

onMounted(() => {
  document.addEventListener("keydown", onKeydown);
  // Focus the panel so keyboard users start inside it (and Escape works straight away).
  panel.value?.focus({ preventScroll: true });
});

onBeforeUnmount(() => document.removeEventListener("keydown", onKeydown));
</script>

<template>
  <div class="modal-overlay" @click.self="requestClose">
    <div
      ref="panel"
      class="modal"
      :class="[`modal--${size}`, { 'modal--padded': padded }]"
      :role="role"
      aria-modal="true"
      :aria-labelledby="labelledBy ?? ($slots.title ? titleId : undefined)"
      :aria-describedby="describedBy"
      tabindex="-1"
    >
      <p v-if="$slots.title" :id="titleId" class="modal-title"><slot name="title" /></p>
      <slot />
      <div v-if="$slots.actions" class="modal-actions"><slot name="actions" /></div>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-24);
  box-sizing: border-box;
  background: var(--color-grey-alpha-40-dark);
}

.modal {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
  width: 100%;
  max-height: 100%;
  overflow-y: auto;
  box-sizing: border-box;
  background: var(--color-base-white);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-popover);
}

.modal:focus {
  outline: none;
}

.modal--padded {
  padding: var(--spacing-24);
}

/* The big forms bring their own header and form, so no gap between them. */
.modal:not(.modal--padded) {
  gap: 0;
}

.modal--sm {
  max-width: 400px;
}

.modal--md {
  max-width: 600px;
}

.modal--lg {
  max-width: 800px;
}

/* Subheading, bold */
.modal-title {
  margin: 0;
  font-size: 1.125rem;
  font-weight: 700;
  line-height: 1.375rem;
  color: var(--color-grey-900);
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--spacing-8);
  margin-top: var(--spacing-16);
}
</style>
