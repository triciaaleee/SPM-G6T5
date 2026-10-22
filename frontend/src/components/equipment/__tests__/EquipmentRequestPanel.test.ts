import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import EquipmentRequestPanel from "../EquipmentRequestPanel.vue";
import {
  EquipmentRequestError,
  EquipmentValidationError,
  amendEquipmentRequest,
  cancelEquipmentRequest,
  fetchEquipmentCatalog,
  fetchEquipmentRequestsForEvent,
  type EquipmentRequest,
} from "../../../lib/equipmentApi";

vi.mock("../../../lib/equipmentApi", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/equipmentApi")>("../../../lib/equipmentApi");
  return {
    CANCELLED_REQUEST_STATUS: actual.CANCELLED_REQUEST_STATUS,
    EquipmentRequestError: actual.EquipmentRequestError,
    EquipmentValidationError: actual.EquipmentValidationError,
    amendEquipmentRequest: vi.fn(),
    cancelEquipmentRequest: vi.fn(),
    fetchEquipmentCatalog: vi.fn(),
    fetchEquipmentRequestsForEvent: vi.fn(),
    itemFulfilmentBadgeClass: actual.itemFulfilmentBadgeClass,
    itemFulfilmentState: actual.itemFulfilmentState,
    submitEquipmentRequest: vi.fn(),
  };
});

const mockedRequests = vi.mocked(fetchEquipmentRequestsForEvent);
const mockedCatalog = vi.mocked(fetchEquipmentCatalog);
const mockedAmend = vi.mocked(amendEquipmentRequest);
const mockedCancel = vi.mocked(cancelEquipmentRequest);

const NO_FLAG = { flagged: false, reason: null };

function equipmentRequest(overrides: Partial<EquipmentRequest> = {}): EquipmentRequest {
  return {
    id: 55,
    eventId: 7,
    status: "Partially Fulfilled",
    fulfillmentNote: "2 still to arrange",
    createdAt: "2026-10-07T02:00:00.000Z",
    items: [
      { id: 1, equipmentCatalogId: 1, equipmentType: "Projector", quantity: 5, quantityFulfilled: 3, reservationFlag: NO_FLAG },
      { id: 2, equipmentCatalogId: 2, equipmentType: "Screen", quantity: 1, quantityFulfilled: 0, reservationFlag: NO_FLAG },
    ],
    ...overrides,
  };
}

const catalog = [
  { id: 1, name: "Projector", totalStock: 10, availableStock: 7 },
  { id: 2, name: "Screen", totalStock: 4, availableStock: 4 },
  { id: 3, name: "Microphone", totalStock: 8, availableStock: 8 },
];

async function mountPanel(requests: EquipmentRequest[], canSubmit = true) {
  mockedRequests.mockResolvedValue(requests);
  const wrapper = mount(EquipmentRequestPanel, {
    props: { eventId: 7, organiserNote: null, canSubmit },
    global: { stubs: { RouterLink: true } },
  });
  await flushPromises();
  return wrapper;
}

const card = (wrapper: Awaited<ReturnType<typeof mountPanel>>, id: number) => wrapper.find(`[data-testid='eq-request-${id}']`);

beforeEach(() => {
  vi.clearAllMocks();
  mockedCatalog.mockResolvedValue(catalog);
});

