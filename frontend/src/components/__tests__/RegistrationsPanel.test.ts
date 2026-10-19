import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import RegistrationsPanel from "../RegistrationsPanel.vue";
import { fetchEventRegistrations, type EventRegistration } from "../../lib/registrationApi";

vi.mock("../../lib/registrationApi", () => ({ fetchEventRegistrations: vi.fn() }));

const mockedFetch = vi.mocked(fetchEventRegistrations);

function registration(overrides: Partial<EventRegistration> = {}): EventRegistration {
  return {
    registrationId: 1,
    eventId: 7,
    userId: "ATT-0001",
    status: "Registered",
    createdAt: "2026-10-20T02:00:00.000Z",
    additionalInfo: null,
    name: "Ana Attendee",
    ...overrides,
  };
}

async function mountPanel(capacity?: number | null) {
  const wrapper = mount(RegistrationsPanel, { props: { eventId: 7, capacity } });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RegistrationsPanel (E3-5 AC3)", () => {
  it("lists each registration with its status, including withdrawals", async () => {
    mockedFetch.mockResolvedValue([
      registration(),
      registration({ registrationId: 2, userId: "ATT-0002", name: "Ben Attendee", status: "Withdrawn" }),
    ]);
    const wrapper = await mountPanel();

    expect(mockedFetch).toHaveBeenCalledWith(7);
    const rows = wrapper.findAll(".registration-row");
    expect(rows).toHaveLength(2);
    expect(rows[0].text()).toContain("Ana Attendee");
    expect(rows[0].text()).toContain("Registered");
    expect(rows[1].text()).toContain("Withdrawn");
  });

  it("shows the registered count against capacity, with places left and a progress meter", async () => {
    mockedFetch.mockResolvedValue([
      registration(),
      registration({ registrationId: 2, userId: "ATT-0002" }),
      registration({ registrationId: 3, userId: "ATT-0003", status: "Withdrawn" }),
    ]);
    const wrapper = await mountPanel(50);

    expect(wrapper.find("[data-testid='registered-count']").text()).toBe("2 of 50 registered");
    expect(wrapper.find("[data-testid='places-left']").text()).toBe("48 places left");
    const meter = wrapper.find("[role='progressbar']");
    expect(meter.attributes("aria-valuenow")).toBe("2");
    expect(meter.attributes("aria-valuemax")).toBe("50");
    expect(wrapper.find(".meter__fill").attributes("style")).toContain("width: 4%");
  });

  it("says Full when every place is taken", async () => {
    mockedFetch.mockResolvedValue([registration(), registration({ registrationId: 2, userId: "ATT-0002" })]);
    const wrapper = await mountPanel(2);

    expect(wrapper.find("[data-testid='registered-count']").text()).toBe("2 of 2 registered");
    expect(wrapper.find("[data-testid='places-left']").text()).toBe("Full");
  });

  it("shows just the count, with no meter, when the event has no cap", async () => {
    mockedFetch.mockResolvedValue([registration()]);
    const wrapper = await mountPanel(null);

    expect(wrapper.find("[data-testid='registered-count']").text()).toBe("1 registered");
    expect(wrapper.find("[role='progressbar']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='places-left']").exists()).toBe(false);
  });

  it("breaks the numbers down by Registered and Withdrawn, and doesn't count Cancelled", async () => {
    mockedFetch.mockResolvedValue([
      registration(),
      registration({ registrationId: 2, userId: "ATT-0002", status: "Withdrawn" }),
      registration({ registrationId: 3, userId: "ATT-0003", status: "Withdrawn" }),
      registration({ registrationId: 4, userId: "ATT-0004", status: "Cancelled" }),
    ]);
    const wrapper = await mountPanel(10);

    const breakdown = wrapper.find("[data-testid='breakdown']");
    expect(breakdown.findAll(".badge").map((b) => b.text())).toEqual(["Registered 1", "Withdrawn 2"]);
    expect(breakdown.text()).not.toContain("Cancelled");
    expect(wrapper.find("[data-testid='registered-count']").text()).toBe("1 of 10 registered");
  });

  it("lists those still attending first, then withdrawn, then cancelled, and dims the rest", async () => {
    mockedFetch.mockResolvedValue([
      registration({ registrationId: 1, userId: "ATT-0001", name: "Withdrawn One", status: "Withdrawn" }),
      registration({ registrationId: 2, userId: "ATT-0002", name: "Cancelled One", status: "Cancelled" }),
      registration({ registrationId: 3, userId: "ATT-0003", name: "Attending One" }),
      registration({ registrationId: 4, userId: "ATT-0004", name: "Attending Two" }),
    ]);
    const wrapper = await mountPanel(10);

    expect(wrapper.findAll(".registration-name").map((n) => n.text())).toEqual([
      "Attending One",
      "Attending Two",
      "Withdrawn One",
      "Cancelled One",
    ]);
    const rows = wrapper.findAll(".registration-row");
    expect(rows[0].classes()).not.toContain("registration-row--inactive");
    expect(rows[2].classes()).toContain("registration-row--inactive");
    expect(rows[3].classes()).toContain("registration-row--inactive");
  });

  it("falls back to the user id when the name couldn't be looked up", async () => {
    mockedFetch.mockResolvedValue([registration({ name: null })]);
    const wrapper = await mountPanel();
    expect(wrapper.find(".registration-name").text()).toBe("ATT-0001");
  });

  it("is read-only — it offers no actions", async () => {
    mockedFetch.mockResolvedValue([registration()]);
    const wrapper = await mountPanel();
    expect(wrapper.findAll("button")).toHaveLength(0);
  });

  it("says so when no one has registered", async () => {
    mockedFetch.mockResolvedValue([]);
    const wrapper = await mountPanel();
    expect(wrapper.text()).toContain("No one has registered for this event.");
  });

  it("shows a message when the registrations can't be loaded", async () => {
    mockedFetch.mockRejectedValue(new Error("Failed to load registrations"));
    const wrapper = await mountPanel();
    expect(wrapper.text()).toContain("We couldn't load the registrations for this event.");
  });
});
