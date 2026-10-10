import { createRouter, createWebHistory } from "vue-router";
import EventsListView from "../views/EventsListView.vue";
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
import LeadDashboardView from "../views/LeadDashboardView.vue";
import { getStoredUser, isAuthenticated, landingRouteForRole } from "../lib/auth";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/login", name: "login", component: LoginView },
    { path: "/signup", name: "signup", component: SignupView },
    { path: "/", name: "events-list", component: EventsListView, meta: { requiresAuth: true } },
    {
      path: "/events/new",
      name: "new-event-request",
      component: NewEventRequestView,
      meta: { requiresAuth: true },
    },
    {
      // E2-4 AC2: resume editing a saved draft, reusing the same form.
      path: "/events/:id/edit",
      name: "edit-draft",
      component: NewEventRequestView,
      meta: { requiresAuth: true },
    },
    {
      path: "/events/:id",
      name: "event-detail",
      component: EventDetailView,
      meta: { requiresAuth: true },
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
      // E1-8: the Event Coordinator Lead's unassigned queue, plus every
      // active event and its coordinator (Week 7 change 5) as the way in
      // to a reassignment (E2-12). AC3: other roles are turned away here
      // and by the backend.
      path: "/lead",
      name: "lead-dashboard",
      component: LeadDashboardView,
      meta: { requiresAuth: true, roles: ["coordinator_lead"] },
    },
  ],
});

router.beforeEach((to) => {
  const authed = isAuthenticated();

  // AC5: any protected route reached without a session — including typing
  // the URL straight into the address bar — goes to login. The intended
  // destination rides along so the user lands where they meant to after
  // signing in, rather than being dumped on the default page.
  if (to.meta.requiresAuth && !authed) {
    return {
      name: "login",
      query: to.fullPath === "/" ? {} : { redirect: to.fullPath },
    };
  }

  // Someone already signed in has no use for the login or signup form;
  // send them to their role's landing view instead of showing a form that
  // would only re-authenticate them as the same person.
  if (authed && (to.name === "login" || to.name === "signup")) {
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

  return true;
});
