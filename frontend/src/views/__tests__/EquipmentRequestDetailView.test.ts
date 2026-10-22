import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { h } from "vue";
import EquipmentRequestDetailView from "../EquipmentRequestDetailView.vue";
import {
  EquipmentAccessDeniedError,
  checkEquipmentAvailability,
  fetchEquipmentCatalog,
  fetchEquipmentRequestsForSupport,
  updateEquipmentRequestStatus,
  type EventEquipmentView,
} from "../../lib/equipmentApi";

vi.mock("../../lib/equipmentApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/equipmentApi")>("../../lib/equipmentApi");
  return {
    ...actual,
    fetchEquipmentRequestsForSupport: vi.fn(),
    fetchEquipmentCatalog: vi.fn(),
    checkEquipmentAvailability: vi.fn(),
    updateEquipmentRequestStatus: vi.fn(),
  };
});

const mockedView = vi.mocked(fetchEquipmentRequestsForSupport);
const mockedCatalog = vi.mocked(fetchEquipmentCatalog);
const mockedAvailability = vi.mocked(checkEquipmentAvailability);
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
        items: [
          { id: 1, equipmentType: "Projector", quantity: 2, quantityFulfilled: 0, reservationFlag: { flagged: false, reason: null } },
          { id: 2, equipmentType: "Microphones", quantity: 3, quantityFulfilled: 0, reservationFlag: { flagged: false, reason: null } },
        ],
      },
    ],
    ...overrides,
  };
}

async function mountView() {
  await router.push("/equipment-requests/event/7");
  await router.isReady();
  const wrapper = mount(EquipmentRequestDetailView, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedCatalog.mockResolvedValue([
    { id: 1, name: "Projector", totalStock: 5, availableStock: 5 },
    { id: 2, name: "Microphones", totalStock: 10, availableStock: 1 },
  ]);
  mockedAvailability.mockResolvedValue({
    event: { id: 7, name: "Alumni Gala" },
    type: "Projector",
    requestedQuantity: 2,
    totalUnits: 5,
    unusableCount: 0,
    reservedElsewhereCount: 0,
    availableCount: 5,
    shortfall: 0,
  });
});

