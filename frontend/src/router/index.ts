import { createRouter, createWebHistory } from "vue-router";
import EventsListView from "../views/EventsListView.vue";
import AttendeeEventsView from "../views/AttendeeHomeView.vue";
import AttendeeDiscoverView from "../views/AttendeeDiscoverView.vue";
import AttendeeEventDetailView from "../views/AttendeeEventDetailView.vue";
import EventDetailView from "../views/EventDetailView.vue";
import NewEventRequestView from "../views/NewEventRequestView.vue";
import LoginView from "../views/LoginView.vue";
import SignupView from "../views/SignupView.vue";
import VenueSearchView from "../views/VenueSearchView.vue";
import VenueAvailabilityView from "../views/VenueAvailabilityView.vue";
import VenueStaff from "../views/VenueStaff.vue";
import VenueRequestQueue from "../views/VenueRequestQueue.vue";
import CoordinatorWorkloadView from "../views/CoordinatorWorkloadView.vue";
import TechnicalSupportView from "../views/TechnicalSupportView.vue";
import EquipmentRequestDetailView from "../views/EquipmentRequestDetailView.vue";
import EquipmentInventoryView from "../views/EquipmentInventoryView.vue";
import LeadDashboardView from "../views/LeadDashboardView.vue";
import LeadUnassignedQueueView from "../views/LeadUnassignedQueueView.vue";
import LeadCoordinatorView from "../views/LeadCoordinatorView.vue";
import SafetyReviewQueueView from "../views/SafetyReviewQueueView.vue";
import NotificationsView from "../views/NotificationsView.vue";
import LandingView from "../views/public/LandingView.vue";
import PublicEventsView from "../views/public/PublicEventsView.vue";
import PublicEventDetailView from "../views/public/PublicEventDetailView.vue";
import PublicVenuesView from "../views/public/PublicVenuesView.vue";
import { getStoredUser, isAuthenticated, landingRouteForRole } from "../lib/auth";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/login", name: "login", component: LoginView },
    { path: "/signup", name: "signup", component: SignupView },
    // Guest pages: anyone can browse events and venues without an account.
    // `guestOnly` sends a signed-in user to their own pages instead.
    { path: "/welcome", name: "welcome", component: LandingView, meta: { guestOnly: true } },
    { path: "/explore/events", name: "public-events", component: PublicEventsView, meta: { guestOnly: true } },
    { path: "/explore/events/:id", name: "public-event-detail", component: PublicEventDetailView, meta: { guestOnly: true } },
    { path: "/explore/venues", name: "public-venues", component: PublicVenuesView, meta: { guestOnly: true } },
    {
      path: "/",
      name: "events-list",
      component: EventsListView,
      meta: { requiresAuth: true, roles: ["organiser", "coordinator", "venue_staff", "technical_support"] },
    },
    {
      // E6: the attendee homepage — events the attendee has registered for.
      path: "/attendee/events",
      name: "attendee-events",
      component: AttendeeEventsView,
      meta: { requiresAuth: true, roles: ["attendee"] },
    },
    {
      // E6: events open for registration, to find and open before registering.
      path: "/attendee/discover",
      name: "attendee-discover",
      component: AttendeeDiscoverView,
      meta: { requiresAuth: true, roles: ["attendee"] },
    },
    {
      // E6: one event as an attendee sees it (attendee-facing fields only).
      path: "/attendee/events/:id",
      name: "attendee-event-detail",
      component: AttendeeEventDetailView,
      meta: { requiresAuth: true, roles: ["attendee"] },
    },
    {
      path: "/events/new",
      name: "new-event-request",
      component: NewEventRequestView,
      meta: { requiresAuth: true, roles: ["organiser", "coordinator"] },
    },
    {
      // E2-4 AC2: resume editing a saved draft, reusing the same form.
      path: "/events/:id/edit",
      name: "edit-draft",
      component: NewEventRequestView,
      meta: { requiresAuth: true, roles: ["organiser", "coordinator"] },
    },
    {
      path: "/events/:id",
      name: "event-detail",
      component: EventDetailView,
      // coordinator_lead: EventDetailView's own `isLead`/`canAssign` (E2-13)
      // and `canReassign` (E2-12) gate the Lead's assign/reassign panel —
      // without this role here, the Lead's card click (LeadDashboardView)
      // never reaches the page at all.
      meta: { requiresAuth: true, roles: ["organiser", "coordinator", "coordinator_lead"] },
    },
    {
      path: "/coordinator",
      name: "coordinator-workload",
      component: CoordinatorWorkloadView,
      meta: { requiresAuth: true, roles: ["coordinator"] },
    },
    {
      path: "/venues",
      name: "venue-search",
      component: VenueSearchView,
      meta: { requiresAuth: true, roles: ["coordinator"] },
    },
    {
      // E4-10: venue staff's decision queue — every request still waiting
      // on them, soonest event first.
      path: "/venue-requests",
      name: "venue-requests",
      component: VenueRequestQueue,
      meta: { requiresAuth: true, roles: ["venue_staff"] },
    },
    {
      // E4-4: venue availability calendar — when a venue could realistically
      // be requested.
      path: "/venue-availability",
      name: "venue-availability",
      component: VenueAvailabilityView,
      meta: { requiresAuth: true, roles: ["coordinator"] },
    },
    {
      // E1-5: venue staff's schedule — bookings per venue and day, limited
      // to the fields they need to set the venue up.
      path: "/venue-schedule",
      name: "venue-schedule",
      component: VenueStaff,
      meta: { requiresAuth: true, roles: ["venue_staff"] },
    },
    {
      // E5-1 AC1: Technical Support's view of every equipment request.
      path: "/equipment-requests",
      name: "equipment-requests",
      component: TechnicalSupportView,
      meta: { requiresAuth: true, roles: ["technical_support"] },
    },
    {
      // E5-1 AC1/AC2: one event's equipment requests. The backend refuses an event with none.
      path: "/equipment-requests/event/:eventId",
      name: "equipment-request-detail",
      component: EquipmentRequestDetailView,
      meta: { requiresAuth: true, roles: ["technical_support"] },
    },
    {
      // E5-1 AC3: view and update item records and availability.
      path: "/equipment-inventory",
      name: "equipment-inventory",
      component: EquipmentInventoryView,
      meta: { requiresAuth: true, roles: ["technical_support"] },
    },
    {
      // Week 7 change 5: the Event Coordinator Lead's landing page — every
      // coordinator and their active events, the way in to a reassignment
      // (E2-12). Other roles are turned away here and by the backend.
      path: "/lead",
      name: "lead-dashboard",
      component: LeadDashboardView,
      meta: { requiresAuth: true, roles: ["coordinator_lead"] },
    },
    {
      // E1-8: the Lead's unassigned queue, reached from "Assign event".
      // AC3: other roles are turned away here and by the backend.
      path: "/lead/unassigned",
      name: "lead-unassigned",
      component: LeadUnassignedQueueView,
      meta: { requiresAuth: true, roles: ["coordinator_lead"] },
    },
    {
      // One coordinator's active events ("View all N events" on the overview).
      path: "/lead/coordinators/:id",
      name: "lead-coordinator",
      component: LeadCoordinatorView,
      meta: { requiresAuth: true, roles: ["coordinator_lead"] },
    },
    {
      // E3-12/13/14: the Safety Officer's landing page.
      path: "/safety-review",
      name: "safety-review-queue",
      component: SafetyReviewQueueView,
      meta: { requiresAuth: true, roles: ["safety_officer"] },
    },
    {
      // E7-1 (#61): the full notification feed, beyond the bell's 5-item
      // preview. The bell is now on every role's header (App.vue), so no
      // role restriction here beyond being signed in.
      path: "/notifications",
      name: "notifications",
      component: NotificationsView,
      meta: { requiresAuth: true },
    },
  ],
});

