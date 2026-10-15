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

async function mountPanel() {
  const wrapper = mount(RegistrationsPanel, { props: { eventId: 7 } });
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
    expect(wrapper.text()).toContain("1 registered, 1 withdrawn");
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
