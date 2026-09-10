import { createRouter, createWebHistory } from "vue-router";
import EventsListView from "../views/EventsListView.vue";
import EventDetailView from "../views/EventDetailView.vue";
import LoginView from "../views/LoginView.vue";
import { supabase } from "../lib/supabase";

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/login", name: "login", component: LoginView },
    { path: "/", name: "events-list", component: EventsListView, meta: { requiresAuth: true } },
    {
      path: "/events/:id",
      name: "event-detail",
      component: EventDetailView,
      meta: { requiresAuth: true },
    },
  ],
});

router.beforeEach(async (to) => {
  if (!to.meta.requiresAuth) return true;

  const { data } = await supabase.auth.getSession();
  if (!data.session) {
    return { name: "login" };
  }
  return true;
});