describe("EquipmentRequestPanel — cancelled requests (E5-2)", () => {
  it("greys a cancelled request out, labels it Cancelled and offers no actions on it", async () => {
    const wrapper = await mountPanel([equipmentRequest({ id: 56, status: "Cancelled", fulfillmentNote: null })]);

    const cancelled = card(wrapper, 56);
    expect(cancelled.classes()).toContain("eq-request--cancelled");
    expect(cancelled.find(".badge").text()).toBe("Cancelled");
    expect(cancelled.find(".badge").classes()).toContain("status-cancelled");
    expect(cancelled.findAll("button")).toHaveLength(0);
    // Nothing is reserved against a cancelled request, so the Reserved column shows a dash.
    expect(cancelled.findAll(".row-item .cell:nth-child(3)").every((cell) => cell.text() === "—")).toBe(true);
    expect(cancelled.text()).not.toMatch(/\d+ of \d+/);
  });

  it("pushes cancelled requests below the active ones, keeping each group's own order", async () => {
    const wrapper = await mountPanel([
      equipmentRequest({ id: 1, status: "Cancelled" }),
      equipmentRequest({ id: 2, status: "Requested", fulfillmentNote: null }),
      equipmentRequest({ id: 3, status: "Cancelled" }),
      equipmentRequest({ id: 4, status: "Arranged", fulfillmentNote: null }),
    ]);

    const order = wrapper.findAll(".eq-request").map((li) => li.attributes("data-testid"));
    expect(order).toEqual(["eq-request-2", "eq-request-4", "eq-request-1", "eq-request-3"]);
  });
});

describe("EquipmentRequestPanel — per-item progress", () => {
  it("shows which items are arranged, partly arranged or not arranged on a partly fulfilled request", async () => {
    const wrapper = await mountPanel([
      equipmentRequest({
        status: "Partially Fulfilled",
        items: [
          { id: 1, equipmentCatalogId: 1, equipmentType: "Round table", quantity: 2, quantityFulfilled: 2, reservationFlag: NO_FLAG },
          { id: 2, equipmentCatalogId: 2, equipmentType: "Chairs", quantity: 5, quantityFulfilled: 3, reservationFlag: NO_FLAG },
          { id: 3, equipmentCatalogId: 3, equipmentType: "Screen", quantity: 1, quantityFulfilled: 0, reservationFlag: NO_FLAG },
        ],
      }),
    ]);

    const states = wrapper.findAll("[data-testid='item-status']").map((b) => b.text());
    expect(states).toEqual(["Arranged", "Partially fulfilled", "Not arranged"]);
  });

  it("shows no per-item badges while the request is still Requested", async () => {
    const wrapper = await mountPanel([equipmentRequest({ status: "Requested", fulfillmentNote: null })]);
    expect(wrapper.findAll("[data-testid='item-status']")).toHaveLength(0);
  });
});

describe("EquipmentRequestPanel — reservation flags (E5-5)", () => {
  it("shows the coordinator why a reservation no longer holds, e.g. a reserved unit became unusable", async () => {
    const flagged = equipmentRequest({
      items: [
        {
          id: 1,
          equipmentCatalogId: 1,
          equipmentType: "Projector",
          quantity: 2,
          quantityFulfilled: 2,
          reservationFlag: { flagged: true, reason: "A reserved unit is unavailable (Damaged) during this event, so it needs a replacement." },
        },
        { id: 2, equipmentCatalogId: 2, equipmentType: "Screen", quantity: 1, quantityFulfilled: 1, reservationFlag: NO_FLAG },
      ],
    });
    const wrapper = await mountPanel([flagged]);

    const flags = wrapper.findAll("[data-testid='reservation-flag']");
    expect(flags).toHaveLength(1);
    expect(flags[0].text()).toBe("A reserved unit is unavailable (Damaged) during this event, so it needs a replacement.");
  });

  it("shows no warning when nothing is flagged", async () => {
    const wrapper = await mountPanel([equipmentRequest()]);
    expect(wrapper.find("[data-testid='reservation-flag']").exists()).toBe(false);
  });
});

describe("EquipmentRequestPanel — who gets Amend and Cancel (E5-2)", () => {
  it("offers Amend and Cancel on a request that isn't fully arranged", async () => {
    const wrapper = await mountPanel([equipmentRequest(), equipmentRequest({ id: 56, status: "Requested", fulfillmentNote: null })]);

    for (const id of [55, 56]) {
      expect(card(wrapper, id).findAll(".eq-request__actions button").map((b) => b.text())).toEqual(["Amend", "Cancel request"]);
    }
  });

  it("lets a fully arranged request be cancelled but not amended, and says why", async () => {
    const wrapper = await mountPanel([equipmentRequest({ status: "Arranged", fulfillmentNote: null })]);

    expect(card(wrapper, 55).findAll(".eq-request__actions button").map((b) => b.text())).toEqual(["Cancel request"]);
    expect(wrapper.find("[data-testid='arranged-hint']").text()).toContain("cancel it and record a new request");
  });

  it("offers nothing to someone who can't change requests (not the assigned coordinator, or past Planning)", async () => {
    const wrapper = await mountPanel([equipmentRequest()], false);

    expect(wrapper.find(".eq-request__actions").exists()).toBe(false);
    expect(wrapper.find("[data-testid='arranged-hint']").exists()).toBe(false);
  });
});

