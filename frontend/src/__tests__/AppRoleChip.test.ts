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
    { path: "/attendee/discover", name: "attendee-discover", component: { render: () => h("div") } },
    { path: "/coordinator", name: "coordinator-workload", component: { render: () => h("div") } },
    { path: "/all-events", name: "all-events", component: { render: () => h("div") } },
    { path: "/lead", name: "lead-dashboard", component: { render: () => h("div") } },
    { path: "/lead/unassigned", name: "lead-unassigned", component: { render: () => h("div") } },
    { path: "/lead/coordinators/:id", name: "lead-coordinator", component: { render: () => h("div") } },
    { path: "/venue-availability", name: "venue-availability", component: { render: () => h("div") } },
    { path: "/equipment-requests", name: "equipment-requests", component: { render: () => h("div") } },
    {
      path: "/equipment-requests/event/:eventId",
      name: "equipment-request-detail",
      component: { render: () => h("div") },
    },
    { path: "/equipment-inventory", name: "equipment-inventory", component: { render: () => h("div") } },
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
  // The role pill now only renders inside the account dropdown, closed by default.
  await wrapper.find(".account-trigger").trigger("click");
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

describe("Technical Support's nav links", () => {
  it("offers Requests and Inventory", async () => {
    const wrapper = await mountAs("technical_support");

    expect(wrapper.findAll(".nav__tab").map((link) => link.text())).toEqual(["Requests", "Inventory"]);
  });

  it("marks only the current page's link, and keeps Requests current on a request's detail page", async () => {
    const wrapper = await mountAs("technical_support");

    await router.push("/equipment-inventory");
    await flushPromises();
    expect(wrapper.find(".nav__tab--active").text()).toBe("Inventory");
    expect(wrapper.findAll(".nav__tab--active")).toHaveLength(1);

    await router.push("/equipment-requests/event/7");
    await flushPromises();
    expect(wrapper.find(".nav__tab--active").text()).toBe("Requests");
    expect(wrapper.find(".nav__tab--active").attributes("aria-current")).toBe("page");
    expect(wrapper.findAll(".nav__tab--active")).toHaveLength(1);
  });
});

describe("notification bell visibility", () => {
  // E7-1 (#61) AC2: shown unconditionally, for every role — venue staff
  // included, since they're notified on E4-9 withdrawals/releases.
  it.each(["coordinator", "technical_support", "organiser", "venue_staff", "attendee"])(
    "shows it for %s",
    async (role) => {
      const wrapper = await mountAs(role);
      expect(wrapper.find("notification-bell-stub").exists()).toBe(true);
    },
  );
});

describe("top navigation for the coordinator roles", () => {
  const tabLabels = (wrapper: Awaited<ReturnType<typeof mountAs>>) =>
    wrapper.findAll("nav a").map((a) => a.text().trim());

  it("gives a coordinator My events, All events and Venue Availability", async () => {
    const wrapper = await mountAs("coordinator");
    expect(tabLabels(wrapper)).toEqual(["My events", "All events", "Venue Availability"]);
  });

  it("gives the Coordinator Lead a Dashboard and an All events tab", async () => {
    const wrapper = await mountAs("coordinator_lead");
    expect(tabLabels(wrapper)).toEqual(["Dashboard", "All events"]);
  });
});
