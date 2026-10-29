import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { h } from "vue";
import EquipmentRequestDetailView from "../EquipmentRequestDetailView.vue";
import {
  EquipmentAccessDeniedError,
  fetchEquipmentCatalog,
  fetchEquipmentRequestsForSupport,
  previewUnitsForItem,
  updateEquipmentRequestStatus,
  type EventEquipmentView,
} from "../../../lib/equipmentApi";

vi.mock("../../../lib/equipmentApi", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/equipmentApi")>("../../../lib/equipmentApi");
  return {
    ...actual,
    fetchEquipmentRequestsForSupport: vi.fn(),
    fetchEquipmentCatalog: vi.fn(),
    previewUnitsForItem: vi.fn(),
    updateEquipmentRequestStatus: vi.fn(),
  };
});

const mockedView = vi.mocked(fetchEquipmentRequestsForSupport);
const mockedCatalog = vi.mocked(fetchEquipmentCatalog);
const mockedPreview = vi.mocked(previewUnitsForItem);
const mockedUpdate = vi.mocked(updateEquipmentRequestStatus);

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", component: { render: () => h("div") } },
    { path: "/equipment-requests", name: "equipment-requests", component: { render: () => h("div") } },
    {
      path: "/equipment-requests/event/:eventId",
      name: "equipment-request-detail",
      component: { render: () => h("div") },
    },
  ],
});

function eventView(overrides: Partial<EventEquipmentView> = {}): EventEquipmentView {
  return {
    event: {
      id: 7,
      name: "Alumni Gala",
      proposedDate: "2099-06-15",
      startTime: "18:00",
      endTime: "21:00",
      venue: "Grand Ballroom",
    },
    technicalRequirements: "Two wireless mics.\n\nA lectern mic.",
    equipmentRequests: [
      {
        id: 55,
        eventId: 7,
        status: "Requested",
        fulfillmentNote: null,
        createdAt: "2099-01-01T00:00:00Z",
        requestedBy: { id: "COORD-0001", name: "Priya Shah" },
        items: [
          { id: 1, equipmentType: "Projector", quantity: 2, quantityFulfilled: 0, reservationFlag: { flagged: false, reason: null } },
          { id: 2, equipmentType: "Microphones", quantity: 3, quantityFulfilled: 0, reservationFlag: { flagged: false, reason: null } },
        ],
      },
    ],
    ...overrides,
  };
}

// Tracked so afterEach can unmount it: an unmounted component clears its own
// pending debounce timers (onBeforeUnmount), which otherwise fire later
// against whatever mock state a later test has set up.
let mountedWrapper: ReturnType<typeof mount> | null = null;

async function mountView() {
  await router.push("/equipment-requests/event/7");
  await router.isReady();
  const wrapper = mount(EquipmentRequestDetailView, { global: { plugins: [router] } });
  mountedWrapper = wrapper;
  await flushPromises();
  return wrapper;
}

afterEach(() => {
  mountedWrapper?.unmount();
  mountedWrapper = null;
});

beforeEach(() => {
  vi.clearAllMocks();
  mockedCatalog.mockResolvedValue([
    { id: 1, name: "Projector", totalStock: 5, availableStock: 5 },
    { id: 2, name: "Microphones", totalStock: 10, availableStock: 1 },
  ]);
  mockedPreview.mockResolvedValue({
    claimedIds: [201, 202],
    units: [
      { id: 201, label: "Projector #1" },
      { id: 202, label: "Projector #2" },
    ],
    availableCount: 5,
    shortfall: 0,
  });
});

/** The two equipment rows' arranging-now steppers, in item order (Projector, Microphones). */
function qtyValues(wrapper: ReturnType<typeof mount>): string[] {
  return wrapper.findAll("[data-testid='qty-value']").map((el) => el.text());
}

async function incQty(wrapper: ReturnType<typeof mount>, rowIndex: number, times = 1): Promise<void> {
  for (let i = 0; i < times; i++) {
    await wrapper.findAll("[data-testid='qty-inc']")[rowIndex].trigger("click");
  }
}

