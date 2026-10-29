// @ts-nocheck
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchEventEquipmentRequests } from "../lib/arrangementsClient.js";
import { findOutstandingArrangements } from "../lib/safetyReview.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubEquipmentService(equipmentRequests: { id: number; status: string; items: unknown[] }[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ equipmentRequests }) })),
  );
}

describe("fetchEventEquipmentRequests (E5-2)", () => {
  const arranged = {
    id: 1,
    status: "Arranged",
    items: [{ id: 10, equipmentType: "Projector", quantity: 2, quantityFulfilled: 2 }],
  };
  const cancelled = {
    id: 2,
    status: "Cancelled",
    items: [{ id: 11, equipmentType: "Screen", quantity: 1, quantityFulfilled: 0 }],
  };

  it("leaves out a request the coordinator cancelled", async () => {
    stubEquipmentService([arranged, cancelled]);

    const result = await fetchEventEquipmentRequests(7, "Bearer test-token");

    expect(result).toEqual({ status: "ok", value: [arranged] });
  });

  it("so a cancelled request can't hold the event back from safety review as an outstanding arrangement", async () => {
    stubEquipmentService([arranged, cancelled]);

    const result = await fetchEventEquipmentRequests(7, "Bearer test-token");
    if (result.status !== "ok") throw new Error("expected ok");
    const outstanding = findOutstandingArrangements([], result.value);

    expect(JSON.stringify(outstanding)).not.toContain("Screen");
  });

  it("passes an equipment-service failure on", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));

    expect(await fetchEventEquipmentRequests(7, "Bearer test-token")).toEqual({ status: "error" });
  });
});
