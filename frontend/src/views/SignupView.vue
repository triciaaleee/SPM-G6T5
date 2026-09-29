<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import {
  SignupError,
  landingRouteForRole,
  signup,
  type SignupField,
  type SignupRole,
} from "../lib/auth";
import {
  PASSWORD_MAX_BYTES,
  PASSWORD_RULE,
  passwordRequirements,
  passwordTooLong,
} from "../lib/passwordPolicy";

/**
 * E1-1: only the two self-service roles. Internal staff accounts are
 * seeded, so they never appear here (and the backend refuses them).
 */
const ROLE_OPTIONS: { value: SignupRole; label: string }[] = [
  { value: "attendee", label: "Attendee" },
  { value: "organiser", label: "Event Organiser" },
];

const name = ref("");
const email = ref("");
const password = ref("");
// AC4: Attendee unless the user deliberately picks otherwise.
const role = ref<SignupRole>("attendee");
const fieldErrors = ref<Partial<Record<SignupField, string>>>({});
const formError = ref<string | null>(null);
// AC2: the address is taken — offer the way forward, not just the error.
const emailInUse = ref(false);
const submitting = ref(false);
const router = useRouter();

/**
 * WAI-ARIA tabs pattern: only the active tab is in the Tab order, and the
 * arrow keys move between tabs (Home/End jump to the ends), selecting as
 * they go.
 */
const tabButtons = ref<HTMLButtonElement[]>([]);

function handleTabKeydown(event: KeyboardEvent) {
  const current = ROLE_OPTIONS.findIndex((o) => o.value === role.value);
  const last = ROLE_OPTIONS.length - 1;
  const next =
    event.key === "ArrowRight" ? (current === last ? 0 : current + 1)
    : event.key === "ArrowLeft" ? (current === 0 ? last : current - 1)
    : event.key === "Home" ? 0
    : event.key === "End" ? last
    : null;
  if (next === null) return;
  event.preventDefault();
  role.value = ROLE_OPTIONS[next].value;
  tabButtons.value[next]?.focus();
}

// AC3: the rule is on screen from the start, ticking off as it's met,
// rather than only surfacing after a failed submit.
const requirements = computed(() => passwordRequirements(password.value));
const passwordMeetsRule = computed(
  () => requirements.value.every((r) => r.met) && !passwordTooLong(password.value),
);

// A field's error is about what was typed then; once the user edits that
// field it's stale, so clear it rather than leave it contradicting them.
watch(name, () => delete fieldErrors.value.name);
watch(email, () => {
  delete fieldErrors.value.email;
  emailInUse.value = false;
});
watch(password, () => delete fieldErrors.value.password);
watch(role, () => delete fieldErrors.value.role);

