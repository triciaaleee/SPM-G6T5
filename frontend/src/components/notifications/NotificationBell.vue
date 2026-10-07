<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { BellIcon } from "@heroicons/vue/24/outline";
import { XMarkIcon } from "@heroicons/vue/20/solid";
import { fetchNotifications, markNotificationsRead, type AppNotification } from "../../lib/notificationsApi";

/**
 * E7-1: the header's notification bell. The badge flags unread
 * notifications; opening the dropdown shows the five latest and marks them
 * read. Beyond the badge, a new arrival also raises a toast, rings the bell
 * and puts the unread count in the tab title, so it's noticed even when the
 * header isn't being looked at.
 *
 * Notification-service has no push channel yet (the C4 model plans a
 * broker), so the feed is polled, and refreshed whenever the tab regains
 * focus.
 */

const POLL_MS = 30_000;
const TOAST_MS = 8_000;
const LIST_LIMIT = 5;

const router = useRouter();

const notifications = ref<AppNotification[]>([]);
const unreadCount = ref(0);
const open = ref(false);
const loading = ref(false);
const loadError = ref<string | null>(null);
const ringing = ref(false);
const toast = ref<{ title: string; body: string } | null>(null);

const root = ref<HTMLElement | null>(null);
const toastEl = ref<HTMLElement | null>(null);

/** Highest id seen so far — anything newer is a fresh arrival. Null until the first load. */
let lastSeenId: number | null = null;
let pollTimer: number | undefined;
let toastTimer: number | undefined;
const baseTitle = document.title;

const badgeLabel = computed(() => (unreadCount.value > 9 ? "9+" : String(unreadCount.value)));

const bellLabel = computed(() =>
  unreadCount.value === 0
    ? "Notifications"
    : `Notifications, ${unreadCount.value} unread`,
);

watch(unreadCount, (count) => {
  document.title = count > 0 ? `(${count}) ${baseTitle}` : baseTitle;
});

function showToast(title: string, body: string): void {
  toast.value = { title, body };
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (toast.value = null), TOAST_MS);

  ringing.value = false;
  // Next frame, so re-adding the class restarts the animation.
  requestAnimationFrame(() => (ringing.value = true));
}

/** Alerts for anything that arrived since the last load. */
function announce(feed: AppNotification[], unread: number): void {
  const newestId = feed[0]?.id ?? 0;

  if (lastSeenId === null) {
    if (unread > 0) {
      showToast(
        `You have ${unread} unread notification${unread === 1 ? "" : "s"}`,
        "Open the bell to see what's changed.",
      );
    }
  } else {
    const fresh = feed.filter((n) => n.id > lastSeenId! && !n.read);
    if (fresh.length === 1) showToast(fresh[0].title, fresh[0].body);
    else if (fresh.length > 1) showToast(`${fresh.length} new notifications`, fresh[0].title);
  }

  lastSeenId = Math.max(lastSeenId ?? 0, newestId);
}

async function refresh(): Promise<void> {
  try {
    const feed = await fetchNotifications(LIST_LIMIT);
    notifications.value = feed.notifications;
    unreadCount.value = feed.unreadCount;
    loadError.value = null;
    announce(feed.notifications, feed.unreadCount);
  } catch {
    loadError.value = "We couldn't load your notifications.";
  }
}

async function toggle(): Promise<void> {
  open.value = !open.value;
  if (!open.value) return;

  toast.value = null;
  loading.value = true;
  await refresh();
  loading.value = false;

  // Opening the list counts as reading it. Rows keep their unread styling
  // until it's closed, so it's still clear which ones are new.
  if (unreadCount.value > 0) {
    try {
      await markNotificationsRead();
      unreadCount.value = 0;
    } catch {
      // Leave the badge as is; the next poll will try again.
    }
  }
}

function close(): void {
  if (!open.value) return;
  open.value = false;
  notifications.value = notifications.value.map((n) => ({ ...n, read: true }));
}

async function openNotification(notification: AppNotification): Promise<void> {
  close();
  if (notification.link) await router.push(notification.link);
}

