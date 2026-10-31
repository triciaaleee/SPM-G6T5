import { describe, expect, it } from "vitest";
import { findCatalogIdByName } from "../lib/catalogLookup.js";
import { createFakeDb } from "./helpers/fakeDb.js";

describe("findCatalogIdByName", () => {
  const seed = { equipment_catalog: [{ id: 3, name: "Projector" }, { id: 4, name: "Microphone" }] };

  it("resolves a catalog name to its id", async () => {
    expect(await findCatalogIdByName(createFakeDb(seed), "Microphone")).toBe(4);
  });

  it("is case-sensitive and exact", async () => {
    expect(await findCatalogIdByName(createFakeDb(seed), "projector")).toBeNull();
  });

  it("is null when no such item exists", async () => {
    expect(await findCatalogIdByName(createFakeDb(seed), "Laser")).toBeNull();
  });

  it("throws when the catalog can't be read", async () => {
    const db = createFakeDb(seed);
    db.failOn("equipment_catalog", "select");
    await expect(findCatalogIdByName(db, "Projector")).rejects.toThrow("Failed to load the equipment catalog");
  });
});
