import { Router } from "express";
import type { Response } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth } from "../middleware/auth.js";
import { getPublisher } from "../lib/rabbitPublisher.js";
import { reportArrangementsChanged } from "../lib/eventsClient.js";
import { todaySingapore } from "../lib/effectiveStock.js";
import { dateRangeWindow } from "../lib/scheduleWindow.js";
import { impactForUnits, suggestUnits, type ImpactUnit, type UnitRecord } from "../lib/unitImpact.js";
import { UNAVAILABILITY_COLUMNS, fetchUnavailability, type UnavailabilityRow } from "../lib/unitUnavailability.js";
import { isRealDate, validateUnavailability } from "../lib/validateUnavailability.js";

/**
 * E5-5: Technical Support mark physical equipment units damaged or under
 * maintenance for a period, so they stop being offered to events (AC1), and the
 * assigned coordinator of every event holding a reservation on one of them in
 * that period is told (AC2). Periods live in equipment_unavailability
 * (migration 0043); the availability check and the reservation claim read them,
 * so an excluded unit is never offered.
 *
 * Units are interchangeable and anonymous (an id, plus an optional label), so
 * the usual way to mark them is by quantity: GET /impact shows which units
 * would go and which events that touches, and Technical Support confirm with
 * POST /mark (the units they ticked). Nothing is saved or sent until then.
 */
export const equipmentUnitsRouter = Router();

equipmentUnitsRouter.use(requireAuth);

const MAX_UNITS_PER_REQUEST = 500;
const MAX_LABEL_LENGTH = 50;

function isPositiveInteger(value: unknown): boolean {
  return typeof value === "string" && /^[1-9]\d*$/.test(value);
}

function toPeriod(row: UnavailabilityRow) {
  return { id: row.id, reason: row.reason, startDate: row.start_date, endDate: row.end_date, note: row.note };
}

/** Writes the 401/403 and returns false unless the caller is Technical Support. */
function requireSupport(req: AuthedRequest, res: Response): boolean {
  if (!req.supabase || !req.user) {
    res.status(401).json({ error: "Unauthenticated" });
    return false;
  }
  if (req.user.role !== "technical_support") {
    res.status(403).json({ error: "Only Technical Support can manage equipment units" });
    return false;
  }
  return true;
}

function eventSummary(event: ImpactUnit["events"][number]) {
  return { eventId: event.eventId, eventName: event.eventName, proposedDate: event.proposedDate, startTime: event.startTime };
}

/**
 * Every physical unit (optionally one `?type=`), with the unavailability
 * periods that are running or still to come — a finished period is history,
 * not something to act on. `status` is the unit's own condition (Available, or
 * Damaged/Under Maintenance with no end), `periods` the dated ones.
 */
equipmentUnitsRouter.get("/", async (req: AuthedRequest, res) => {
  if (!requireSupport(req, res)) return;
  const supabase = req.supabase!;

  const type = typeof req.query.type === "string" && req.query.type.trim() !== "" ? req.query.type.trim() : null;
  let unitsQuery = supabase.from("equipment").select("id, type, status, label").order("type").order("id");
  if (type) unitsQuery = unitsQuery.eq("type", type);
  const { data: unitRows, error: unitsError } = await unitsQuery;
  if (unitsError || !unitRows) {
    res.status(500).json({ error: "Failed to load equipment units" });
    return;
  }
  const units = unitRows as UnitRecord[];

  let periods: UnavailabilityRow[];
  try {
    periods = await fetchUnavailability(
      supabase,
      units.map((unit) => unit.id),
    );
  } catch {
    res.status(500).json({ error: "Failed to load equipment unavailability" });
    return;
  }

  const cutoff = todaySingapore();
  res.json({
    units: units.map((unit) => ({
      id: unit.id,
      type: unit.type,
      status: unit.status,
      label: unit.label ?? null,
      periods: periods
        .filter((p) => p.equipment_id === unit.id && (p.end_date === null || p.end_date >= cutoff))
        .sort((a, b) => a.start_date.localeCompare(b.start_date) || a.id - b.id)
        .map(toPeriod),
    })),
  });
});