async function viewFromToast(): Promise<void> {
  toast.value = null;
  if (!open.value) await toggle();
}

function formatWhen(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function onDocumentClick(event: MouseEvent): void {
  const target = event.target as Node;
  // The toast is teleported out of `root`, but clicking it isn't "outside".
  if (root.value?.contains(target) || toastEl.value?.contains(target)) return;
  close();
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") close();
}

function onVisible(): void {
  if (document.visibilityState === "visible") void refresh();
}

onMounted(() => {
  void refresh();
  pollTimer = window.setInterval(refresh, POLL_MS);
  document.addEventListener("click", onDocumentClick);
  document.addEventListener("keydown", onKeydown);
  document.addEventListener("visibilitychange", onVisible);
});

onBeforeUnmount(() => {
  window.clearInterval(pollTimer);
  window.clearTimeout(toastTimer);
  document.removeEventListener("click", onDocumentClick);
  document.removeEventListener("keydown", onKeydown);
  document.removeEventListener("visibilitychange", onVisible);
  document.title = baseTitle;
});
</script>

<template>
  <div ref="root" class="bell">
    <button type="button" class="bell__button" :class="{ 'bell__button--ringing': ringing }" :aria-label="bellLabel"
      :aria-expanded="open" aria-haspopup="true" @click="toggle" @animationend="ringing = false">
      <BellIcon class="bell__icon" aria-hidden="true" />
      <span v-if="unreadCount > 0" class="bell__badge" aria-hidden="true">{{ badgeLabel }}</span>
    </button>

    <div v-if="open" class="dropdown" role="region" aria-label="Notifications">
      <p class="dropdown__heading">Notifications</p>

      <p v-if="loading && notifications.length === 0" class="body-small muted dropdown__message">Loading…</p>
      <p v-else-if="loadError" class="body-small error-text dropdown__message">{{ loadError }}</p>
      <p v-else-if="notifications.length === 0" class="body-small muted dropdown__message">
        You're all caught up.
      </p>

      <ul v-else class="dropdown__list">
        <li v-for="notification in notifications" :key="notification.id">
          <button type="button" class="item" :class="{ 'item--unread': !notification.read }"
            @click="openNotification(notification)">
            <span class="item__title">{{ notification.title }}</span>
            <span class="item__body">{{ notification.body }}</span>
            <span class="item__when">{{ formatWhen(notification.createdAt) }}</span>
          </button>
        </li>
      </ul>

      <!-- The full history view isn't built yet; this is its entry point. -->
      <div class="dropdown__footer">
        <button type="button" class="btn-ghost">See more</button>
      </div>
    </div>

    <Teleport to="body">
      <div v-if="toast" ref="toastEl" class="toast" role="status">
        <BellIcon class="toast__icon" aria-hidden="true" />
        <div class="toast__content">
          <p class="toast__title">{{ toast.title }}</p>
          <p class="toast__body">{{ toast.body }}</p>
          <button type="button" class="btn-ghost toast__action" @click="viewFromToast">View</button>
        </div>
        <button type="button" class="toast__close" aria-label="Dismiss" @click="toast = null">
          <XMarkIcon class="toast__close-icon" aria-hidden="true" />
        </button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.bell {
  position: relative;
}

.bell__button {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--spacing-40);
  height: var(--spacing-40);
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-grey-700);
  cursor: pointer;
}

.bell__button:hover {
  background: var(--color-grey-75);
  color: var(--color-grey-800);
}

.bell__button:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

.bell__icon {
  width: var(--spacing-24);
  height: var(--spacing-24);
}

/* Style.md 3.5: unread notification badge. */
.bell__badge {
  position: absolute;
  top: var(--spacing-2);
  right: var(--spacing-2);
  min-width: var(--spacing-16);
  padding: 0 var(--spacing-4);
  border-radius: var(--radius-full);
  background: var(--color-error-400);
  color: var(--color-base-white);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  text-align: center;
}

.bell__button--ringing .bell__icon {
  animation: ring 0.8s ease-in-out;
  transform-origin: top center;
}

