<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import {
  fetchEventById,
  saveDraft,
  submitEventRequest,
  updateDraft,
  updateEventDetails,
  ValidationError,
  type EventRequestPayload,
} from "../lib/eventsApi";

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
    router.push({ name: "events-list" });
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
  <div class="grid grid-cols-4 gap-4 px-[var(--grid-mobile-margin)] py-8 md:grid-cols-6 md:gap-8 md:px-[var(--grid-tablet-margin)] md:py-10 lg:grid-cols-12 lg:px-[var(--grid-desktop-margin)] lg:py-10">
    <div class="col-span-4 md:col-span-6 md:col-start-1 lg:col-span-8 lg:col-start-3">
      <RouterLink to="/" class="mb-6 inline-block text-sm font-bold text-purple-600 hover:text-purple-700">
        Back to my events
      </RouterLink>

      <p v-if="loadingDraft" class="text-lg text-grey-500">Loading draft…</p>

      <p v-else-if="loadError" class="mt-4 text-sm text-error-600">{{ loadError }}</p>

      <div v-else-if="submittedEventId" class="rounded-lg border border-grey-100 bg-grey-50 p-8">
        <p class="text-2xl font-bold text-grey-900">Request submitted</p>
        <p class="mt-2 text-grey-500">
          Your event request has been created with status <span class="font-bold text-grey-700">Requested</span>.
          You'll see it in your events list along with its submission date.
        </p>
        <RouterLink
          :to="{ name: 'event-detail', params: { id: submittedEventId } }"
          class="mt-6 inline-block rounded-xs bg-purple-600 px-6 py-3 text-sm font-bold text-base-white hover:bg-purple-700"
        >
          View request
        </RouterLink>
        <RouterLink to="/" class="ml-4 text-sm font-bold text-purple-600 hover:text-purple-700">
          Back to my events
        </RouterLink>
      </div>

      <form v-else class="rounded-lg border border-grey-100 bg-grey-50 p-8" @submit.prevent="handleSubmit">
        <h1 class="text-3xl font-bold leading-tight text-grey-900">
          {{ draftId ? "Edit draft" : "Submit an event request" }}
        </h1>
        <p class="mt-2 text-lg text-grey-500">
          Tell us about your event so ConnectSphere can plan it.
        </p>

        <p v-if="generalError" class="mt-4 text-sm text-error-600">{{ generalError }}</p>

        <div class="mt-8 flex flex-col gap-4">
          <div>
            <label for="name" class="mb-1 block text-sm font-bold text-grey-700">Event name</label>
            <input
              id="name"
              v-model="form.name"
              type="text"
              class="w-full rounded-xs border border-grey-200 bg-base-white px-3 py-3 text-grey-900"
            />
            <p v-if="fieldErrors.name" class="mt-1 text-sm text-error-600">{{ fieldErrors.name }}</p>
          </div>

          <div>
            <label for="purpose" class="mb-1 block text-sm font-bold text-grey-700">Purpose</label>
            <input
              id="purpose"
              v-model="form.purpose"
              type="text"
              class="w-full rounded-xs border border-grey-200 bg-base-white px-3 py-3 text-grey-900"
            />
            <p v-if="fieldErrors.purpose" class="mt-1 text-sm text-error-600">{{ fieldErrors.purpose }}</p>
          </div>

          <div>
            <label for="description" class="mb-1 block text-sm font-bold text-grey-700">Description</label>
            <textarea
              id="description"
              v-model="form.description"
              rows="4"
              class="w-full rounded-xs border border-grey-200 bg-base-white px-3 py-3 text-grey-900"
            />
            <p v-if="fieldErrors.description" class="mt-1 text-sm text-error-600">{{ fieldErrors.description }}</p>
          </div>

          <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div>
              <label for="proposedDate" class="mb-1 block text-sm font-bold text-grey-700">Proposed date</label>
              <input
                id="proposedDate"
                v-model="form.proposedDate"
                type="date"
                class="w-full rounded-xs border border-grey-200 bg-base-white px-3 py-3 text-grey-900"
              />
              <p v-if="fieldErrors.proposedDate" class="mt-1 text-sm text-error-600">{{ fieldErrors.proposedDate }}</p>
            </div>

            <div>
              <label for="startTime" class="mb-1 block text-sm font-bold text-grey-700">Start time</label>
              <input
                id="startTime"
                v-model="form.startTime"
                type="time"
                class="w-full rounded-xs border border-grey-200 bg-base-white px-3 py-3 text-grey-900"
              />
              <p v-if="fieldErrors.startTime" class="mt-1 text-sm text-error-600">{{ fieldErrors.startTime }}</p>
            </div>

            <div>
              <label for="endTime" class="mb-1 block text-sm font-bold text-grey-700">End time</label>
              <input
                id="endTime"
                v-model="form.endTime"
                type="time"
                class="w-full rounded-xs border border-grey-200 bg-base-white px-3 py-3 text-grey-900"
              />
              <p v-if="fieldErrors.endTime" class="mt-1 text-sm text-error-600">{{ fieldErrors.endTime }}</p>
            </div>
          </div>

          <div>
            <label for="expectedAttendance" class="mb-1 block text-sm font-bold text-grey-700">
              Expected attendance
            </label>
            <input
              id="expectedAttendance"
              v-model="form.expectedAttendance"
              type="number"
              min="1"
              class="w-full rounded-xs border border-grey-200 bg-base-white px-3 py-3 text-grey-900 sm:w-48"
            />
            <p v-if="fieldErrors.expectedAttendance" class="mt-1 text-sm text-error-600">
              {{ fieldErrors.expectedAttendance }}
            </p>
          </div>
        </div>

        <div class="mt-8">
          <h2 class="text-xl font-bold text-grey-900">Requirements</h2>
          <p class="mt-1 text-sm text-grey-500">
            Tell your coordinator what this event needs. If a field doesn't apply to your event, type NA
          </p>

          <div class="mt-4 overflow-hidden rounded-xs border border-grey-200">
            <table class="w-full border-collapse text-left">
              <tbody>
                <tr class="border-b border-grey-200">
                  <th scope="row" class="w-40 bg-grey-50 px-3 py-3 align-top text-sm font-bold text-grey-700">
                    <label for="venue">Venue Requirements</label>
                  </th>
                  <td class="px-3 py-3">
                    <textarea
                      id="venue"
                      v-model="form.venue"
                      rows="2"
                      placeholder="e.g. indoor hall, parking availability"
                      class="w-full rounded-xs border border-grey-200 bg-base-white px-3 py-2 text-grey-900"
                    />
                    <p v-if="fieldErrors.venue" class="mt-1 text-sm text-error-600">{{ fieldErrors.venue }}</p>
                  </td>
                </tr>

                <tr class="border-b border-grey-200">
                  <th scope="row" class="w-40 bg-grey-50 px-3 py-3 align-top text-sm font-bold text-grey-700">
                    <label for="accessibility">Accessibility</label>
                  </th>
                  <td class="px-3 py-3">
                    <textarea
                      id="accessibility"
                      v-model="form.accessibility"
                      rows="2"
                      placeholder="e.g. wheelchair access, ramps/lifts, prayer room"
                      class="w-full rounded-xs border border-grey-200 bg-base-white px-3 py-2 text-grey-900"
                    />
                    <p v-if="fieldErrors.accessibility" class="mt-1 text-sm text-error-600">
                      {{ fieldErrors.accessibility }}
                    </p>
                  </td>
                </tr>

                <tr class="border-b border-grey-200">
                  <th scope="row" class="w-40 bg-grey-50 px-3 py-3 align-top text-sm font-bold text-grey-700">
                    <label for="equipment">Equipment</label>
                  </th>
                  <td class="px-3 py-3">
                    <textarea
                      id="equipment"
                      v-model="form.equipment"
                      rows="2"
                      placeholder="e.g. projector/screen, whiteboard, podium, extension cords"
                      class="w-full rounded-xs border border-grey-200 bg-base-white px-3 py-2 text-grey-900"
                    />
                    <p v-if="fieldErrors.equipment" class="mt-1 text-sm text-error-600">{{ fieldErrors.equipment }}</p>
                  </td>
                </tr>

                <tr class="border-b border-grey-200">
                  <th scope="row" class="w-40 bg-grey-50 px-3 py-3 align-top text-sm font-bold text-grey-700">
                    <label for="technicalSupport">Technical support</label>
                  </th>
                  <td class="px-3 py-3">
                    <textarea
                      id="technicalSupport"
                      v-model="form.technicalSupport"
                      rows="2"
                      placeholder="e.g. AV/sound system, livestream setup, on-site IT support"
                      class="w-full rounded-xs border border-grey-200 bg-base-white px-3 py-2 text-grey-900"
                    />
                    <p v-if="fieldErrors.technicalSupport" class="mt-1 text-sm text-error-600">
                      {{ fieldErrors.technicalSupport }}
                    </p>
                  </td>
                </tr>

                <tr>
                  <th scope="row" class="w-40 bg-grey-50 px-3 py-3 align-top text-sm font-bold text-grey-700">
                    Registration needed
                  </th>
                  <td class="px-3 py-3">
                    <div class="flex gap-2" role="group" aria-label="Registration needed">
                      <button
                        type="button"
                        class="rounded-xs border px-4 py-2 text-sm font-bold"
                        :class="
                          form.registrationNeeded
                            ? 'border-purple-600 bg-purple-600 text-base-white'
                            : 'border-grey-200 bg-base-white text-grey-700 hover:bg-grey-75'
                        "
                        :aria-pressed="form.registrationNeeded"
                        @click="form.registrationNeeded = true"
                      >
                        Yes
                      </button>
                      <button
                        type="button"
                        class="rounded-xs border px-4 py-2 text-sm font-bold"
                        :class="
                          !form.registrationNeeded
                            ? 'border-purple-600 bg-purple-600 text-base-white'
                            : 'border-grey-200 bg-base-white text-grey-700 hover:bg-grey-75'
                        "
                        :aria-pressed="!form.registrationNeeded"
                        @click="form.registrationNeeded = false"
                      >
                        No
                      </button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div class="mt-8 flex gap-4">
          <button
            type="button"
            :disabled="submitting || savingDraft"
            class="rounded-xs border border-purple-600 px-6 py-3 text-sm font-bold text-purple-600 hover:bg-purple-100 disabled:cursor-not-allowed disabled:border-grey-200 disabled:text-grey-400"
            @click="handleSaveDraft"
          >
            {{ savingDraft ? "Saving…" : "Save as Draft" }}
          </button>

          <button
            type="submit"
            :disabled="submitting || savingDraft"
            class="rounded-xs bg-purple-600 px-6 py-3 text-sm font-bold text-base-white hover:bg-purple-700 disabled:cursor-not-allowed disabled:bg-grey-200 disabled:text-grey-400"
          >
            {{ submitting ? "Submitting…" : "Submit request" }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