async function arrangeAll(wrapper: ReturnType<typeof mount>, rowIndex: number): Promise<void> {
  await wrapper.findAll("[data-testid='qty-all']")[rowIndex].trigger("click");
}

describe("EquipmentRequestDetailView", () => {
  it("loads the event named in the route", async () => {
    mockedView.mockResolvedValue(eventView());
    await mountView();

    expect(mockedView).toHaveBeenCalledWith("7");
  });

  it("never squeezes the Item column below 12rem, so item names don't wrap letter by letter", async () => {
    mockedView.mockResolvedValue(eventView());
    const wrapper = await mountView();

    const style = wrapper.get("ul.rows").attributes("style") ?? "";
    expect(style).toContain("--table-columns: minmax(12rem, 1fr)");
  });

  it("shows the equipment, quantities, technical requirements and the event's date, time and venue", async () => {
    mockedView.mockResolvedValue(eventView());
    const wrapper = await mountView();

    expect(wrapper.find("h1").text()).toBe("Alumni Gala");

    const details = wrapper.find(".details").text();
    expect(details).toContain("Monday, 15 June 2099");
    expect(details).toContain("18:00 – 21:00");
    expect(details).toContain("Grand Ballroom");

    expect(wrapper.find(".requirements").findAll("p").map((p) => p.text())).toEqual([
      "Two wireless mics.",
      "A lectern mic.",
    ]);

    const items = wrapper.findAll(".item-row").map((row) => row.text().replace(/\s+/g, " "));
    expect(items[0]).toContain("Projector");
    expect(items[0]).toContain("2×");
    expect(items[1]).toContain("Microphones");
    expect(items[1]).toContain("3×");
  });

  it("shows which coordinator raised the request, falling back to their id if the name wasn't resolved", async () => {
    mockedView.mockResolvedValue(
      eventView({
        equipmentRequests: [
          { ...eventView().equipmentRequests[0], requestedBy: { id: "COORD-0001", name: "Priya Shah" } },
          { ...eventView().equipmentRequests[0], id: 56, requestedBy: { id: "COORD-0002", name: null } },
          { ...eventView().equipmentRequests[0], id: 57, requestedBy: null },
        ],
      }),
    );
    const wrapper = await mountView();

    const cards = wrapper.findAll(".request-card");
    expect(cards[0].text()).toContain("Requested by Priya Shah");
    expect(cards[1].text()).toContain("Requested by COORD-0002");
    expect(cards[2].text()).not.toContain("Requested by");
  });

  it("says so when the organiser gave no technical requirements, and when the venue is not set", async () => {
    mockedView.mockResolvedValue(
      eventView({ technicalRequirements: null, event: { ...eventView().event, venue: null } }),
    );
    const wrapper = await mountView();

    expect(wrapper.find(".requirements").text()).toContain("didn't add any technical requirements");
    expect(wrapper.find(".details").text()).toContain("Venue to be confirmed");
  });

  it("checks each item's availability for the event's own date on load", async () => {
    mockedView.mockResolvedValue(eventView());
    const wrapper = await mountView();

    expect(mockedPreview).toHaveBeenCalledWith(1, 2);
    expect(mockedPreview).toHaveBeenCalledWith(2, 3);

    // The "Free stock" column only shows once editing (the collapsed view has no such column).
    await wrapper.find("[data-testid='edit-arrangement']").trigger("click");
    expect(wrapper.text()).toContain("more free");
  });

  it("shows only a no-access message, with none of the event, when access is denied", async () => {
    mockedView.mockRejectedValue(new EquipmentAccessDeniedError("denied"));
    const wrapper = await mountView();

    expect(wrapper.find("[role='alert']").text()).toContain("You don't have access to this event");
    expect(wrapper.find(".details").exists()).toBe(false);
    expect(wrapper.find(".requests").exists()).toBe(false);
    expect(wrapper.find(".back-link").exists()).toBe(true);
  });

  it("shows an error message when loading fails", async () => {
    mockedView.mockRejectedValue(new Error("boom"));
    const wrapper = await mountView();

    expect(wrapper.find("[role='alert']").text()).toContain("couldn't load");
  });

  it("status is a read-out, not a choice: it follows the quantity picked, with no separate status control", async () => {
    mockedView.mockResolvedValue(eventView());
    const wrapper = await mountView();

    await wrapper.find("[data-testid='edit-arrangement']").trigger("click");

    // Both start at "Not arranged" (nothing fulfilled yet) — the same shared wording used everywhere else.
    expect(wrapper.findAll("[data-testid='item-status']").map((b) => b.text())).toEqual(["Not arranged", "Not arranged"]);
    expect(wrapper.find("select").exists()).toBe(false);

    await arrangeAll(wrapper, 0); // Projector: 2 of 2
    await incQty(wrapper, 1, 1); // Microphones: 1 of 3

    expect(wrapper.findAll("[data-testid='item-status']").map((b) => b.text())).toEqual(["Arranged", "Partially fulfilled"]);
  });

  it("updates a request's status and tells the user the coordinator was notified", async () => {
    mockedView.mockResolvedValue(eventView());
    mockedUpdate.mockResolvedValue({
      equipmentRequest: { ...eventView().equipmentRequests[0], status: "Arranged" },
      notified: true,
    });
    const wrapper = await mountView();

    await wrapper.find("[data-testid='edit-arrangement']").trigger("click");
    await arrangeAll(wrapper, 0);
    await arrangeAll(wrapper, 1);
    await wrapper.find("[data-testid='reserve-stock']").trigger("click");
    await flushPromises();

    expect(mockedUpdate).toHaveBeenCalledWith(55, "Arranged", undefined, undefined);
    expect(wrapper.find("[role='status']").text()).toContain("coordinator has been notified");
  });

  it("works out what is outstanding from current stock for a partial fulfilment", async () => {
    mockedView.mockResolvedValue(eventView());
    mockedUpdate.mockResolvedValue({
      equipmentRequest: { ...eventView().equipmentRequests[0], status: "Partially Fulfilled" },
      notified: true,
    });
    const wrapper = await mountView();

    await wrapper.find("[data-testid='edit-arrangement']").trigger("click");
    await arrangeAll(wrapper, 0); // Projector fully arranged
    await incQty(wrapper, 1, 1); // Microphones: 1 of 3

    expect(wrapper.find("[data-testid='outstanding-text']").text()).toBe("2 Microphones outstanding");

    await wrapper.find("[data-testid='reserve-stock']").trigger("click");
    await flushPromises();

    expect(mockedUpdate).toHaveBeenCalledWith(55, "Partially Fulfilled", "2 Microphones outstanding", [
      { itemId: 1, fulfilledQuantity: 2 },
      { itemId: 2, fulfilledQuantity: 1 },
    ]);
  });

  it("lets Technical Support mark one item arranged and another only partly", async () => {
    mockedView.mockResolvedValue(eventView());
    mockedUpdate.mockResolvedValue({
      equipmentRequest: {
        ...eventView().equipmentRequests[0],
        status: "Partially Fulfilled",
        items: [
          { id: 1, equipmentType: "Projector", quantity: 2, quantityFulfilled: 2, reservationFlag: { flagged: false, reason: null } },
          { id: 2, equipmentType: "Microphones", quantity: 3, quantityFulfilled: 2, reservationFlag: { flagged: false, reason: null } },
        ],
      },
      notified: true,
    });
    const wrapper = await mountView();

    await wrapper.find("[data-testid='edit-arrangement']").trigger("click");
    await arrangeAll(wrapper, 0); // Projector: 2 of 2
    await incQty(wrapper, 1, 2); // Microphones: 2 of 3

    expect(wrapper.find("[data-testid='outstanding-text']").text()).toBe("1 Microphones outstanding");

    await wrapper.find("[data-testid='reserve-stock']").trigger("click");
    await flushPromises();

    expect(mockedUpdate).toHaveBeenCalledWith(55, "Partially Fulfilled", "1 Microphones outstanding", [
      { itemId: 1, fulfilledQuantity: 2 },
      { itemId: 2, fulfilledQuantity: 2 },
    ]);
    const states = wrapper.findAll("[data-testid='item-status']").map((b) => b.text());
    expect(states).toEqual(["Arranged", "Partially fulfilled"]);
  });

  it("saves as Arranged when every item is fully in, even if one was reached by stepping up", async () => {
    mockedView.mockResolvedValue(eventView());
    mockedUpdate.mockResolvedValue({
      equipmentRequest: { ...eventView().equipmentRequests[0], status: "Arranged" },
      notified: true,
    });
    const wrapper = await mountView();

    await wrapper.find("[data-testid='edit-arrangement']").trigger("click");
    await arrangeAll(wrapper, 0); // Projector: 2 of 2
    await incQty(wrapper, 1, 3); // Microphones: 3 of 3, one click at a time
    await wrapper.find("[data-testid='reserve-stock']").trigger("click");
    await flushPromises();

    expect(mockedUpdate).toHaveBeenCalledWith(55, "Arranged", undefined, undefined);
  });

  it("never lets the stepper go past what was requested, or below zero", async () => {
    mockedView.mockResolvedValue(eventView());
    const wrapper = await mountView();

    await wrapper.find("[data-testid='edit-arrangement']").trigger("click");
    // Projector needs 2 — try to go to 3.
    await incQty(wrapper, 0, 3);
    expect(qtyValues(wrapper)[0]).toBe("2");
    expect((wrapper.findAll("[data-testid='qty-inc']")[0].element as HTMLButtonElement).disabled).toBe(true);

    // Can't go below zero either.
    await wrapper.findAll("[data-testid='qty-dec']")[1].trigger("click");
    expect(qtyValues(wrapper)[1]).toBe("0");
    expect((wrapper.findAll("[data-testid='qty-dec']")[1].element as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a cancelled request read-only: no editor, no per-item badges, and says why", async () => {
    mockedView.mockResolvedValue(
      eventView({
        equipmentRequests: [{ ...eventView().equipmentRequests[0], status: "Cancelled" }],
      }),
    );
    const wrapper = await mountView();

    // No table or editor for it: it sits in the collapsed "Cancelled requests" list instead.
    expect(wrapper.find(".request-card").exists()).toBe(false);
    expect(wrapper.find("[data-testid='edit-arrangement']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='no-active-requests']").text()).toContain("No active equipment requests");
    expect(wrapper.find("[data-testid='cancelled-list']").exists()).toBe(false);
    expect(wrapper.get("[data-testid='cancelled-toggle']").text()).toContain("Cancelled requests (1)");

    await wrapper.get("[data-testid='cancelled-toggle']").trigger("click");
    const rows = wrapper.findAll(".cancelled-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].text()).toContain("Request 1");
    expect(rows[0].text()).toContain("Cancelled");
    expect(rows[0].findAll(".cancelled-row__items li")).toHaveLength(2);

    // Nothing is checked for availability on a request that is no longer live.
    expect(mockedPreview).not.toHaveBeenCalled();
  });

  it("expanding an item reveals which units are already reserved for it", async () => {
    mockedView.mockResolvedValue(
      eventView({
        equipmentRequests: [
          {
            ...eventView().equipmentRequests[0],
            items: [
              {
                id: 1,
                equipmentType: "Projector",
                quantity: 2,
                quantityFulfilled: 2,
                reservationFlag: { flagged: false, reason: null },
                reservedUnits: [{ id: 201, label: "Projector #1" }],
              },
              eventView().equipmentRequests[0].items[1],
            ],
          },
        ],
      }),
    );
    const wrapper = await mountView();

    expect(wrapper.find("[data-testid='unit-panel']").exists()).toBe(false);

    await wrapper.find("[data-testid='expand-toggle']").trigger("click");

    expect(wrapper.find("[data-testid='unit-panel']").text()).toContain("Projector #1");
  });

  it("re-checks availability live as the arranged quantity changes, without hitting Save", async () => {
    vi.useFakeTimers();
    try {
      mockedView.mockResolvedValue(eventView());
      const wrapper = await mountView();
      mockedPreview.mockClear();

      await wrapper.find("[data-testid='edit-arrangement']").trigger("click");
      mockedPreview.mockResolvedValueOnce({ claimedIds: [], units: [], availableCount: 0, shortfall: 2 });
      await incQty(wrapper, 1, 3); // Microphones: step up to 3 of 3

      // The quantity change is debounced before it re-fires the live check.
      await vi.advanceTimersByTimeAsync(400);
      await flushPromises();

      expect(mockedPreview).toHaveBeenCalledWith(2, 3);
      expect(wrapper.find("[data-testid='shortfall-banner']").exists()).toBe(true);
      expect(wrapper.findAll("[data-testid='item-status']")[1].text()).toBe("Needs fixing");
      expect(wrapper.find("[data-testid='reserve-stock']").attributes("disabled")).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows a shortfall as a disabled Reserve stock, a row warning and a quick fix, and 'Set to N' resolves it", async () => {
    vi.useFakeTimers();
    try {
      // Microphones has exactly 1 free, however many are asked for.
      mockedPreview.mockImplementation(async (itemId: number, quantity: number) =>
        itemId === 2
          ? {
              claimedIds: quantity > 0 ? [204] : [],
              units: quantity > 0 ? [{ id: 204, label: "Mic #4" }] : [],
              availableCount: 1,
              shortfall: Math.max(0, quantity - 1),
            }
          : { claimedIds: [201, 202], units: [{ id: 201, label: "P1" }, { id: 202, label: "P2" }], availableCount: 2, shortfall: 0 },
      );
      mockedView.mockResolvedValue(eventView());
      const wrapper = await mountView();

      await wrapper.find("[data-testid='edit-arrangement']").trigger("click");
      await incQty(wrapper, 1, 3); // Microphones: step up to 3, only 1 free
      await vi.advanceTimersByTimeAsync(400);
      await flushPromises();

      expect(wrapper.find("[data-testid='qty-warning']").text()).toContain("Only 1 free");
      expect(wrapper.find("[data-testid='reserve-stock']").attributes("disabled")).toBeDefined();

      await wrapper.find("[data-testid='qty-set-to-free']").trigger("click");
      await vi.advanceTimersByTimeAsync(400);
      await flushPromises();

      expect(qtyValues(wrapper)[1]).toBe("1");
      expect(wrapper.find("[data-testid='shortfall-banner']").exists()).toBe(false);
      expect(wrapper.find("[data-testid='reserve-stock']").attributes("disabled")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("expanding a shortfall item shows the units it would still reserve, plus how many short", async () => {
    vi.useFakeTimers();
    try {
      mockedPreview.mockImplementation(async (itemId: number) =>
        itemId === 2
          ? { claimedIds: [204], units: [{ id: 204, label: "Mic #4" }], availableCount: 1, shortfall: 2 }
          : { claimedIds: [201, 202], units: [{ id: 201, label: "P1" }, { id: 202, label: "P2" }], availableCount: 2, shortfall: 0 },
      );
      mockedView.mockResolvedValue(eventView());
      const wrapper = await mountView();

      await wrapper.find("[data-testid='edit-arrangement']").trigger("click");
      await incQty(wrapper, 1, 3);
      await vi.advanceTimersByTimeAsync(400);
      await flushPromises();

      const toggles = wrapper.findAll("[data-testid='expand-toggle']");
      await toggles[1].trigger("click");

      const panel = wrapper.find("[data-testid='unit-panel']");
      expect(panel.text()).toContain("Mic #4");
      expect(panel.text()).toContain("2 short");
    } finally {
      vi.useRealTimers();
    }
  });
});
