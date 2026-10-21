<script setup lang="ts">
import AppButton from "../components/ui/AppButton.vue";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ChevronDownIcon } from "@heroicons/vue/16/solid";
import VenueCalendar from "../components/venues/VenueCalendar.vue";
import VenueRequestRows from "../components/venues/VenueRequestRows.vue";
import VenueMultiSelect from "../components/venues/VenueMultiSelect.vue";
import BlockOutPanel from "../components/venues/BlockOutPanel.vue";
import UnavailabilityCard from "../components/venues/UnavailabilityCard.vue";
import VenueFormPanel from "../components/venues/VenueFormPanel.vue";
import BufferOverlapList from "../components/venues/BufferOverlapList.vue";
import {
  fetchBufferOverlaps,
  fetchMyVenues,
  fetchPendingRequests,
  fetchStaffVenues,
  fetchVenueBookings,
  type BufferOverlapRecord,
  type PendingVenueRequest,
  type StaffVenueOption,
  type VenueBooking,
  type VenueRecord,
  type VenueUpdateResult,
} from "../lib/venuesApi";
import {
  deleteUnavailability,
  fetchUnavailability,
  type CreatePeriodResult,
  type UnavailabilityPeriod,
} from "../lib/unavailabilityApi";


// Current EVENTS  as of 1/10
/* Great Lawn - 30 sept
Grand ballroom - 30 sept
Innovation Hub - 30 sep


/**
 * E1-5: venue staff's schedule. Pick a venue and a date to see what's
 * booked there — event name, date, times, attendance, layout and facility
 * requirements only. The API never sends the wider event plan, so there's
 * nothing here to hide.
 *
 * Tabs split bookings by booking status: Bookings (approved) and Requested
 * (awaiting a decision). Rejected bookings aren't shown. The tabs filter
 * the list only: the calendar marks every day with a booking (purple dot)
 * or a request (blue dot), whichever tab is open.
 */

type ScheduleTab = "bookings" | "requested" | "held";

const TABS: { key: ScheduleTab; label: string; status: VenueBooking["status"]; noun: string; empty: string }[] = [
  { key: "bookings", label: "Bookings", status: "Approved", noun: "booking", empty: "No confirmed bookings." },
  { key: "requested", label: "Requests", status: "Requested", noun: "request", empty: "No booking requests." },
  { key: "held", label: "On Hold", status: "On Hold", noun: "hold", empty: "No venues on hold." },
];

