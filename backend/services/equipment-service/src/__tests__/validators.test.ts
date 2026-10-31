import { describe, expect, it } from "vitest";
import { validateAvailabilityQuery } from "../lib/validateAvailabilityQuery.js";
import { validateNewCatalogItem } from "../lib/validateCatalogItem.js";
import {
  EQUIPMENT_REQUEST_STATUSES,
  validateAmendedItems,
  validateEquipmentItems,
  validateStatusUpdate,
} from "../lib/validateEquipmentRequest.js";
import { validateStockChange } from "../lib/validateStockChange.js";
import { isRealDate, validateUnavailability } from "../lib/validateUnavailability.js";

describe("validateAvailabilityQuery", () => {
  it("accepts a good query, trimming the type and coercing numbers", () => {
    expect(validateAvailabilityQuery({ eventId: "7", type: "  Projector ", quantity: "3" })).toEqual({
      valid: true,
      fields: {},
      value: { eventId: 7, type: "Projector", quantity: 3 },
    });
  });

  it.each([[undefined], [null], [""], ["abc"], ["0"], ["-1"], ["1.5"], ["Infinity"], [0], [-3], [2.5], [NaN]])(
    "rejects eventId and quantity of %s",
    (bad) => {
      const out = validateAvailabilityQuery({ eventId: bad, type: "Projector", quantity: bad });
      expect(out.valid).toBe(false);
      expect(out.fields).toEqual({
        eventId: "A valid eventId is required.",
        quantity: "Quantity must be a whole number greater than zero.",
      });
      expect(out.value).toBeUndefined();
    },
  );

  it("accepts 1 as the smallest quantity", () => {
    expect(validateAvailabilityQuery({ eventId: 1, type: "x", quantity: 1 }).valid).toBe(true);
  });

  it("rejects a missing, blank or non-string type", () => {
    for (const type of [undefined, "", "   ", 5, ["a"]]) {
      expect(validateAvailabilityQuery({ eventId: 1, type, quantity: 1 }).fields).toEqual({ type: "Equipment type is required." });
    }
  });

  it("reports only the broken fields", () => {
    expect(validateAvailabilityQuery({ eventId: 1, type: "x", quantity: 0 }).fields).toEqual({
      quantity: "Quantity must be a whole number greater than zero.",
    });
    expect(validateAvailabilityQuery({ eventId: 0, type: "x", quantity: 1 }).fields).toEqual({ eventId: "A valid eventId is required." });
  });
});

describe("validateNewCatalogItem", () => {

  it("defaults stock to 0 and accepts numeric strings", () => {
    expect(validateNewCatalogItem({ name: "X" })).toEqual({ valid: true, value: { name: "X", totalStock: 0 } });
    expect(validateNewCatalogItem({ name: "X", totalStock: null })).toEqual({ valid: true, value: { name: "X", totalStock: 0 } });
    expect(validateNewCatalogItem({ name: "X", totalStock: " 12 " })).toEqual({ valid: true, value: { name: "X", totalStock: 12 } });
  });

  it("limits the name to 100 characters", () => {
    expect(validateNewCatalogItem({ name: "a".repeat(100) }).valid).toBe(true);
    expect(validateNewCatalogItem({ name: "a".repeat(101) })).toEqual({ valid: false, fields: { name: "Use at most 100 characters." } });
  });

  it("requires a name", () => {
    for (const body of [{}, { name: "" }, { name: "   " }, { name: 5 }, null, undefined, "str", 42]) {
      expect(validateNewCatalogItem(body)).toEqual({ valid: false, fields: { name: "Enter an equipment name." } });
    }
  });

  it("limits stock to whole numbers from 0 to 100000", () => {
    expect(validateNewCatalogItem({ name: "X", totalStock: 0 }).valid).toBe(true);
    expect(validateNewCatalogItem({ name: "X", totalStock: 100000 }).valid).toBe(true);
    for (const totalStock of [-1, 100001, 1.5, "1.5", "abc", "", "  ", true, [], {}, NaN]) {
      expect(validateNewCatalogItem({ name: "X", totalStock })).toEqual({
        valid: false,
        fields: { totalStock: "Total stock must be a whole number, 0 or more." },
      });
    }
  });

  it("reports every problem at once", () => {
    const out = validateNewCatalogItem({ name: "", totalStock: -1 });
    expect(out).toEqual({
      valid: false,
      fields: { name: "Enter an equipment name.", totalStock: "Total stock must be a whole number, 0 or more." },
    });
  });
});

