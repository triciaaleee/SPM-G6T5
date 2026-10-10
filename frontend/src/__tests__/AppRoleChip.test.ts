import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { h } from "vue";
import App from "../App.vue";
import { getStoredUser } from "../lib/auth";

vi.mock("../lib/auth", async () => {
  const actual = await vi.importActual<typeof import("../lib/auth")>("../lib/auth");
  return { ...actual, getStoredUser: vi.fn(), logout: vi.fn() };
});

const mockedUser = vi.mocked(getStoredUser);

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", name: "home", component: { render: () => h("div") } },
    { path: "/login", name: "login", component: { render: () => h("div") } },
    { path: "/attendee/events", name: "attendee-events", component: { render: () => h("div") } },
    { path: "/coordinator", name: "coordinator-workload", component: { render: () => h("div") } },
    { path: "/venue-availability", name: "venue-availability", component: { render: () => h("div") } },
  ],
});

async function mountAs(role: string) {
  mockedUser.mockReturnValue({ id: "U-1", name: "Test User", email: "t@example.com", role });
  await router.push("/");
  await router.isReady();
  const wrapper = mount(App, {
    global: { plugins: [router], stubs: { NotificationBell: true } },
  });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("role chip in the header", () => {
  it.each([
    ["attendee", "Attendee", "role-pill--attendee"],
    ["organiser", "Organiser", "role-pill--organiser"],
    ["coordinator", "Coordinator", "role-pill--coordinator"],
    ["venue_staff", "Venue staff", "role-pill--venue_staff"],
    ["technical_support", "Technical support", "role-pill--technical_support"],
  ])("gives %s its own colour class", async (role, label, className) => {
    const wrapper = await mountAs(role);

    const chip = wrapper.find(".role-pill");
    expect(chip.text()).toBe(label);
    expect(chip.classes()).toContain(className);
  });

  it("uses a different class for every role", async () => {
    const roles = ["attendee", "organiser", "coordinator", "venue_staff", "technical_support"];
    const classes: string[] = [];
    for (const role of roles) {
      const wrapper = await mountAs(role);
      classes.push(wrapper.find(".role-pill").classes().find((c) => c.startsWith("role-pill--")) ?? "");
    }

    expect(new Set(classes).size).toBe(roles.length);
  });

  it("falls back to the attendee colours for an unknown role", async () => {
    const wrapper = await mountAs("mystery");

    expect(wrapper.find(".role-pill").classes()).toContain("role-pill--attendee");
  });
});
