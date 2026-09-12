<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { formatRole, getStoredUser, logout } from "./lib/auth";

const route = useRoute();
const router = useRouter();

// Re-read storage on every navigation rather than caching the user once:
// logging in and out are both navigations, so this stays in step without
// needing a store. `route.fullPath` is the dependency that drives it.
const user = computed(() => {
  void route.fullPath;
  return getStoredUser();
});

async function handleLogout() {
  // AC4: drop the token, then send the user to login. `replace` keeps the
  // protected page they were on out of the history, so Back can't put it
  // back on screen.
  logout();
  await router.replace({ name: "login" });
}
</script>

<template>
  <header v-if="user" class="app-header">
    <span class="brand">ConnectSphere</span>
    <div class="account">
      <span class="account-name">{{ user.name }}</span>
      <span class="role-pill">{{ formatRole(user.role) }}</span>
      <button type="button" class="btn-logout" @click="handleLogout">Log out</button>
    </div>
  </header>

  <RouterView />
</template>

<style scoped>
.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-16);
  padding: var(--spacing-12) var(--grid-desktop-margin);
  background: var(--color-base-white);
  border-bottom: 1px solid var(--color-grey-100);
}

@media (max-width: 1024px) {
  .app-header {
    padding: var(--spacing-12) var(--grid-tablet-margin);
  }
}

@media (max-width: 640px) {
  .app-header {
    padding: var(--spacing-12) var(--grid-mobile-margin);
  }
}

.brand {
  font-family: var(--font-family-lato);
  font-size: 1rem;
  font-weight: 700;
  color: var(--color-purple-700);
}

.account {
  display: flex;
  align-items: center;
  gap: var(--spacing-12);
}

.account-name {
  font-size: 0.875rem;
  color: var(--color-grey-700);
}

/* Hidden on mobile so a long name and the Log out button don't collide. */
@media (max-width: 640px) {
  .account-name {
    display: none;
  }
}

.role-pill {
  font-size: 0.75rem;
  font-weight: 700;
  color: var(--color-purple-700);
  background: var(--color-purple-100);
  border-radius: var(--radius-full);
  padding: var(--spacing-4) var(--spacing-12);
}

.btn-logout {
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  font-weight: 700;
  color: var(--color-grey-700);
  background: transparent;
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-xs);
  padding: var(--spacing-4) var(--spacing-12);
  cursor: pointer;
}

.btn-logout:hover {
  background: var(--color-grey-50);
  color: var(--color-grey-900);
}
</style>