describe("EquipmentRequestPanel — amend (E5-2 AC1, AC2)", () => {
  async function openAmend() {
    const wrapper = await mountPanel([equipmentRequest()]);
    await wrapper.find("[data-testid='amend-request']").trigger("click");
    return wrapper;
  }

  it("opens the form pre-filled with the request's items", async () => {
    const wrapper = await openAmend();

    const types = wrapper.findAll("[data-testid='amend-form'] select").map((s) => (s.element as HTMLSelectElement).value);
    const quantities = wrapper.findAll("[data-testid='amend-form'] input[type='number']").map((i) => (i.element as HTMLInputElement).value);
    expect(types).toEqual(["1", "2"]);
    expect(quantities).toEqual(["5", "1"]);
    expect(wrapper.find(".eq-items").exists()).toBe(false);
  });

  it("warns, before saving, how much reserved equipment lowering a quantity would release", async () => {
    const wrapper = await openAmend();
    expect(wrapper.find("[data-testid='release-note']").exists()).toBe(false);

    await wrapper.find("#amend-qty-0").setValue("2");

    expect(wrapper.find("[data-testid='release-note']").text()).toBe("1 of the 3 reserved will be released back to inventory.");

    await wrapper.find("#amend-qty-0").setValue("4");
    expect(wrapper.find("[data-testid='release-note']").exists()).toBe(false);
  });

  it("warns that changing the type of a reserved item releases all of it, and removing it does too", async () => {
    const wrapper = await openAmend();

    await wrapper.find("#amend-type-0").setValue("3");
    expect(wrapper.find("[data-testid='release-note']").text()).toBe("All 3 reserved will be released back to inventory.");

    await wrapper.find("#amend-type-0").setValue("1");
    await wrapper.findAll(".eq-remove")[0].trigger("click");
    expect(wrapper.find("[data-testid='removed-note']").text()).toBe("3× Projector reserved will be released.");
  });

  it("keeps at least one item", async () => {
    const wrapper = await openAmend();

    await wrapper.findAll(".eq-remove")[1].trigger("click");

    expect(wrapper.findAll(".eq-remove")[0].attributes("disabled")).toBeDefined();
  });

  it("saves the amendment, updates the card, tells the page and reports what was released", async () => {
    mockedAmend.mockResolvedValue({
      equipmentRequest: equipmentRequest({
        items: [
          { id: 1, equipmentCatalogId: 1, equipmentType: "Projector", quantity: 2, quantityFulfilled: 2, reservationFlag: NO_FLAG },
          { id: 2, equipmentCatalogId: 2, equipmentType: "Screen", quantity: 1, quantityFulfilled: 0, reservationFlag: NO_FLAG },
        ],
      }),
      changes: [{ kind: "quantity", equipmentType: "Projector", from: 5, to: 2, released: 1 }],
      released: 1,
      notified: true,
    });
    const wrapper = await openAmend();

    await wrapper.find("#amend-qty-0").setValue("2");
    await wrapper.find("[data-testid='save-amendment']").trigger("click");
    await flushPromises();

    expect(mockedAmend).toHaveBeenCalledWith(55, [
      { itemId: 1, equipmentCatalogId: 1, quantity: 2 },
      { itemId: 2, equipmentCatalogId: 2, quantity: "1" },
    ]);
    expect(wrapper.emitted("changed")).toHaveLength(1);
    expect(wrapper.find("[data-testid='amend-form']").exists()).toBe(false);
    expect(wrapper.find(".eq-items .row-item").text()).toContain("Projector");
    expect(wrapper.find(".eq-items .row-item").text()).toContain("2");
    expect(wrapper.find("[role='status']").text()).toBe(
      "Equipment request amended. Technical Support has been notified of what changed. 1 reserved item was released back to inventory.",
    );
  });

  it("sends a newly added row without an itemId", async () => {
    mockedAmend.mockResolvedValue({
      equipmentRequest: equipmentRequest(),
      changes: [{ kind: "added", equipmentType: "Microphone", quantity: 2, released: 0 }],
      released: 0,
      notified: true,
    });
    const wrapper = await openAmend();

    await wrapper.find(".eq-add").trigger("click");
    await wrapper.find("#amend-type-2").setValue("3");
    await wrapper.find("#amend-qty-2").setValue("2");
    await wrapper.find("[data-testid='save-amendment']").trigger("click");
    await flushPromises();

    const sent = mockedAmend.mock.calls[0][1];
    expect(sent[2]).toEqual({ itemId: undefined, equipmentCatalogId: 3, quantity: 2 });
  });

  it("says so when nothing changed, and warns when Technical Support couldn't be told", async () => {
    mockedAmend.mockResolvedValueOnce({ equipmentRequest: equipmentRequest(), changes: [], released: 0, notified: false });
    const unchanged = await openAmend();
    await unchanged.find("[data-testid='save-amendment']").trigger("click");
    await flushPromises();
    expect(unchanged.find("[role='status']").text()).toBe("No changes were made.");

    mockedAmend.mockResolvedValueOnce({
      equipmentRequest: equipmentRequest(),
      changes: [{ kind: "added", equipmentType: "Microphone", quantity: 1, released: 0 }],
      released: 0,
      notified: false,
    });
    const unnotified = await openAmend();
    await unnotified.find("[data-testid='save-amendment']").trigger("click");
    await flushPromises();
    expect(unnotified.find("[role='status']").text()).toContain("couldn't notify Technical Support");
    expect(unnotified.find("[role='status']").classes()).toContain("eq-notice--warning");
  });

  it("shows validation errors against the right row, and keeps the form open", async () => {
    mockedAmend.mockRejectedValue(new EquipmentValidationError({ "items[0].quantity": "Quantity must be greater than zero." }));
    const wrapper = await openAmend();

    await wrapper.find("[data-testid='save-amendment']").trigger("click");
    await flushPromises();

    expect(wrapper.find("[data-testid='amend-form']").text()).toContain("Quantity must be greater than zero.");
    expect(wrapper.emitted("changed")).toBeUndefined();
  });

  it("shows the backend's message when it refuses, and discards the edit on Cancel", async () => {
    mockedAmend.mockRejectedValue(new EquipmentRequestError("This request can no longer be amended."));
    const wrapper = await openAmend();

    await wrapper.find("[data-testid='save-amendment']").trigger("click");
    await flushPromises();
    expect(wrapper.find("[data-testid='amend-form']").text()).toContain("This request can no longer be amended.");

    const discard = wrapper.findAll("[data-testid='amend-form'] button").find((b) => b.text() === "Cancel")!;
    await discard.trigger("click");
    expect(wrapper.find("[data-testid='amend-form']").exists()).toBe(false);
    expect(wrapper.find(".eq-items").exists()).toBe(true);
  });
});

