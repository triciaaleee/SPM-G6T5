import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EquipmentAccessDeniedError,
  EquipmentRequestError,
  EquipmentValidationError,
  amendEquipmentRequest,
  cancelEquipmentRequest,
  createCatalogItem,
  fetchEquipmentUnits,
  fetchEquipmentRequestsForSupport,
  changeStock,
  clearUnavailability,
  fetchStockHistory,
  fetchUnitImpact,
  markUnitsUnusable,
  setUnitLabel,
  markUnitUsable,
} from "../equipmentApi";

vi.mock("../eventsApi", () => ({
  authHeader: () => ({ Authorization: "Bearer test-token" }),
  redirectIfUnauthenticated: vi.fn().mockResolvedValue(undefined),
}));

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("equipment units (E5-5)", () => {
  it("lists the units with the bearer token", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { units: [{ id: 12, type: "Projector", status: "Available", periods: [] }] }));

    expect(await fetchEquipmentUnits()).toEqual([{ id: 12, type: "Projector", status: "Available", periods: [] }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/equipment-units$/);
    expect(init.headers).toEqual({ Authorization: "Bearer test-token" });
  });

  it("asks for the impact of marking units for a period, without saving anything", async () => {
    const preview = { type: "Projector", units: [], pickable: 0, suggested: [12] };
    fetchMock.mockResolvedValue(jsonResponse(200, preview));

    expect(await fetchUnitImpact("Projector", { startDate: "2026-11-03", endDate: "2026-11-07", quantity: 2 })).toEqual(preview);

    const [url, init] = fetchMock.mock.calls[0];
    const query = new URL(url).searchParams;
    expect(query.get("type")).toBe("Projector");
    expect(query.get("startDate")).toBe("2026-11-03");
    expect(query.get("endDate")).toBe("2026-11-07");
    expect(query.get("quantity")).toBe("2");
    expect(init.method).toBeUndefined();
  });

  it("leaves the end date and quantity out of the query when they aren't given", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { type: "Projector", units: [], pickable: 0, suggested: [] }));

    await fetchUnitImpact("Projector", { startDate: "2026-11-03" });

    const query = new URL(fetchMock.mock.calls[0][0]).searchParams;
    expect(query.has("endDate")).toBe(false);
    expect(query.has("quantity")).toBe(false);
  });

  it("POSTs the chosen units and returns who was affected", async () => {
    const payload = { periods: [{ unitId: 12 }], affectedEvents: [{ eventId: 1, eventName: "Gala", units: 1 }], notified: true };
    fetchMock.mockResolvedValue(jsonResponse(201, payload));
    const input = { type: "Projector", unitIds: [12], reason: "Damaged" as const, startDate: "2026-11-03", endDate: "2026-11-07", note: "cracked" };

    expect(await markUnitsUnusable(input)).toEqual(payload);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/equipment-units\/mark$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual(input);
  });

  it("throws EquipmentValidationError on a 400 and EquipmentRequestError on any other failure", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { fields: { startDate: "Start date is required." } }));
    const invalid = await markUnitsUnusable({ type: "Projector", unitIds: [12], reason: "Damaged", startDate: "" }).catch((e) => e);
    expect(invalid).toBeInstanceOf(EquipmentValidationError);
    expect(invalid.fields.startDate).toBe("Start date is required.");

    fetchMock.mockResolvedValueOnce(jsonResponse(409, { error: "Projector #12 is already out of use for those dates." }));
    await expect(markUnitsUnusable({ type: "Projector", unitIds: [12], reason: "Damaged", startDate: "2026-11-03" })).rejects.toThrow(
      "already out of use",
    );
  });

  it("clears a group of periods in one request", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { removed: 2 }));

    expect(await clearUnavailability([5, 6])).toBe(2);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/equipment-units\/unavailability\/clear$/);
    expect(JSON.parse(init.body)).toEqual({ periodIds: [5, 6] });

    fetchMock.mockResolvedValueOnce(jsonResponse(400, { error: "Validation failed" }));
    await expect(clearUnavailability([])).rejects.toThrow("Validation failed");
  });

  it("sets a unit's label", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { unit: { id: 12, label: "A-012" } }));

    expect(await setUnitLabel(12, "A-012")).toEqual({ id: 12, label: "A-012" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/equipment-units\/12$/);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ label: "A-012" });
  });

  it("DELETEs a period to mark the unit usable again, and surfaces a refusal", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { removed: true }));
    await markUnitUsable(12, 5);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/equipment-units\/12\/unavailability\/5$/);
    expect(init.method).toBe("DELETE");

    fetchMock.mockResolvedValueOnce(jsonResponse(404, { error: "Unavailability period not found" }));
    await expect(markUnitUsable(12, 99)).rejects.toThrow("Unavailability period not found");
  });
});

