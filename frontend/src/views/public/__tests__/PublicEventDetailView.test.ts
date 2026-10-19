import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { h } from "vue";
import PublicEventDetailView from "../PublicEventDetailView.vue";
import {
  PublicEventNotFoundError,
  fetchPublicEvent,
  fetchPublicEventVenues,
  type PublicEvent,
} from "../../../lib/publicApi";

vi.mock("../../../lib/publicApi", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/publicApi")>("../../../lib/publicApi");
  return {
    PublicEventNotFoundError: actual.PublicEventNotFoundError,
    fetchPublicEvent: vi.fn(),
    fetchPublicEventVenues: vi.fn(),
  };
});

const mockedEvent = vi.mocked(fetchPublicEvent);
const mockedVenues = vi.mocked(fetchPublicEventVenues);

const stub = { render: () => h("div") };
const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/welcome", name: "welcome", component: stub },
    { path: "/login", name: "login", component: stub },
    { path: "/signup", name: "signup", component: stub },
    { path: "/explore/events", name: "public-events", component: stub },
    { path: "/explore/events/:id", name: "public-event-detail", component: stub },
    { path: "/explore/venues", name: "public-venues", component: stub },
  ],
});

function publicEvent(overrides: Partial<PublicEvent> = {}): PublicEvent {
  return {
    id: 12,
    name: "Campus Fair",
    description: "Stalls and food.\n\nBring a friend.",
    proposedDate: "2099-01-01",
    startTime: "10:00",
    endTime: "16:00",
    accessibility: "Step-free entry.",
    organiserName: "Pat Organiser",
    registrationState: "OPEN",
    open: true,
    ...overrides,
  };
}

async function mountView() {
  await router.push("/explore/events/12");
  await router.isReady();
  const wrapper = mount(PublicEventDetailView, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedVenues.mockResolvedValue(new Map([[12, ["Main Hall"]]]));
});

describe("PublicEventDetailView", () => {
  it("shows the event to a guest: name, description, date, time, venue, organiser and accessibility", async () => {
    mockedEvent.mockResolvedValue(publicEvent());
    const wrapper = await mountView();

    expect(mockedEvent).toHaveBeenCalledWith("12");
    const text = wrapper.text();
    expect(text).toContain("Campus Fair");
    expect(text).toContain("Bring a friend.");
    expect(text).toContain("1 January 2099");
    expect(text).toContain("10:00 AM to 4:00 PM");
    expect(text).toContain("Main Hall");
    expect(text).toContain("Pat Organiser");
    expect(text).toContain("Step-free entry.");
  });

  it("has no way to register as a guest: Register sends them to sign up, then back to the event", async () => {
    mockedEvent.mockResolvedValue(publicEvent());
    const wrapper = await mountView();

    expect(wrapper.find("[data-testid='guest-register-note']").text()).toContain("Guest registration isn't available");
    const links = wrapper.findAll(".register-panel a");
    const signup = links.find((a) => a.text() === "Sign up to register")!;
    const login = links.find((a) => a.text() === "Log in to register")!;
    expect(signup.attributes("href")).toBe("/signup?redirect=/attendee/events/12");
    expect(login.attributes("href")).toBe("/login?redirect=/attendee/events/12");
    expect(wrapper.findAll(".register-panel button")).toHaveLength(0);
  });

  it("says registration is closed, with no sign-up prompt, once it has closed", async () => {
    mockedEvent.mockResolvedValue(publicEvent({ registrationState: "CLOSED", open: false }));
    const wrapper = await mountView();

    expect(wrapper.find("[data-testid='registration-closed']").exists()).toBe(true);
    expect(wrapper.text()).not.toContain("Sign up to register");
    expect(wrapper.find(".badge").text()).toBe("Registration closed");
  });

  it("shows a not-available notice, and nothing about the event, when it isn't listed", async () => {
    mockedEvent.mockRejectedValue(new PublicEventNotFoundError("Event not found"));
    const wrapper = await mountView();

    expect(wrapper.find("[role='alert']").text()).toContain("This event isn't available");
    expect(wrapper.find(".register-panel").exists()).toBe(false);
    expect(mockedVenues).not.toHaveBeenCalled();
  });

  it("still shows the event when the venue lookup fails", async () => {
    mockedEvent.mockResolvedValue(publicEvent());
    mockedVenues.mockRejectedValue(new Error("down"));
    const wrapper = await mountView();

    expect(wrapper.text()).toContain("Campus Fair");
    expect(wrapper.text()).toContain("To be confirmed");
  });
});
