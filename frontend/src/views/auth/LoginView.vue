<script setup lang="ts">
import AppButton from "../../components/ui/AppButton.vue";
import AuthSplitLayout from "../../components/auth/AuthSplitLayout.vue";
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { LockedOutError, landingRouteForRole, login } from "../../lib/auth";

const email = ref("");
const password = ref("");
const errorMessage = ref<string | null>(null);
const lockedOut = ref(false);
const submitting = ref(false);
const router = useRouter();
const route = useRoute();

/** Keeps a pending ?redirect when switching to the signup form. */
const signupLink = computed(() => ({ name: "signup", query: typeof route.query.redirect === "string" ? { redirect: route.query.redirect } : {} }));

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
    Laid out by AuthSplitLayout: graphic 30% on the left, form (no card) centred in the right 70%.
    Mobile (4-col): graphic hidden; form col 1-4, full width, grid-mobile-margin 6px.
  -->
  <AuthSplitLayout>
    <form class="form" @submit.prevent="handleSubmit">
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

      <AppButton variant="primary" type="submit" :disabled="submitting || lockedOut">
        {{ submitting ? "Signing in…" : "Sign in" }}
      </AppButton>

      <p class="body-small muted signup-hint">
        No account yet? <RouterLink :to="signupLink">Sign up</RouterLink>
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

.muted {
  color: var(--color-grey-600);
}

.signup-hint {
  margin: var(--spacing-16) 0 0;
  text-align: center;
}
</style>
