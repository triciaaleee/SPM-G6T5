<script setup lang="ts">
/**
 * E2-15: a live chat between an Organiser and their event's assigned
 * coordinator. Mounted once in App.vue (sibling to RouterView, not inside
 * it), so collapse/expand state and the active thread survive navigation —
 * "consistently there" on every page, not just the event's own.
 *
 * One thread per event. On an event's own detail page the drawer binds to
 * that event's thread; everywhere else (the events list, the coordinator's
 * workload view) it shows an inbox of every thread this viewer has.
 *
 * Chat-service has no push channel (same situation notification-service is
 * in — see NotificationBell.vue), so "live" means polling: the inbox
 * refreshes in the background every 20s (for the unread badge), and the
 * open thread polls every 4s while the drawer is expanded on it.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { ChatBubbleLeftRightIcon } from "@heroicons/vue/24/outline";
import { ChevronRightIcon, ArrowLeftIcon } from "@heroicons/vue/20/solid";
import {
  ChatError,
  fetchChatMessages,
  fetchChatThreads,
  markChatThreadRead,
  sendChatMessage,
  type ChatMessage,
  type ChatThreadHistory,
  type ChatThreadSummary,
} from "../../lib/chatApi";

const THREADS_POLL_MS = 20_000;
const ACTIVE_POLL_MS = 4_000;

const route = useRoute();

const expanded = ref(false);
const threads = ref<ChatThreadSummary[]>([]);
const threadsLoading = ref(false);
const threadsError = ref<string | null>(null);

const activeEventId = ref<number | null>(null);
const history = ref<ChatThreadHistory | null>(null);
const historyLoading = ref(false);
const historyError = ref<string | null>(null);

const composerText = ref("");
const sending = ref(false);
const sendError = ref<string | null>(null);

const messageList = ref<HTMLElement | null>(null);

/** Whether the current route is a single event's own page — the drawer binds to its thread there. */
const boundEventId = computed(() => {
  if (route.name !== "event-detail") return null;
  const id = Number(route.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
});

const onEventPage = computed(() => boundEventId.value !== null);
const totalUnread = computed(() => threads.value.reduce((sum, t) => sum + t.unreadCount, 0));

const activeSummary = computed(() => threads.value.find((t) => t.eventId === activeEventId.value) ?? null);

async function loadThreads(): Promise<void> {
  threadsLoading.value = threads.value.length === 0;
  try {
    threads.value = await fetchChatThreads();
    threadsError.value = null;
  } catch {
    threadsError.value = "We couldn't load your conversations.";
  } finally {
    threadsLoading.value = false;
  }
}

async function scrollToBottom(): Promise<void> {
  await new Promise((resolve) => requestAnimationFrame(resolve));
  if (messageList.value) messageList.value.scrollTop = messageList.value.scrollHeight;
}

async function loadHistory(eventId: number, { markRead }: { markRead: boolean }): Promise<void> {
  historyLoading.value = history.value?.event.id !== eventId;
  try {
    const result = await fetchChatMessages(eventId);
    history.value = result;
    historyError.value = null;
    await scrollToBottom();
    if (markRead && result.unreadCount > 0) {
      await markChatThreadRead(eventId);
      // Reflect it immediately rather than waiting for the next poll.
      threads.value = threads.value.map((t) => (t.eventId === eventId ? { ...t, unreadCount: 0 } : t));
    }
  } catch (err) {
    historyError.value = err instanceof ChatError ? err.message : "We couldn't load this conversation.";
  } finally {
    historyLoading.value = false;
  }
}

function openThread(eventId: number): void {
  activeEventId.value = eventId;
}

function backToInbox(): void {
  activeEventId.value = null;
  history.value = null;
}

async function send(): Promise<void> {
  const eventId = activeEventId.value;
  const body = composerText.value.trim();
  if (!eventId || !body || sending.value) return;

  sending.value = true;
  sendError.value = null;
  try {
    const { message } = await sendChatMessage(eventId, body);
    if (history.value?.event.id === eventId) {
      history.value.messages.push(message as ChatMessage);
      await scrollToBottom();
    }
    composerText.value = "";
    await loadThreads();
  } catch (err) {
    sendError.value = err instanceof ChatError ? err.message : "Couldn't send your message.";
  } finally {
    sending.value = false;
  }
}

function toggle(): void {
  expanded.value = !expanded.value;
}

function formatWhen(iso: string): string {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr${hours === 1 ? "" : "s"} ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function truncate(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// Entering/leaving an event's own page always wins: bound there, back to
// the inbox everywhere else. A thread picked by hand from the inbox stays
// open until the route changes to or from an event-detail page.
watch(
  () => [route.name, boundEventId.value] as const,
  ([, id]) => {
    activeEventId.value = id;
    history.value = null;
  },
  { immediate: true },
);

watch(
  () => [activeEventId.value, expanded.value] as const,
  ([eventId, isExpanded]) => {
    if (eventId && isExpanded) void loadHistory(eventId, { markRead: true });
  },
  { immediate: true },
);

let threadsTimer: number | undefined;
let activeTimer: number | undefined;

watch(
  () => [activeEventId.value, expanded.value] as const,
  ([eventId, isExpanded]) => {
    window.clearInterval(activeTimer);
    if (eventId && isExpanded) {
      activeTimer = window.setInterval(() => void loadHistory(eventId, { markRead: true }), ACTIVE_POLL_MS);
    }
  },
);

onMounted(() => {
  void loadThreads();
  threadsTimer = window.setInterval(loadThreads, THREADS_POLL_MS);
});

onBeforeUnmount(() => {
  window.clearInterval(threadsTimer);
  window.clearInterval(activeTimer);
});
</script>

<template>
  <div class="chat-drawer">
    <button
      type="button"
      class="tab"
      :aria-expanded="expanded"
      aria-haspopup="true"
      aria-label="Chat"
      @click="toggle"
    >
      <ChatBubbleLeftRightIcon class="tab__icon" aria-hidden="true" />
      <span v-if="totalUnread > 0" class="tab__badge" aria-hidden="true">{{ totalUnread > 9 ? "9+" : totalUnread }}</span>
    </button>

    <Transition name="slide">
      <aside v-if="expanded" class="panel" role="complementary" aria-label="Chat">
        <!-- Inbox: every event this viewer has a chat for. -->
        <template v-if="activeEventId === null">
          <div class="panel__header">
            <p class="panel__title">Conversations</p>
            <button type="button" class="icon-btn" aria-label="Collapse chat" @click="toggle">
              <ChevronRightIcon class="icon-btn__icon" aria-hidden="true" />
            </button>
          </div>

          <p v-if="threadsLoading" class="body-small muted panel__message">Loading…</p>
          <p v-else-if="threadsError" class="body-small error-text panel__message">{{ threadsError }}</p>
          <p v-else-if="threads.length === 0" class="body-small muted panel__message">
            No conversations yet.
          </p>

          <ul v-else class="thread-list">
            <li v-for="t in threads" :key="t.eventId">
              <button type="button" class="thread-row" @click="openThread(t.eventId)">
                <div class="thread-row__top">
                  <span class="thread-row__name">{{ t.eventName }}</span>
                  <span v-if="t.lastMessage" class="thread-row__when">{{ formatWhen(t.lastMessage.createdAt) }}</span>
                </div>
                <p class="thread-row__event">{{ t.otherParty ?? "Unknown" }}</p>
                <div class="thread-row__bottom">
                  <p class="thread-row__preview">
                    {{ t.lastMessage ? truncate(t.lastMessage.body) : "No messages yet" }}
                  </p>
                  <span v-if="t.unreadCount > 0" class="thread-row__badge">{{ t.unreadCount }}</span>
                </div>
              </button>
            </li>
          </ul>
        </template>

        <!-- One event's thread. -->
        <template v-else>
          <div class="panel__header">
            <div class="panel__header-info">
              <button v-if="!onEventPage" type="button" class="icon-btn icon-btn--inline" aria-label="Back to conversations" @click="backToInbox">
                <ArrowLeftIcon class="icon-btn__icon" aria-hidden="true" />
              </button>
              <div>
                <p class="panel__title">{{ activeSummary?.eventName ?? history?.event.name ?? "Chat" }}</p>
                <p v-if="activeSummary" class="body-small muted panel__subtitle">{{ activeSummary.otherParty }}</p>
              </div>
            </div>
            <button type="button" class="icon-btn" aria-label="Collapse chat" @click="toggle">
              <ChevronRightIcon class="icon-btn__icon" aria-hidden="true" />
            </button>
          </div>

          <p v-if="historyLoading && !history" class="body-small muted panel__message">Loading…</p>
          <p v-else-if="historyError" class="body-small error-text panel__message">{{ historyError }}</p>

          <template v-else-if="history">
            <div ref="messageList" class="message-list">
              <p v-if="history.messages.length === 0" class="body-small muted panel__message">
                No messages yet — say hello.
              </p>
              <div
                v-for="m in history.messages"
                :key="m.id"
                class="bubble-row"
                :class="{ 'bubble-row--mine': m.mine }"
              >
                <div class="bubble" :class="{ 'bubble--mine': m.mine }">
                  <p class="bubble__body">{{ m.body }}</p>
                  <p class="bubble__time">{{ formatTime(m.createdAt) }}</p>
                </div>
              </div>
            </div>

            <div class="composer">
              <p v-if="!history.event.canSend" class="body-small muted composer__closed">
                This event is closed — the conversation is read-only.
              </p>
              <template v-else>
                <p v-if="sendError" class="body-small error-text composer__error">{{ sendError }}</p>
                <div class="composer__row">
                  <textarea
                    v-model="composerText"
                    class="composer__input"
                    rows="1"
                    placeholder="Message…"
                    :disabled="sending"
                    @keydown.enter.exact.prevent="send"
                  />
                  <button type="button" class="btn-send" :disabled="sending || !composerText.trim()" @click="send">
                    Send
                  </button>
                </div>
              </template>
            </div>
          </template>
        </template>
      </aside>
    </Transition>
  </div>
</template>

<style scoped>
.chat-drawer {
  position: relative;
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

/* Trigger button, sitting inline in the header's account row next to the
   notification bell — same footprint/hover convention as .bell__button in
   NotificationBell.vue. */
.tab {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--spacing-40);
  height: var(--spacing-40);
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-purple-600);
  cursor: pointer;
}

.tab:hover {
  background: var(--color-purple-100);
  color: var(--color-purple-700);
}

.tab:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

.tab__icon {
  width: var(--spacing-24);
  height: var(--spacing-24);
}

.tab__badge {
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

/* Expanded panel. */
.panel {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 34;
  width: 380px;
  max-width: 100vw;
  display: flex;
  flex-direction: column;
  background: var(--color-base-white);
  border-left: 1px solid var(--color-grey-100);
  box-shadow: var(--shadow-popover);
}

.slide-enter-active,
.slide-leave-active {
  transition: transform 0.2s ease-out;
}

.slide-enter-from,
.slide-leave-to {
  transform: translateX(100%);
}

@media (prefers-reduced-motion: reduce) {
  .slide-enter-active,
  .slide-leave-active {
    transition: none;
  }
}

.panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-8);
  padding: var(--spacing-16);
  border-bottom: 1px solid var(--color-grey-100);
  flex-shrink: 0;
}

.panel__header-info {
  display: flex;
  align-items: center;
  gap: var(--spacing-8);
  min-width: 0;
}

.panel__title {
  margin: 0;
  font-size: 1rem;
  font-weight: 700;
  line-height: 1.25rem;
  color: var(--color-grey-900);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.panel__subtitle {
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.panel__message {
  padding: var(--spacing-24) var(--spacing-16);
  text-align: center;
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: var(--spacing-32);
  height: var(--spacing-32);
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-grey-700);
  cursor: pointer;
}

.icon-btn:hover {
  background: var(--color-grey-75);
}

.icon-btn--inline {
  margin-left: calc(-1 * var(--spacing-8));
}

.icon-btn__icon {
  width: var(--spacing-20, 20px);
  height: var(--spacing-20, 20px);
}

/* Inbox list. */
.thread-list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  flex: 1;
}

.thread-list li + li {
  border-top: 1px solid var(--color-grey-100);
}

.thread-row {
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

.thread-row:hover {
  background: var(--color-grey-75);
}

.thread-row__top {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--spacing-8);
}

.thread-row__name {
  font-size: 0.9375rem;
  font-weight: 700;
  color: var(--color-grey-900);
}

.thread-row__when {
  flex-shrink: 0;
  font-size: 0.75rem;
  color: var(--color-grey-500);
}

.thread-row__event {
  margin: 0;
  font-size: 0.75rem;
  color: var(--color-purple-700);
}

.thread-row__bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-8);
}