describe("validateStockChange", () => {
  const ok = { direction: "add", quantity: 5, reason: "Bought more" };

  it("accepts add and remove", () => {
    expect(validateStockChange(ok)).toEqual({ valid: true, value: { direction: "add", quantity: 5, reason: "Bought more" } });
    expect(validateStockChange({ ...ok, direction: "remove" })).toMatchObject({ valid: true, value: { direction: "remove" } });
  });

  it("trims the reason and accepts a numeric-string quantity", () => {
    expect(validateStockChange({ ...ok, quantity: " 7 ", reason: "  why  " })).toEqual({
      valid: true,
      value: { direction: "add", quantity: 7, reason: "why" },
    });
  });

  it("limits quantity to whole numbers from 1 to 100000", () => {
    expect(validateStockChange({ ...ok, quantity: 1 }).valid).toBe(true);
    expect(validateStockChange({ ...ok, quantity: 100000 }).valid).toBe(true);
    for (const quantity of [0, -1, 100001, 1.5, "abc", "", "  ", undefined, null, true, NaN]) {
      expect(validateStockChange({ ...ok, quantity })).toEqual({
        valid: false,
        fields: { quantity: "Enter a whole number from 1 to 100000." },
      });
    }
  });

  it("limits the reason to 500 characters and requires one", () => {
    expect(validateStockChange({ ...ok, reason: "r".repeat(500) }).valid).toBe(true);
    expect(validateStockChange({ ...ok, reason: "r".repeat(501) })).toEqual({ valid: false, fields: { reason: "Use at most 500 characters." } });
    for (const reason of [undefined, "", "   ", 5]) {
      expect(validateStockChange({ ...ok, reason })).toEqual({ valid: false, fields: { reason: "A reason is required." } });
    }
  });

  it("requires add or remove", () => {
    for (const direction of [undefined, "", "Add", "set", 1]) {
      expect(validateStockChange({ ...ok, direction })).toEqual({ valid: false, fields: { direction: "Choose add or remove." } });
    }
  });

  it("treats a non-object body as empty and reports everything", () => {
    for (const body of [null, undefined, "x", 5]) {
      expect(validateStockChange(body)).toEqual({
        valid: false,
        fields: {
          direction: "Choose add or remove.",
          quantity: "Enter a whole number from 1 to 100000.",
          reason: "A reason is required.",
        },
      });
    }
  });
});

describe("isRealDate", () => {
  it("accepts real dates and rejects impossible or malformed ones", () => {
    expect(isRealDate("2026-02-28")).toBe(true);
    expect(isRealDate("2028-02-29")).toBe(true);
    expect(isRealDate("2026-02-29")).toBe(false);
    expect(isRealDate("2026-02-30")).toBe(false);
    expect(isRealDate("2026-13-01")).toBe(false);
    expect(isRealDate("2026-00-10")).toBe(false);
    expect(isRealDate("2026-04-31")).toBe(false);
    expect(isRealDate("2026-4-1")).toBe(false);
    expect(isRealDate("2026-04-01T00:00")).toBe(false);
    expect(isRealDate("")).toBe(false);
  });
});

