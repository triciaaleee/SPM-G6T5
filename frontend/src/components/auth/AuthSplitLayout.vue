<script setup lang="ts">
import loginPic from "../../assets/login_pic.png";

/**
 * Login and sign-up share this split screen: the brand graphic on the left, the form on the right with
 * no card behind it.
 */
</script>

<template>
  <!--
    Column mapping — Auth split layout
    Desktop (12-col): graphic cols 1-3.6 (30% of the viewport, full height), form area the remaining 70%.
    Tablet (6-col): same 30 / 70 split, grid-tablet-margin 32px around the form.
    Mobile (4-col): graphic hidden; form col 1-4, full width, grid-mobile-margin 6px.
  -->
  <div class="split">
    <div class="split__graphic">
      <img :src="loginPic" alt="" class="split__image" />
      <div class="split__copy">
        <p class="split__headline">Less admin.<br />More event.</p>
        <p class="split__tagline">Your events, venues and equipment — all in<br />one place.</p>
      </div>
    </div>
    <main class="split__form">
      <div class="split__form-inner">
        <slot />
      </div>
    </main>
  </div>
</template>

<style scoped>
.split {
  display: grid;
  grid-template-columns: 3fr 7fr;
  min-height: 100vh;
}

/* Stays in view while a tall form (sign-up) scrolls. */
.split__graphic {
  position: sticky;
  top: 0;
  height: 100vh;
  overflow: hidden;
  /* Matches the artwork's own lavender, so the panel and the image read as one. */
  background: var(--color-purple-100);
}

/* The artwork spans the panel's full width from the top; the headline sits at the bottom. */
.split__image {
  display: block;
  width: 100%;
  height: auto;
}

.split__copy {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: var(--spacing-32);
  color: var(--color-purple-800);
}

/* H2, uppercase, Black weight (Style.md 4.3: hero headings) */
.split__headline {
  margin: 0;
  font-size: 2.85rem;
  font-weight: 800;
  line-height: 2.75rem;
  text-transform: uppercase;
}

/* Body Default */
.split__tagline {
  margin: var(--spacing-12) 0 0;
  font-size: 1rem;
  line-height: 1.25rem;
}

.split__form {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-80) var(--grid-desktop-margin);
}

.split__form-inner {
  width: 100%;
  max-width: 28rem;
}

@media (max-width: 1024px) {
  .split__form {
    padding: var(--spacing-40) var(--grid-tablet-margin);
  }
}

@media (max-width: 640px) {
  .split {
    grid-template-columns: 1fr;
  }

  .split__graphic {
    display: none;
  }

  .split__form {
    padding: var(--spacing-24) var(--grid-mobile-margin);
  }
}
</style>