describe("EquipmentRequestPanel — cancel (E5-2 AC3)", () => {
  it("asks first, saying how much reserved equipment will go back to inventory", async () => {
    const wrapper = await mountPanel([equipmentRequest()]);

    await wrapper.find("[data-testid='cancel-request']").trigger("click");

    const dialog = wrapper.find("[role='alertdialog']");
    expect(dialog.text()).toContain("Cancel this equipment request?");
    expect(dialog.text()).toContain("3 reserved items will be released back to inventory.");
    expect(dialog.text()).toContain("Technical Support will be notified.");
    expect(mockedCancel).not.toHaveBeenCalled();
  });

  it("keeps the request when the coordinator changes their mind", async () => {
    const wrapper = await mountPanel([equipmentRequest()]);
    await wrapper.find("[data-testid='cancel-request']").trigger("click");

    const keep = wrapper.findAll("[role='alertdialog'] button").find((b) => b.text() === "Keep request")!;
    await keep.trigger("click");

    expect(wrapper.find("[role='alertdialog']").exists()).toBe(false);
    expect(mockedCancel).not.toHaveBeenCalled();
    expect(card(wrapper, 55).find(".badge").text()).toBe("Partially Fulfilled");
  });

  it("cancels once confirmed: the card turns Cancelled and moves below the active requests", async () => {
    const other = equipmentRequest({ id: 56, status: "Requested", fulfillmentNote: null });
    mockedCancel.mockResolvedValue({
      equipmentRequest: equipmentRequest({
        status: "Cancelled",
        fulfillmentNote: null,
        items: [{ id: 1, equipmentCatalogId: 1, equipmentType: "Projector", quantity: 5, quantityFulfilled: 0, reservationFlag: NO_FLAG }],
      }),
      released: [{ equipmentType: "Projector", quantity: 3 }],
      notified: true,
    });
    const wrapper = await mountPanel([equipmentRequest(), other]);

    await card(wrapper, 55).find("[data-testid='cancel-request']").trigger("click");
    await wrapper.find("[data-testid='confirm-cancel']").trigger("click");
    await flushPromises();

    expect(mockedCancel).toHaveBeenCalledWith(55);
    expect(wrapper.emitted("changed")).toHaveLength(1);
    expect(wrapper.find("[role='alertdialog']").exists()).toBe(false);
    expect(wrapper.findAll(".eq-request").map((li) => li.attributes("data-testid"))).toEqual(["eq-request-56", "eq-request-55"]);
    expect(card(wrapper, 55).classes()).toContain("eq-request--cancelled");
    expect(wrapper.find("[role='status']").text()).toBe(
      "Equipment request cancelled. Technical Support has been notified. 3 reserved items were released back to inventory.",
    );
  });

  it("doesn't mention a release when nothing was reserved", async () => {
    const wrapper = await mountPanel([equipmentRequest({ status: "Requested", fulfillmentNote: null, items: [
      { id: 1, equipmentCatalogId: 1, equipmentType: "Projector", quantity: 2, quantityFulfilled: 0, reservationFlag: NO_FLAG },
    ] })]);
    mockedCancel.mockResolvedValue({
      equipmentRequest: equipmentRequest({ status: "Cancelled", fulfillmentNote: null }),
      released: [],
      notified: true,
    });

    await wrapper.find("[data-testid='cancel-request']").trigger("click");
    expect(wrapper.find("[role='alertdialog']").text()).not.toContain("reserved");
    await wrapper.find("[data-testid='confirm-cancel']").trigger("click");
    await flushPromises();

    expect(wrapper.find("[role='status']").text()).toBe("Equipment request cancelled. Technical Support has been notified.");
  });

  it("shows the backend's message in the dialog when cancelling fails, and keeps the request", async () => {
    mockedCancel.mockRejectedValue(new EquipmentRequestError("Equipment requests can only be changed while the event is in Planning."));
    const wrapper = await mountPanel([equipmentRequest()]);

    await wrapper.find("[data-testid='cancel-request']").trigger("click");
    await wrapper.find("[data-testid='confirm-cancel']").trigger("click");
    await flushPromises();

    expect(wrapper.find("[role='alertdialog'] [role='alert']").text()).toContain("only be changed while the event is in Planning");
    expect(wrapper.emitted("changed")).toBeUndefined();
    expect(card(wrapper, 55).find(".badge").text()).toBe("Partially Fulfilled");
  });
});