describe("validateUnavailability", () => {
  const ok = { reason: "Damaged", startDate: "2026-11-01", endDate: "2026-11-03", note: "cracked lens" };

  it("accepts a full input", () => {
    expect(validateUnavailability(ok)).toEqual({
      valid: true,
      fields: {},
      value: { reason: "Damaged", startDate: "2026-11-01", endDate: "2026-11-03", note: "cracked lens" },
    });
  });

  it("accepts both reasons, trimming everything", () => {
    expect(validateUnavailability({ ...ok, reason: " Under Maintenance ", startDate: " 2026-11-01 ", endDate: " 2026-11-01 ", note: " n " })).toEqual({
      valid: true,
      fields: {},
      value: { reason: "Under Maintenance", startDate: "2026-11-01", endDate: "2026-11-01", note: "n" },
    });
  });

  it("makes end date and note optional", () => {
    for (const endDate of [undefined, null, "", "   ", 5]) {
      expect(validateUnavailability({ ...ok, endDate, note: undefined }).value).toEqual({
        reason: "Damaged", startDate: "2026-11-01", endDate: null, note: null,
      });
    }
    expect(validateUnavailability({ ...ok, note: "   " }).value!.note).toBeNull();
  });

  it("rejects an unknown reason", () => {
    for (const reason of [undefined, "", "Lost", "damaged", 3]) {
      expect(validateUnavailability({ ...ok, reason }).fields).toEqual({ reason: "Choose one of: Damaged, Under Maintenance." });
    }
  });

  it("requires a real start date", () => {
    for (const startDate of [undefined, "", "   ", 5]) {
      expect(validateUnavailability({ ...ok, startDate }).fields).toEqual({ startDate: "Start date is required." });
    }
    for (const startDate of ["2026-02-30", "nope", "2026-1-1"]) {
      expect(validateUnavailability({ ...ok, startDate }).fields).toEqual({ startDate: "Enter a valid date." });
    }
  });

  it("rejects a malformed end date, and an end before the start", () => {
    expect(validateUnavailability({ ...ok, endDate: "2026-02-30" }).fields).toEqual({ endDate: "Enter a valid date." });
    expect(validateUnavailability({ ...ok, endDate: "2026-10-31" }).fields).toEqual({ endDate: "End date can't be before the start date." });
    expect(validateUnavailability({ ...ok, endDate: "2026-11-01" }).valid).toBe(true);
  });

  it("does not compare the end date with an invalid start date", () => {
    const out = validateUnavailability({ ...ok, startDate: "bad", endDate: "2020-01-01" });
    expect(out.fields).toEqual({ startDate: "Enter a valid date." });
  });

  it("limits the note to 500 characters", () => {
    expect(validateUnavailability({ ...ok, note: "n".repeat(500) }).valid).toBe(true);
    expect(validateUnavailability({ ...ok, note: "n".repeat(501) }).fields).toEqual({ note: "Use at most 500 characters." });
  });

  it("treats a non-object body as empty", () => {
    for (const body of [null, undefined, "x", 5]) {
      expect(validateUnavailability(body).fields).toEqual({
        reason: "Choose one of: Damaged, Under Maintenance.",
        startDate: "Start date is required.",
      });
    }
  });
});

