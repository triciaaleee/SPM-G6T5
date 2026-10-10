import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { h } from "vue";
import AttendeeEventDetailView from "../AttendeeEventDetailView.vue";
import {
  AccessDeniedError,
  RegistrationRequestError,
  fetchAttendeeEventView,
  withdraw,
  type AttendeeEventView,
} from "../../lib/registrationApi";

vi.mock("../../lib/registrationApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/registrationApi")>("../../lib/registrationApi");
  return {
    AccessDeniedError: actual.AccessDeniedError,
    RegistrationRequestError: actual.RegistrationRequestError,
    fetchAttendeeEventView: vi.fn(),
    withdraw: vi.fn(),
  };
});

const mockedView = vi.mocked(fetchAttendeeEventView);
const mockedWithdraw = vi.mocked(withdraw);

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/attendee/events", name: "attendee-events", component: { render: () => h("div") } },
    { path: "/attendee/events/:id", name: "attendee-event-detail", component: { render: () => h("div") } },
  ],
});

function eventView(overrides: Partial<AttendeeEventView> = {}): AttendeeEventView {
  return {
    id: 1,
    name: "Freshman Orientation Fair",
    description: "Meet clubs and new friends.\n\nIf it rains, the fair moves indoors.",
    proposedDate: "2026-11-14",
    startTime: "10:00",
    endTime: "16:00",
    venues: ["Great Lawn", "Sports Hall (rain site)"],
    accessibility: "Step-free entry and a hearing loop.",
    registrationStatus: "Registered",
    open: false,
    ...overrides,
  };
}

async function mountView() {
  await router.push("/attendee/events/1");
  await router.isReady();
  const wrapper = mount(AttendeeEventDetailView, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AttendeeEventDetailView", () => {
  it("loads the event named in the route", async () => {
    mockedView.mockResolvedValue(eventView());
    await mountView();

    expect(mockedView).toHaveBeenCalledWith("1");
  });

  it("shows the event's name, description, date, time, venues and accessibility", async () => {
    mockedView.mockResolvedValue(eventView());
    const wrapper = await mountView();

    expect(wrapper.find("h1").text()).toBe("Freshman Orientation Fair");
    expect(wrapper.findAll(".description p").map((p) => p.text())).toEqual([
      "Meet clubs and new friends.",
      "If it rains, the fair moves indoors.",
    ]);
    const details = wrapper.find(".details").text();
    expect(details).toContain("14 November 2026");
    expect(details).not.toContain("Saturday");
    expect(details).toContain("10:00 AM to 4:00 PM");
    expect(details).toContain("Great Lawn");
    expect(details).toContain("Sports Hall (rain site)");
    expect(details).toContain("Step-free entry and a hearing loop.");
  });

  it("shows the attendee's own status in a badge with no dot", async () => {
    mockedView.mockResolvedValue(eventView());
    const wrapper = await mountView();

    const badge = wrapper.find(".badge");
    expect(badge.text()).toBe("Registered");
    expect(badge.classes()).toContain("status-success");
    expect(badge.element.children).toHaveLength(0);
  });

  it("omits the accessibility row when there is no note, and falls back when there is no venue", async () => {
    mockedView.mockResolvedValue(eventView({ accessibility: null, venues: [] }));
    const wrapper = await mountView();

    expect(wrapper.find(".details").text()).not.toContain("Accessibility");
    expect(wrapper.find(".details").text()).toContain("Venue to be confirmed");
  });

  it("offers Withdraw registration only while registered, and never a Register button", async () => {
    mockedView.mockResolvedValue(eventView());
    const registered = await mountView();
    expect(registered.findAll("button").map((b) => b.text())).toEqual(["Withdraw registration"]);

    mockedView.mockResolvedValue(eventView({ registrationStatus: "Withdrawn" }));
    const withdrawn = await mountView();
    expect(withdrawn.findAll("button")).toHaveLength(0);

    mockedView.mockResolvedValue(eventView({ registrationStatus: null, open: true }));
    const unregistered = await mountView();
    expect(unregistered.findAll("button")).toHaveLength(0);
    expect(unregistered.find(".badge").exists()).toBe(false);
  });

  it("withdraws and flips the badge in place", async () => {
    mockedView.mockResolvedValue(eventView());
    mockedWithdraw.mockResolvedValue(undefined);
    const wrapper = await mountView();

    await wrapper.find("button").trigger("click");
    await flushPromises();

    expect(mockedWithdraw).toHaveBeenCalledWith("1");
    expect(wrapper.find(".badge").text()).toBe("Withdrawn");
    expect(wrapper.find(".badge").classes()).toContain("status-warning");
    expect(wrapper.findAll("button")).toHaveLength(0);
  });

  it("disables the button while withdrawing", async () => {
    mockedView.mockResolvedValue(eventView());
    let finish: () => void = () => {};
    mockedWithdraw.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    const wrapper = await mountView();

    await wrapper.find("button").trigger("click");

    expect(wrapper.find("button").attributes("disabled")).toBeDefined();
    expect(wrapper.find("button").text()).toBe("Withdrawing…");
    finish();
    await flushPromises();
  });

  it("shows the backend's message when withdrawing fails, and keeps the registration", async () => {
    mockedView.mockResolvedValue(eventView());
    mockedWithdraw.mockRejectedValue(new RegistrationRequestError("Failed to withdraw", 500, null));
    const wrapper = await mountView();

    await wrapper.find("button").trigger("click");
    await flushPromises();

    expect(wrapper.find('[role="alert"]').text()).toBe("Failed to withdraw");
    expect(wrapper.find(".badge").text()).toBe("Registered");
    expect(wrapper.find("button").attributes("disabled")).toBeUndefined();
  });

  it("treats 'already withdrawn' as withdrawn", async () => {
    mockedView.mockResolvedValue(eventView());
    mockedWithdraw.mockRejectedValue(new RegistrationRequestError("already", 409, "already_withdrawn"));
    const wrapper = await mountView();

    await wrapper.find("button").trigger("click");
    await flushPromises();

    expect(wrapper.find(".badge").text()).toBe("Withdrawn");
  });

  it("shows only a no-access message, with none of the event, when access is denied", async () => {
    mockedView.mockRejectedValue(new AccessDeniedError("denied"));
    const wrapper = await mountView();

    expect(wrapper.find('[role="alert"]').text()).toContain("You don't have access to this event");
    expect(wrapper.find(".details").exists()).toBe(false);
    expect(wrapper.find(".badge").exists()).toBe(false);
    expect(wrapper.find("button").exists()).toBe(false);
    expect(wrapper.find("a").attributes("href")).toBe("/attendee/events");
  });

  it("shows an error message when loading fails", async () => {
    mockedView.mockRejectedValue(new Error("boom"));
    const wrapper = await mountView();

    expect(wrapper.find('[role="alert"]').text()).toContain("couldn't load this event");
    expect(wrapper.find(".details").exists()).toBe(false);
  });
});