/**
 * The preview before marking units unusable: every unit of `type` with its
 * state for the period — free, reserved (and for which events), or already out
 * of use. With `quantity` it also suggests which units to take: free ones
 * first, then reserved ones whose events are furthest away. Read-only.
 */
equipmentUnitsRouter.get("/impact", async (req: AuthedRequest, res) => {
  if (!requireSupport(req, res)) return;
  const supabase = req.supabase!;

  const type = typeof req.query.type === "string" ? req.query.type.trim() : "";
  const startDate = typeof req.query.startDate === "string" ? req.query.startDate.trim() : "";
  const endDate = typeof req.query.endDate === "string" && req.query.endDate.trim() !== "" ? req.query.endDate.trim() : null;
  const quantityRaw = typeof req.query.quantity === "string" && req.query.quantity.trim() !== "" ? Number(req.query.quantity) : null;

  const fields: Record<string, string> = {};
  if (type === "") fields.type = "Choose an equipment type.";
  if (!isRealDate(startDate)) fields.startDate = "Enter a valid start date.";
  if (endDate !== null && !isRealDate(endDate)) fields.endDate = "Enter a valid end date.";
  else if (endDate !== null && !fields.startDate && endDate < startDate) fields.endDate = "End date can't be before the start date.";
  if (quantityRaw !== null && (!Number.isInteger(quantityRaw) || quantityRaw < 1)) fields.quantity = "Enter a whole number, 1 or more.";
  if (Object.keys(fields).length > 0) {
    res.status(400).json({ error: "Validation failed", fields });
    return;
  }

  const { data: unitRows, error: unitsError } = await supabase.from("equipment").select("id, type, status, label").eq("type", type).order("id");
  if (unitsError || !unitRows) {
    res.status(500).json({ error: "Failed to load equipment units" });
    return;
  }

  const period = dateRangeWindow(startDate, endDate)!;
  let impact;
  try {
    impact = await impactForUnits(supabase, req.headers.authorization!, unitRows as UnitRecord[], period);
  } catch {
    res.status(500).json({ error: "Failed to check the equipment's reservations" });
    return;
  }
  if (!impact.eventsOk) {
    res.status(502).json({ error: "Couldn't check which events these units are reserved for. Please try again." });
    return;
  }

  res.json({
    type,
    units: impact.units.map((unit) => ({
      id: unit.id,
      label: unit.label,
      state: unit.state,
      reason: unit.reason,
      events: unit.events.map(eventSummary),
    })),
    pickable: impact.units.filter((u) => u.state !== "unavailable").length,
    suggested: quantityRaw === null ? [] : suggestUnits(impact.units, quantityRaw),
  });
});

/**
 * AC1: mark the given units of one type unusable from `startDate` to `endDate`
 * (no end = until marked usable again), one period per unit. From then on the
 * availability check and the reservation claim skip them for any event
 * overlapping that period.
 *
 * AC2: every reservation those units hold for an event in that period is found,
 * and each such event's assigned coordinator is notified once
 * (`equipment.unusable`, with how many of their units are affected). The
 * reservations themselves are left alone and show as flagged
 * (lib/reservationFlags.ts) for Technical Support to re-arrange. Notices are
 * best-effort: a failure never undoes the saved periods, and `notified` says
 * whether they all went out.
 */
