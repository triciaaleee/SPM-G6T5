<script setup lang="ts">
import UnderlineTabs from "../../components/ui/UnderlineTabs.vue";
import AppButton from "../../components/ui/AppButton.vue";
import AuthSplitLayout from "../../components/auth/AuthSplitLayout.vue";
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import {
  SignupError,
  landingRouteForRole,
  signup,
  type SignupField,
  type SignupRole,
} from "../../lib/auth";
import {
  PASSWORD_MAX_BYTES,
  PASSWORD_RULE,
  passwordRequirements,
  passwordTooLong,
} from "../../lib/passwordPolicy";

/**
 * E1-1: only the two self-service roles. Internal staff accounts are
 * seeded, so they never appear here (and the backend refuses them).
 */
const ROLE_OPTIONS: { value: SignupRole; label: string }[] = [
  { value: "attendee", label: "Attendee" },
  { value: "organiser", label: "Event Organiser" },
];

const ROLE_TABS = ROLE_OPTIONS.map((option) => ({ key: option.value, label: option.label }));

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
const route = useRoute();

/** Keeps a pending ?redirect when switching to the login form. */
const loginLink = computed(() => ({ name: "login", query: typeof route.query.redirect === "string" ? { redirect: route.query.redirect } : {} }));

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
    // Same as login: back to where the guard (or a guest page's "Sign up
    // to register") sent us from, else the role-driven landing (AC1).
    const redirect = route.query.redirect;
    if (typeof redirect === "string" && redirect.startsWith("/")) {
      router.replace(redirect);
    } else {
      router.replace({ name: landingRouteForRole(user.role) });
    }
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
    Laid out by AuthSplitLayout: graphic 30% on the left, form (no card) centred in the right 70%.
    Mobile (4-col): graphic hidden; form col 1-4, full width, grid-mobile-margin 6px.
    Account-type tabs span the full form width; the form below is their shared tab panel.
  -->
  <AuthSplitLayout>
    <form class="form" novalidate @submit.prevent="handleSubmit">
      <h1 class="h3">Create an account</h1>
      <p class="subheading">Sign up to join events or organise your own.</p>

      <UnderlineTabs v-model="role" class="tabs" :tabs="ROLE_TABS" aria-label="Account type" id-prefix="role-tab"
        panel-id="signup-fields" />

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
          <RouterLink v-if="emailInUse" :to="loginLink">Sign in instead</RouterLink>
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

        <AppButton variant="primary" type="submit" :disabled="submitting">
          {{ submitting ? "Creating account…" : "Sign up" }}
        </AppButton>
      </div>

      <p class="body-small muted signup-hint">
        Already have an account? <RouterLink :to="loginLink">Sign in</RouterLink>
      </p>
    </form>
  </AuthSplitLayout>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  width: 100%;
}

.h3 {
  margin: 0;
}

.subheading {
  color: var(--color-grey-600);
  margin: var(--spacing-8) 0 var(--spacing-24);
}

.field-label {
  font-size: 0.875rem;
  line-height: 1.125rem;
  font-weight: 700;
  color: var(--color-grey-700);
  margin-bottom: var(--spacing-4);
}

.text-input {
  font-size: 1rem;
  line-height: 1.25rem;
  padding: var(--spacing-12);
  margin-bottom: var(--spacing-16);
}

/* Error sits directly under its input, so pull it up into the input's gap. */
.field-error {
  margin-top: calc(-1 * var(--spacing-12));
}

/* Account-type tabs — same treatment as the EventsListView tabs; active
   tab in Purple Primary/600 (Style.md 2.4 "active tabs"). Equal widths so
   the pair reads as one control across the card. */
.tabs {
  margin-bottom: var(--spacing-24);
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
  color: var(--color-grey-600);
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

.error-text {
  color: var(--color-error-600);
  margin: 0 0 var(--spacing-16);
}

.muted {
  color: var(--color-grey-600);
}

.signup-hint {
  margin: var(--spacing-16) 0 0;
  text-align: center;
}
</style>
