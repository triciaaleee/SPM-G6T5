<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import AppButton from "../../components/ui/AppButton.vue";
import AppPanel from "../../components/ui/AppPanel.vue";
import BackLink from "../../components/ui/BackLink.vue";
import SegmentedToggle from "../../components/ui/SegmentedToggle.vue";
import { useRoute, useRouter } from "vue-router";
import {
  fetchEventById,
  saveDraft,
  submitEventRequest,
  updateDraft,
  updateEventDetails,
  ValidationError,
  type EventRequestPayload,
} from "../../lib/eventsApi";

const route = useRoute();
const router = useRouter();

const form = reactive<EventRequestPayload>({
  name: "",
  purpose: "",
  description: "",
  proposedDate: "",
  startTime: "",
  endTime: "",
  expectedAttendance: "",
  venue: "",
  accessibility: "",
  equipment: "",
  technicalSupport: "",
  registrationNeeded: false,
});

const fieldErrors = ref<Record<string, string>>({});

const REGISTRATION_OPTIONS = [
  { key: "yes" as const, label: "Yes" },
  { key: "no" as const, label: "No" },
];
const registrationChoice = computed({
  get: () => (form.registrationNeeded ? "yes" : "no"),
  set: (value: "yes" | "no") => {
    form.registrationNeeded = value === "yes";
  },
});
const generalError = ref<string | null>(null);
const submitting = ref(false);
const submittedEventId = ref<number | null>(null);

// E2-4 AC2: when reached via /events/:id/edit, this holds the draft's id so
// Save/Submit act on it instead of creating a new event.
const draftId = ref<number | null>(null);
const loadingDraft = ref(false);
const loadError = ref<string | null>(null);
const savingDraft = ref(false);

async function handleSubmit() {
  generalError.value = null;
  fieldErrors.value = {};
  submitting.value = true;

  try {
    // E2-4 AC3: submitting a draft validates it against the E2-1 rules and
    // moves it to Requested, via the same PATCH used for editing a live request.
    const event = draftId.value
      ? await updateEventDetails(draftId.value, form)
      : await submitEventRequest(form);
    submittedEventId.value = event.id;
  } catch (err) {
    if (err instanceof ValidationError) {
      fieldErrors.value = err.fields;
    } else {
      generalError.value = "We couldn't submit your request. Please try again.";
    }
  } finally {
    submitting.value = false;
  }
}

/** E2-4 AC1: save progress as a draft, skipping mandatory-field validation. */
async function handleSaveDraft() {
  generalError.value = null;
  fieldErrors.value = {};
  savingDraft.value = true;

  try {
    if (draftId.value) {
      await updateDraft(draftId.value, form);
    } else {
      const event = await saveDraft(form);
      draftId.value = event.id;
    }
    // Land back on the Drafts tab, since that's where this draft now lives.
    router.push({ name: "events-list", query: { tab: "drafts" } });
  } catch {
    generalError.value = "We couldn't save your draft. Please try again.";
  } finally {
    savingDraft.value = false;
  }
}

onMounted(async () => {
  const id = route.params.id as string | undefined;
  if (!id) return;

  loadingDraft.value = true;
  try {
    const event = await fetchEventById(id);
    if (event.status !== "Draft") {
      // Already submitted (or otherwise no longer a draft) — the read-mostly
      // detail page is the right place for it, not this form.
      await router.replace({ name: "event-detail", params: { id: event.id } });
      return;
    }

    draftId.value = event.id;
    const details = event.submitted_details as Partial<EventRequestPayload>;
    Object.assign(form, {
      name: details.name ?? "",
      purpose: details.purpose ?? "",
      description: details.description ?? "",
      proposedDate: details.proposedDate ?? "",
      startTime: details.startTime ?? "",
      endTime: details.endTime ?? "",
      expectedAttendance: details.expectedAttendance ?? "",
      venue: details.venue ?? "",
      accessibility: details.accessibility ?? "",
      equipment: details.equipment ?? "",
      technicalSupport: details.technicalSupport ?? "",
      registrationNeeded: details.registrationNeeded ?? false,
    });
  } catch {
    loadError.value = "We couldn't load this draft. Please try again.";
  } finally {
    loadingDraft.value = false;
  }
});
</script>

