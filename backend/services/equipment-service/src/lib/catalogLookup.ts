/**
 * The API still names equipment by its catalog name (`?type=Projector`); inside,
 * units are tied to their catalog item by id (migration 0048). This turns the
 * name into the id once, at the edge. Resolves null when no such item exists.
 * Throws if the catalog can't be read.
 */
export async function findCatalogIdByName(supabase: any, name: string): Promise<number | null> {
  const { data, error } = await supabase.from("equipment_catalog").select("id").eq("name", name).maybeSingle();
  if (error) throw new Error("Failed to load the equipment catalog");
  return data ? (data.id as number) : null;
}
