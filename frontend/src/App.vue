<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ChevronDownIcon } from "@heroicons/vue/16/solid";
import { ArrowRightStartOnRectangleIcon } from "@heroicons/vue/20/solid";
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
    { name: "coordinator-workload", label: "My events" },
    { name: "all-events", label: "All events" },
    { name: "venue-availability", label: "Venue Availability" },
  ],
  coordinator_lead: [
    // The Lead's other screens (unassigned queue, one coordinator's events) belong to the dashboard.
    {
      name: "lead-dashboard",
      label: "Dashboard",
      alsoActiveOn: ["lead-unassigned", "lead-coordinator"],
    },
    { name: "all-events", label: "All events" },
  ],
  venue_staff: [
    { name: "venue-schedule", label: "Schedule" },
    { name: "venue-catalogue", label: "Venue catalogue" },
  ],
  technical_support: [
    // A request's detail page belongs to Requests, so that link stays current while it is open.
    { name: "equipment-requests", label: "Requests", alsoActiveOn: ["equipment-request-detail"] },
    { name: "equipment-inventory", label: "Inventory" },
    { name: "equipment-maintenance", label: "Maintenance" },
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

const userInitial = computed(() => user.value?.name?.charAt(0).toUpperCase() ?? "");

/** Account dropdown: same pattern as FilterChip.vue — outside-click and
 * Escape both close it, Escape also returns focus to the trigger. */
const menuOpen = ref(false);
const accountMenuRoot = ref<HTMLElement | null>(null);
const accountTrigger = ref<HTMLButtonElement | null>(null);

function closeMenu(returnFocus = false): void {
  menuOpen.value = false;
  if (returnFocus) accountTrigger.value?.focus();
}

function onDocumentPointerDown(e: PointerEvent): void {
  if (accountMenuRoot.value && !accountMenuRoot.value.contains(e.target as Node)) closeMenu();
}

function onMenuKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.stopPropagation();
    closeMenu(true);
  }
}

watch(menuOpen, (isOpen) => {
  if (isOpen) {
    document.addEventListener("pointerdown", onDocumentPointerDown);
  } else {
    document.removeEventListener("pointerdown", onDocumentPointerDown);
  }
});

onBeforeUnmount(() => document.removeEventListener("pointerdown", onDocumentPointerDown));

async function handleLogout() {
  // AC4: drop the token, then send the user to login. `replace` keeps the
  // protected page they were on out of the history, so Back can't put it
  // back on screen.
  closeMenu();
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
      <!-- E7-1 (#61) AC2: the unread count must be visible from any page,
           for anyone who can receive a notification — per #104-#107's
           trigger matrices that's every role, not just coordinator/
           technical_support/organiser. -->
      <NotificationBell :key="user.id" />
      <!-- E2-15: a live chat drawer, persistent on every page — only an
           Organiser or Coordinator has one. -->
      <ChatDrawer v-if="user.role === 'organiser' || user.role === 'coordinator'" :key="`chat-${user.id}`" />

      <span class="account-divider" aria-hidden="true" />

      <div ref="accountMenuRoot" class="account-menu" @keydown="onMenuKeydown">
        <button
          ref="accountTrigger"
          type="button"
          class="account-trigger"
          :aria-expanded="menuOpen"
          aria-haspopup="menu"
          @click="menuOpen = !menuOpen"
        >
          <span class="avatar avatar--sm">{{ userInitial }}</span>
          <span class="account-identity">
            <span class="account-name">{{ user.name }}</span>
            <span class="account-role">{{ formatRole(user.role) }}</span>
          </span>
          <ChevronDownIcon class="account-chevron" :class="{ 'account-chevron--open': menuOpen }" aria-hidden="true" />
        </button>

        <div v-if="menuOpen" class="account-popover" role="menu">
          <div class="account-popover__header">
            <span class="avatar avatar--lg">{{ userInitial }}</span>
            <div class="account-popover__identity">
              <p class="account-popover__name">{{ user.name }}</p>
              <span class="role-pill" :class="roleChipClass(user.role)">{{ formatRole(user.role) }}</span>
            </div>
          </div>

          <hr class="account-popover__divider" />

          <button type="button" class="account-popover__logout" role="menuitem" @click="handleLogout">
            <ArrowRightStartOnRectangleIcon class="account-popover__logout-icon" aria-hidden="true" />
            Log out
          </button>
        </div>
      </div>
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

.account-identity {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  line-height: 1.25rem;
}

.account-name {
  font-size: 0.875rem;
  font-weight: 700;
  color: var(--color-grey-900);
}

.account-role {
  font-size: 0.75rem;
  color: var(--color-grey-500);
}

/* Hidden on mobile so a long name and the Log out button don't collide. */
@media (max-width: 640px) {
  .account-identity {
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

.account-divider {
  width: 1px;
  height: var(--spacing-24);
  background: var(--color-grey-100);
}

.avatar {
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--color-purple-200);
  color: var(--color-purple-600);
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}

.avatar--sm {
  width: 28px;
  height: 28px;
  font-size: 0.75rem;
}

.avatar--lg {
  width: 40px;
  height: 40px;
  font-size: 1rem;
}

.account-menu {
  position: relative;
}

.account-trigger {
  display: flex;
  align-items: center;
  gap: var(--spacing-8);
  background: none;
  border: none;
  padding: var(--spacing-4);
  border-radius: var(--radius-xs);
  cursor: pointer;
}

.account-trigger:hover {
  background: var(--color-grey-50);
}

.account-trigger:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

.account-chevron {
  width: 16px;
  height: 16px;
  color: var(--color-grey-500);
  transition: transform 0.15s ease;
}

.account-chevron--open {
  transform: rotate(180deg);
}

.account-popover {
  position: absolute;
  top: calc(100% + var(--spacing-8));
  right: 0;
  z-index: 20;
  width: 240px;
  padding: var(--spacing-16);
  background: var(--color-base-white);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-popover);
}

.account-popover__header {
  display: flex;
  align-items: center;
  gap: var(--spacing-12);
}

.account-popover__identity {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--spacing-4);
  min-width: 0;
}

.account-popover__name {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 700;
  color: var(--color-grey-900);
}

.account-popover__divider {
  border: none;
  border-top: 1px solid var(--color-grey-100);
  margin: var(--spacing-16) 0;
}

.account-popover__logout {
  display: flex;
  align-items: center;
  gap: var(--spacing-8);
  width: 100%;
  background: none;
  border: none;
  padding: var(--spacing-8);
  border-radius: var(--radius-xs);
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  font-weight: 700;
  color: var(--color-grey-700);
  cursor: pointer;
}

.account-popover__logout:hover {
  background: var(--color-grey-50);
  color: var(--color-grey-900);
}

.account-popover__logout:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

.account-popover__logout-icon {
  width: 20px;
  height: 20px;
  color: var(--color-grey-500);
}
</style>
