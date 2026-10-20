import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { validateNewCatalogItem } from "../lib/validateCatalogItem.js";
import { validateStockChange } from "../lib/validateStockChange.js";
import { effectiveAvailable, unusableNowByType } from "../lib/effectiveStock.js";

/**
 * E5-1/E5-3 stock tracking (migration 0022): the fixed equipment list
 * Coordinators pick from when recording requirements, and the current-stock
 * table Technical Support see alongside incoming requests. Any authenticated
 * role may read it — it's not sensitive, and both roles need it. Only
 * Technical Support may change it: add an item, or add or remove stock of one
 * with a reason (the total is never overwritten, and available stock is
 * derived from reservations, so it is never edited by hand).
 */
export const equipmentCatalogRouter = Router();

equipmentCatalogRouter.use(requireAuth);

interface CatalogRow {
  id: number;
  name: string;
  total_stock: number;
  available_stock: number;
}

const COLUMNS = "id, name, total_stock, available_stock";

/**
 * `availableStock` is the stored counter (stock not held by requests) minus the
 * units out of use today (E5-5, lib/effectiveStock.ts), so a unit marked
 * damaged or under maintenance drops out of it and returns when its period ends.
 * `unusableNow` is how many units that took off, so the number can be explained.
 */
function toItem(row: CatalogRow, unusableNow = 0) {
  return {
    id: row.id,
    name: row.name,
    totalStock: row.total_stock,
    availableStock: effectiveAvailable(row.available_stock, unusableNow),
    unusableNow,
  };
}

/** Postgres error code: unique_violation. */
const UNIQUE_VIOLATION = "23505";

/** Units are created in batches so a large stock count isn't one enormous insert. */
const UNIT_INSERT_BATCH = 1000;

equipmentCatalogRouter.get("/", async (req: AuthedRequest, res) => {
  const { supabase } = req;
  if (!supabase) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const { data, error } = await supabase.from("equipment_catalog").select(COLUMNS).order("name");

  if (error || !data) {
    res.status(500).json({ error: "Failed to load the equipment catalog" });
    return;
  }

  let unusable: Map<string, number>;
  try {
    unusable = await unusableNowByType(supabase);
  } catch {
    res.status(500).json({ error: "Failed to load the equipment catalog" });
    return;
  }

  res.json({ equipmentCatalog: (data as CatalogRow[]).map((row) => toItem(row, unusable.get(row.name) ?? 0)) });
});

/** Add an item to the inventory. New stock starts fully available. */
equipmentCatalogRouter.post("/", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  if (user.role !== "technical_support") {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const result = validateNewCatalogItem(req.body);
  if (!result.valid) {
    res.status(400).json({ error: "Invalid equipment item", fields: result.fields });
    return;
  }

  const { name, totalStock } = result.value;
  const { data, error } = await supabase
    .from("equipment_catalog")
    .insert({ name, total_stock: totalStock, available_stock: totalStock })
    .select(COLUMNS)
    .single();

  if (error?.code === UNIQUE_VIOLATION) {
    res.status(409).json({
      error: "An equipment item with that name already exists.",
      fields: { name: "Already in use." },
    });
    return;
  }
  if (error || !data) {
    res.status(500).json({ error: "Failed to add the equipment item" });
    return;
  }

  // E5-5: stock is also tracked per physical unit (the equipment table), so
  // each unit can be marked damaged or under maintenance on its own.
  const createdUnitIds: number[] = [];
  for (let created = 0; created < totalStock; created += UNIT_INSERT_BATCH) {
    const batch = Array.from({ length: Math.min(UNIT_INSERT_BATCH, totalStock - created) }, () => ({
      type: name,
      status: "Available",
    }));
    const { data: units, error: unitsError } = await supabase.from("equipment").insert(batch).select("id");
    if (unitsError) {
      // Don't leave a catalog entry whose units don't exist, or units without one.
      if (createdUnitIds.length > 0) await supabase.from("equipment").delete().in("id", createdUnitIds);
      await supabase.from("equipment_catalog").delete().eq("id", (data as CatalogRow).id);
      res.status(500).json({ error: "Failed to add the equipment item" });
      return;
    }
    if (Array.isArray(units)) createdUnitIds.push(...units.map((unit) => unit.id as number));
  }

  res.status(201).json({ equipment: toItem(data as CatalogRow) });
});