.thread-row__preview {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--color-grey-700);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.thread-row__badge {
  flex-shrink: 0;
  min-width: var(--spacing-16);
  padding: 0 var(--spacing-4);
  border-radius: var(--radius-full);
  background: var(--color-purple-600);
  color: var(--color-base-white);
  font-size: 0.6875rem;
  font-weight: 700;
  text-align: center;
}

/* Thread view. */
.message-list {
  flex: 1;
  overflow-y: auto;
  padding: var(--spacing-16);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
}

.bubble-row {
  display: flex;
}

.bubble-row--mine {
  justify-content: flex-end;
}

.bubble {
  max-width: 80%;
  padding: var(--spacing-8) var(--spacing-12);
  border-radius: var(--radius-sm);
  background: var(--color-grey-75);
}

.bubble--mine {
  background: var(--color-purple-600);
  color: var(--color-base-white);
}

.bubble__body {
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.25rem;
  white-space: pre-wrap;
  word-break: break-word;
}

.bubble__time {
  margin: var(--spacing-2) 0 0;
  font-size: 0.6875rem;
  opacity: 0.7;
}

.composer {
  flex-shrink: 0;
  padding: var(--spacing-12) var(--spacing-16);
  border-top: 1px solid var(--color-grey-100);
}

.composer__closed {
  text-align: center;
}

.composer__error {
  margin: 0 0 var(--spacing-8);
}

.composer__row {
  display: flex;
  align-items: flex-end;
  gap: var(--spacing-8);
}

.composer__input {
  flex: 1;
  min-width: 0;
  max-height: 96px;
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  color: var(--color-grey-900);
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-xs);
  padding: var(--spacing-8) var(--spacing-12);
  resize: none;
}

.composer__input:disabled {
  opacity: 0.6;
}

.btn-send {
  flex-shrink: 0;
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  font-weight: 700;
  color: var(--color-base-white);
  background: var(--color-purple-600);
  border: 1px solid transparent;
  border-radius: var(--radius-xs);
  padding: var(--spacing-8) var(--spacing-16);
  cursor: pointer;
}

.btn-send:not(:disabled):hover {
  background: var(--color-purple-700, var(--color-purple-600));
}

.btn-send:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
</style>
