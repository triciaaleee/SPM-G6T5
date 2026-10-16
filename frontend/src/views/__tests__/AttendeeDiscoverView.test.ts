import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { h } from "vue";
import AttendeeDiscoverView from "../AttendeeDiscoverView.vue";
import { fetchOpenEvents, type OpenEvent } from "../../lib/registrationApi";

vi.mock("../../lib/registrationApi", () => ({ fetchOpenEvents: vi.fn() }));

const mockedOpen = vi.mocked(fetchOpenEvents);

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", component: { render: () => h("div") } },
    { path: "/attendee/events/:id", name: "attendee-event-detail", component: { render: () => h("div") } },
  ],
});

function openEvent(overrides: Partial<OpenEvent> = {}): OpenEvent {
  return {
    id: 1,
    name: "Career Networking Night",
    description: "Talk to employers and alumni.",
    proposedDate: "2026-11-19",
    startTime: "18:30",
    endTime: "21:00",
    accessibility: null,
    registrationStatus: null,
    ...overrides,
  };
}

async function mountView() {
  const wrapper = mount(AttendeeDiscoverView, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AttendeeDiscoverView", () => {
  it("lists open events soonest first, with a count", async () => {
    mockedOpen.mockResolvedValue([
      openEvent({ id: 2, name: "Later", proposedDate: "2026-12-04" }),
      openEvent({ id: 1, name: "Sooner", proposedDate: "2026-11-19" }),
    ]);
    const wrapper = await mountView();

    expect(wrapper.findAll(".card-title").map((t) => t.text())).toEqual(["Sooner", "Later"]);
    expect(wrapper.text()).toContain("Showing 2 events");
  });

  it("makes the whole card a link to the event, never a Register button or capacity info", async () => {
    mockedOpen.mockResolvedValue([openEvent()]);
    const wrapper = await mountView();

    expect(wrapper.text()).not.toContain("Register");
    expect(wrapper.text()).not.toContain("View details");
    expect(wrapper.text()).not.toMatch(/places left|Full/);
    expect(wrapper.find("[role='img']").exists()).toBe(false);
    const card = wrapper.find("a.card");
    expect(card.attributes("href")).toBe("/attendee/events/1");
  });

  it("badges an unregistered event Open and a registered one Registered", async () => {
    mockedOpen.mockResolvedValue([
      openEvent({ id: 1, registrationStatus: null }),
      openEvent({ id: 2, registrationStatus: "Registered", proposedDate: "2026-12-01" }),
    ]);
    const wrapper = await mountView();

    const badges = wrapper.findAll(".badge");
    expect(badges[0].text()).toBe("Open");
    expect(badges[1].text()).toBe("Registered");
    expect(badges[1].classes()).toContain("status-success");
  });

  it("shows an empty message when nothing is open", async () => {
    mockedOpen.mockResolvedValue([]);
    const wrapper = await mountView();

    expect(wrapper.text()).toContain("No events are open for registration right now");
  });

  it("shows an error when loading fails", async () => {
    mockedOpen.mockRejectedValue(new Error("boom"));
    const wrapper = await mountView();

    expect(wrapper.find("[role='alert']").text()).toContain("couldn't load events");
  });
});