/**
 * Add or remove stock of an item, always with a reason. The database function
 * (change_equipment_stock, migration 0044) creates or deletes the matching unit
 * rows, moves total and available stock together, and records the change — all
 * in one step. Removing only takes units that are free (not reserved, not out
 * of use), so it can never pull equipment from under an event; if fewer than
 * asked qualify, nothing changes and the answer says how many can go.
 */
equipmentCatalogRouter.post("/:id/stock", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  if (user.role !== "technical_support") {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!/^[1-9]\d*$/.test(rawId)) {
    res.status(404).json({ error: "Equipment item not found" });
    return;
  }

  const result = validateStockChange(req.body);
  if (!result.valid) {
    res.status(400).json({ error: "Invalid stock change", fields: result.fields });
    return;
  }
  const { direction, quantity, reason } = result.value;

  const { data, error } = await supabase.rpc("change_equipment_stock", {
    p_catalog_id: Number(rawId),
    p_delta: direction === "add" ? quantity : -quantity,
    p_reason: reason,
    p_user: user.id,
  });

  if (error) {
    const message = error.message ?? "";
    const cannotRemove = /only (\d+) can be removed/.exec(message);
    if (cannotRemove) {
      const removable = Number(cannotRemove[1]);
      res.status(409).json({
        error:
          removable === 0
            ? "None of this item's stock can be removed right now: it is all reserved, out of use or held by requests."
            : `Only ${removable} can be removed: the rest is reserved, out of use or held by requests.`,
        fields: { quantity: `At most ${removable}.` },
        removable,
      });
      return;
    }
    if (message.includes("not found")) {
      res.status(404).json({ error: "Equipment item not found" });
      return;
    }
    res.status(500).json({ error: "Failed to change the stock" });
    return;
  }

  const row = data as { id: number; name: string; totalStock: number; availableStock: number };
  let unusableNow = 0;
  try {
    unusableNow = (await unusableNowByType(supabase)).get(row.name) ?? 0;
  } catch {
    // The change is saved; the count shown just won't take out-of-use units off until the page is reloaded.
  }
  res.json({
    equipment: {
      id: row.id,
      name: row.name,
      totalStock: row.totalStock,
      availableStock: effectiveAvailable(row.availableStock, unusableNow),
      unusableNow,
    },
  });
});

interface StockChangeRow {
  id: number;
  change_type: string;
  quantity: number;
  total_before: number;
  total_after: number;
  reason: string;
  changed_by: string | null;
  created_at: string;
}

const HISTORY_LIMIT = 50;

/** The most recent stock changes for an item, newest first (who, when, how much, why). */
equipmentCatalogRouter.get("/:id/stock-history", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  if (user.role !== "technical_support") {
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!/^[1-9]\d*$/.test(rawId)) {
    res.status(404).json({ error: "Equipment item not found" });
    return;
  }

  const { data, error } = await supabase
    .from("equipment_stock_changes")
    .select("id, change_type, quantity, total_before, total_after, reason, changed_by, created_at")
    .eq("equipment_catalog_id", Number(rawId))
    .order("created_at", { ascending: false })
    .limit(HISTORY_LIMIT);
  if (error || !data) {
    res.status(500).json({ error: "Failed to load the stock history" });
    return;
  }

  res.json({
    changes: (data as StockChangeRow[]).map((row) => ({
      id: row.id,
      changeType: row.change_type,
      quantity: row.quantity,
      totalBefore: row.total_before,
      totalAfter: row.total_after,
      reason: row.reason,
      changedBy: row.changed_by,
      createdAt: row.created_at,
    })),
  });
});