equipmentUnitsRouter.post("/mark", async (req: AuthedRequest, res) => {
  if (!requireSupport(req, res)) return;
  const supabase = req.supabase!;
  const user = req.user!;

  const body = (req.body ?? {}) as { type?: unknown; unitIds?: unknown };
  const validation = validateUnavailability(req.body);
  const fields: Record<string, string> = validation.valid ? {} : { ...validation.fields };

  const type = typeof body.type === "string" ? body.type.trim() : "";
  if (type === "") fields.type = "Choose an equipment type.";

  const rawIds = Array.isArray(body.unitIds) ? body.unitIds : [];
  const unitIds = [...new Set(rawIds.map(Number))];
  if (unitIds.length === 0 || unitIds.some((id) => !Number.isInteger(id) || id < 1)) {
    fields.unitIds = "Choose at least one unit.";
  } else if (unitIds.length > MAX_UNITS_PER_REQUEST) {
    fields.unitIds = `Choose at most ${MAX_UNITS_PER_REQUEST} units at a time.`;
  }
  if (Object.keys(fields).length > 0 || !validation.valid) {
    res.status(400).json({ error: "Validation failed", fields });
    return;
  }
  const { reason, startDate, endDate, note } = validation.value!;

  const { data: unitRows, error: unitsError } = await supabase.from("equipment").select("id, type, status, label").in("id", unitIds);
  if (unitsError) {
    res.status(500).json({ error: "Failed to load the equipment units" });
    return;
  }
  const units = ((unitRows ?? []) as UnitRecord[]).filter((unit) => unit.type === type);
  if (units.length !== unitIds.length) {
    res.status(404).json({ error: "One or more of those equipment units wasn't found" });
    return;
  }

  const period = dateRangeWindow(startDate, endDate)!;
  let impact;
  try {
    impact = await impactForUnits(supabase, req.headers.authorization!, units, period);
  } catch {
    res.status(500).json({ error: "Failed to check the equipment's reservations" });
    return;
  }

  const alreadyOut = impact.units.filter((unit) => unit.state === "unavailable");
  if (alreadyOut.length > 0) {
    res.status(409).json({
      error: `${alreadyOut.map((u) => `${type} #${u.id}`).join(", ")} ${alreadyOut.length === 1 ? "is" : "are"} already out of use for those dates.`,
      unitIds: alreadyOut.map((u) => u.id),
    });
    return;
  }

  const { data: saved, error: insertError } = await supabase
    .from("equipment_unavailability")
    .insert(units.map((unit) => ({ equipment_id: unit.id, reason, start_date: startDate, end_date: endDate, note, marked_by: user.id })))
    .select(UNAVAILABILITY_COLUMNS);
  if (insertError || !saved) {
    res.status(500).json({ error: "Failed to mark the equipment unusable" });
    return;
  }
  const savedPeriods = saved as UnavailabilityRow[];
  const labelById = new Map(units.map((unit) => [unit.id, unit.label]));
  const periods = savedPeriods.map((row) => ({ unitId: row.equipment_id, label: labelById.get(row.equipment_id) ?? null, period: toPeriod(row) }));

  // AC2: who has these units reserved during the period? One notice per event.
  if (!impact.eventsOk) {
    // The periods are saved (so AC1 holds); only the notices couldn't be worked out.
    res.status(201).json({ periods, affectedEvents: [], notified: false });
    return;
  }

  const byEvent = new Map<number, { event: ImpactUnit["events"][number]; units: number }>();
  for (const unit of impact.units) {
    for (const event of unit.events) {
      const entry = byEvent.get(event.eventId) ?? { event, units: 0 };
      entry.units += 1;
      byEvent.set(event.eventId, entry);
    }
  }

  let notified = true;
  const affectedEvents: { eventId: number; eventName: string; units: number }[] = [];
  for (const { event, units: count } of byEvent.values()) {
    affectedEvents.push({ eventId: event.eventId, eventName: event.eventName, units: count });
    await reportArrangementsChanged(event.eventId, `${count} reserved ${type} unit${count === 1 ? " is" : "s are"} unusable (${reason})`);
    if (!event.coordinatorId) {
      notified = false;
      continue;
    }
    const sent = await getPublisher().publish({
      type: "equipment.unusable",
      eventId: event.eventId,
      actorId: user.id,
      recipients: { userIds: [event.coordinatorId], roles: [] },
      data: { eventName: event.eventName, equipmentType: type, quantity: count, reason, startDate, endDate },
    });
    if (!sent) notified = false;
  }

  res.status(201).json({ periods, affectedEvents, notified });
});

