<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  ClarificationActionError,
  addClarificationQuestion,
  fetchClarifications,
  replyToClarification,
  resolveClarificationQuestion,
  type ClarificationMessage,
} from "../lib/eventsApi";

const props = defineProps<{
  eventId: number;
  /** Coordinator-only: whether the thread can be acted on right now — asking a follow-up question or resolving one (AC2: only while clarification is outstanding). */
  canManage: boolean;
  currentUserId: string;
}>();

const messages = ref<ClarificationMessage[]>([]);
const loading = ref(false);
const loadError = ref<string | null>(null);

const expanded = ref<Set<number>>(new Set());
const replyOpenFor = ref<number | null>(null);
const replyText = ref("");
const replyError = ref<string | null>(null);
const submittingReply = ref(false);

const showNewQuestionBox = ref(false);
const newQuestionText = ref("");
const newQuestionError = ref<string | null>(null);
const submittingQuestion = ref(false);

const resolvingFor = ref<number | null>(null);

const questions = computed(() =>
  messages.value
    .filter((m) => m.parent_id === null)
    .slice()
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()),
);

/** Approve unblocks once every question is resolved — read by the parent
 * via a template ref (see EventDetailView's canApprove). */
const allResolved = computed(() => questions.value.length > 0 && questions.value.every((q) => q.resolved));

function repliesFor(questionId: number): ClarificationMessage[] {
  return messages.value
    .filter((m) => m.parent_id === questionId)
    .slice()
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
}

function authorLabel(m: ClarificationMessage): string {
  if (m.author_role === "coordinator") return m.author_id === props.currentUserId ? "You (Coordinator)" : "Coordinator";
  return m.author_id === props.currentUserId ? "You (Organiser)" : "Organiser";
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

/** Telegram-style alignment: the caller's own messages sit on the right
 * in the accent colour, the other party's sit on the left in white. */
function isOwnMessage(m: ClarificationMessage): boolean {
  return m.author_id === props.currentUserId;
}

function toggleQuestion(id: number): void {
  if (expanded.value.has(id)) {
    expanded.value.delete(id);
  } else {
    expanded.value.add(id);
  }
  // Set mutation doesn't trigger reactivity on its own — reassign to notify.
  expanded.value = new Set(expanded.value);
}

function openReplyBox(questionId: number): void {
  replyOpenFor.value = questionId;
  replyText.value = "";
  replyError.value = null;
  // Replying without the thread expanded would mean composing blind —
  // show the conversation being replied to.
  expanded.value = new Set(expanded.value).add(questionId);
}

function cancelReply(): void {
  replyOpenFor.value = null;
  replyText.value = "";
  replyError.value = null;
}

async function submitReply(questionId: number): Promise<void> {
  const text = replyText.value.trim();
  if (!text) {
    replyError.value = "A reply is required.";
    return;
  }
  submittingReply.value = true;
  replyError.value = null;
  try {
    const created = await replyToClarification(props.eventId, questionId, text);
    messages.value.push(created);
    cancelReply();
  } catch (err) {
    replyError.value = err instanceof ClarificationActionError ? err.message : "We couldn't send that reply. Please try again.";
  } finally {
    submittingReply.value = false;
  }
}

function openNewQuestion(): void {
  showNewQuestionBox.value = true;
  newQuestionText.value = "";
  newQuestionError.value = null;
}

function cancelNewQuestion(): void {
  showNewQuestionBox.value = false;
  newQuestionText.value = "";
  newQuestionError.value = null;
}

async function submitNewQuestion(): Promise<void> {
  const text = newQuestionText.value.trim();
  if (!text) {
    newQuestionError.value = "A question is required.";
    return;
  }
  submittingQuestion.value = true;
  newQuestionError.value = null;
  try {
    const created = await addClarificationQuestion(props.eventId, text);
    messages.value.push(created);
    cancelNewQuestion();
  } catch (err) {
    newQuestionError.value = err instanceof ClarificationActionError ? err.message : "We couldn't add that question. Please try again.";
  } finally {
    submittingQuestion.value = false;
  }
}

async function refresh(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    messages.value = await fetchClarifications(props.eventId);
  } catch {
    loadError.value = "We couldn't load the clarification thread. Please try again.";
  } finally {
    loading.value = false;
  }
}

/** Marks a question resolved, then auto-collapses it (cascades back closed). */
async function resolveQuestion(questionId: number): Promise<void> {
  resolvingFor.value = questionId;
  try {
    const updated = await resolveClarificationQuestion(props.eventId, questionId);
    const index = messages.value.findIndex((m) => m.id === updated.id);
    if (index !== -1) messages.value[index] = updated;

    if (replyOpenFor.value === questionId) cancelReply();
    expanded.value.delete(questionId);
    expanded.value = new Set(expanded.value);
  } catch {
    loadError.value = "We couldn't resolve that question. Please try again.";
  } finally {
    resolvingFor.value = null;
  }
}

defineExpose({ refresh, allResolved });

onMounted(refresh);
</script>