<template>
  <!--
    Column mapping — Event request form
    Desktop (12-col): outer container col 1-12 (grid-desktop-margin 80px); back link, form panel and the submitted
    notice col 3-10, centred.
    Tablet (6-col): content col 1-6, full width, grid-tablet-margin 32px.
    Mobile (4-col): content col 1-4, full width, grid-mobile-margin 6px.
    Nested grid: the date / start / end row uses a local 3-col grid on desktop and tablet, one column on mobile;
    each requirement is a label column beside its field (stacked on mobile).
  -->
  <div class="page">
    <div class="content">
      <BackLink to="/">Back to my events</BackLink>

      <p v-if="loadingDraft" class="subheading muted">Loading draft…</p>

      <p v-else-if="loadError" class="body-small error-text" role="alert">{{ loadError }}</p>

      <AppPanel v-else-if="submittedEventId" size="lg" class="submitted">
        <h1 class="h4">Request submitted</h1>
        <p class="body-default muted">
          Your event request has been created with status <strong class="strong">Unassigned</strong>
          until a coordinator is assigned to it. You'll see it in your events list along with its submission date.
        </p>
        <div class="actions">
          <AppButton variant="primary" :to="{ name: 'event-detail', params: { id: submittedEventId } }">
            View request
          </AppButton>
          <AppButton variant="outline" to="/">Back to my events</AppButton>
        </div>
      </AppPanel>

      <AppPanel v-else as="form" size="lg" class="request-form" @submit.prevent="handleSubmit">
        <div>
          <h1 class="h2">{{ draftId ? "Edit draft" : "Submit an event request" }}</h1>
          <p class="subheading muted">Tell us about your event so ConnectSphere can plan it.</p>
        </div>

        <p v-if="generalError" class="body-small error-text" role="alert">{{ generalError }}</p>

        <div class="fields">
          <div class="field">
            <label for="name" class="field-label">Event name</label>
            <input id="name" v-model="form.name" type="text" class="text-input" :aria-invalid="!!fieldErrors.name"
              :aria-describedby="fieldErrors.name ? 'name-error' : undefined" />
            <p v-if="fieldErrors.name" id="name-error" class="body-small error-text" role="alert">{{ fieldErrors.name }}</p>
          </div>

          <div class="field">
            <label for="purpose" class="field-label">Purpose</label>
            <input id="purpose" v-model="form.purpose" type="text" class="text-input"
              :aria-invalid="!!fieldErrors.purpose" :aria-describedby="fieldErrors.purpose ? 'purpose-error' : undefined" />
            <p v-if="fieldErrors.purpose" id="purpose-error" class="body-small error-text" role="alert">
              {{ fieldErrors.purpose }}
            </p>
          </div>

          <div class="field">
            <label for="description" class="field-label">Description</label>
            <textarea id="description" v-model="form.description" rows="4" class="text-input"
              :aria-invalid="!!fieldErrors.description"
              :aria-describedby="fieldErrors.description ? 'description-error' : undefined" />
            <p v-if="fieldErrors.description" id="description-error" class="body-small error-text" role="alert">
              {{ fieldErrors.description }}
            </p>
          </div>

          <div class="when">
            <div class="field">
              <label for="proposedDate" class="field-label">Proposed date</label>
              <input id="proposedDate" v-model="form.proposedDate" type="date" class="text-input"
                :aria-invalid="!!fieldErrors.proposedDate"
                :aria-describedby="fieldErrors.proposedDate ? 'proposedDate-error' : undefined" />
              <p v-if="fieldErrors.proposedDate" id="proposedDate-error" class="body-small error-text" role="alert">
                {{ fieldErrors.proposedDate }}
              </p>
            </div>

            <div class="field">
              <label for="startTime" class="field-label">Start time</label>
              <input id="startTime" v-model="form.startTime" type="time" class="text-input"
                :aria-invalid="!!fieldErrors.startTime"
                :aria-describedby="fieldErrors.startTime ? 'startTime-error' : undefined" />
              <p v-if="fieldErrors.startTime" id="startTime-error" class="body-small error-text" role="alert">
                {{ fieldErrors.startTime }}
              </p>
            </div>

            <div class="field">
              <label for="endTime" class="field-label">End time</label>
              <input id="endTime" v-model="form.endTime" type="time" class="text-input"
                :aria-invalid="!!fieldErrors.endTime"
                :aria-describedby="fieldErrors.endTime ? 'endTime-error' : undefined" />
              <p v-if="fieldErrors.endTime" id="endTime-error" class="body-small error-text" role="alert">
                {{ fieldErrors.endTime }}
              </p>
            </div>
          </div>

          <div class="field field--short">
            <label for="expectedAttendance" class="field-label">Expected attendance</label>
            <input id="expectedAttendance" v-model="form.expectedAttendance" type="number" min="1" class="text-input"
              :aria-invalid="!!fieldErrors.expectedAttendance"
              :aria-describedby="fieldErrors.expectedAttendance ? 'expectedAttendance-error' : undefined" />
            <p v-if="fieldErrors.expectedAttendance" id="expectedAttendance-error" class="body-small error-text"
              role="alert">
              {{ fieldErrors.expectedAttendance }}
            </p>
          </div>
        </div>

        <section class="requirements" aria-labelledby="requirements-title">
          <h2 id="requirements-title" class="h6">Requirements</h2>
          <p class="body-small muted">
            Tell your coordinator what this event needs. If a field doesn't apply to your event, type NA
          </p>

          <div class="requirement">
            <label for="venue" class="field-label">Venue Requirements</label>
            <div class="field">
              <textarea id="venue" v-model="form.venue" rows="2" placeholder="e.g. indoor hall, parking availability"
                class="text-input" :aria-invalid="!!fieldErrors.venue"
                :aria-describedby="fieldErrors.venue ? 'venue-error' : undefined" />
              <p v-if="fieldErrors.venue" id="venue-error" class="body-small error-text" role="alert">{{ fieldErrors.venue }}</p>
            </div>
          </div>

          <div class="requirement">
            <label for="accessibility" class="field-label">Accessibility</label>
            <div class="field">
              <textarea id="accessibility" v-model="form.accessibility" rows="2"
                placeholder="e.g. wheelchair access, ramps/lifts, prayer room" class="text-input"
                :aria-invalid="!!fieldErrors.accessibility"
                :aria-describedby="fieldErrors.accessibility ? 'accessibility-error' : undefined" />
              <p v-if="fieldErrors.accessibility" id="accessibility-error" class="body-small error-text" role="alert">
                {{ fieldErrors.accessibility }}
              </p>
            </div>
          </div>

          <div class="requirement">
            <label for="equipment" class="field-label">Equipment</label>
            <div class="field">
              <textarea id="equipment" v-model="form.equipment" rows="2"
                placeholder="e.g. projector/screen, whiteboard, podium, extension cords" class="text-input"
                :aria-invalid="!!fieldErrors.equipment"
                :aria-describedby="fieldErrors.equipment ? 'equipment-error' : undefined" />
              <p v-if="fieldErrors.equipment" id="equipment-error" class="body-small error-text" role="alert">
                {{ fieldErrors.equipment }}
              </p>
            </div>
          </div>

          <div class="requirement">
            <label for="technicalSupport" class="field-label">Technical support</label>
            <div class="field">
              <textarea id="technicalSupport" v-model="form.technicalSupport" rows="2"
                placeholder="e.g. AV/sound system, livestream setup, on-site IT support" class="text-input"
                :aria-invalid="!!fieldErrors.technicalSupport"
                :aria-describedby="fieldErrors.technicalSupport ? 'technicalSupport-error' : undefined" />
              <p v-if="fieldErrors.technicalSupport" id="technicalSupport-error" class="body-small error-text"
                role="alert">
                {{ fieldErrors.technicalSupport }}
              </p>
            </div>
          </div>

          <div class="requirement">
            <span class="field-label">Registration needed</span>
            <SegmentedToggle v-model="registrationChoice" :options="REGISTRATION_OPTIONS"
              aria-label="Registration needed" />
          </div>
        </section>

        <div class="actions">
          <AppButton variant="outline" :disabled="submitting || savingDraft" @click="handleSaveDraft">
            {{ savingDraft ? "Saving…" : "Save as Draft" }}
          </AppButton>

          <AppButton variant="primary" type="submit" :disabled="submitting || savingDraft">
            {{ submitting ? "Submitting…" : "Submit request" }}
          </AppButton>
        </div>
      </AppPanel>
    </div>
  </div>