/**
 * Mark units usable again: removes the given unusable periods (typically a
 * group marked together), so availability checks offer those units once more.
 */
equipmentUnitsRouter.post("/unavailability/clear", async (req: AuthedRequest, res) => {
  if (!requireSupport(req, res)) return;
  const supabase = req.supabase!;

  const rawIds = Array.isArray((req.body ?? {}).periodIds) ? ((req.body ?? {}).periodIds as unknown[]) : [];
  const periodIds = [...new Set(rawIds.map(Number))];
  if (periodIds.length === 0 || periodIds.length > MAX_UNITS_PER_REQUEST || periodIds.some((id) => !Number.isInteger(id) || id < 1)) {
    res.status(400).json({ error: "Validation failed", fields: { periodIds: "Choose at least one period." } });
    return;
  }

  const { data, error } = await supabase.from("equipment_unavailability").delete().in("id", periodIds).select("id");
  if (error) {
    res.status(500).json({ error: "Failed to mark the equipment usable again" });
    return;
  }
  res.json({ removed: (data ?? []).length });
});

/** Mark one unit usable again by removing one of its periods. The period must belong to the unit. */
equipmentUnitsRouter.delete("/:id/unavailability/:periodId", async (req: AuthedRequest, res) => {
  if (!requireSupport(req, res)) return;
  const supabase = req.supabase!;

  if (!isPositiveInteger(req.params.id) || !isPositiveInteger(req.params.periodId)) {
    res.status(400).json({ error: "A valid unit and period id are required" });
    return;
  }

  const { data: existing, error: lookupError } = await supabase
    .from("equipment_unavailability")
    .select("id")
    .eq("id", Number(req.params.periodId))
    .eq("equipment_id", Number(req.params.id))
    .maybeSingle();
  if (lookupError) {
    res.status(500).json({ error: "Failed to load the unavailability period" });
    return;
  }
  if (!existing) {
    res.status(404).json({ error: "Unavailability period not found" });
    return;
  }

  const { error: deleteError } = await supabase.from("equipment_unavailability").delete().eq("id", Number(req.params.periodId));
  if (deleteError) {
    res.status(500).json({ error: "Failed to mark the equipment usable again" });
    return;
  }
  res.json({ removed: true });
});

/**
 * Set or clear a unit's label — an optional tag such as the sticker number on
 * the physical item, so "Projector #12" can be matched to the real thing.
 */
equipmentUnitsRouter.patch("/:id", async (req: AuthedRequest, res) => {
  if (!requireSupport(req, res)) return;
  const supabase = req.supabase!;

  if (!isPositiveInteger(req.params.id)) {
    res.status(400).json({ error: "A valid unit id is required" });
    return;
  }

  const raw = (req.body ?? {}).label;
  const label = typeof raw === "string" ? raw.trim() : "";
  if (raw !== undefined && raw !== null && typeof raw !== "string") {
    res.status(400).json({ error: "Validation failed", fields: { label: "Enter text." } });
    return;
  }
  if (label.length > MAX_LABEL_LENGTH) {
    res.status(400).json({ error: "Validation failed", fields: { label: `Use at most ${MAX_LABEL_LENGTH} characters.` } });
    return;
  }

  const { data, error } = await supabase
    .from("equipment")
    .update({ label: label === "" ? null : label })
    .eq("id", Number(req.params.id))
    .select("id, label")
    .maybeSingle();
  if (error) {
    res.status(500).json({ error: "Failed to save the label" });
    return;
  }
  if (!data) {
    res.status(404).json({ error: "Equipment unit not found" });
    return;
  }
  res.json({ unit: { id: (data as { id: number }).id, label: (data as { label: string | null }).label } });
});