<template>
  <aside v-if="loading || messages.length > 0" class="clarification-panel" aria-label="Clarification thread">
    <div class="clarification-panel__header">
      <p class="clarification-panel__title">Clarifications</p>
      <button
        v-if="canManage"
        type="button"
        class="clarification-panel__icon-btn"
        title="Ask another question"
        aria-label="Ask another question"
        @click="openNewQuestion"
      >
        +
      </button>
    </div>

    <div v-if="showNewQuestionBox" class="clarification-panel__new-question">
      <label for="new-question-text" class="body-small muted">New question for the Organiser</label>
      <textarea
        id="new-question-text"
        v-model="newQuestionText"
        rows="3"
        class="clarification-panel__textarea"
        placeholder="What would you like to ask?"
      />
      <p v-if="newQuestionError" class="clarification-panel__error">{{ newQuestionError }}</p>
      <div class="clarification-panel__row-buttons">
        <button type="button" class="btn btn-primary" :disabled="submittingQuestion" @click="submitNewQuestion">
          {{ submittingQuestion ? "Submitting…" : "Submit" }}
        </button>
        <button type="button" class="btn btn-secondary" :disabled="submittingQuestion" @click="cancelNewQuestion">
          Cancel
        </button>
      </div>
    </div>

    <div class="clarification-panel__body">
      <p v-if="loading" class="body-default muted">Loading…</p>
      <p v-else-if="loadError" class="clarification-panel__error">{{ loadError }}</p>

      <ul v-else class="clarification-thread">
        <li v-for="(q, index) in questions" :key="q.id" class="clarification-thread__item">
          <div class="clarification-thread__item-header">
            <button
              type="button"
              class="clarification-thread__question"
              :aria-expanded="expanded.has(q.id)"
              @click="toggleQuestion(q.id)"
            >
              <span class="clarification-thread__chevron" :class="{ 'clarification-thread__chevron--open': expanded.has(q.id) }">
                &#9656;
              </span>
              <span class="clarification-thread__question-text">
                <strong>Qn {{ index + 1 }}.</strong> {{ q.message }}
              </span>
            </button>

            <span v-if="q.resolved" class="clarification-thread__resolved-tick" title="Resolved">&#10003;</span>
            <button
              v-else-if="canManage"
              type="button"
              class="clarification-thread__resolve-btn"
              :disabled="resolvingFor === q.id"
              @click="resolveQuestion(q.id)"
            >
              {{ resolvingFor === q.id ? "…" : "Resolve" }}
            </button>
          </div>
          <p class="clarification-thread__meta">{{ authorLabel(q) }} · {{ formatTime(q.created_at) }}</p>

          <!-- Collapsed: Reply sits right here, no need to expand first.
               Resolved questions are read-only — no more replies.
               Independent of the expand toggle below, not an else-branch
               of it — a resolved question must still require a click to
               reveal the thread, not just skip straight to it. -->
          <div v-if="!expanded.has(q.id) && !q.resolved" class="clarification-thread__reply-area">
            <button type="button" class="clarification-thread__reply-btn" @click="openReplyBox(q.id)">
              Reply
            </button>
          </div>

          <!-- Expanded (resolved or not): replies to the question, as a
               chat thread — the question itself isn't repeated here, it's
               already shown above. -->
          <div v-if="expanded.has(q.id)" class="chat-thread">
            <div
              v-for="reply in repliesFor(q.id)"
              :key="reply.id"
              class="chat-row"
              :class="isOwnMessage(reply) ? 'chat-row--own' : 'chat-row--other'"
            >
              <div class="chat-bubble" :class="isOwnMessage(reply) ? 'chat-bubble--own' : 'chat-bubble--other'">
                <p class="chat-bubble__text">{{ reply.message }}</p>
              </div>
            </div>

            <!-- Reply drops to the bottom of the thread, like a chat input.
                 Resolved questions are read-only — the thread stays viewable, but no more replies. -->
            <template v-if="!q.resolved">
              <div v-if="replyOpenFor === q.id" class="clarification-thread__reply-box">
                <textarea v-model="replyText" rows="2" class="clarification-panel__textarea" placeholder="Write a reply…" />
                <p v-if="replyError" class="clarification-panel__error">{{ replyError }}</p>
                <div class="clarification-panel__row-buttons">
                  <button type="button" class="btn btn-primary" :disabled="submittingReply" @click="submitReply(q.id)">
                    {{ submittingReply ? "Sending…" : "Send" }}
                  </button>
                  <button type="button" class="btn btn-secondary" :disabled="submittingReply" @click="cancelReply">
                    Cancel
                  </button>
                </div>
              </div>
              <button v-else type="button" class="clarification-thread__reply-btn" @click="openReplyBox(q.id)">
                Reply
              </button>
            </template>
          </div>
        </li>
      </ul>
    </div>
  </aside>
</template>

<style scoped>
/* Sits under the Coordinator Details card as its own block, matching the
 * same card language (border/radius/shadow) as its siblings rather than
 * a stretched or floating side panel. */
