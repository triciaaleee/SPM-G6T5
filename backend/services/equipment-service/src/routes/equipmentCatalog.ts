import { Router } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";

/**
 * E5-1/E5-3 stock tracking (migration 0022): the fixed equipment list
 * Coordinators pick from when recording requirements, and the current-stock
 * table Technical Support see alongside incoming requests. Any authenticated
 * role may read it — it's not sensitive, and both roles need it.
 */
export const equipmentCatalogRouter = Router();

equipmentCatalogRouter.use(requireAuth);

equipmentCatalogRouter.get("/", async (req: AuthedRequest, res) => {
  const { supabase } = req;
  if (!supabase) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const { data, error } = await supabase
    .from("equipment_catalog")
    .select("id, name, total_stock, available_stock")
    .order("name");

  if (error || !data) {
    res.status(500).json({ error: "Failed to load the equipment catalog" });
    return;
  }

  res.json({
    equipmentCatalog: data.map((row) => ({
      id: row.id,
      name: row.name,
      totalStock: row.total_stock,
      availableStock: row.available_stock,
    })),
  });
});