describe("validateEquipmentItems", () => {
  it("requires a non-empty array", () => {
    for (const input of [undefined, null, [], {}, "x", 5]) {
      expect(validateEquipmentItems(input)).toEqual({ valid: false, fields: { items: "At least one equipment item is required." } });
    }
  });

  it("allows at most 50 items", () => {
    const item = { equipmentCatalogId: 1, quantity: 1 };
    expect(validateEquipmentItems(Array(50).fill(item)).valid).toBe(true);
    expect(validateEquipmentItems(Array(51).fill(item))).toEqual({
      valid: false,
      fields: { items: "At most 50 items are allowed per request." },
    });
  });

  it("normalises ids and quantities to numbers", () => {
    expect(validateEquipmentItems([{ equipmentCatalogId: "3", quantity: " 4 " }, { equipmentCatalogId: 5, quantity: 1 }])).toEqual({
      valid: true,
      fields: {},
      value: [{ equipmentCatalogId: 3, quantity: 4 }, { equipmentCatalogId: 5, quantity: 1 }],
    });
  });

  it("requires a positive whole catalog id", () => {
    for (const equipmentCatalogId of [undefined, null, "", "abc", 0, -2, 1.5]) {
      expect(validateEquipmentItems([{ equipmentCatalogId, quantity: 1 }]).fields).toEqual({
        "items[0].equipmentCatalogId": "Select an equipment type.",
      });
    }
  });

  it("requires a quantity: present, whole, above zero", () => {
    const q = (quantity: unknown) => validateEquipmentItems([{ equipmentCatalogId: 1, quantity }]).fields;
    for (const quantity of [undefined, null, "", "   "]) expect(q(quantity)).toEqual({ "items[0].quantity": "Quantity is required." });
    for (const quantity of ["abc", 1.5, "2.5", NaN, Infinity]) expect(q(quantity)).toEqual({ "items[0].quantity": "Enter a whole number." });
    for (const quantity of [0, -1, "-3"]) expect(q(quantity)).toEqual({ "items[0].quantity": "Quantity must be greater than zero." });
    expect(q(1)).toEqual({});
  });

  it("reports each bad item by index, and treats non-object rows as empty", () => {
    const out = validateEquipmentItems([{ equipmentCatalogId: 1, quantity: 1 }, null, "str", { equipmentCatalogId: 2, quantity: 0 }]);
    expect(out.valid).toBe(false);
    expect(out.fields).toEqual({
      "items[1].equipmentCatalogId": "Select an equipment type.",
      "items[1].quantity": "Quantity is required.",
      "items[2].equipmentCatalogId": "Select an equipment type.",
      "items[2].quantity": "Quantity is required.",
      "items[3].quantity": "Quantity must be greater than zero.",
    });
    expect(out.value).toBeUndefined();
  });
});

describe("validateStatusUpdate", () => {
  const items = [{ id: 1, quantity: 4 }, { id: 2, quantity: 2 }];

  it("accepts Requested and Arranged, with no note and no fulfillments", () => {
    for (const status of ["Requested", "Arranged"]) {
      expect(validateStatusUpdate({ status, note: "stale note", fulfillments: [{ itemId: 1, fulfilledQuantity: 1 }] }, items)).toEqual({
        valid: true,
        fields: {},
        value: { status, note: null, fulfillments: [] },
      });
    }
  });

  it("rejects an unknown status, listing the real ones", () => {
    for (const status of [undefined, "", "Done", "arranged", 3]) {
      expect(validateStatusUpdate({ status }, items).fields).toEqual({
        status: `Status must be one of: ${EQUIPMENT_REQUEST_STATUSES.join(", ")}.`,
      });
    }
  });

  it("requires a note for Partially Fulfilled, and keeps it trimmed", () => {
    const fulfillments = [{ itemId: 1, fulfilledQuantity: 2 }, { itemId: 2, fulfilledQuantity: 0 }];
    expect(validateStatusUpdate({ status: "Partially Fulfilled", fulfillments }, items).fields).toEqual({
      note: "A note describing what remains outstanding is required.",
    });
    expect(validateStatusUpdate({ status: "Partially Fulfilled", note: "   ", fulfillments }, items).fields.note).toBeDefined();
    expect(validateStatusUpdate({ status: " Partially Fulfilled ", note: "  need 2 more ", fulfillments }, items)).toEqual({
      valid: true,
      fields: {},
      value: {
        status: "Partially Fulfilled",
        note: "need 2 more",
        fulfillments: [{ itemId: 1, fulfilledQuantity: 2 }, { itemId: 2, fulfilledQuantity: 0 }],
      },
    });
  });

  it("needs a fulfilled quantity for every item", () => {
    const out = validateStatusUpdate({ status: "Partially Fulfilled", note: "n", fulfillments: [{ itemId: 1, fulfilledQuantity: 1 }] }, items);
    expect(out.fields).toEqual({ "fulfillments[2]": "Enter how many of this item were fulfilled." });
    for (const fulfillments of [undefined, "x", null, {}]) {
      const none = validateStatusUpdate({ status: "Partially Fulfilled", note: "n", fulfillments }, items);
      expect(Object.keys(none.fields)).toEqual(["fulfillments[1]", "fulfillments[2]"]);
    }
  });

  it("rejects a non-whole fulfilled quantity", () => {
    for (const fulfilledQuantity of ["abc", 1.5, NaN, undefined]) {
      const out = validateStatusUpdate({ status: "Partially Fulfilled", note: "n", fulfillments: [{ itemId: 1, fulfilledQuantity }, { itemId: 2, fulfilledQuantity: 1 }] }, items);
      expect(out.fields).toEqual({ "fulfillments[1]": "Enter how many of this item were fulfilled." });
    }
  });

  it("limits a fulfilled quantity to 0..requested quantity", () => {
    const run = (n: number) =>
      validateStatusUpdate({ status: "Partially Fulfilled", note: "n", fulfillments: [{ itemId: 1, fulfilledQuantity: n }, { itemId: 2, fulfilledQuantity: 0 }] }, items);
    expect(run(0).valid).toBe(true);
    expect(run(4).valid).toBe(true);
    expect(run(-1).fields).toEqual({ "fulfillments[1]": "Enter a number between 0 and 4." });
    expect(run(5).fields).toEqual({ "fulfillments[1]": "Enter a number between 0 and 4." });
  });

  it("matches fulfillments to items by itemId and ignores unknown or malformed rows", () => {
    const out = validateStatusUpdate(
      {
        status: "Partially Fulfilled",
        note: "n",
        fulfillments: [null, "junk", { itemId: 99, fulfilledQuantity: 1 }, { itemId: "2", fulfilledQuantity: "1" }, { itemId: 1, fulfilledQuantity: 3 }],
      },
      items,
    );
    expect(out.value!.fulfillments).toEqual([{ itemId: 1, fulfilledQuantity: 3 }, { itemId: 2, fulfilledQuantity: 1 }]);
  });

  it("does not check fulfillments when the status itself is invalid", () => {
    const out = validateStatusUpdate({ status: "Nope", note: "", fulfillments: [] }, items);
    expect(Object.keys(out.fields)).toEqual(["status"]);
  });

  it("with no items, Partially Fulfilled needs only a note", () => {
    expect(validateStatusUpdate({ status: "Partially Fulfilled", note: "n" }, []).value).toEqual({
      status: "Partially Fulfilled", note: "n", fulfillments: [],
    });
  });
});

