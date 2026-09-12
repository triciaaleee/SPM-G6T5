import { createRouter, createWebHistory } from "vue-router";
import EventsListView from "../views/EventsListView.vue";
import EventDetailView from "../views/EventDetailView.vue";
import NewEventRequestView from "../views/NewEventRequestView.vue";
import LoginView from "../views/LoginView.vue";
import SignupView from "../views/SignupView.vue";
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
      path: "/events/:id",
      name: "event-detail",
      component: EventDetailView,
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

  return true;
});
