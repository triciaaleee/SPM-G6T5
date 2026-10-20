<script setup lang="ts">
import { useRoute } from "vue-router";
import AppButton from "../ui/AppButton.vue";

/**
 * The shell for the guest pages (landing, events, venues): their own header
 * and footer, since App.vue's header is for signed-in users only. Guests can
 * browse everything here; Log in and Sign up are the only ways further in.
 */

// Served from public/; a bound value keeps the bundler from trying to resolve it as an asset import.
const LOGO_URL = "/logoo.svg";

const route = useRoute();

const NAV = [
  { name: "welcome", label: "Home", alsoActiveOn: [] as string[] },
  { name: "public-events", label: "Events", alsoActiveOn: ["public-event-detail"] },
  { name: "public-venues", label: "Venues", alsoActiveOn: [] as string[] },
];

function isActive(link: (typeof NAV)[number]): boolean {
  const current = String(route.name ?? "");
  return current === link.name || link.alsoActiveOn.includes(current);
}

const year = new Date().getFullYear();
</script>

<template>
  <div class="public-shell">
    <!--
      Column mapping — Public header
      Desktop (12-col, grid-desktop-margin 80px): logo col 1-3; nav col 4-9, centred; account buttons col 10-12, right-aligned.
      Tablet (6-col, grid-tablet-margin 32px): logo col 1-2; nav col 3-4, centred; buttons col 5-6.
      Mobile (4-col, grid-mobile-margin 6px): logo col 1-2; buttons col 3-4; nav col 1-4 on its own row.
    -->
    <header class="public-header">
      <RouterLink :to="{ name: 'welcome' }" class="brand-link" aria-label="ConnectSphere home">
        <img :src="LOGO_URL" alt="ConnectSphere" class="brand" />
      </RouterLink>

      <nav class="nav" aria-label="Main">
        <RouterLink v-for="link in NAV" :key="link.name" :to="{ name: link.name }" class="nav__link"
          :class="{ 'nav__link--active': isActive(link) }" :aria-current="isActive(link) ? 'page' : undefined">
          {{ link.label }}
        </RouterLink>
      </nav>

      <div class="account">
        <AppButton variant="outline" size="sm" :to="{ name: 'login' }">Log in</AppButton>
        <AppButton variant="primary" size="sm" :to="{ name: 'signup' }">Sign up</AppButton>
      </div>
    </header>

    <main class="public-main">
      <slot />
    </main>

    <!--
      Column mapping — Public footer
      Desktop (12-col): brand and tagline col 1-6; Discover col 7-9; Account col 10-12; bottom bar col 1-12.
      Tablet (6-col): brand col 1-6; Discover col 1-3; Account col 4-6; bottom bar col 1-6.
      Mobile (4-col): brand col 1-4; Discover col 1-2; Account col 3-4; bottom bar col 1-4.
    -->
    <footer class="public-footer">
      <div class="footer-brand">
        <img :src="LOGO_URL" alt="ConnectSphere" class="brand" />
        <p class="small-text muted">Find your people. Find your place.<br />Your next unforgettable event starts here.</p>
      </div>

      <nav class="footer-col" aria-label="Discover">
        <h2 class="footer-heading">Discover</h2>
        <RouterLink :to="{ name: 'public-events' }" class="footer-link">Events</RouterLink>
        <RouterLink :to="{ name: 'public-venues' }" class="footer-link">Venues</RouterLink>
      </nav>

      <nav class="footer-col" aria-label="Account">
        <h2 class="footer-heading">Account</h2>
        <RouterLink :to="{ name: 'login' }" class="footer-link">Log in</RouterLink>
        <RouterLink :to="{ name: 'signup' }" class="footer-link">Sign up</RouterLink>
      </nav>

      <p class="footer-bottom small-text muted">&copy; {{ year }} ConnectSphere. All rights reserved.</p>
    </footer>
  </div>
</template>

<style scoped>
.public-shell {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  background: var(--color-grey-25);
}

.public-main {
  flex: 1;
}

/* Header ------------------------------------------------------------------ */

.public-header {
  position: sticky;
  top: 0;
  z-index: 10;
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: var(--grid-desktop-gutter);
  align-items: center;
  align-content: start;
  padding: var(--spacing-16) var(--grid-desktop-margin);
  background: var(--color-base-white);
  border-bottom: 1px solid var(--color-grey-100);
}

