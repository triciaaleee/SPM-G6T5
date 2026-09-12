import { createRouter, createWebHistory } from "vue-router";
import EventsListView from "../views/EventsListView.vue";
import EventDetailView from "../views/EventDetailView.vue";
import NewEventRequestView from "../views/NewEventRequestView.vue";
import LoginView from "../views/LoginView.vue";
import SignupView from "../views/SignupView.vue";
import { isAuthenticated } from "../lib/auth";

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
  if (!to.meta.requiresAuth) return true;

  if (!isAuthenticated()) {
    return { name: "login" };
  }
  return true;
});