function toKey(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${m}-${d}`;
}

function fromKey(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

const route = useRoute();
const router = useRouter();

/** A single string query param, or null. */
function queryParam(name: string): string | null {
  const value = route.query[name];
  return typeof value === "string" ? value : null;
}

/*
 * The selected venue, date and tab live in the URL
 * (?venue=1&date=2026-09-25&tab=requested), so a refresh or a shared link
 * reopens the same view instead of resetting to the first venue and today.
 */
function queryDay(name: string): string {
  const value = queryParam(name);
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : "";
}
const queryTab = queryParam("tab");

const venues = ref<StaffVenueOption[]>([]);
const venueCalendar = ref<InstanceType<typeof VenueCalendar> | null>(null);
/**
 * Venues the calendar was filtered to, or null for "all my venues" (the default, so every request that
 * needs a decision is visible at a glance). Set only when the user changes the calendar's venues.
 */
const filterIds = ref<number[] | null>(null);
const scopeIds = computed(() => filterIds.value ?? venues.value.map((v) => v.id));
const scopeKey = computed(() => scopeIds.value.join(","));
/** Where "Block out time" starts: the first venue in scope. */
const venueId = computed(() => scopeIds.value[0] ?? null);
const venueName = (id: number) => venues.value.find((v) => v.id === id)?.name ?? "Venue";
/** The calendar stays empty until the filter names a venue or a date range. */
const calendarActive = computed(() => filterIds.value !== null || rangeActive.value);
/** The calendar draws at most four venues; the list below it covers every venue in scope. */
const CALENDAR_VENUES = 4;
const calendarVenues = computed(() =>
  scopeIds.value.slice(0, CALENDAR_VENUES).flatMap((id) => venues.value.filter((v) => v.id === id)),
);
/** Optional date range for the lists below; empty means every booking, whenever it is. */
const rangeFrom = ref(queryDay("from"));
const rangeTo = ref(queryDay("to"));
const rangeActive = computed(() => rangeFrom.value !== "" || rangeTo.value !== "");
const today = toKey(new Date());
/** Past bookings and block-outs are never listed; the range narrows what is left. */
const inRange = (start: string, end = start) =>
  end >= today && (rangeFrom.value === "" || end >= rangeFrom.value) && (rangeTo.value === "" || start <= rangeTo.value);

/** Booking ids whose layout / facility details are open. */
const expanded = ref<Set<number>>(new Set());
function toggleDetails(id: number): void {
  const next = new Set(expanded.value);
  if (!next.delete(id)) next.add(id);
  expanded.value = next;
}

const activeTab = ref<ScheduleTab>(TABS.some((tab) => tab.key === queryTab) ? (queryTab as ScheduleTab) : "requested");
const activeTabConfig = computed(() => TABS.find((tab) => tab.key === activeTab.value)!);

type ScheduleBooking = VenueBooking & { venueId: number };
const bookings = ref<ScheduleBooking[]>([]);
const loadingVenues = ref(true);
const loadingBookings = ref(false);
const venuesError = ref<string | null>(null);
const bookingsError = ref<string | null>(null);

/**
 * Whether a booking belongs in a tab. A booking flagged Replacement
 * Required by a block-out (E4-3) was approved, so it stays under Bookings
 * (with a badge) rather than disappearing from both tabs.
 */
function inTab(booking: ScheduleBooking, tab: (typeof TABS)[number]): boolean {
  return (
    booking.status === tab.status ||
    (tab.key === "bookings" && (booking.status === "Replacement Required" || booking.status === "Cancelled"))
  );
}

/** Approved bookings in the date range, earliest first. Requests and holds come from the decision queue below. */
const tabBookings = computed(() =>
  bookings.value
    .filter((b) => inTab(b, TABS[0]) && inRange(b.date))
    .sort((a, b) => a.date.localeCompare(b.date) || (a.startTime ?? "").localeCompare(b.startTime ?? "")),
);

// ---- E4-10: the decision queue (Requested and On Hold bookings) ---------

const pending = ref<PendingVenueRequest[]>([]);
const pendingLoading = ref(true);
const pendingError = ref<string | null>(null);

async function loadPending(): Promise<void> {
  pendingLoading.value = true;
  pendingError.value = null;
  try {
    pending.value = await fetchPendingRequests();
  } catch (err) {
    pending.value = [];
    pendingError.value = err instanceof Error ? err.message : "Failed to load booking requests";
  } finally {
    pendingLoading.value = false;
  }
}

/** The date range alone, without the "not in the past" floor. */
const inChosenRange = (day: string) =>
  (rangeFrom.value === "" || day >= rangeFrom.value) && (rangeTo.value === "" || day <= rangeTo.value);

/** Requests whose event date has already passed are hidden unless this is ticked, since past bookings aren't listed. */
const showOverdue = ref(false);

/** Waiting requests at the venues in scope, inside the date range; undated ones only while no range is set. */
const pendingInScope = computed(() =>
  pending.value.filter((r) => {
    if (!scopeIds.value.includes(r.venue.id)) return false;
    if (r.event.date === null) return !rangeActive.value;
    return showOverdue.value ? inChosenRange(r.event.date) : inRange(r.event.date);
  }),
);

/** How many past-dated requests the active tab is leaving out, so an empty tab can say why. */
const overdueCount = computed(
  () =>
    pending.value.filter(
      (r) =>
        scopeIds.value.includes(r.venue.id) &&
        r.status === activeTabConfig.value.status &&
        r.event.date !== null &&
        r.event.date < today &&
        inChosenRange(r.event.date),
    ).length,
);

/** E4-10 AC7: soonest event first. */
const tabPending = computed(() =>
  pendingInScope.value
    .filter((r) => r.status === activeTabConfig.value.status)
    .sort(
      (a, b) =>
        (a.event.date ?? "9999-12-31").localeCompare(b.event.date ?? "9999-12-31") ||
        (a.event.startTime ?? "").localeCompare(b.event.startTime ?? ""),
    ),
);

const isDecisionTab = computed(() => activeTab.value !== "bookings");

/** Each tab's total for the venues and date range in view, shown beside its label. */
const tabCounts = computed<Record<ScheduleTab, number>>(() => ({
  bookings: tabBookings.value.length,
  requested: pendingInScope.value.filter((r) => r.status === "Requested").length,
  held: pendingInScope.value.filter((r) => r.status === "On Hold").length,
}));

/** A decision landed: it can knock other requests out, so reload everything it touches. */
function onDecided(message: string): void {
  notice.value = { text: message, warning: false };
  void loadPending();
  void loadBookings();
  void venueCalendar.value?.refresh();
}

/** The calendar's "Go to booking requests": open the Requests tab and bring it into view. */
async function showRequests(): Promise<void> {
  activeTab.value = "requested";
  await nextTick();
  document.getElementById("schedule-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function formatRowDate(key: string): string {
  return fromKey(key).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

const heading = computed(() => {
  const fmt = (key: string) => formatLongDate(key);
  if (rangeFrom.value && rangeTo.value) return `${fmt(rangeFrom.value)} – ${fmt(rangeTo.value)}`;
  if (rangeFrom.value) return `From ${fmt(rangeFrom.value)}`;
  if (rangeTo.value) return `Up to ${fmt(rangeTo.value)}`;
  return "Upcoming bookings";
});

function formatLongDate(key: string): string {
  return fromKey(key).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

/** Times come from the event, which could in principle be missing one. */
function formatTimeRange(start: string | null, end: string | null): string {
  return start && end ? `${start} ${end}` : "Not specified";
}

function formatAttendance(value: number | null): string {
  return value === null ? "Not specified" : `${value} guest${value === 1 ? "" : "s"}`;
}

// Switching venue or month quickly can land responses out of order; only
// the latest request may update the schedule.
let requestSeq = 0;

async function loadBookings(): Promise<void> {
  if (scopeIds.value.length === 0) return;

  const seq = ++requestSeq;
  loadingBookings.value = true;
  bookingsError.value = null;
  try {
    const perVenue = await Promise.all(
      scopeIds.value.map(async (id) => (await fetchVenueBookings(id)).map((b) => ({ ...b, venueId: id }))),
    );
    if (seq !== requestSeq) return;
    bookings.value = perVenue.flat();
  } catch {
    if (seq !== requestSeq) return;
    bookings.value = [];
    bookingsError.value = "We couldn't load the bookings. Please try again.";
  } finally {
    if (seq === requestSeq) loadingBookings.value = false;
  }
}

watch(scopeKey, loadBookings);

// ---- E4-3: block-out periods -------------------------------------------

const periods = ref<UnavailabilityPeriod[]>([]);
const periodsError = ref<string | null>(null);
const panelOpen = ref(false);
/** The period being edited in the panel; null while adding a new one. */
const editingPeriod = ref<UnavailabilityPeriod | null>(null);
const removingId = ref<number | null>(null);
/** Outcome of the last block-out change, shown above the day's list. */
const notice = ref<{ text: string; warning: boolean } | null>(null);


/** Periods in the date range: earliest first, all-day before timed ones. */
const visiblePeriods = computed(() =>
  periods.value
    .filter((p) => inRange(p.startDate, p.endDate))
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || Number(b.allDay) - Number(a.allDay) || (a.startTime ?? "").localeCompare(b.startTime ?? "")),
);

let periodsSeq = 0;

async function loadUnavailability(): Promise<void> {
  if (scopeIds.value.length === 0) return;

  const seq = ++periodsSeq;
  try {
    const result = (await Promise.all(scopeIds.value.map((id) => fetchUnavailability(id)))).flat();
    if (seq !== periodsSeq) return;
    periods.value = result;
    periodsError.value = null;
  } catch {
    if (seq !== periodsSeq) return;
    periods.value = [];
    periodsError.value = "We couldn't load the unavailable periods.";
  }
}

watch(scopeKey, loadUnavailability);
watch(scopeKey, () => (notice.value = null));

// ---- E4-13 AC2/AC3: persisted buffer-overlap review list ----------------

const bufferOverlaps = ref<BufferOverlapRecord[]>([]);
const bufferOverlapsLoading = ref(false);
const bufferOverlapsError = ref<string | null>(null);

let overlapsSeq = 0;

/** Venue-scoped, not date-scoped — reloaded whenever the venues in scope change. */
async function loadBufferOverlaps(): Promise<void> {
  if (scopeIds.value.length === 0) {
    bufferOverlaps.value = [];
    return;
  }
  const seq = ++overlapsSeq;
  bufferOverlapsLoading.value = true;
  bufferOverlapsError.value = null;
  try {
    const result = (await Promise.all(scopeIds.value.map((id) => fetchBufferOverlaps(id)))).flat();
    if (seq !== overlapsSeq) return;
    bufferOverlaps.value = result;
  } catch {
    if (seq !== overlapsSeq) return;
    bufferOverlaps.value = [];
    bufferOverlapsError.value = "We couldn't load the flagged bookings.";
  } finally {
    if (seq === overlapsSeq) bufferOverlapsLoading.value = false;
  }
}

watch(scopeKey, loadBufferOverlaps);

function openBlockOut(period: UnavailabilityPeriod | null = null): void {
  editingPeriod.value = period;
  panelOpen.value = true;
}

function closeBlockOut(): void {
  panelOpen.value = false;
  editingPeriod.value = null;
}

function onBlockOutSaved(result: CreatePeriodResult): void {
  const verb = editingPeriod.value ? "Block-out updated." : "Period blocked out.";
  closeBlockOut();

  const flagged = result.affected.filter((b) => b.replacementRequired).length;
  const pending = result.affected.length - flagged;
  if (result.affected.length === 0) {
    notice.value = { text: `${verb} It shows as unavailable on the calendar.`, warning: false };
  } else {
    const parts = [];
    if (flagged > 0) parts.push(`${flagged} booking${flagged === 1 ? "" : "s"} cancelled`);
    if (pending > 0) parts.push(`${pending} pending request${pending === 1 ? "" : "s"} clash with it`);
    const notified = result.notificationsFailed
      ? "but we couldn't notify the coordinators — please let them know directly."
      : `${result.coordinatorsNotified} coordinator${result.coordinatorsNotified === 1 ? "" : "s"} notified.`;
    notice.value = { text: `${verb} ${parts.join("; ")}; ${notified}`, warning: result.notificationsFailed };
  }
  void loadUnavailability();
  void loadBookings();
  void venueCalendar.value?.refresh();
}

async function removePeriod(period: UnavailabilityPeriod): Promise<void> {
  if (!window.confirm(`Remove this block-out (${period.reason})? The venue will show as available again.`)) return;
  removingId.value = period.id;
  try {
    await deleteUnavailability(period.id);
    notice.value = { text: "Block-out removed.", warning: false };
    await loadUnavailability();
    void venueCalendar.value?.refresh();
  } catch {
    notice.value = { text: "We couldn't remove that block-out. Please try again.", warning: true };
  } finally {
    removingId.value = null;
  }
}

// ---- E4-1: adding and editing venue records ----------------------------------

const venueFormOpen = ref(false);
/** The venue being edited in the drawer; null while adding a new one. */
const editingVenue = ref<VenueRecord | null>(null);
/** Venues this staff member looks after — the only ones they may edit. */
const myVenues = ref<VenueRecord[]>([]);
const myVenuesError = ref(false);
const editMenuOpen = ref(false);
const editMenu = ref<HTMLElement | null>(null);

async function loadMyVenues(): Promise<void> {
  try {
    myVenues.value = await fetchMyVenues();
    myVenuesError.value = false;
  } catch {
    myVenuesError.value = true;
  }
}

function openAddVenue(): void {
  editingVenue.value = null;
  venueFormOpen.value = true;
}

function openEditVenue(venue: VenueRecord): void {
  editMenuOpen.value = false;
  editingVenue.value = venue;
  venueFormOpen.value = true;
}

function closeVenueForm(): void {
  venueFormOpen.value = false;
  editingVenue.value = null;
}

/** The menu closes on Escape or a click anywhere outside it. */
function onDocumentPointer(event: Event): void {
  if (editMenuOpen.value && editMenu.value && !editMenu.value.contains(event.target as Node)) editMenuOpen.value = false;
}

function onMenuKeydown(event: KeyboardEvent): void {
  if (event.key === "Escape") editMenuOpen.value = false;
}

/** Reload both venue lists, then show `id`'s schedule with a notice. */
async function afterVenueSaved(id: number, text: string, warning = false): Promise<void> {
  closeVenueForm();
  await Promise.all([
    loadMyVenues(),
    fetchStaffVenues()
      .then((list) => {
        venues.value = list;
        venuesError.value = null;
      })
      .catch(() => undefined),
  ]);
  // A new venue joins the "all venues" scope on its own; a filtered view keeps its filter.
  void id;
  await nextTick();
  notice.value = { text, warning };
}

function onVenueCreated(venue: VenueRecord): void {
  void afterVenueSaved(venue.id, `${venue.name} added. Coordinators can find and book it straight away.`);
}

function onVenueUpdated(result: VenueUpdateResult): void {
  const shortfalls = result.capacityShortfalls.length;
  const overlaps = result.bufferOverlaps.length;
  const parts = [];
  if (shortfalls > 0) parts.push(`${shortfalls} confirmed event${shortfalls === 1 ? "" : "s"} no longer fit the capacity`);
  if (overlaps > 0) parts.push(`${overlaps} pair${overlaps === 1 ? "" : "s"} of bookings now overlap`);
  let text = `${result.venue.name} updated.`;
  if (parts.length > 0) {
    const notified = result.notificationsFailed
      ? "but we couldn't notify the coordinators — please let them know directly."
      : `${result.coordinatorsNotified} coordinator${result.coordinatorsNotified === 1 ? "" : "s"} notified.`;
    text += ` ${parts.join("; ")}; ${notified}`;
  }
  void afterVenueSaved(result.venue.id, text, result.notificationsFailed);
  // The schedule's bookings carry layouts/facilities derived from the venue.
  void loadBookings();
  // E4-13: the save may have changed which pairs overlap, and the scope may not change, so reload explicitly.
  void loadBufferOverlaps();
}

onMounted(() => {
  void loadMyVenues();
  void loadPending();
  document.addEventListener("pointerdown", onDocumentPointer);
});

onBeforeUnmount(() => document.removeEventListener("pointerdown", onDocumentPointer));

// replace, not push: picking a date shouldn't add a history entry.
watch([filterIds, rangeFrom, rangeTo, activeTab], ([ids, from, to, tab]) => {
  const { venue: _venue, from: _from, to: _to, date: _date, ...rest } = route.query;
  void router.replace({
    query: { ...rest, ...(ids ? { venue: ids.join(",") } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}), tab },
  });
});

onMounted(async () => {
  try {
    venues.value = await fetchStaffVenues();
    // ?venue=1,2 reopens a filtered view; no param means all venues.
    const fromQuery = (queryParam("venue") ?? "")
      .split(",")
      .map(Number)
      .filter((id) => venues.value.some((venue) => venue.id === id));
    if (fromQuery.length > 0) filterIds.value = fromQuery.slice(0, 4);
  } catch {
    venuesError.value = "We couldn't load the venue list. Please refresh the page.";
  } finally {
    loadingVenues.value = false;
  }
});
</script>

<template>
  <!--
    Column mapping — Venue Schedule
    Desktop (12-col, grid-desktop-margin 80px): header col 1-12 (title left; on the right, "Add new venue" and
      "Edit venue" and "Block out time" on one line); upcoming bookings col 1-12; calendar col 1-12;
      block-out cards above the tabs.
      The Block out time and Add new venue panels are overlay drawers outside this grid (mappings in
      BlockOutPanel.vue and VenueFormPanel.vue).
      Nested grid: each booking card's detail rows use a local 8-col grid (the schedule's span);
      time and attendance span 4 each, layout and facilities span 8.
    Tablet (6-col, grid-tablet-margin 32px): header, calendar and schedule each col 1-6, stacked.
      Card detail grid is 6-col; time/attendance span 3 each, layout/facilities span 6.
    Mobile (4-col, grid-mobile-margin 6px): everything col 1-4, stacked; card detail rows span 4.
  -->
  <div class="page">
    <div class="page-header page-header--with-action">
      <div>
        <h1 class="h2">Venue schedule</h1>
        <p class="subheading">Everything booked into your venues; narrow by venue or date range</p>
      </div>
      <!-- Style.md 3.4: one solid action per view, so "Go to booking requests" is it; the rest are outline. -->
      <div class="header-actions">
        <div class="venue-actions">
        <AppButton variant="outline" type="button" @click="openAddVenue">Add new venue</AppButton>
        <!--
          E4-1: opens on hover (pointer devices) and on click/Enter (touch and keyboard), listing only the
          venues this staff member looks after.
        -->
        <div ref="editMenu" class="edit-menu" @mouseenter="editMenuOpen = true" @mouseleave="editMenuOpen = false"
          @keydown="onMenuKeydown">
          <AppButton variant="outline" type="button" class="edit-menu__trigger" aria-haspopup="true"
            :aria-expanded="editMenuOpen" aria-controls="edit-venue-menu" @click="editMenuOpen = true">
            Edit venue
            <ChevronDownIcon class="edit-menu__chevron" aria-hidden="true" />
          </AppButton>
          <div v-if="editMenuOpen" id="edit-venue-menu" class="edit-menu__popover">
            <p class="edit-menu__heading">Your venues</p>
            <p v-if="myVenuesError" class="edit-menu__empty">We couldn't load your venues.</p>
            <p v-else-if="myVenues.length === 0" class="edit-menu__empty">
              You don't look after any venues yet. Add one, or ask an admin to assign you.
            </p>
            <ul v-else class="edit-menu__list">
              <li v-for="venue in myVenues" :key="venue.id">
                <button type="button" class="edit-menu__item" @click="openEditVenue(venue)">
                  <span class="edit-menu__name">{{ venue.name }}</span>
                  <span class="edit-menu__meta">{{ venue.location }} · {{ venue.capacity }} people</span>
                </button>
              </li>
            </ul>
          </div>
        </div>
        </div>
        <div class="main-actions">
          <!-- E4-3: secondary action. -->
          <AppButton variant="outline" v-if="venueId !== null" type="button" @click="openBlockOut()">
            Block out time
          </AppButton>
        </div>
      </div>
    </div>

    <p v-if="venuesError" class="body-default error-text full-row">{{ venuesError }}</p>
    <p v-else-if="loadingVenues" class="body-default muted full-row">Loading venues…</p>
    <div v-else-if="venues.length === 0" class="empty-state full-row">
      <p class="empty-state__title">No venues yet</p>
      <p class="body-default muted">There are no active venues to show a schedule for.</p>
    </div>

    <template v-else>
      <section class="schedule" aria-live="polite" :aria-busy="loadingBookings">
        <!-- Two columns: the schedule (about 70%) and a bulletin of unavailable periods (about 30%), starting level with the heading. -->
        <div class="schedule__body">
          <div class="schedule__main">
        <div class="schedule__header">
          <h2 class="h5 schedule__day">
            {{ heading }}
          </h2>
          <!-- One filter for the list, the request rows and the calendar: every venue by default. -->
          <div class="range-filter" role="group" aria-label="Filter by venue and date range">
            <div class="range-filter__field">
              <span class="field-label">Venue</span>
              <VenueMultiSelect v-model="filterIds" :venues="venues" />
            </div>
            <label class="range-filter__field">
              <span class="field-label">From</span>
              <input v-model="rangeFrom" type="date" class="range-filter__input" :min="today" :max="rangeTo || undefined" />
            </label>
            <label class="range-filter__field">
              <span class="field-label">To</span>
              <input v-model="rangeTo" type="date" class="range-filter__input" :min="rangeFrom || today" />
            </label>
            <button v-if="rangeActive" type="button" class="link-button" @click="rangeFrom = ''; rangeTo = ''">
              Clear dates
            </button>
          </div>
        </div>

        <p v-if="notice" class="notice" :class="{ 'notice--warning': notice.warning }" role="status">
          {{ notice.text }}
        </p>
        <p v-if="periodsError" class="body-default error-text">{{ periodsError }}</p>

        <div class="tabs" role="tablist" aria-label="Booking status">
          <button v-for="tab in TABS" :id="`tab-${tab.key}`" :key="tab.key" type="button" role="tab" class="tab"
            :class="{ 'tab--active': activeTab === tab.key }" :aria-selected="activeTab === tab.key"
            aria-controls="schedule-panel" :tabindex="activeTab === tab.key ? 0 : -1" @click="activeTab = tab.key">
            {{ tab.label }} ({{ tabCounts[tab.key] }})
          </button>
        </div>

        <!-- Long lists scroll inside this area instead of paging. -->
        <div id="schedule-panel" class="schedule__scroll" role="tabpanel" :aria-labelledby="`tab-${activeTab}`" tabindex="0">
          <!-- Requests and On Hold: the decision queue (hold, approve, reject), venue- and date-filtered. -->
          <template v-if="isDecisionTab">
            <label v-if="overdueCount > 0 || showOverdue" class="overdue-toggle">
              <input v-model="showOverdue" type="checkbox" />
              Include requests for dates that have passed<template v-if="!showOverdue"> ({{ overdueCount }})</template>
            </label>
            <p v-if="pendingError" class="body-default error-text" role="alert">{{ pendingError }}</p>
            <p v-else-if="pendingLoading" class="body-default muted">Loading booking requests…</p>
            <div v-else-if="tabPending.length === 0" class="empty-state">
              <p class="empty-state__title">Nothing here</p>
              <p class="body-default muted">{{ activeTabConfig.empty }}</p>
            </div>
            <VenueRequestRows v-else :requests="tabPending" @decided="onDecided" />
          </template>

          <!-- Bookings: approved bookings, read-only. -->
          <template v-else>
            <p v-if="bookingsError" class="body-default error-text">{{ bookingsError }}</p>
            <p v-else-if="loadingBookings && bookings.length === 0" class="body-default muted">Loading bookings…</p>
            <div v-else-if="tabBookings.length === 0" class="empty-state" :class="{ 'is-stale': loadingBookings }">
              <p class="empty-state__title">Nothing here</p>
              <p class="body-default muted">{{ activeTabConfig.empty }}</p>
            </div>
            <ul v-else class="rows" :class="{ 'is-stale': loadingBookings }">
            <li class="rows__head" aria-hidden="true">
              <span>Date</span><span>Time</span><span>Event</span><span>Attendance</span><span />
            </li>
            <li v-for="booking in tabBookings" :key="`${booking.venueId}-${booking.id}`" class="row">
              <div class="row__main">
                <span class="row__date">{{ formatRowDate(booking.date) }}</span>
                <span class="row__time">{{ formatTimeRange(booking.startTime, booking.endTime) }}</span>
                <span class="row__event">
                  <span class="row__name">{{ booking.event.name || "Untitled event" }}</span>
                  <span class="row__venue">{{ venueName(booking.venueId) }}</span>
                  <span v-if="booking.status === 'Replacement Required'" class="replacement-badge">Replacement Required</span>
                   <span v-else-if="booking.status === 'Cancelled'" class="replacement-badge">Cancelled — venue unavailable</span>
                </span>
                <!-- E4-17: set up for this booking's own session, not the whole event. -->
                <span class="row__people">
                  {{ formatAttendance(booking.setup ? booking.setup.headcount : booking.event.expectedAttendance) }}
                  <span v-if="booking.setup" class="row__purpose">{{ booking.setup.purpose }}</span>
                </span>
                <button type="button" class="link-button row__toggle" :aria-expanded="expanded.has(booking.id)"
                  :aria-controls="`details-${booking.venueId}-${booking.id}`" @click="toggleDetails(booking.id)">
                  {{ expanded.has(booking.id) ? "Hide details" : "Details" }}
                </button>
              </div>
              <dl v-if="expanded.has(booking.id)" :id="`details-${booking.venueId}-${booking.id}`" class="row__details">
                <div class="detail">
                  <dt class="detail__label">Layout</dt>
                  <dd v-if="(booking.setup ?? booking.event).layouts.length > 0" class="detail__value">
                    {{ (booking.setup ?? booking.event).layouts.join(", ") }}
                  </dd>
                  <dd v-else class="body-small muted">Not specified</dd>
                </div>
                <div class="detail">
                  <dt class="detail__label">Facility requirements</dt>
                  <dd v-if="(booking.setup ?? booking.event).facilities.length > 0" class="tags">
                    <span v-for="facility in (booking.setup ?? booking.event).facilities" :key="facility" class="tag">
                      {{ facility }}
                    </span>
                  </dd>
                  <dd v-else class="body-small muted">None specified</dd>
                </div>
              </dl>
            </li>
          </ul>
          </template>

        </div>
          </div>

          <!-- E4-3 AC1: block-outs, so an unavailable day is obvious whichever tab is open. -->
          <aside class="schedule__aside" aria-label="Unavailable periods">
            <h3 class="aside__title">Unavailable <span class="muted">({{ visiblePeriods.length }})</span></h3>
            <ul v-if="visiblePeriods.length > 0" class="booking-list block-list">
              <li v-for="period in visiblePeriods" :key="period.id">
                <UnavailabilityCard compact :period="period" :venue-name="venueName(period.venueId)"
                  :removing="removingId === period.id" @edit="openBlockOut(period)" @remove="removePeriod(period)" />
              </li>
            </ul>
            <p v-else class="body-default muted">{{ filterIds === null ? "All your venues are available." : "All the selected venues are available." }}</p>
          </aside>
        </div>
      </section>

      <!-- E1-5: everything booked into the staff member's venues, up to four at once. Its venue filter also narrows the lists below. -->
      <section class="full-row" aria-label="Venue calendar">
        <!-- Until a venue or a date range is chosen the list above covers everything and the calendar stays empty. -->
        <VenueCalendar ref="venueCalendar" :venues="calendarActive ? calendarVenues : []" :total="scopeIds.length"
          :day="rangeFrom || undefined" :from="rangeFrom || undefined" :to="rangeTo || undefined"
          :prompt="calendarActive ? undefined : 'Choose a venue or a date range above to see it on the calendar.'"
          @show-requests="showRequests" />
      </section>

      <!-- E4-13 AC2/AC3: persistent, self-reconciling — distinct from VenueFormPanel's one-shot edit warning. -->
      <section class="overlap-review-row">
        <BufferOverlapList :overlaps="bufferOverlaps" :loading="bufferOverlapsLoading" :load-error="bufferOverlapsError" />
      </section>
    </template>

    <BlockOutPanel v-if="panelOpen && venueId !== null" :key="editingPeriod?.id ?? 'new'" :venue-id="venueId"
      :venues="venues" :initial-date="today" :period="editingPeriod"
      @close="closeBlockOut" @saved="onBlockOutSaved" />

    <VenueFormPanel v-if="venueFormOpen" :key="editingVenue?.id ?? 'new'" :venue="editingVenue"
      @close="closeVenueForm" @created="onVenueCreated" @updated="onVenueUpdated" />
  </div>
</template>

<style scoped>
.page {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  gap: var(--spacing-24) var(--grid-desktop-gutter);
  padding: var(--spacing-40) var(--grid-desktop-margin);
  align-content: start;
}

.page-header,
.full-row {
  grid-column: 1 / 13;
  margin-bottom:8px;
}

.schedule {
  grid-column: 1 / 13;
  min-width: 0;
}

/* E4-13: full-width row below the sidebar+schedule pair, same convention as .full-row. */
.overlap-review-row {
  grid-column: 1 / 13;
  margin-top: var(--spacing-8);
}

@media (max-width: 1024px) {
  .page {
    grid-template-columns: repeat(6, 1fr);
    padding: var(--spacing-32) var(--grid-tablet-margin);
  }

  .page-header,
  .full-row,
  .schedule,
  .overlap-review-row {
    grid-column: 1 / 7;
  }
}

@media (max-width: 640px) {
  .page {
    grid-template-columns: repeat(4, 1fr);
    column-gap: var(--grid-mobile-gutter);
    padding: var(--spacing-24) var(--grid-mobile-margin);
  }

  .page-header,
  .full-row,
  .schedule,
  .overlap-review-row {
    grid-column: 1 / 5;
  }
}

.h2 {
  font-size: 2.25rem;
  font-weight: 700;
  line-height: 2.625rem;
  color: var(--color-grey-900);
  margin: 0;
}

.h5 {
  font-size: 1.5rem;
  font-weight: 700;
  line-height: 2rem;
  color: var(--color-grey-900);
  margin: 0;
}

.subheading {
  font-size: 1.125rem;
  font-weight: 400;
  line-height: 1.375rem;
  color: var(--color-grey-500);
  margin: var(--spacing-8) 0 0;
}

.body-default {
  font-size: 1rem;
  line-height: 1.25rem;
}

.body-small {
  font-size: 0.875rem;
  line-height: 1.125rem;
}

.muted {
  color: var(--color-grey-500);
}

.error-text {
  color: var(--color-error-600);
}

.schedule__header {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--spacing-16);
  margin-bottom: var(--spacing-16);
}

/* Tabs: Style.md 2.4 — Purple 600 marks the active tab. */
.tabs {
  display: flex;
  gap: var(--spacing-24);
  margin-bottom: var(--spacing-16);
  border-bottom: 1px solid var(--color-grey-100);
}

.tab {
  margin-bottom: -1px;
  padding: var(--spacing-8) 0;
  border: none;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: var(--color-grey-500);
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  cursor: pointer;
}

.tab:hover {
  color: var(--color-grey-800);
}

.tab--active,
.tab--active:hover {
  border-bottom-color: var(--color-purple-600);
  color: var(--color-purple-600);
}

.schedule__day {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: var(--spacing-8);
}

.schedule__count {
  font-weight: 400;
}

.rows {
  margin: 0;
  padding: 0;
  list-style: none;
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-sm);
  background: var(--color-base-white);
}

.rows__head {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--color-base-white);
}

.rows__head,
.row__main {
  display: grid;
  grid-template-columns: 7rem 7.5rem minmax(0, 1fr) 11rem 6rem;
  align-items: center;
  gap: var(--spacing-16);
  padding: var(--spacing-12) var(--spacing-16);
}

.rows__head {
  border-bottom: 1px solid var(--color-grey-100);
  font-size: 0.75rem;
  font-weight: 700;
  color: var(--color-grey-500);
}

.row + .row {
  border-top: 1px solid var(--color-grey-100);
}

.row__main {
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-900);
}

.row__date {
  font-weight: 700;
}

.row__event {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.row__name {
  overflow: hidden;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.row__venue,
.row__purpose {
  color: var(--color-grey-500);
  font-size: 0.75rem;
}

.row__people {
  display: flex;
  flex-direction: column;
}

.row__toggle {
  justify-self: end;
}

.row__details {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--spacing-16);
  margin: 0;
  padding: var(--spacing-12) var(--spacing-16) var(--spacing-16);
  background: var(--color-grey-25);
}

@media (max-width: 640px) {
  .rows__head {
    display: none;
  }

  .row__main {
    grid-template-columns: 1fr auto;
  }

  .row__event {
    grid-column: 1 / 3;
  }

  .row__details {
    grid-template-columns: 1fr;
  }
}

.range-filter {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  justify-content: flex-end;
  gap: var(--spacing-12);
}

.range-filter__field {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-4);
}

.range-filter__input {
  height: 40px;
  padding: 0 var(--spacing-12);
  border: 1px solid var(--color-grey-200);
  border-radius: var(--radius-xs);
  background: var(--color-base-white);
  color: var(--color-grey-900);
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
}

.range-filter__input:focus {
  outline: none;
  border-color: var(--ring-brand);
  box-shadow: 0 0 0 4px var(--ring-light);
}

.link-button {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-purple-600);
  font-family: var(--font-family-lato);
  font-size: 0.875rem;
  font-weight: 700;
  cursor: pointer;
}

.link-button:focus-visible {
  outline: 2px solid var(--ring-brand);
  outline-offset: 2px;
}

.is-stale {
  opacity: 0.6;
  transition: opacity 0.15s;
}

.booking-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-16);
  list-style: none;
  margin: 0;
  padding: 0;
}

/* Expanded row details sit in a local 2-col grid (.row__details); mobile collapses it to 1 col. */
.detail {
  min-width: 0;
}

.detail__label {
  margin-bottom: var(--spacing-4);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  color: var(--color-grey-500);
}

.detail__value {
  margin: 0;
  font-size: 1rem;
  font-weight: 700;
  line-height: 1.25rem;
  color: var(--color-grey-900);
}

.detail dd {
  margin: 0;
}

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-4);
}

.tag {
  padding: var(--spacing-2) var(--spacing-8);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-xs);
  background: var(--color-base-white);
  color: var(--color-grey-700);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: var(--spacing-40) var(--spacing-24);
  background: var(--color-grey-50);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-sm);
}

.empty-state__title {
  margin: 0 0 var(--spacing-8);
  font-size: 1.25rem;
  font-weight: 700;
  line-height: 1.75rem;
  color: var(--color-grey-900);
}

/* ---- E4-3: block-out periods ---- */

.page-header--with-action {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--spacing-16);
}

.header-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--spacing-8);
}

/* Add new venue, Edit venue and Block out time sit on one line (they wrap only when the screen is too narrow). */
.venue-actions,
.main-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-8);
}

/* E4-1: "Edit venue" menu of the staff member's own venues. */
.edit-menu {
  position: relative;
}

.edit-menu__trigger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-4);
}

.edit-menu__chevron {
  width: var(--spacing-16);
  height: var(--spacing-16);
}

/* Sits flush under the trigger (padding-top bridges the gap) so moving the pointer into it keeps it open. */
.edit-menu__popover {
  position: absolute;
  top: 100%;
  right: 0;
  z-index: 30;
  width: 280px;
  max-width: calc(100vw - 2 * var(--grid-mobile-margin));
  padding-top: var(--spacing-4);
}

.edit-menu__heading,
.edit-menu__empty,
.edit-menu__list {
  margin: 0;
  background: var(--color-base-white);
  border-left: 1px solid var(--color-grey-100);
  border-right: 1px solid var(--color-grey-100);
}

.edit-menu__heading {
  padding: var(--spacing-12) var(--spacing-16) var(--spacing-4);
  border-top: 1px solid var(--color-grey-100);
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
  color: var(--color-grey-500);
}

.edit-menu__empty,
.edit-menu__list {
  border-bottom: 1px solid var(--color-grey-100);
  border-radius: 0 0 var(--radius-sm) var(--radius-sm);
  box-shadow: var(--shadow-popover);
}

.edit-menu__empty {
  padding: var(--spacing-8) var(--spacing-16) var(--spacing-12);
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-500);
}

.edit-menu__list {
  max-height: 320px;
  overflow-y: auto;
  padding: var(--spacing-4) 0 var(--spacing-8);
  list-style: none;
}

.edit-menu__item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 100%;
  padding: var(--spacing-8) var(--spacing-16);
  border: none;
  background: transparent;
  font-family: var(--font-family-lato);
  text-align: left;
  cursor: pointer;
}

.edit-menu__item:hover,
.edit-menu__item:focus-visible {
  background: var(--color-grey-75);
  outline: none;
}

.edit-menu__name {
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.125rem;
  color: var(--color-grey-900);
}

.edit-menu__meta {
  font-size: 0.75rem;
  line-height: 1rem;
  color: var(--color-grey-500);
}

.notice {
  margin: 0 0 var(--spacing-16);
  padding: var(--spacing-12) var(--spacing-16);
  border: 1px solid var(--color-grey-100);
  border-radius: var(--radius-xs);
  background: var(--color-grey-50);
  font-size: 0.875rem;
  line-height: 1.125rem;
  color: var(--color-grey-700);
}

.notice--warning {
  border-color: var(--color-warning-300);
  background: var(--color-warning-100);
  color: var(--color-warning-900);
}

.schedule__body {
  display: grid;
  /* About 70/30: the bulletin gets room for its notes, the schedule keeps most of the width. */
  grid-template-columns: minmax(0, 7fr) minmax(18rem, 3fr);
  gap: var(--spacing-24);
  align-items: start;
}

.schedule__main {
  min-width: 0;
}

.overdue-toggle {
  display: flex;
  align-items: center;
  gap: var(--spacing-8);
  margin-bottom: var(--spacing-8);
  font-size: 0.875rem;
  color: var(--color-grey-700);
  cursor: pointer;
}

.overdue-toggle input {
  accent-color: var(--color-purple-600);
}

/* Both columns scroll at the same height, so the bulletin and the list stay level. */
.schedule__scroll,
.block-list {
  max-height: 34rem;
  overflow-y: auto;
}

/* The bulletin keeps its own height so a long list of block-outs scrolls instead of pushing the page. */
.schedule__aside {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-12);
  min-width: 0;
}

.aside__title {
  margin: 0;
  font-size: 1.5rem;
  font-weight: 700;
  line-height: 2rem;
  color: var(--color-grey-900);
}

@media (max-width: 1024px) {
  .schedule__body {
    grid-template-columns: minmax(0, 1fr);
  }

}

/* Style.md 3.5: Replacement Required badge. */
.replacement-badge {
  display: inline-block;
  margin-bottom: var(--spacing-8);
  padding: var(--spacing-2) var(--spacing-8);
  border: 1px solid var(--color-warning-300);
  border-radius: var(--radius-full);
  background: var(--color-warning-200);
  color: var(--color-warning-900);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1rem;
}
</style>