router.beforeEach((to) => {
  const authed = isAuthenticated();

  // AC5: any protected route reached without a session — including typing
  // the URL straight into the address bar — goes to login. The intended
  // destination rides along so the user lands where they meant to after
  // signing in, rather than being dumped on the default page.
  // A guest opening the site's root gets the public landing page rather
  // than a login form; any other protected URL still goes to login below.
  if (to.path === "/" && !authed) {
    return { name: "welcome" };
  }

  if (to.meta.requiresAuth && !authed) {
    return {
      name: "login",
      query: to.fullPath === "/" ? {} : { redirect: to.fullPath },
    };
  }

  // Someone already signed in has no use for the login or signup form;
  // send them to their role's landing view instead of showing a form that
  // would only re-authenticate them as the same person.
  if (authed && (to.name === "login" || to.name === "signup" || to.meta.guestOnly)) {
    return { name: landingRouteForRole(getStoredUser()?.role) };
  }

  // Role-restricted screens (e.g. coordinator-only venue search). The
  // backend enforces the same rule; this just keeps other roles from
  // landing on a page whose every request would 403.
  const roles = to.meta.roles as string[] | undefined;
  if (authed && roles && !roles.includes(getStoredUser()?.role ?? "")) {
    return { name: landingRouteForRole(getStoredUser()?.role) };
  }

  // E1-5: venue staff have no events of their own, so the events list
  // would only ever be empty for them — send them to their schedule.
  if (authed && to.name === "events-list" && getStoredUser()?.role === "venue_staff") {
    return { name: "venue-schedule" };
  }

  // E5-1: Technical Support have no events of their own either — send them
  // to their equipment request queue instead of an empty events list.
  if (authed && to.name === "events-list" && getStoredUser()?.role === "technical_support") {
    return { name: "equipment-requests" };
  }

  // E3-2: coordinators have their own grouped workload view — redirect them
  // away from the organiser-oriented events list.
  if (authed && to.name === "events-list" && getStoredUser()?.role === "coordinator") {
    return { name: "coordinator-workload" };
  }

  // E1-8: the Lead organises no events — their screen is the queue.
  if (authed && to.name === "events-list" && getStoredUser()?.role === "coordinator_lead") {
    return { name: "lead-dashboard" };
  }

  // E3-12/13/14: the Safety Officer organises no events — their screen is
  // the safety review queue.
  if (authed && to.name === "events-list" && getStoredUser()?.role === "safety_officer") {
    return { name: "safety-review-queue" };
  }

  return true;
});
