<script setup lang="ts">
import AppButton from "../components/ui/AppButton.vue";
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import {
  fetchNotifications,
  markNotificationRead,
  type AppNotification,
} from "../lib/notificationsApi";

/**
 * E7-1 (#61): the full notification feed, beyond the bell's 5-item
 * preview. Each item is marked read on its own — unlike the bell's dropdown,
 * which marks everything read on open.
 */

const PAGE_SIZE = 20;

const router = useRouter();

const notifications = ref<AppNotification[]>([]);
const nextCursor = ref<number | null>(null);
const loading = ref(false);
const loadingMore = ref(false);
const loadError = ref<string | null>(null);

async function loadFirstPage(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    const feed = await fetchNotifications({ limit: PAGE_SIZE });
    notifications.value = feed.notifications;
    nextCursor.value = feed.nextCursor;
  } catch {
    loadError.value = "We couldn't load your notifications.";
  } finally {
    loading.value = false;
  }
}

async function loadMore(): Promise<void> {
  if (nextCursor.value === null || loadingMore.value) return;
  loadingMore.value = true;
  try {
    const feed = await fetchNotifications({ limit: PAGE_SIZE, before: nextCursor.value });
    notifications.value = [...notifications.value, ...feed.notifications];
    nextCursor.value = feed.nextCursor;
  } catch {
    loadError.value = "We couldn't load more notifications.";
  } finally {
    loadingMore.value = false;
  }
}

async function openNotification(notification: AppNotification): Promise<void> {
  if (!notification.read) {
    notification.read = true;
    try {
      await markNotificationRead(notification.id);
    } catch {
      notification.read = false;
    }
  }
  if (notification.link) await router.push(notification.link);
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

onMounted(loadFirstPage);
</script>

<template>
  <div class="feed">
    <h1 class="feed__heading">Notifications</h1>

    <p v-if="loading" class="body-small muted feed__message">Loading…</p>
    <p v-else-if="loadError" class="body-small error-text feed__message">{{ loadError }}</p>
    <p v-else-if="notifications.length === 0" class="body-small muted feed__message">
      You're all caught up.
    </p>

    <ul v-else class="feed__list">
      <li v-for="notification in notifications" :key="notification.id">
        <button type="button" class="item" :class="{ 'item--unread': !notification.read }"
          @click="openNotification(notification)">
          <span class="item__title">{{ notification.title }}</span>
          <span class="item__body">{{ notification.body }}</span>
          <span class="item__when">{{ formatWhen(notification.createdAt) }}</span>
        </button>
      </li>
    </ul>

    <div v-if="nextCursor !== null" class="feed__footer">
      <AppButton variant="ghost" type="button" :disabled="loadingMore" @click="loadMore">
        {{ loadingMore ? "Loading…" : "Load more" }}
      </AppButton>
    </div>
  </div>
</template>

<style scoped>
.feed {
  max-width: 640px;
  margin: 0 auto;
  padding: var(--spacing-24) var(--grid-desktop-margin);
}

.feed__heading {
  margin: 0 0 var(--spacing-16);
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--color-grey-900);
}

.feed__message {
  margin: 0;
  padding: var(--spacing-24) 0;
  text-align: center;
}

.feed__list {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.feed__list li + li {
  border-top: 1px solid var(--color-grey-100);
}

.item {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-4);
  width: 100%;
  padding: var(--spacing-16);
  border: none;
  background: var(--color-base-white);
  font-family: var(--font-family-lato);
  text-align: left;
  cursor: pointer;
}

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
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-700);
}

.item__when {
  font-size: 0.75rem;
  line-height: 1rem;
  color: var(--color-grey-500);
}

.feed__footer {
  display: flex;
  justify-content: center;
  padding: var(--spacing-16) 0;
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