.brand-link {
  grid-column: 1 / 4;
  display: inline-flex;
  justify-self: start;
}

.brand-link:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

/* Style.md 3.5a: spacing-40 tall, width from the aspect ratio. */
.brand {
  height: var(--spacing-40);
  width: auto;
  display: block;
}

.nav {
  grid-column: 4 / 10;
  display: flex;
  justify-content: center;
  gap: var(--spacing-32);
}

/* Style.md 3.5a: 16px regular Grey/500, Grey/900 on hover, current page bold Secondary Blue/600. */
.nav__link {
  font-size: 1rem;
  line-height: 1.25rem;
  font-weight: 400;
  color: var(--color-grey-500);
  text-decoration: none;
}

.nav__link:hover {
  color: var(--color-grey-900);
}

.nav__link--active {
  font-weight: 700;
  color: var(--color-blue-600);
}

.nav__link:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

.account {
  grid-column: 10 / 13;
  display: flex;
  justify-content: flex-end;
  gap: var(--spacing-8);
}

/* Footer ------------------------------------------------------------------ */

.public-footer {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  grid-template-rows: auto auto;
  gap: var(--spacing-40) var(--grid-desktop-gutter);
  align-content: start;
  padding: var(--spacing-48) var(--grid-desktop-margin) var(--spacing-32);
  background: var(--color-base-white);
  border-top: 1px solid var(--color-grey-100);
}

.footer-brand {
  grid-column: 1 / 7;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-12);
}

.footer-col {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-8);
}

.footer-col:nth-of-type(1) {
  grid-column: 7 / 10;
}

.footer-col:nth-of-type(2) {
  grid-column: 10 / 13;
}

/* Small Text / Tag */
.footer-heading {
  margin: 0 0 var(--spacing-4);
  font-size: 0.75rem;
  line-height: 1rem;
  font-weight: 700;
  color: var(--color-grey-900);
}

.footer-link {
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-500);
  text-decoration: none;
  justify-self: start;
}

.footer-link:hover {
  color: var(--color-purple-700);
}

.footer-link:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

.footer-bottom {
  grid-column: 1 / 13;
  margin: 0;
  padding-top: var(--spacing-24);
  border-top: 1px solid var(--color-grey-100);
}

/* Small Text */
.small-text {
  margin: 0;
  font-size: 0.75rem;
  line-height: 1rem;
}

.muted {
  color: var(--color-grey-500);
}

@media (max-width: 1024px) {
  .public-header {
    grid-template-columns: repeat(6, 1fr);
    gap: var(--grid-tablet-gutter);
    padding: var(--spacing-16) var(--grid-tablet-margin);
  }
  .brand-link { grid-column: 1 / 3; }
  .nav { grid-column: 3 / 5; gap: var(--spacing-24); }
  .account { grid-column: 5 / 7; }

  .public-footer {
    grid-template-columns: repeat(6, 1fr);
    column-gap: var(--grid-tablet-gutter);
    padding: var(--spacing-40) var(--grid-tablet-margin) var(--spacing-24);
  }
  .footer-brand { grid-column: 1 / 7; }
  .footer-col:nth-of-type(1) { grid-column: 1 / 4; }
  .footer-col:nth-of-type(2) { grid-column: 4 / 7; }
  .footer-bottom { grid-column: 1 / 7; }
}

@media (max-width: 640px) {
  .public-header {
    grid-template-columns: repeat(4, 1fr);
    grid-template-rows: auto auto;
    gap: var(--spacing-12) var(--grid-mobile-gutter);
    padding: var(--spacing-12) var(--grid-mobile-margin);
  }
  .brand-link { grid-column: 1 / 3; }
  .account { grid-column: 3 / 5; }
  .nav { grid-column: 1 / 5; grid-row: 2; }

  .public-footer {
    grid-template-columns: repeat(4, 1fr);
    column-gap: var(--grid-mobile-gutter);
    padding: var(--spacing-40) var(--grid-mobile-margin) var(--spacing-24);
  }
  .footer-brand { grid-column: 1 / 5; }
  .footer-col:nth-of-type(1) { grid-column: 1 / 3; }
  .footer-col:nth-of-type(2) { grid-column: 3 / 5; }
  .footer-bottom { grid-column: 1 / 5; }
}
</style>