describe("validateAmendedItems", () => {
  it("passes base validation errors straight through", () => {
    expect(validateAmendedItems([])).toEqual({ valid: false, fields: { items: "At least one equipment item is required." } });
    expect(validateAmendedItems([{ equipmentCatalogId: 0, quantity: 1 }]).fields).toEqual({
      "items[0].equipmentCatalogId": "Select an equipment type.",
    });
  });

  it("keeps new rows as they are and tags existing rows with their itemId", () => {
    expect(
      validateAmendedItems([
        { equipmentCatalogId: 1, quantity: 2 },
        { equipmentCatalogId: 2, quantity: 3, itemId: "9" },
        { equipmentCatalogId: 3, quantity: 1, itemId: null },
        { equipmentCatalogId: 4, quantity: 1, itemId: "" },
      ]),
    ).toEqual({
      valid: true,
      fields: {},
      value: [
        { equipmentCatalogId: 1, quantity: 2 },
        { equipmentCatalogId: 2, quantity: 3, itemId: 9 },
        { equipmentCatalogId: 3, quantity: 1 },
        { equipmentCatalogId: 4, quantity: 1 },
      ],
    });
  });

  it("rejects an item id that is not a positive whole number", () => {
    for (const itemId of ["abc", 0, -1, 1.5]) {
      expect(validateAmendedItems([{ equipmentCatalogId: 1, quantity: 1, itemId }]).fields).toEqual({ "items[0].itemId": "Unknown item." });
    }
  });

  it("rejects the same existing item twice", () => {
    const out = validateAmendedItems([
      { equipmentCatalogId: 1, quantity: 1, itemId: 5 },
      { equipmentCatalogId: 2, quantity: 1, itemId: 5 },
    ]);
    expect(out).toEqual({ valid: false, fields: { "items[1].itemId": "This item appears more than once." } });
  });
});
