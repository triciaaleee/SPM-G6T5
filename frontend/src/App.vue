<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { formatRole, getStoredUser, logout } from "./lib/auth";
import NotificationBell from "./components/notifications/NotificationBell.vue";

const route = useRoute();
const router = useRouter();

// Re-read storage on every navigation rather than caching the user once:
// logging in and out are both navigations, so this stays in step without
// needing a store. `route.fullPath` is the dependency that drives it.
const user = computed(() => {
  void route.fullPath;
  return getStoredUser();
});

/** Top tabs per role. Roles with a single screen get none. */
const NAV_TABS: Record<string, { name: string; label: string }[]> = {
  coordinator: [
    { name: "coordinator-workload", label: "Events" },
    { name: "venue-availability", label: "Venue Availability" },
  ],
};

const navTabs = computed(() => (user.value ? NAV_TABS[user.value.role] ?? [] : []));

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
    <nav v-if="navTabs.length > 0" class="nav" aria-label="Main">
      <RouterLink v-for="tab in navTabs" :key="tab.name" :to="{ name: tab.name }" class="nav__tab"
        :class="{ 'nav__tab--active': route.name === tab.name }"
        :aria-current="route.name === tab.name ? 'page' : undefined">
        {{ tab.label }}
      </RouterLink>
    </nav>
    <div class="account">
      <!-- E7-1: coordinators are the only notification recipients so far (E4-3). -->
      <NotificationBell v-if="user.role === 'coordinator'" :key="user.id" />
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

/* Tabs: Style.md 2.4 — Purple 600 marks the active tab, as on the venue schedule's tabs. */
.nav {
  display: flex;
  align-self: stretch;
  gap: var(--spacing-24);
  margin-right: auto;
  margin-left: var(--spacing-24);
}

.nav__tab {
  display: flex;
  align-items: center;
  margin: calc(var(--spacing-12) * -1) 0;
  padding: var(--spacing-12) 0;
  border-bottom: 2px solid transparent;
  color: var(--color-grey-500);
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  text-decoration: none;
}

.nav__tab:hover {
  color: var(--color-grey-800);
}

.nav__tab--active,
.nav__tab--active:hover {
  border-bottom-color: var(--color-purple-600);
  color: var(--color-purple-600);
}

.nav__tab:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

/* On mobile the tabs drop to their own row under the brand and account. */
@media (max-width: 640px) {
  .app-header {
    flex-wrap: wrap;
  }

  .nav {
    order: 3;
    flex-basis: 100%;
    margin: 0;
  }
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