@keyframes ring {
  0%, 100% { transform: rotate(0); }
  15% { transform: rotate(14deg); }
  30% { transform: rotate(-12deg); }
  45% { transform: rotate(9deg); }
  60% { transform: rotate(-6deg); }
  75% { transform: rotate(3deg); }
}

@media (prefers-reduced-motion: reduce) {
  .bell__button--ringing .bell__icon {
    animation: none;
  }
}

.dropdown {
  position: absolute;
  top: calc(100% + var(--spacing-8));
  right: 0;
  z-index: 20;
  width: 360px;
  max-width: calc(100vw - 2 * var(--grid-mobile-margin));
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-popover);
  overflow: hidden;
}

.dropdown__heading {
  margin: 0;
  padding: var(--spacing-16);
  border-bottom: 1px solid var(--color-grey-100);
  font-size: 1rem;
  font-weight: 700;
  line-height: 1.25rem;
  color: var(--color-grey-900);
}

.dropdown__message {
  margin: 0;
  padding: var(--spacing-24) var(--spacing-16);
  text-align: center;
}

.dropdown__list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.dropdown__list li + li {
  border-top: 1px solid var(--color-grey-100);
}

.item {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-4);
  width: 100%;
  padding: var(--spacing-12) var(--spacing-16);
  border: none;
  background: var(--color-base-white);
  font-family: var(--font-family-lato);
  text-align: left;
  cursor: pointer;
}

/* Style.md 3.5: unread notification row. */
.item--unread {
  background: var(--color-purple-100);
}

.item:hover {
  background: var(--color-grey-75);
}

.item:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: -2px;
}

.item__title {
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  color: var(--color-grey-900);
}

.item__body {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-700);
}

.item__when {
  font-size: 0.75rem;
  line-height: 1rem;
  color: var(--color-grey-500);
}

.dropdown__footer {
  display: flex;
  justify-content: center;
  padding: var(--spacing-8);
  border-top: 1px solid var(--color-grey-100);
}

.btn-ghost {
  padding: var(--spacing-4) var(--spacing-12);
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--color-purple-600);
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  cursor: pointer;
}

.btn-ghost:hover {
  background: var(--color-purple-100);
}

.btn-ghost:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

/* Style.md 3.5: toast. */
.toast {
  position: fixed;
  top: var(--spacing-80);
  right: var(--grid-desktop-margin);
  z-index: 30;
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-12);
  width: 360px;
  max-width: calc(100vw - 2 * var(--grid-mobile-margin));
  padding: var(--spacing-16);
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-popover);
  animation: toast-in 0.2s ease-out;
}

@keyframes toast-in {
  from { opacity: 0; transform: translateY(calc(-1 * var(--spacing-8))); }
  to { opacity: 1; transform: none; }
}

@media (prefers-reduced-motion: reduce) {
  .toast {
    animation: none;
  }
}

@media (max-width: 1024px) {
  .toast {
    right: var(--grid-tablet-margin);
  }
}

@media (max-width: 640px) {
  .toast {
    right: var(--grid-mobile-margin);
  }
}

.toast__icon {
  flex-shrink: 0;
  width: var(--spacing-24);
  height: var(--spacing-24);
  color: var(--color-purple-600);
}

.toast__content {
  flex: 1;
  min-width: 0;
}

.toast__title {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  color: var(--color-grey-900);
}

.toast__body {
  margin: var(--spacing-4) 0 0;
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-700);
}

.toast__action {
  margin: var(--spacing-8) 0 0 calc(-1 * var(--spacing-12));
}

.toast__close {
  display: inline-flex;
  flex-shrink: 0;
  padding: var(--spacing-2);
  border: none;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--color-grey-500);
  cursor: pointer;
}

.toast__close:hover {
  background: var(--color-grey-75);
  color: var(--color-grey-800);
}

.toast__close:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

.toast__close-icon {
  width: var(--spacing-16);
  height: var(--spacing-16);
}

.body-small {
  font-size: 0.875rem;
  line-height: 1.125rem;
}

.muted {
  color: var(--color-grey-500);
}

.error-text {
  color: var(--color-error-600);
}
</style>
