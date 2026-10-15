<script setup lang="ts">
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { formatRole, getStoredUser, logout } from "./lib/auth";
import NotificationBell from "./components/notifications/NotificationBell.vue";
import ChatDrawer from "./components/chat/ChatDrawer.vue";

// Served from public/; a bound value keeps the bundler from trying to resolve it as an asset import.
const LOGO_URL = "/logoo.svg";

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
const NAV_TABS: Record<string, { name: string; label: string; alsoActiveOn?: string[] }[]> = {
  attendee: [
    { name: "attendee-events", label: "My events" },
    { name: "attendee-discover", label: "Discover events" },
  ],
  coordinator: [
    { name: "coordinator-workload", label: "Events" },
    { name: "venue-availability", label: "Venue Availability" },
  ],
  technical_support: [
    // A request's detail page belongs to Requests, so that link stays current while it is open.
    { name: "equipment-requests", label: "Requests", alsoActiveOn: ["equipment-request-detail"] },
    { name: "equipment-inventory", label: "Inventory" },
  ],
};

function isTabActive(tab: { name: string; alsoActiveOn?: string[] }): boolean {
  const current = String(route.name ?? "");
  return current === tab.name || (tab.alsoActiveOn ?? []).includes(current);
}

const navTabs = computed(() => (user.value ? NAV_TABS[user.value.role] ?? [] : []));

/** Style.md 3.6: each role has its own chip colour; an unknown role gets the Attendee colours. */
const ROLE_CHIP_CLASSES = ["attendee", "organiser", "coordinator", "venue_staff", "technical_support"];

function roleChipClass(role: string): string {
  return `role-pill--${ROLE_CHIP_CLASSES.includes(role) ? role : "attendee"}`;
}

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
    <img :src="LOGO_URL" alt="ConnectSphere" class="brand" />
    <nav v-if="navTabs.length > 0" class="nav" aria-label="Main">
      <RouterLink v-for="tab in navTabs" :key="tab.name" :to="{ name: tab.name }" class="nav__tab"
        :class="{ 'nav__tab--active': isTabActive(tab) }"
        :aria-current="isTabActive(tab) ? 'page' : undefined">
        {{ tab.label }}
      </RouterLink>
    </nav>
    <div class="account">
      <!-- E7-1: coordinators (E4-3), technical support (E5-1) and, since
           E2-15's chat, organisers are notification recipients. -->
      <NotificationBell
        v-if="user.role === 'coordinator' || user.role === 'technical_support' || user.role === 'organiser'"
        :key="user.id"
      />
      <span class="account-name">{{ user.name }}</span>
      <span class="role-pill" :class="roleChipClass(user.role)">{{ formatRole(user.role) }}</span>
      <button type="button" class="btn-logout" @click="handleLogout">Log out</button>
      <!-- E2-15: a live chat drawer, persistent on every page — only an
           Organiser or Coordinator has one. -->
      <ChatDrawer v-if="user.role === 'organiser' || user.role === 'coordinator'" :key="`chat-${user.id}`" />
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

/* Logo mark (public/logoo.svg, 121x155): fixed height, width follows the aspect ratio. */
.brand {
  display: block;
  height: var(--spacing-40);
  width: auto;
}

/* Nav links: the current page is just bold, no underline or tab styling. */
.nav {
  display: flex;
  align-items: center;
  gap: var(--spacing-24);
  margin-right: auto;
  margin-left: var(--spacing-24);
}

.nav__tab {
  display: flex;
  align-items: center;
  min-height: 44px;
  color: var(--color-grey-500);
  font-size: 16px;
  font-weight: 400;
  line-height: 1.125rem;
  text-decoration: none;
  text-transform: capitalize;
}

.nav__tab:hover {
  color: var(--color-grey-900);
}

/* Secondary Blue relief accent (Style.md 3.5a/2.8): the logo and most
   interactive elements are already Purple Primary/600, so the active tab
   uses blue instead of one more purple element. */
.nav__tab--active,
.nav__tab--active:hover {
  color: var(--color-blue-600);
  font-weight: 700;
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
  border: 1px solid transparent;
  border-radius: var(--radius-full);
  padding: var(--spacing-4) var(--spacing-12);
}

/* Role chip colours: Style.md 3.6. */
.role-pill--attendee {
  background: var(--color-purple-50);
  border-color: var(--color-purple-200);
  color: var(--color-purple-800);
}

.role-pill--organiser {
  background: var(--color-blue-100);
  border-color: var(--color-blue-300);
  color: var(--color-blue-800);
}

.role-pill--coordinator {
  background: var(--color-success-200);
  border-color: var(--color-success-300);
  color: var(--color-success-700);
}

.role-pill--venue_staff {
  background: var(--color-warning-100);
  border-color: var(--color-warning-300);
  color: var(--color-warning-900);
}

.role-pill--technical_support {
  background: var(--color-orchid-50);
  border-color: var(--color-orchid-200);
  color: var(--color-orchid-800);
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