</template>

<style scoped>
.page {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: var(--grid-desktop-gutter);
  padding: var(--spacing-40) var(--grid-desktop-margin);
  align-content: start;
}

.content {
  grid-column: 3 / 11;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-16);
}

@media (max-width: 1024px) {
  .page {
    grid-template-columns: repeat(6, 1fr);
    gap: var(--grid-tablet-gutter);
    padding: var(--spacing-32) var(--grid-tablet-margin);
  }

  .content {
    grid-column: 1 / 7;
  }
}

@media (max-width: 640px) {
  .page {
    grid-template-columns: repeat(4, 1fr);
    gap: var(--grid-mobile-gutter);
    padding: var(--spacing-24) var(--grid-mobile-margin);
  }

  .content {
    grid-column: 1 / 5;
  }
}

.h2,
.h4,
.h6 {
  margin: 0;
}

.subheading {
  margin: var(--spacing-8) 0 0;
}

.muted {
  color: var(--color-grey-600);
}

.error-text {
  margin: 0;
  color: var(--color-error-600);
}

.strong {
  color: var(--color-grey-700);
}

.submitted,
.request-form {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-24);
}

.submitted p {
  margin: 0;
}

.fields {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-16);
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-4);
}

.field--short {
  max-width: 12rem;
}

.field-label {
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  color: var(--color-grey-700);
}

.text-input {
  width: 100%;
  padding: var(--spacing-12);
  font-size: 1rem;
  line-height: 1.25rem;
}

.when {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--spacing-16);
}

@media (max-width: 640px) {
  .when {
    grid-template-columns: 1fr;
  }
}

.requirements {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-16);
}

.requirement {
  display: grid;
  grid-template-columns: 10rem 1fr;
  gap: var(--spacing-16);
  align-items: start;
  padding-top: var(--spacing-16);
  border-top: 1px solid var(--color-grey-100);
}

@media (max-width: 640px) {
  .requirement {
    grid-template-columns: 1fr;
    gap: var(--spacing-8);
  }
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-16);
}
</style>
