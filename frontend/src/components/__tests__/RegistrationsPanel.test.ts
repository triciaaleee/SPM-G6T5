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

const tabButton = (wrapper: Awaited<ReturnType<typeof mountPanel>>, startsWith: string) =>
  wrapper.findAll(".toggle-btn").find((button) => button.text().startsWith(startsWith))!;

const names = (wrapper: Awaited<ReturnType<typeof mountPanel>>) =>
  wrapper.findAll(".registration-name").map((n) => n.text());

beforeEach(() => {
  vi.clearAllMocks();
});

describe("RegistrationsPanel (E3-5 AC3)", () => {
  it("is a title and tables with no card behind them", async () => {
    mockedFetch.mockResolvedValue([registration()]);
    const wrapper = await mountPanel(50);

    expect(wrapper.find(".section-title").text()).toBe("Registrations");
    expect(wrapper.find(".details-card").exists()).toBe(false);
    expect(wrapper.find("[role='progressbar']").exists()).toBe(false);
  });

  it("puts the toggle in the title row and the registered count and places left under them", async () => {
    mockedFetch.mockResolvedValue([registration()]);
    const wrapper = await mountPanel(300);

    const header = wrapper.find(".registrations__header");
    expect(header.find(".section-title").text()).toBe("Registrations");
    expect(header.find(".view-toggle").exists()).toBe(true);
    const order = wrapper.findAll(".registrations__header, .summary, .rows").map((el) => el.classes()[0]);
    expect(order).toEqual(["registrations__header", "summary", "rows"]);
    expect(wrapper.find("[data-testid='registered-count']").text()).toBe("1 of 300 registered");
    expect(wrapper.find("[data-testid='places-left']").text()).toBe("299 places left");
  });

  it("is a two-button toggle (not tabs)", async () => {
    mockedFetch.mockResolvedValue([registration()]);
    const wrapper = await mountPanel();

    expect(wrapper.find(".view-toggle").attributes("role")).toBe("group");
    expect(wrapper.find("[role='tab']").exists()).toBe(false);
  });

  it("marks the selected toggle button as active", async () => {
    mockedFetch.mockResolvedValue([registration()]);
    const wrapper = await mountPanel();

    expect(tabButton(wrapper, "Registered").classes()).toContain("toggle-btn--active");
    expect(tabButton(wrapper, "Withdrawn").classes()).not.toContain("toggle-btn--active");
    await tabButton(wrapper, "Withdrawn").trigger("click");
    expect(tabButton(wrapper, "Withdrawn").classes()).toContain("toggle-btn--active");
    expect(tabButton(wrapper, "Registered").classes()).not.toContain("toggle-btn--active");
  });

  it("opens on the Registered tab and lists only the people who are registered", async () => {
    mockedFetch.mockResolvedValue([
      registration(),
      registration({ registrationId: 2, userId: "ATT-0002", name: "Ben Attendee", status: "Withdrawn" }),
    ]);
    const wrapper = await mountPanel();

    expect(mockedFetch).toHaveBeenCalledWith(7);
    expect(tabButton(wrapper, "Registered").attributes("aria-pressed")).toBe("true");
    // Header row + one row per person (the shared DataTable).
    expect(wrapper.find(".row--header").text()).toContain("Registered on");
    expect(wrapper.findAll(".row-item")).toHaveLength(1);
    expect(names(wrapper)).toEqual(["Ana Attendee"]);
    expect(wrapper.find(".row-item").text()).toContain("Registered");
  });

  it("shows the withdrawn people on the Withdrawn tab", async () => {
    mockedFetch.mockResolvedValue([
      registration(),
      registration({ registrationId: 2, userId: "ATT-0002", name: "Ben Attendee", status: "Withdrawn" }),
    ]);
    const wrapper = await mountPanel();

    await tabButton(wrapper, "Withdrawn").trigger("click");

    expect(tabButton(wrapper, "Withdrawn").attributes("aria-pressed")).toBe("true");
    expect(names(wrapper)).toEqual(["Ben Attendee"]);
    expect(wrapper.find(".row-item").text()).toContain("Withdrawn");
  });

  it("puts the count of each group in its tab label, and doesn't count Cancelled as registered", async () => {
    mockedFetch.mockResolvedValue([
      registration(),
      registration({ registrationId: 2, userId: "ATT-0002", status: "Withdrawn" }),
      registration({ registrationId: 3, userId: "ATT-0003", status: "Withdrawn" }),
      registration({ registrationId: 4, userId: "ATT-0004", status: "Cancelled" }),
    ]);
    const wrapper = await mountPanel(10);

    expect(wrapper.findAll(".toggle-btn").map((t) => t.text())).toEqual(["Registered (1)", "Withdrawn (3)"]);
    expect(wrapper.find("[data-testid='registered-count']").text()).toBe("1 of 10 registered");
  });

  it("lists withdrawn first, then cancelled, on the Withdrawn tab, dimmed as no longer attending", async () => {
    mockedFetch.mockResolvedValue([
      registration({ registrationId: 1, userId: "ATT-0001", name: "Cancelled One", status: "Cancelled" }),
      registration({ registrationId: 2, userId: "ATT-0002", name: "Withdrawn One", status: "Withdrawn" }),
      registration({ registrationId: 3, userId: "ATT-0003", name: "Attending One" }),
    ]);
    const wrapper = await mountPanel(10);

    await tabButton(wrapper, "Withdrawn").trigger("click");

    expect(names(wrapper)).toEqual(["Withdrawn One", "Cancelled One"]);
    expect(wrapper.findAll(".registration-name").every((n) => n.classes().includes("registration-name--inactive"))).toBe(
      true,
    );
    await tabButton(wrapper, "Registered").trigger("click");
    expect(wrapper.find(".registration-name").classes()).not.toContain("registration-name--inactive");
  });

  it("shows the registered count against capacity, with the places left", async () => {
    mockedFetch.mockResolvedValue([
      registration(),
      registration({ registrationId: 2, userId: "ATT-0002" }),
      registration({ registrationId: 3, userId: "ATT-0003", status: "Withdrawn" }),
    ]);
    const wrapper = await mountPanel(300);

    expect(wrapper.find("[data-testid='registered-count']").text()).toBe("2 of 300 registered");
    expect(wrapper.find("[data-testid='places-left']").text()).toBe("298 places left");
  });

  it("says Full when every place is taken", async () => {
    mockedFetch.mockResolvedValue([registration(), registration({ registrationId: 2, userId: "ATT-0002" })]);
    const wrapper = await mountPanel(2);

    expect(wrapper.find("[data-testid='registered-count']").text()).toBe("2 of 2 registered");
    expect(wrapper.find("[data-testid='places-left']").text()).toBe("Full");
  });

  it("shows just the count when the event has no cap", async () => {
    mockedFetch.mockResolvedValue([registration()]);
    const wrapper = await mountPanel(null);

    expect(wrapper.find("[data-testid='registered-count']").text()).toBe("1 registered");
    expect(wrapper.find("[data-testid='places-left']").exists()).toBe(false);
  });

  it("tells the event page how many are registered, for the tab label", async () => {
    mockedFetch.mockResolvedValue([
      registration(),
      registration({ registrationId: 2, userId: "ATT-0002" }),
      registration({ registrationId: 3, userId: "ATT-0003", status: "Withdrawn" }),
    ]);
    const wrapper = await mountPanel();

    expect(wrapper.emitted("loaded")).toEqual([[2]]);
  });

  it("falls back to the user id when the name couldn't be looked up", async () => {
    mockedFetch.mockResolvedValue([registration({ name: null })]);
    const wrapper = await mountPanel();
    expect(wrapper.find(".registration-name").text()).toBe("ATT-0001");
  });

  it("is read-only — the only buttons are the two tabs", async () => {
    mockedFetch.mockResolvedValue([registration()]);
    const wrapper = await mountPanel();
    expect(wrapper.findAll("button")).toHaveLength(2);
  });

  it("says so, per tab, when there is no one to list", async () => {
    mockedFetch.mockResolvedValue([]);
    const wrapper = await mountPanel(20);

    expect(wrapper.text()).toContain("No one is registered yet.");
    await tabButton(wrapper, "Withdrawn").trigger("click");
    expect(wrapper.text()).toContain("No one has withdrawn.");
    expect(wrapper.find("[data-testid='registered-count']").text()).toBe("0 of 20 registered");
  });

  it("shows a message when the registrations can't be loaded", async () => {
    mockedFetch.mockRejectedValue(new Error("Failed to load registrations"));
    const wrapper = await mountPanel();
    expect(wrapper.text()).toContain("We couldn't load the registrations for this event.");
  });
});