describe("EquipmentRequestDetailView", () => {
  it("loads the event named in the route", async () => {
    mockedView.mockResolvedValue(eventView());
    await mountView();

    expect(mockedView).toHaveBeenCalledWith("7");
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

    const items = wrapper.findAll(".item-row").map((row) => row.find("strong").text().replace(/\s+/g, " "));
    expect(items).toEqual(["2× Projector", "3× Microphones"]);
  });

  it("says so when the organiser gave no technical requirements, and when the venue is not set", async () => {
    mockedView.mockResolvedValue(
      eventView({ technicalRequirements: null, event: { ...eventView().event, venue: null } }),
    );
    const wrapper = await mountView();

    expect(wrapper.find(".requirements").text()).toContain("didn't add any technical requirements");
    expect(wrapper.find(".details").text()).toContain("Venue to be confirmed");
  });

  it("checks each item's availability while the request is still Requested", async () => {
    mockedView.mockResolvedValue(eventView());
    const wrapper = await mountView();

    expect(mockedAvailability).toHaveBeenCalledWith(7, "Projector", 2);
    expect(mockedAvailability).toHaveBeenCalledWith(7, "Microphones", 3);
    expect(wrapper.text()).toContain("Available");
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

  it("updates a request's status and tells the user the coordinator was notified", async () => {
    mockedView.mockResolvedValue(eventView());
    mockedUpdate.mockResolvedValue({
      equipmentRequest: { ...eventView().equipmentRequests[0], status: "Arranged" },
      notified: true,
    });
    const wrapper = await mountView();

    await wrapper.find(".status-editor .btn--outline").trigger("click");
    // Each item has its own Requested / Arranged / Partially Fulfilled pills: Arranged for both.
    await wrapper.findAll(".status-pill")[1].trigger("click");
    await wrapper.findAll(".status-pill")[4].trigger("click");
    await wrapper.find(".btn--primary").trigger("click");
    await flushPromises();

    expect(mockedUpdate).toHaveBeenCalledWith(55, "Arranged", undefined, undefined);
    expect(wrapper.find(".badge").text()).toBe("Arranged");
    expect(wrapper.find("[role='status']").text()).toContain("coordinator has been notified");
  });

  it("works out what is outstanding from current stock for a partial fulfilment", async () => {
    mockedView.mockResolvedValue(eventView());
    mockedUpdate.mockResolvedValue({
      equipmentRequest: { ...eventView().equipmentRequests[0], status: "Partially Fulfilled" },
      notified: true,
    });
    const wrapper = await mountView();

    await wrapper.find(".status-editor .btn--outline").trigger("click");
    await wrapper.findAll(".status-pill")[1].trigger("click");
    await wrapper.findAll(".status-pill")[5].trigger("click");

    // Projectors Arranged; Microphones partly, starting at the 1 of 3 that is in stock.
    expect(wrapper.find(".outstanding-preview").text()).toBe("2 Microphones outstanding");

    await wrapper.find(".btn--primary").trigger("click");
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

    await wrapper.find(".status-editor .btn--outline").trigger("click");
    await wrapper.findAll(".status-pill")[1].trigger("click");
    await wrapper.findAll(".status-pill")[5].trigger("click");
    await wrapper.find("input[aria-label='Microphones arranged']").setValue(2);

    expect(wrapper.find(".outstanding-preview").text()).toBe("1 Microphones outstanding");

    await wrapper.find(".btn--primary").trigger("click");
    await flushPromises();

    expect(mockedUpdate).toHaveBeenCalledWith(55, "Partially Fulfilled", "1 Microphones outstanding", [
      { itemId: 1, fulfilledQuantity: 2 },
      { itemId: 2, fulfilledQuantity: 2 },
    ]);
    const states = wrapper.findAll("[data-testid='item-status']").map((b) => b.text());
    expect(states).toEqual(["Arranged", "Partially fulfilled"]);
  });

  it("saves as Arranged when every item is fully in, even if one was set by number", async () => {
    mockedView.mockResolvedValue(eventView());
    mockedUpdate.mockResolvedValue({
      equipmentRequest: { ...eventView().equipmentRequests[0], status: "Arranged" },
      notified: true,
    });
    const wrapper = await mountView();

    await wrapper.find(".status-editor .btn--outline").trigger("click");
    await wrapper.findAll(".status-pill")[1].trigger("click");
    await wrapper.findAll(".status-pill")[5].trigger("click");
    await wrapper.find("input[aria-label='Microphones arranged']").setValue(3);
    await wrapper.find(".btn--primary").trigger("click");
    await flushPromises();

    expect(mockedUpdate).toHaveBeenCalledWith(55, "Arranged", undefined, undefined);
  });
  it("shows a cancelled request read-only: no Update status, no per-item badges, and says why", async () => {
    mockedView.mockResolvedValue(
      eventView({
        equipmentRequests: [{ ...eventView().equipmentRequests[0], status: "Cancelled" }],
      }),
    );
    const wrapper = await mountView();

    expect(wrapper.find(".badge").text()).toBe("Cancelled");
    expect(wrapper.find(".badge").classes()).toContain("status-cancelled");
    expect(wrapper.find(".status-editor").exists()).toBe(false);
    expect(wrapper.findAll("[data-testid='item-status']")).toHaveLength(0);
    expect(wrapper.findAll("[data-testid='item-cancelled']")).toHaveLength(2);
    expect(wrapper.find("[data-testid='cancelled-note']").text()).toContain("cancelled");
    // Nothing is checked for availability on a request that is no longer live.
    expect(mockedAvailability).not.toHaveBeenCalled();
  });
});
