import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { h } from "vue";
import AttendeeEventDetailView from "../AttendeeEventDetailView.vue";
import {
  AccessDeniedError,
  RegistrationRequestError,
  fetchAttendeeEventView,
  register,
  withdraw,
  type AttendeeEventView,
} from "../../lib/registrationApi";
import { NOTIFICATIONS_REFRESH_EVENT } from "../../lib/notificationsApi";

vi.mock("../../lib/registrationApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/registrationApi")>("../../lib/registrationApi");
  return {
    AccessDeniedError: actual.AccessDeniedError,
    RegistrationRequestError: actual.RegistrationRequestError,
    fetchAttendeeEventView: vi.fn(),
    register: vi.fn(),
    withdraw: vi.fn(),
  };
});

const mockedView = vi.mocked(fetchAttendeeEventView);
const mockedWithdraw = vi.mocked(withdraw);
const mockedRegister = vi.mocked(register);

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
    capacity: null,
    slotsLeft: null,
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

/** Withdraw now asks first (E6-4): click Withdraw, then confirm in the dialog. */
async function withdrawAndConfirm(wrapper: Awaited<ReturnType<typeof mountView>>) {
  await wrapper.find(".actions button").trigger("click");
  await wrapper.find("[data-testid='confirm-withdraw']").trigger("click");
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
    // Accessibility sits in its own container, outside the Date/Time/Venue strip.
    expect(details).not.toContain("Step-free entry");
    expect(wrapper.find(".accessibility-note").text()).toContain("Step-free entry and a hearing loop.");
    expect(wrapper.find(".details").element.contains(wrapper.find(".accessibility-note").element)).toBe(false);
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

    expect(wrapper.find(".accessibility-note").exists()).toBe(false);
    expect(wrapper.find(".details").text()).toContain("Venue to be confirmed");
  });

  it("offers Withdraw only while registered, and Register only while open and not registered", async () => {
    mockedView.mockResolvedValue(eventView());
    const registered = await mountView();
    expect(registered.findAll(".actions button").map((b) => b.text())).toEqual(["Withdraw registration"]);

    mockedView.mockResolvedValue(eventView({ registrationStatus: "Withdrawn", open: false }));
    const withdrawnClosed = await mountView();
    expect(withdrawnClosed.findAll(".actions button")).toHaveLength(0);

    mockedView.mockResolvedValue(eventView({ registrationStatus: "Withdrawn", open: true }));
    const withdrawnOpen = await mountView();
    expect(withdrawnOpen.findAll(".actions button").map((b) => b.text())).toEqual(["Register"]);

    mockedView.mockResolvedValue(eventView({ registrationStatus: null, open: true }));
    const unregistered = await mountView();
    expect(unregistered.findAll(".actions button").map((b) => b.text())).toEqual(["Register"]);
    expect(unregistered.find(".badge").exists()).toBe(false);
  });

  it("makes Register an extra-large button", async () => {
    mockedView.mockResolvedValue(eventView({ registrationStatus: null, open: true }));
    const wrapper = await mountView();

    const button = wrapper.find(".actions button");
    expect(button.text()).toBe("Register");
    expect(button.classes()).toContain("btn--xl");
  });

  it("registers and flips the badge and button in place", async () => {
    mockedView.mockResolvedValue(eventView({ registrationStatus: null, open: true }));
    mockedRegister.mockResolvedValue(undefined);
    const wrapper = await mountView();

    await wrapper.find(".actions button").trigger("click");
    await flushPromises();

    expect(mockedRegister).toHaveBeenCalledWith("1");
    expect(wrapper.find(".badge").text()).toBe("Registered");
    expect(wrapper.findAll(".actions button").map((b) => b.text())).toEqual(["Withdraw registration"]);
  });

  it("confirms a successful registration on the page, and clears it on withdrawing", async () => {
    mockedView.mockResolvedValue(eventView({ registrationStatus: null, open: true }));
    mockedRegister.mockResolvedValue(undefined);
    mockedWithdraw.mockResolvedValue(undefined);
    const wrapper = await mountView();
    expect(wrapper.find("[data-testid='register-success']").exists()).toBe(false);

    await wrapper.find(".actions button").trigger("click");
    await flushPromises();
    const success = wrapper.find("[data-testid='register-success']");
    expect(success.attributes("role")).toBe("status");
    expect(success.text()).toContain("You're registered");

    await withdrawAndConfirm(wrapper);
    await flushPromises();
    expect(wrapper.find("[data-testid='register-success']").exists()).toBe(false);
  });

  it("asks the bell to refresh once a registration or withdrawal goes through", async () => {
    mockedView.mockResolvedValue(eventView({ registrationStatus: null, open: true }));
    mockedRegister.mockResolvedValue(undefined);
    mockedWithdraw.mockResolvedValue(undefined);
    const refreshes = vi.fn();
    window.addEventListener(NOTIFICATIONS_REFRESH_EVENT, refreshes);
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const wrapper = await mountView();

      await wrapper.find(".actions button").trigger("click");
      await flushPromises();
      vi.runAllTimers();
      expect(refreshes).toHaveBeenCalledTimes(1);

      await withdrawAndConfirm(wrapper);
      await flushPromises();
      vi.runAllTimers();
      expect(refreshes).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      window.removeEventListener(NOTIFICATIONS_REFRESH_EVENT, refreshes);
    }
  });

  it("shows no confirmation when registering fails", async () => {
    mockedView.mockResolvedValue(eventView({ registrationStatus: null, open: true }));
    mockedRegister.mockRejectedValue(new RegistrationRequestError("full", 409, "event_full"));
    const wrapper = await mountView();

    await wrapper.find(".actions button").trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-testid='register-success']").exists()).toBe(false);
  });

  it("treats already_registered as success and shows an error when the event is no longer open", async () => {
    mockedView.mockResolvedValue(eventView({ registrationStatus: null, open: true }));
    mockedRegister.mockRejectedValue(new RegistrationRequestError("dup", 409, "already_registered"));
    const dup = await mountView();
    await dup.find(".actions button").trigger("click");
    await flushPromises();
    expect(dup.find(".badge").text()).toBe("Registered");

    mockedRegister.mockRejectedValue(new RegistrationRequestError("closed", 409, "not_open"));
    const closed = await mountView();
    await closed.find(".actions button").trigger("click");
    await flushPromises();
    expect(closed.find("[role='alert']").text()).toContain("no longer open");
    expect(closed.findAll(".actions button")).toHaveLength(0);
  });

  it("shows slots left, and none when the event has no cap", async () => {
    mockedView.mockResolvedValue(eventView({ capacity: 50, slotsLeft: 12 }));
    const capped = await mountView();
    expect(capped.find("[data-testid='slots-left']").text()).toContain("12 slots left");

    mockedView.mockResolvedValue(eventView());
    const uncapped = await mountView();
    expect(uncapped.find("[data-testid='slots-left']").exists()).toBe(false);
  });

  it("shows a disabled Event full button instead of Register when no places are left", async () => {
    mockedView.mockResolvedValue(eventView({ registrationStatus: null, open: true, capacity: 50, slotsLeft: 0 }));
    const wrapper = await mountView();

    const buttons = wrapper.findAll(".actions button");
    expect(buttons.map((b) => b.text())).toEqual(["Event full"]);
    expect(buttons[0].attributes("disabled")).toBeDefined();
    expect(wrapper.find("[data-testid='slots-left']").text()).toContain("Full");
  });

  it("still lets a registered attendee withdraw from a full event, freeing a place", async () => {
    mockedView.mockResolvedValue(eventView({ open: true, capacity: 50, slotsLeft: 0 }));
    mockedWithdraw.mockResolvedValue(undefined);
    const wrapper = await mountView();

    await withdrawAndConfirm(wrapper);
    await flushPromises();

    expect(wrapper.find("[data-testid='slots-left']").text()).toContain("1 slot left");
    expect(wrapper.findAll(".actions button").map((b) => b.text())).toEqual(["Register"]);
  });

  it("takes a place on registering, and says so when the last one went first", async () => {
    mockedView.mockResolvedValue(eventView({ registrationStatus: null, open: true, capacity: 50, slotsLeft: 3 }));
    mockedRegister.mockResolvedValue(undefined);
    const ok = await mountView();
    await ok.find(".actions button").trigger("click");
    await flushPromises();
    expect(ok.find("[data-testid='slots-left']").text()).toContain("2 slots left");

    mockedView.mockResolvedValue(eventView({ registrationStatus: null, open: true, capacity: 50, slotsLeft: 1 }));
    mockedRegister.mockRejectedValue(new RegistrationRequestError("full", 409, "event_full"));
    const raced = await mountView();
    await raced.find(".actions button").trigger("click");
    await flushPromises();
    expect(raced.find("[role='alert']").text()).toContain("now full");
    expect(raced.findAll(".actions button").map((b) => b.text())).toEqual(["Event full"]);
  });

  it("asks before withdrawing, and keeps the place if the attendee changes their mind", async () => {
    mockedView.mockResolvedValue(eventView());
    const wrapper = await mountView();

    await wrapper.find(".actions button").trigger("click");
    const dialog = wrapper.find("[role='alertdialog']");
    expect(dialog.text()).toContain("Withdraw from this event?");
    expect(dialog.text()).toContain('Your place at "Freshman Orientation Fair" will be released straight away.');
    expect(mockedWithdraw).not.toHaveBeenCalled();

    const keep = dialog.findAll("button").find((b) => b.text() === "Keep my place")!;
    await keep.trigger("click");

    expect(wrapper.find("[role='alertdialog']").exists()).toBe(false);
    expect(mockedWithdraw).not.toHaveBeenCalled();
    expect(wrapper.find(".badge").text()).toBe("Registered");
  });

  it("withdraws once confirmed, flips the badge in place and confirms on the page", async () => {
    mockedView.mockResolvedValue(eventView());
    mockedWithdraw.mockResolvedValue(undefined);
    const wrapper = await mountView();

    await withdrawAndConfirm(wrapper);
    await flushPromises();

    expect(mockedWithdraw).toHaveBeenCalledWith("1");
    expect(wrapper.find(".badge").text()).toBe("Withdrawn");
    expect(wrapper.find(".badge").classes()).toContain("status-warning");
    expect(wrapper.findAll(".actions button")).toHaveLength(0);
    expect(wrapper.find("[role='alertdialog']").exists()).toBe(false);
    const success = wrapper.find("[data-testid='withdraw-success']");
    expect(success.attributes("role")).toBe("status");
    expect(success.text()).toBe("You've withdrawn from this event. A confirmation has been sent to your notifications.");
  });

  it("disables the dialog's buttons while withdrawing", async () => {
    mockedView.mockResolvedValue(eventView());
    let finish: () => void = () => {};
    mockedWithdraw.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
    const wrapper = await mountView();

    await withdrawAndConfirm(wrapper);

    const confirm = wrapper.find("[data-testid='confirm-withdraw']");
    expect(confirm.attributes("disabled")).toBeDefined();
    expect(confirm.text()).toBe("Withdrawing…");
    finish();
    await flushPromises();
  });

  it("still offers Withdraw inside the last 5 days, once registration has closed", async () => {
    mockedView.mockResolvedValue(eventView({ open: false, registrationState: "CLOSED", hasStarted: false }));
    const wrapper = await mountView();

    expect(wrapper.findAll(".actions button").map((b) => b.text())).toEqual(["Withdraw registration"]);
  });

  it("offers no Withdraw once the event has started", async () => {
    mockedView.mockResolvedValue(eventView({ open: false, registrationState: "CLOSED", hasStarted: true }));
    const wrapper = await mountView();

    expect(wrapper.findAll(".actions button")).toHaveLength(0);
    expect(wrapper.find("[data-testid='event-started']").text()).toBe("This event has started");
  });

  it("explains, without a Withdraw button, when the backend says the event has started", async () => {
    mockedView.mockResolvedValue(eventView());
    mockedWithdraw.mockRejectedValue(new RegistrationRequestError("started", 409, "event_started"));
    const wrapper = await mountView();

    await withdrawAndConfirm(wrapper);
    await flushPromises();

    expect(wrapper.find("[role='alert']").text()).toContain("already started");
    expect(wrapper.find(".badge").text()).toBe("Registered");
    expect(wrapper.findAll(".actions button")).toHaveLength(0);
  });

  it("shows a registration the organiser cancelled as Cancelled, in red, with nothing to act on", async () => {
    mockedView.mockResolvedValue(eventView({ registrationStatus: "Cancelled", open: false }));
    const wrapper = await mountView();

    expect(wrapper.find(".badge").text()).toBe("Cancelled");
    expect(wrapper.find(".badge").classes()).toContain("status-error");
    expect(wrapper.find("[data-testid='event-cancelled']").text()).toBe("The organiser cancelled this event");
    expect(wrapper.findAll(".actions button")).toHaveLength(0);
  });

  it("shows the backend's message when withdrawing fails, and keeps the registration", async () => {
    mockedView.mockResolvedValue(eventView());
    mockedWithdraw.mockRejectedValue(new RegistrationRequestError("Failed to withdraw", 500, null));
    const wrapper = await mountView();

    await withdrawAndConfirm(wrapper);
    await flushPromises();

    expect(wrapper.find('[role="alert"]').text()).toBe("Failed to withdraw");
    expect(wrapper.find(".badge").text()).toBe("Registered");
    expect(wrapper.find(".actions button").attributes("disabled")).toBeUndefined();
  });

  it("treats 'already withdrawn' as withdrawn", async () => {
    mockedView.mockResolvedValue(eventView());
    mockedWithdraw.mockRejectedValue(new RegistrationRequestError("already", 409, "already_withdrawn"));
    const wrapper = await mountView();

    await withdrawAndConfirm(wrapper);
    await flushPromises();

    expect(wrapper.find(".badge").text()).toBe("Withdrawn");
  });

  it("shows only a no-access message, with none of the event, when access is denied", async () => {
    mockedView.mockRejectedValue(new AccessDeniedError("denied"));
    const wrapper = await mountView();

    expect(wrapper.find('[role="alert"]').text()).toContain("You don't have access to this event");
    expect(wrapper.find(".details").exists()).toBe(false);
    expect(wrapper.find(".badge").exists()).toBe(false);
    expect(wrapper.find(".actions button").exists()).toBe(false);
    expect(wrapper.find(".back-link").text()).toContain("Back");
  });

  it("shows an error message when loading fails", async () => {
    mockedView.mockRejectedValue(new Error("boom"));
    const wrapper = await mountView();

    expect(wrapper.find('[role="alert"]').text()).toContain("couldn't load this event");
    expect(wrapper.find(".details").exists()).toBe(false);
  });
});
