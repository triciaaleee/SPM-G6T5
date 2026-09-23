<script setup lang="ts">
/**
 * Stroke icons for the venue search UI. Kept local rather than adding an
 * icon library for a handful of glyphs; all inherit currentColor so the
 * chip/button state colours apply to them too.
 */
export type VenueIconName =
  | "search"
  | "close"
  | "chevron-down"
  | "chevron-left"
  | "chevron-right"
  | "calendar"
  | "users"
  | "capacity"
  | "location"
  | "accessibility"
  | "layout"
  | "facilities";

defineProps<{ name: VenueIconName; size?: number }>();
</script>

<template>
  <svg :width="size ?? 18" :height="size ?? 18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" class="venue-icon">
    <template v-if="name === 'search'">
      <circle cx="11" cy="11" r="7" />
      <path d="M16.5 16.5 21 21" />
    </template>
    <path v-else-if="name === 'close'" d="M6 6l12 12M18 6 6 18" />
    <path v-else-if="name === 'chevron-down'" d="m6 9 6 6 6-6" />
    <path v-else-if="name === 'chevron-left'" d="m15 6-6 6 6 6" />
    <path v-else-if="name === 'chevron-right'" d="m9 6 6 6-6 6" />
    <template v-else-if="name === 'calendar'">
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </template>
    <template v-else-if="name === 'users'">
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M16 4.5a3.5 3.5 0 0 1 0 7M18 14c2.2.6 3.5 2.6 3.5 6" />
    </template>
    <path v-else-if="name === 'capacity'" d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
    <template v-else-if="name === 'location'">
      <path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21Z" />
      <circle cx="12" cy="9.5" r="2.5" />
    </template>
    <template v-else-if="name === 'accessibility'">
      <circle cx="12" cy="4.5" r="1.5" />
      <path d="m5 8.5 7 1.5 7-1.5M12 10v5l-3 6M12 15l3 6" />
    </template>
    <template v-else-if="name === 'layout'">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </template>
    <path v-else-if="name === 'facilities'" d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0V8ZM12 17v4" />
  </svg>
</template>

<style scoped>
.venue-icon {
  flex-shrink: 0;
}
</style>
