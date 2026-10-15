import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { validateCatalogChanges, validateNewCatalogItem } from "../lib/validateCatalogItem.js";

/**
 * E5-1/E5-3 stock tracking (migration 0022): the fixed equipment list
 * Coordinators pick from when recording requirements, and the current-stock
 * table Technical Support see alongside incoming requests. Any authenticated
 * role may read it — it's not sensitive, and both roles need it. Only
 * Technical Support may change it (E5-1 AC3: view and update item records
 * and availability).
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

function toItem(row: CatalogRow) {
  return { id: row.id, name: row.name, totalStock: row.total_stock, availableStock: row.available_stock };
}

/** Postgres error codes: unique_violation, check_violation. */
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";

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

  res.json({ equipmentCatalog: (data as CatalogRow[]).map(toItem) });
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

  res.status(201).json({ equipment: toItem(data as CatalogRow) });
});

/**
 * Correct an item's stock. `availableStock` cannot exceed `totalStock`
 * (checked against the current value of whichever field is left out, and
 * again by the table's own constraint). This is a manual correction; request
 * status changes keep moving available stock through
 * apply_equipment_request_status.
 */
equipmentCatalogRouter.patch("/:id", async (req: AuthedRequest, res) => {
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

  const result = validateCatalogChanges(req.body);
  if (!result.valid) {
    res.status(400).json({ error: "Invalid equipment item", fields: result.fields });
    return;
  }

  const { data: current, error: currentError } = await supabase
    .from("equipment_catalog")
    .select(COLUMNS)
    .eq("id", Number(rawId))
    .maybeSingle();

  if (currentError) {
    res.status(500).json({ error: "Failed to load the equipment item" });
    return;
  }
  if (!current) {
    res.status(404).json({ error: "Equipment item not found" });
    return;
  }

  const row = current as CatalogRow;
  const total = result.value.totalStock ?? row.total_stock;
  const available = result.value.availableStock ?? row.available_stock;
  if (available > total) {
    res.status(400).json({
      error: "Available stock cannot be more than total stock.",
      fields: { availableStock: "Cannot be more than total stock." },
    });
    return;
  }

  const { data, error } = await supabase
    .from("equipment_catalog")
    .update({ total_stock: total, available_stock: available })
    .eq("id", row.id)
    .select(COLUMNS)
    .single();

  if (error?.code === CHECK_VIOLATION) {
    res.status(400).json({ error: "Those stock numbers aren't allowed.", fields: { availableStock: "Not allowed." } });
    return;
  }
  if (error || !data) {
    res.status(500).json({ error: "Failed to update the equipment item" });
    return;
  }

  res.json({ equipment: toItem(data as CatalogRow) });
});