describe("amendEquipmentRequest (E5-2)", () => {
  const items = [
    { itemId: 1, equipmentCatalogId: 1, quantity: 3 },
    { equipmentCatalogId: 3, quantity: 2 },
  ];

  it("PUTs the new item list to the request with the bearer token and returns what changed", async () => {
    const payload = { equipmentRequest: { id: 55 }, changes: [{ kind: "added" }], released: 0, notified: true };
    fetchMock.mockResolvedValue(jsonResponse(200, payload));

    expect(await amendEquipmentRequest(55, items)).toEqual(payload);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/55\/items$/);
    expect(init.method).toBe("PUT");
    expect(init.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer test-token" });
    expect(JSON.parse(init.body)).toEqual({ items });
  });

  it("throws EquipmentValidationError with the field errors on a 400", async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { fields: { "items[0].quantity": "Quantity must be greater than zero." } }));

    const error = await amendEquipmentRequest(55, items).catch((e) => e);

    expect(error).toBeInstanceOf(EquipmentValidationError);
    expect(error.fields["items[0].quantity"]).toMatch(/greater than zero/);
  });

  it("throws EquipmentRequestError with the backend's message on any other failure", async () => {
    fetchMock.mockResolvedValue(jsonResponse(409, { error: "A fully arranged request can't be amended." }));

    await expect(amendEquipmentRequest(55, items)).rejects.toThrow("A fully arranged request can't be amended.");
  });
});

describe("cancelEquipmentRequest (E5-2)", () => {
  it("POSTs to the request's cancel route and returns what was released", async () => {
    const payload = { equipmentRequest: { id: 55 }, released: [{ equipmentType: "Projector", quantity: 3 }], notified: true };
    fetchMock.mockResolvedValue(jsonResponse(200, payload));

    expect(await cancelEquipmentRequest(55)).toEqual(payload);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/55\/cancel$/);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ Authorization: "Bearer test-token" });
  });

  it("throws EquipmentRequestError with the backend's message when it is refused", async () => {
    fetchMock.mockResolvedValue(jsonResponse(409, { error: "Equipment requests can only be changed while the event is in Planning." }));

    const error = await cancelEquipmentRequest(55).catch((e) => e);

    expect(error).toBeInstanceOf(EquipmentRequestError);
    expect(error.message).toMatch(/Planning/);
  });
});

describe("fetchEquipmentRequestsForSupport", () => {
  it("requests the event's equipment requests with the bearer token", async () => {
    const payload = { event: { id: 7 }, technicalRequirements: null, equipmentRequests: [] };
    fetchMock.mockResolvedValue(jsonResponse(200, payload));

    const result = await fetchEquipmentRequestsForSupport(7);

    expect(result).toEqual(payload);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/event\/7$/);
    expect(init.headers).toEqual({ Authorization: "Bearer test-token" });
  });

  it("throws EquipmentAccessDeniedError on a 403 (no equipment request for the event)", async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, { error: "Access denied" }));

    await expect(fetchEquipmentRequestsForSupport(7)).rejects.toBeInstanceOf(EquipmentAccessDeniedError);
  });

  it("throws a plain error on other failures", async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, {}));

    const error = await fetchEquipmentRequestsForSupport(7).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(EquipmentAccessDeniedError);
  });
});

describe("createCatalogItem", () => {
  it("posts the name and total stock and returns the new item", async () => {
    const item = { id: 2, name: "Lectern", totalStock: 4, availableStock: 4 };
    fetchMock.mockResolvedValue(jsonResponse(201, { equipment: item }));

    const result = await createCatalogItem("Lectern", 4);

    expect(result).toEqual(item);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/equipment-catalog$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ name: "Lectern", totalStock: 4 });
  });

  it("turns a 409 duplicate into per-field errors", async () => {
    fetchMock.mockResolvedValue(jsonResponse(409, { error: "dup", fields: { name: "Already in use." } }));

    const error = await createCatalogItem("Projector", 1).catch((e) => e);
    expect(error).toBeInstanceOf(EquipmentValidationError);
    expect(error.fields).toEqual({ name: "Already in use." });
  });
});

describe("changeStock", () => {
  it("POSTs the change with its reason and returns the new counts", async () => {
    const item = { id: 1, name: "Projector", totalStock: 12, availableStock: 9 };
    fetchMock.mockResolvedValue(jsonResponse(200, { equipment: item }));

    const result = await changeStock(1, { direction: "add", quantity: 2, reason: "New delivery" });

    expect(result).toEqual(item);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/equipment-catalog\/1\/stock$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ direction: "add", quantity: 2, reason: "New delivery" });
  });

  it("turns a 400 into per-field errors", async () => {
    fetchMock.mockResolvedValue(jsonResponse(400, { error: "bad", fields: { reason: "A reason is required." } }));

    const error = await changeStock(1, { direction: "add", quantity: 2, reason: "" }).catch((e) => e);

    expect(error).toBeInstanceOf(EquipmentValidationError);
    expect(error.fields.reason).toBe("A reason is required.");
  });

  it("throws a request error with the backend's message when too much is removed", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, { error: "Only 2 can be removed: the rest is reserved, out of use or held by requests.", removable: 2 }),
    );

    const error = await changeStock(1, { direction: "remove", quantity: 5, reason: "Sold" }).catch((e) => e);

    expect(error).toBeInstanceOf(EquipmentRequestError);
    expect(error.message).toBe("Only 2 can be removed: the rest is reserved, out of use or held by requests.");
  });
});

describe("fetchStockHistory", () => {
  it("lists the item's changes with the bearer token", async () => {
    const changes = [{ id: 1, changeType: "Added", quantity: 2, totalBefore: 10, totalAfter: 12, reason: "Delivery", changedBy: "TS-0001", createdAt: "x" }];
    fetchMock.mockResolvedValue(jsonResponse(200, { changes }));

    expect(await fetchStockHistory(1)).toEqual(changes);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/equipment-catalog\/1\/stock-history$/);
    expect(init.headers).toEqual({ Authorization: "Bearer test-token" });
  });
});
