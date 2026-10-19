import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EquipmentAccessDeniedError,
  EquipmentRequestError,
  EquipmentValidationError,
  amendEquipmentRequest,
  cancelEquipmentRequest,
  createCatalogItem,
  fetchEquipmentRequestsForSupport,
  updateCatalogItem,
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

describe("updateCatalogItem", () => {
  it("patches the item's stock", async () => {
    const item = { id: 1, name: "Projector", totalStock: 12, availableStock: 9 };
    fetchMock.mockResolvedValue(jsonResponse(200, { equipment: item }));

    const result = await updateCatalogItem(1, { totalStock: 12, availableStock: 9 });

    expect(result).toEqual(item);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/equipment-catalog\/1$/);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ totalStock: 12, availableStock: 9 });
  });

  it("turns a 400 into per-field errors", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(400, { error: "bad", fields: { availableStock: "Cannot be more than total stock." } }),
    );

    const error = await updateCatalogItem(1, { availableStock: 99 }).catch((e) => e);
    expect(error).toBeInstanceOf(EquipmentValidationError);
    expect(error.fields.availableStock).toBe("Cannot be more than total stock.");
  });

  it("throws a request error with the backend's message otherwise", async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { error: "Equipment item not found" }));

    const error = await updateCatalogItem(99, { totalStock: 1 }).catch((e) => e);
    expect(error).toBeInstanceOf(EquipmentRequestError);
    expect(error.message).toBe("Equipment item not found");
  });
});