describe("EquipmentRequestPanel — one table per request", () => {
  const items = [
    { id: 1, equipmentCatalogId: 1, equipmentType: "Projector", quantity: 2, quantityFulfilled: 1, reservationFlag: NO_FLAG },
    { id: 2, equipmentCatalogId: 2, equipmentType: "Screen", quantity: 1, quantityFulfilled: 1, reservationFlag: NO_FLAG },
  ];
  const rowCells = (row: { findAll: (s: string) => { text: () => string }[] }) => row.findAll(".cell").map((c) => c.text());

  it("lists each component with its quantity and how much is reserved, one table for the request", async () => {
    const wrapper = await mountPanel([equipmentRequest({ status: "Partially Fulfilled", items })]);

    const table = card(wrapper, 55).get(".eq-items");
    expect(table.findAll(".cell-header").map((h) => h.text())).toEqual(["Equipment", "Quantity", "Reserved"]);
    const rows = table.findAll(".row-item");
    expect(rows.map(rowCells)).toEqual([
      ["Projector", "2", "1 of 2 Partially fulfilled"],
      ["Screen", "1", "1 of 1 Arranged"],
    ]);
  });

  it("gives every request its own table and shows its single status once, in the header", async () => {
    const wrapper = await mountPanel([
      equipmentRequest({ id: 55, status: "Partially Fulfilled", items }),
      equipmentRequest({ id: 56, status: "Arranged", fulfillmentNote: null, items: [items[1]] }),
    ]);

    expect(wrapper.findAll(".eq-items")).toHaveLength(2);
    for (const [id, status] of [[55, "Partially Fulfilled"], [56, "Arranged"]] as const) {
      const request = card(wrapper, id);
      expect(request.findAll(".badge")).toHaveLength(1);
      expect(request.get(".badge").text()).toBe(status);
      // The request's status is not a column of the table (each item shows its own progress beside its count).
      expect(request.findAll(".eq-items .cell-header").map((h) => h.text())).not.toContain("Status");
    }
  });

  it("puts a reservation warning inside the flagged item's row, under its name", async () => {
    const flagged = [
      { ...items[0], reservationFlag: { flagged: true, reason: "A reserved unit is unavailable." } },
      items[1],
    ];
    const wrapper = await mountPanel([equipmentRequest({ items: flagged })]);

    const [first, second] = wrapper.findAll(".eq-items .row-item");
    expect(first.get("[data-testid='reservation-flag']").text()).toBe("A reserved unit is unavailable.");
    expect(second.find("[data-testid='reservation-flag']").exists()).toBe(false);
  });

  it("replaces the table with the form while a request is being amended", async () => {
    const wrapper = await mountPanel([equipmentRequest({ items })]);
    await wrapper.get("[data-testid='amend-request']").trigger("click");

    expect(wrapper.find(".eq-items").exists()).toBe(false);
    expect(wrapper.find("[data-testid='amend-form']").exists()).toBe(true);
  });
});

describe("EquipmentRequestPanel — Add Equipment Request button", () => {
  it("is a ghost button with a plus icon, labelled Add Equipment Request, like the Add Venue Request button", async () => {
    const wrapper = await mountPanel([equipmentRequest()]);
    const button = wrapper.get("[data-testid='request-new-equipment']");

    expect(button.text()).toBe("Add Equipment Request");
    expect(button.classes()).toContain("btn--ghost");
    expect(button.element.firstElementChild?.tagName.toLowerCase()).toBe("svg");
    expect(button.get("svg").classes()).toContain("eq-new-request__plus");
    expect(wrapper.text()).not.toContain("Record equipment requirements");
  });

  it("opens the request form when clicked, and hides itself while the form is open", async () => {
    const wrapper = await mountPanel([equipmentRequest()]);

    await wrapper.get("[data-testid='request-new-equipment']").trigger("click");

    expect(wrapper.find("[data-testid='request-new-equipment']").exists()).toBe(false);
    expect(wrapper.text()).toContain("Submit request");
  });

  it("is only offered to someone who may submit requests", async () => {
    const wrapper = await mountPanel([equipmentRequest()], false);
    expect(wrapper.find("[data-testid='request-new-equipment']").exists()).toBe(false);
  });
});