.clarification-panel {
  width: 100%;
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.06);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.clarification-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-16);
  border-bottom: 1px solid var(--color-grey-100);
}

.clarification-panel__title {
  font-size: 1.125rem;
  font-weight: 700;
  color: var(--color-grey-900);
}

.clarification-panel__icon-btn {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-xs);
  border: 1px solid var(--color-grey-200);
  background: var(--color-base-white);
  font-size: 1.125rem;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

.clarification-panel__icon-btn:hover {
  background: var(--color-grey-75);
}

.clarification-panel__body {
  padding: var(--spacing-16);
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}

.clarification-panel__new-question {
  padding: var(--spacing-16);
  border-bottom: 1px solid var(--color-grey-100);
  background: var(--color-grey-50);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
}

.clarification-panel__textarea {
  width: 100%;
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-xs);
  padding: var(--spacing-12);
  font-size: 0.9375rem;
  color: var(--color-grey-900);
  background: var(--color-base-white);
  resize: vertical;
}

.clarification-panel__error {
  color: var(--color-error-600);
  font-size: 0.875rem;
}

.clarification-panel__row-buttons {
  display: flex;
  gap: var(--spacing-8);
}

.clarification-thread {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-16);
}

.clarification-thread__item {
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-xs);
  padding: var(--spacing-12);
}

.clarification-thread__item-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--spacing-8);
}

.clarification-thread__question {
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-8);
  flex: 1;
  min-width: 0;
  background: none;
  border: none;
  text-align: left;
  cursor: pointer;
  padding: 0;
  font: inherit;
  color: var(--color-grey-900);
}

/* Top-right corner of the question, as asked. */
.clarification-thread__resolved-tick {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--color-success-600);
  color: var(--color-base-white);
  font-size: 0.75rem;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}

.clarification-thread__resolve-btn {
  flex-shrink: 0;
  background: none;
  border: 1px solid var(--color-purple-600);
  color: var(--color-purple-600);
  border-radius: var(--radius-xs);
  font-size: 0.75rem;
  font-weight: 700;
  padding: var(--spacing-4) var(--spacing-8);
  cursor: pointer;
}

.clarification-thread__resolve-btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.clarification-thread__resolve-btn:not(:disabled):hover {
  background: var(--color-purple-100);
}

.clarification-thread__chevron {
  display: inline-block;
  transition: transform 0.15s ease-out;
  margin-top: 0.15rem;
}

.clarification-thread__chevron--open {
  transform: rotate(90deg);
}

.clarification-thread__question-text {
  flex: 1;
}

.clarification-thread__meta {
  font-size: 0.75rem;
  color: var(--color-grey-500);
  margin: var(--spacing-4) 0 0 var(--spacing-24);
}

.clarification-thread__reply-area {
  margin-top: var(--spacing-8);
  margin-left: var(--spacing-24);
}

.clarification-thread__reply-btn {
  align-self: flex-start;
  background: none;
  border: none;
  color: var(--color-purple-600);
  font-size: 0.875rem;
  font-weight: 700;
  cursor: pointer;
  padding: var(--spacing-4) 0;
}

.clarification-thread__reply-box {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
}

/* Telegram-style chat thread: own messages on the right in the accent
 * colour, the other party's on the left in white with a border. */
.chat-thread {
  margin-top: var(--spacing-12);
  margin-left: var(--spacing-24);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
}

.chat-row {
  display: flex;
}

.chat-row--own {
  justify-content: flex-end;
}

.chat-row--other {
  justify-content: flex-start;
}

.chat-bubble {
  max-width: 80%;
  border-radius: var(--radius-lg);
  padding: var(--spacing-8) var(--spacing-12);
}

.chat-bubble--own {
  background: var(--color-purple-600);
  color: var(--color-base-white);
  border-bottom-right-radius: var(--radius-xs);
}

.chat-bubble--other {
  background: var(--color-base-white);
  color: var(--color-grey-900);
  border: 1px solid var(--color-grey-200);
  border-bottom-left-radius: var(--radius-xs);
}

.chat-bubble__text {
  margin: 0;
  font-size: 0.9375rem;
  line-height: 1.3rem;
  white-space: pre-wrap;
}

.body-default {
  font-size: 1rem;
  line-height: 1.25rem;
}

.body-small {
  font-size: 0.875rem;
  line-height: 1.125rem;
}

.muted {
  color: var(--color-grey-500);
}

.btn {
  border-radius: var(--radius-xs);
  padding: var(--spacing-8) var(--spacing-16);
  font-size: 0.875rem;
  font-weight: 700;
  border: 1px solid transparent;
  cursor: pointer;
}

.btn:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.btn-secondary {
  background: var(--color-grey-75);
  color: var(--color-grey-900);
  border-color: var(--color-grey-200);
}

.btn-secondary:not(:disabled):hover {
  background: var(--color-grey-100);
}

.btn-primary {
  background: var(--color-purple-600);
  color: var(--color-base-white);
}

.btn-primary:not(:disabled):hover {
  background: var(--color-purple-700, var(--color-purple-600));
}
</style>
