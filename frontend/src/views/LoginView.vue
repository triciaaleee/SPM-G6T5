<script setup lang="ts">
import { ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { LockedOutError, landingRouteForRole, login } from "../lib/auth";

const email = ref("");
const password = ref("");
const errorMessage = ref<string | null>(null);
const lockedOut = ref(false);
const submitting = ref(false);
const router = useRouter();
const route = useRoute();

async function handleSubmit() {
  errorMessage.value = null;
  lockedOut.value = false;
  submitting.value = true;
  try {
    const user = await login(email.value, password.value);

    // AC5: if the guard bounced us here from a protected URL, go back to
    // it. Otherwise fall through to the landing view for this user's role
    // (AC1).
    const redirect = route.query.redirect;
    if (typeof redirect === "string" && redirect.startsWith("/")) {
      router.replace(redirect);
    } else {
      router.replace({ name: landingRouteForRole(user.role) });
    }
  } catch (err) {
    if (err instanceof LockedOutError) {
      // AC3: the account is locked, so keep the message on screen and stop
      // offering the button — retrying now can only fail.
      lockedOut.value = true;
      errorMessage.value = err.message;
    } else {
      errorMessage.value = err instanceof Error ? err.message : "Login failed";
    }
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <!--
    Column mapping — Login
    Desktop (12-col): outer container col 1-12 (grid-desktop-margin 80px); form card col 5-8, centred.
    Tablet (6-col): form card col 2-5, centred, grid-tablet-margin 32px.
    Mobile (4-col): form card col 1-4, full width, grid-mobile-margin 6px.
  -->
  <div class="page">
    <form class="form-card" @submit.prevent="handleSubmit">
      <h1 class="h3">Sign in</h1>
      <p class="subheading">Sign in to view the events you've submitted.</p>

      <label class="field-label" for="email">Email</label>
      <input id="email" v-model="email" type="email" required class="text-input" autocomplete="email" />

      <label class="field-label" for="password">Password</label>
      <input
        id="password"
        v-model="password"
        type="password"
        required
        class="text-input"
        autocomplete="current-password"
      />

      <p
        v-if="errorMessage"
        class="body-small"
        :class="lockedOut ? 'lockout-text' : 'error-text'"
        role="alert"
      >
        {{ errorMessage }}
      </p>

      <button type="submit" class="btn-primary" :disabled="submitting || lockedOut">
        {{ submitting ? "Signing in…" : "Sign in" }}
      </button>

      <p class="body-small muted signup-hint">
        No account yet? <RouterLink to="/signup">Sign up</RouterLink>
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

.body-small {
  font-size: 0.875rem;
  line-height: 1.125rem;
}

.error-text {
  color: var(--color-error-600);
  margin: 0 0 var(--spacing-16);
}

/* A lockout isn't a form mistake the user can correct by retyping, so it
   reads as a warning to wait rather than an error to fix. */
.lockout-text {
  color: var(--color-warning-600);
  background: var(--color-grey-75);
  border-radius: var(--radius-xs);
  padding: var(--spacing-12);
  margin: 0 0 var(--spacing-16);
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

.muted {
  color: var(--color-grey-500);
}

.signup-hint {
  margin: var(--spacing-16) 0 0;
  text-align: center;
}
</style>
