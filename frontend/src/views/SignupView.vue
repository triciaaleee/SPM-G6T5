<script setup lang="ts">
import { ref } from "vue";
import { useRouter } from "vue-router";
import { landingRouteForRole, signup } from "../lib/auth";

const name = ref("");
const email = ref("");
const password = ref("");
const errorMessage = ref<string | null>(null);
const submitting = ref(false);
const router = useRouter();

async function handleSubmit() {
  errorMessage.value = null;
  submitting.value = true;
  try {
    const user = await signup(name.value, email.value, password.value);
    // Same role-driven landing as login (AC1). New accounts are always
    // attendees today, but routing through the map keeps the two paths
    // consistent if that ever changes.
    router.replace({ name: landingRouteForRole(user.role) });
  } catch (err) {
    errorMessage.value = err instanceof Error ? err.message : "Signup failed";
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
  -->
  <div class="page">
    <form class="form-card" @submit.prevent="handleSubmit">
      <h1 class="h3">Create an account</h1>
      <p class="subheading">New accounts start as an Attendee.</p>

      <label class="field-label" for="name">Name</label>
      <input id="name" v-model="name" type="text" required class="text-input" autocomplete="name" />

      <label class="field-label" for="email">Email</label>
      <input id="email" v-model="email" type="email" required class="text-input" autocomplete="email" />

      <label class="field-label" for="password">Password</label>
      <input
        id="password"
        v-model="password"
        type="password"
        required
        minlength="8"
        class="text-input"
        autocomplete="new-password"
      />

      <p v-if="errorMessage" class="body-small error-text">{{ errorMessage }}</p>

      <button type="submit" class="btn-primary" :disabled="submitting">
        {{ submitting ? "Creating account…" : "Sign up" }}
      </button>

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