async function handleSubmit() {
  fieldErrors.value = {};
  formError.value = null;
  emailInUse.value = false;

  // Catch the rule client-side for a faster answer; the backend checks
  // again regardless and is what actually enforces it.
  if (!passwordMeetsRule.value) {
    fieldErrors.value.password = passwordTooLong(password.value)
      ? `Password must be at most ${PASSWORD_MAX_BYTES} characters.`
      : PASSWORD_RULE;
    return;
  }

  submitting.value = true;
  try {
    const user = await signup(name.value, email.value, password.value, role.value);
    // Same role-driven landing as login (AC1).
    router.replace({ name: landingRouteForRole(user.role) });
  } catch (err) {
    if (err instanceof SignupError && err.field) {
      fieldErrors.value[err.field] = err.message;
      emailInUse.value = err.code === "email_in_use";
    } else {
      formError.value = err instanceof Error ? err.message : "Signup failed";
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <!--
    Column mapping — Signup
    Desktop (12-col): outer container col 1-12 (grid-desktop-margin 80px); form card col 5-8, centred.
    Tablet (6-col): form card col 2-5, centred, grid-tablet-margin 32px.
    Mobile (4-col): form card col 1-4, full width, grid-mobile-margin 6px.
    Account-type tabs span the full card width; the form below is their shared tab panel.
  -->
  <div class="page">
    <form class="form-card" novalidate @submit.prevent="handleSubmit">
      <h1 class="h3">Create an account</h1>
      <p class="subheading">Sign up to join events or organise your own.</p>

      <div class="tabs" role="tablist" aria-label="Account type" @keydown="handleTabKeydown">
        <button
          v-for="option in ROLE_OPTIONS"
          :id="`role-tab-${option.value}`"
          :key="option.value"
          ref="tabButtons"
          type="button"
          role="tab"
          class="tab"
          :class="{ 'tab--active': role === option.value }"
          :aria-selected="role === option.value"
          :tabindex="role === option.value ? 0 : -1"
          aria-controls="signup-fields"
          @click="role = option.value"
        >
          {{ option.label }}
        </button>
      </div>

      <div
        id="signup-fields"
        class="tab-panel"
        role="tabpanel"
        :aria-labelledby="`role-tab-${role}`"
      >
        <p v-if="fieldErrors.role" id="role-error" class="body-small error-text" role="alert">
          {{ fieldErrors.role }}
        </p>

        <label class="field-label" for="name">Name</label>
        <input
          id="name"
          v-model="name"
          type="text"
          required
          class="text-input"
          :class="{ invalid: fieldErrors.name }"
          :aria-invalid="!!fieldErrors.name"
          :aria-describedby="fieldErrors.name ? 'name-error' : undefined"
          autocomplete="name"
        />
        <p v-if="fieldErrors.name" id="name-error" class="body-small error-text field-error" role="alert">
          {{ fieldErrors.name }}
        </p>

        <label class="field-label" for="email">Email</label>
        <input
          id="email"
          v-model="email"
          type="email"
          required
          class="text-input"
          :class="{ invalid: fieldErrors.email }"
          :aria-invalid="!!fieldErrors.email"
          :aria-describedby="fieldErrors.email ? 'email-error' : undefined"
          autocomplete="email"
        />
        <p v-if="fieldErrors.email" id="email-error" class="body-small error-text field-error" role="alert">
          {{ fieldErrors.email }}
          <RouterLink v-if="emailInUse" to="/login">Sign in instead</RouterLink>
        </p>

        <label class="field-label" for="password">Password</label>
        <input
          id="password"
          v-model="password"
          type="password"
          required
          class="text-input password-input"
          :class="{ invalid: fieldErrors.password }"
          :aria-invalid="!!fieldErrors.password"
          aria-describedby="password-rules"
          autocomplete="new-password"
        />
        <ul id="password-rules" class="password-rules body-small" aria-live="polite">
          <li v-for="req in requirements" :key="req.label" :class="{ met: req.met }">
            {{ req.label }}
            <span class="visually-hidden">{{ req.met ? "(met)" : "(not yet met)" }}</span>
          </li>
        </ul>
        <p v-if="fieldErrors.password" class="body-small error-text" role="alert">
          {{ fieldErrors.password }}
        </p>

        <p v-if="formError" class="body-small error-text" role="alert">{{ formError }}</p>

        <button type="submit" class="btn-primary" :disabled="submitting">
          {{ submitting ? "Creating account…" : "Sign up" }}
        </button>
      </div>

      <p class="body-small muted signup-hint">
        Already have an account? <RouterLink to="/login">Sign in</RouterLink>
      </p>
    </form>
  </div>
</template>

<style scoped>
.page {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: var(--grid-desktop-gutter);
  padding: var(--spacing-80) var(--grid-desktop-margin);
  align-content: start;
  min-height: 100vh;
}

.form-card {
  grid-column: 5 / 9;
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
  padding: var(--spacing-32);
  display: flex;
  flex-direction: column;
  align-self: start;
}

@media (max-width: 1024px) {
  .page {
    grid-template-columns: repeat(6, 1fr);
    padding: var(--spacing-40) var(--grid-tablet-margin);
  }
  .form-card {
    grid-column: 2 / 6;
  }
}

@media (max-width: 640px) {
  .page {
    grid-template-columns: repeat(4, 1fr);
    padding: var(--spacing-24) var(--grid-mobile-margin);
  }
  .form-card {
    grid-column: 1 / 5;
  }
}

.h3 {
  font-size: 2rem;
  font-weight: 700;
  line-height: 2.5rem;
  color: var(--color-grey-900);
  margin: 0;
}

.subheading {
  font-size: 1.125rem;
  line-height: 1.375rem;
  color: var(--color-grey-500);
  margin: var(--spacing-8) 0 var(--spacing-24);
}

.field-label {
  font-size: 0.875rem;
  font-weight: 700;
  color: var(--color-grey-700);
  margin-bottom: var(--spacing-4);
}

.text-input {
  font-family: var(--font-family-lato);
  font-size: 1rem;
  padding: var(--spacing-12);
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-xs);
  margin-bottom: var(--spacing-16);
  background: var(--color-base-white);
  color: var(--color-grey-900);
}

.text-input.invalid {
  border-color: var(--color-error-600);
}

/* Error sits directly under its input, so pull it up into the input's gap. */
.field-error {
  margin-top: calc(-1 * var(--spacing-12));
}

/* Account-type tabs — same treatment as the EventsListView tabs; active
   tab in Purple Primary/600 (Style.md 2.4 "active tabs"). Equal widths so
   the pair reads as one control across the card. */
.tabs {
  display: flex;
  border-bottom: 1px solid var(--color-grey-100);
  margin-bottom: var(--spacing-24);
}

.tab {
  flex: 1;
  appearance: none;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  padding: var(--spacing-12) var(--spacing-4);
  cursor: pointer;
  font-family: var(--font-family-lato);
  font-size: 1rem;
  line-height: 1.25rem;
  font-weight: 700;
  color: var(--color-grey-500);
}

.tab:hover {
  color: var(--color-grey-900);
}

.tab--active {
  color: var(--color-purple-600);
  border-bottom-color: var(--color-purple-600);
}

.tab--active:hover {
  color: var(--color-purple-600);
}

.tab-panel {
  display: flex;
  flex-direction: column;
}

/* Password rule checklist (AC3). */
.password-input {
  margin-bottom: var(--spacing-8);
}

.password-rules {
  list-style: none;
  padding: 0;
  margin: 0 0 var(--spacing-16);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-4);
  color: var(--color-grey-500);
}

.password-rules li {
  display: flex;
  align-items: center;
  gap: var(--spacing-8);
}

.password-rules li::before {
  content: "";
  width: var(--spacing-8);
  height: var(--spacing-8);
  border-radius: var(--radius-full);
  border: 1px solid var(--color-grey-300);
  flex-shrink: 0;
}

.password-rules li.met {
  color: var(--color-success-600);
}

.password-rules li.met::before {
  background: var(--color-success-600);
  border-color: var(--color-success-600);
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

.body-small {
  font-size: 0.875rem;
  line-height: 1.125rem;
}

.error-text {
  color: var(--color-error-600);
  margin: 0 0 var(--spacing-16);
}

.muted {
  color: var(--color-grey-500);
}

.btn-primary {
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  font-weight: 700;
  color: var(--color-base-white);
  background: var(--color-purple-600);
  border: none;
  border-radius: var(--radius-xs);
  padding: var(--spacing-12) var(--spacing-24);
  cursor: pointer;
}

.btn-primary:hover {
  background: var(--color-purple-700);
}

.btn-primary:disabled {
  background: var(--color-grey-200);
  color: var(--color-grey-400);
  cursor: not-allowed;
}

.signup-hint {
  margin: var(--spacing-16) 0 0;
  text-align: center;
}
</style>
