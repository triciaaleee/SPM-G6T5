import { Router } from "express";
import type { Response } from "express";
import type { AuthedRequest } from "../../middleware/auth.js";
import type { ValidatedEventRequest } from "../../lib/validateEventRequest.js";
import { isPositiveInteger } from "../../lib/validation.js";
import { CLOSED_EVENT_STATUSES, EVENT_STATUS } from "../../lib/eventStatus.js";
import { committedFieldValue, validateChangeRequestFields, withHeldValues } from "../../lib/changeRequestFields.js";
import { AUTO_APPLIED_REASON_PREFIX, CHANGE_REQUEST_STATUS } from "../../lib/changeRequestStatus.js";
import { announceAttendanceChange, announceReschedule, SCHEDULE_FIELDS } from "../../lib/reschedule.js";
import { getPublisher } from "../../lib/rabbitPublisher.js";
import {
  checkBookingAvailability,
  fetchEventEquipmentRequests,
  fetchEventVenueBookings,
  flagBookingForRebooking,
  flagEquipmentForReassessment,
} from "../../lib/arrangementsClient.js";
import type { ArrangementEquipmentItem } from "../../lib/arrangementsClient.js";
import { fetchEventRegistrations } from "../../lib/registrationsClient.js";
import {
  routeParam,
  recordAccessDenial,
  recordEventHistory,
  EVENT_COLUMNS,
  type AssignmentEventRow,
  eventDisplayName,
} from "./shared.js";
import { clock } from "../../lib/clock.js";

/**
 * Change request controller (E3-8 to E3-11): the organiser asks to change a
 * Confirmed event. Non-critical fields apply at once; critical ones wait for the
 * assigned coordinator, who sees what the change would affect before deciding.
 */

export const changeRequestsRouter = Router();

/**
 * E3-9: the only edit path once an event is Confirmed — PATCH /:id above
 * already blocks direct edits past Planning. E3-8: critical fields
 * (schedule, attendance, venue, equipment, accessibility) are held as a
 * `change_requests`/`change_request_fields` row for the assigned
 * coordinator to decide (E3-11, not built here); everything else is
 * written straight to submitted_details.
 *
 * Deciding a held request — approving/rejecting, applying its values,
 * returning the event to Planning — belongs to E3-11 (#36) and has no
 * route yet. Assessing impact (affected bookings/reservations/
 * registrations, capacity conflicts) is E3-10 (#35), also not built here.
 */
changeRequestsRouter.post("/:id/change-requests", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const eventId = routeParam(req.params.id);
  if (!isPositiveInteger(eventId)) {
    res.status(404).json({ error: "Event not found" });
    return;
  }

  const { data: existing, error: fetchError } = await supabase
    .from("events")
    .select("id, status, organiser_id, coordinator_id, submitted_details")
    .eq("id", Number(eventId))
    .maybeSingle();

  if (fetchError) {
    res.status(500).json({ error: "Failed to load event" });
    return;
  }
  if (!existing) {
    res.status(404).json({ error: "Event not found" });
    return;
  }
  if (existing.organiser_id !== user.id) {
    await recordAccessDenial(supabase, user.id, eventId, "not_found_or_not_owner");
    res.status(403).json({ error: "Access denied" });
    return;
  }

  // E3-9 AC3: Completed/Cancelled block outright. Every other non-Confirmed
  // status (Draft, Unassigned, Requested, Clarification Requested,
  // Planning, Safety Review) already has a direct-edit or other path, so a
  // change request only ever makes sense from Confirmed.
  if (existing.status !== EVENT_STATUS.Confirmed && existing.status !== EVENT_STATUS.NeedsReview) {
    res.status(409).json({
      error: "Change requests can only be raised once the event is Confirmed.",
    });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const current = (existing.submitted_details ?? {}) as Partial<ValidatedEventRequest>;

  // Merge with whatever's already open (at most one Pending request per
  // event — enforced by a unique index too, migration 0037) so a second
  // submission updates it instead of piling up a parallel one.
  const { data: openRequest, error: openRequestError } = await supabase
    .from("change_requests")
    .select("id")
    .eq("event_id", existing.id)
    .eq("status", CHANGE_REQUEST_STATUS.Pending)
    .maybeSingle();

  if (openRequestError) {
    res.status(500).json({ error: "Failed to load the event's open change request" });
    return;
  }

  let openFields: { id: number; field: string; old_value: string | null; new_value: string; is_critical: boolean }[] = [];
  if (openRequest) {
    const { data, error } = await supabase
      .from("change_request_fields")
      .select("id, field, old_value, new_value, is_critical")
      .eq("request_id", openRequest.id);
    if (error) {
      res.status(500).json({ error: "Failed to load the event's open change request" });
      return;
    }
    // Stryker disable next-line ArrayDeclaration: equivalent - a placeholder row is not critical, so it is filtered out below
    openFields = data ?? [];
  }
  const heldCritical = openFields.filter((field) => field.is_critical);

  // Diff against "what the organiser would see if they reopened the
  // form" — the committed baseline with any already-held values overlaid
  // — so resubmitting an untouched held field is a true no-op, not a
  // spurious re-hold every time.
  const effectiveBaseline = withHeldValues(
    current,
    heldCritical.map((field) => ({ field: field.field, newValue: field.new_value })),
  );
  const result = validateChangeRequestFields(body, effectiveBaseline);

  if (!result.valid) {
    res.status(400).json({ error: "Validation failed", fields: result.fields });
    return;
  }

  if (result.changes.length === 0) {
    res.status(400).json({ error: "No field changes were submitted." });
    return;
  }

  const nonCriticalChanges = result.changes.filter((change) => !change.isCritical);

  // A critical change against the held value is either a revert — the
  // organiser took it back to what's actually committed, so it's un-held
  // — or a genuine overwrite/fresh hold.
  const revertedFields: string[] = [];
  const upsertedCritical: { field: string; oldValue: string | null; newValue: string }[] = [];
  for (const change of result.changes.filter((c) => c.isCritical)) {
    const trueBaseline = committedFieldValue(current, change.field);
    // A change to a field that isn't held always differs from its committed value (the diff above is against it),
    // and a submitted value is never empty, so only a held field can come back equal to the committed one.
    if (change.newValue === trueBaseline) {
      revertedFields.push(change.field);
    } else {
      upsertedCritical.push({ field: change.field, oldValue: trueBaseline, newValue: change.newValue });
    }
  }

  // Whether any held field is left once the reverted ones are dropped; only read when nothing new is being held.
  const willHoldSomething = heldCritical.some((f) => !revertedFields.includes(f.field));

  // Create a row only if nothing's open yet and this submission needs
  // one — a Pending request if it's holding anything, else an already-
  // resolved Approved one for a purely non-critical/pure-revert touch.
  let targetRequestId = openRequest?.id ?? null;
  // With nothing open there is nothing held to revert, so a submission that got this far changes something.
  if (!targetRequestId) {
    const isAutoApplied = upsertedCritical.length === 0;
    const { data: created, error: createError } = await supabase
      .from("change_requests")
      .insert({
        event_id: existing.id,
        organiser_id: user.id,
        status: isAutoApplied ? CHANGE_REQUEST_STATUS.Approved : CHANGE_REQUEST_STATUS.Pending,
        decided_at: isAutoApplied ? clock.now().toISOString() : null,
        // E3-8 AC3: nothing critical was touched, so there's nothing for a
        // coordinator to review — flagged as automatic (not a coordinator's
        // decision) so both sides can tell it apart from a real approval.
        decision_reason: isAutoApplied
          ? `${AUTO_APPLIED_REASON_PREFIX}${nonCriticalChanges.map((c) => c.field).join(", ")}`
          : null,
      })
      .select("id")
      .single();

    if (createError || !created) {
      res.status(500).json({ error: "Failed to raise change request" });
      return;
    }
    targetRequestId = created.id;
  }

  if (revertedFields.length > 0 && targetRequestId) {
    const { error: deleteError } = await supabase
      .from("change_request_fields")
      .delete()
      .eq("request_id", targetRequestId)
      .in("field", revertedFields);
    if (deleteError) {
      res.status(500).json({ error: "Failed to raise change request" });
      return;
    }
  }

  const rowsToUpsert = [
    ...upsertedCritical.map((change) => ({ ...change, isCritical: true })),
    ...nonCriticalChanges.map((change) => ({ field: change.field, oldValue: change.oldValue, newValue: change.newValue, isCritical: false })),
  ];
  if (rowsToUpsert.length > 0 && targetRequestId) {
    const { error: upsertError } = await supabase.from("change_request_fields").upsert(
      rowsToUpsert.map((change) => ({
        request_id: targetRequestId,
        field: change.field,
        old_value: change.oldValue,
        new_value: change.newValue,
        is_critical: change.isCritical,
      })),
      { onConflict: "request_id,field" },
    );
    if (upsertError) {
      res.status(500).json({ error: "Failed to raise change request" });
      return;
    }
  }

  // Non-critical fields apply immediately (E3-8 AC3) — written straight to
  // submitted_details, same as any other direct edit.
  if (nonCriticalChanges.length > 0) {
    const updatedDetails: Record<string, unknown> = { ...current };
    for (const change of nonCriticalChanges) {
      updatedDetails[change.field] =
        change.field === "registrationNeeded" ? body.registrationNeeded === true || body.registrationNeeded === "true" : String(body[change.field]).trim();
    }

    const { error: updateError } = await supabase
      .from("events")
      .update({ submitted_details: updatedDetails })
      .eq("id", existing.id);

    if (updateError) {
      res.status(500).json({ error: "Failed to apply change request" });
      return;
    }

    await recordEventHistory(
      supabase,
      existing.id,
      nonCriticalChanges.map((change) => ({ field: change.field, oldValue: change.oldValue, newValue: change.newValue })),
      user.id,
    );
  }

  // Critical fields are held, not applied (E3-8 AC1) — already recorded
  // above in change_request_fields; just the pending-review event_history
  // entry is left to do here. E3-11 is what later writes decided_by/
  // decided_at/decision_reason and applies these values.
  // Logged as a pending request, not a value change — nothing has been
  // applied yet, so the old value hasn't moved. Covers both a fresh
  // hold and an overwrite of an already-held value — same wording,
  // since either way the committed value is unchanged until decided.
  // (recordEventHistory writes nothing for an empty list.)
  await recordEventHistory(
    supabase,
    existing.id,
    upsertedCritical.map((change) => ({
      field: change.field,
      oldValue: change.oldValue,
      newValue: `requested: ${change.newValue} (pending coordinator review)`,
    })),
    user.id,
  );

  await recordEventHistory(
    supabase,
    existing.id,
    revertedFields.map((field) => {
      const discarded = heldCritical.find((f) => f.field === field)!;
      return {
        field,
        oldValue: discarded.new_value,
        newValue: `reverted to ${committedFieldValue(current, field)} (no longer pending)`,
      };
    }),
    user.id,
  );

  const eventName = eventDisplayName(existing as unknown as AssignmentEventRow);
  let notificationsFailed = false;
  let autoResolved = false;

  // A held critical field puts a Confirmed event into Needs Review until the
  // coordinator decides it (AGENTS.md section 3). The status filter makes it
  // a no-op if the event already moved on; an event already in Needs Review
  // stays there.
  if (upsertedCritical.length > 0 && existing.status === EVENT_STATUS.Confirmed) {
    const { error: reviewError } = await supabase
      .from("events")
      .update({ status: EVENT_STATUS.NeedsReview })
      .eq("id", existing.id)
      .eq("status", EVENT_STATUS.Confirmed);
    if (reviewError) {
      res.status(500).json({ error: "Failed to raise change request" });
      return;
    }
    await recordEventHistory(
      supabase,
      existing.id,
      [{ field: "Status", oldValue: EVENT_STATUS.Confirmed, newValue: EVENT_STATUS.NeedsReview }],
      user.id,
    );
  }

  if (targetRequestId && upsertedCritical.length === 0 && !willHoldSomething && revertedFields.length > 0) {
    // Every held field just got reverted — nothing left to decide. Close
    // the request out rather than leaving it "Pending" with no fields,
    // and tell both sides it resolved itself rather than staying silent.
    autoResolved = true;
    // Its own status (migration 0038) — nothing was actually approved,
    // the request just evaporated, so Approved would be the wrong word.
    // decision_reason is still set as the human-readable explanation.
    const { error: resolveError } = await supabase
      .from("change_requests")
      .update({
        status: CHANGE_REQUEST_STATUS.AutoWithdrawn,
        decided_at: clock.now().toISOString(),
        decided_by: null,
        decision_reason: `The requested change to ${revertedFields.join(", ")} was reverted before it was reviewed.`,
      })
      .eq("id", targetRequestId);
    if (resolveError) {
      res.status(500).json({ error: "Failed to raise change request" });
      return;
    }

    const recipients = existing.coordinator_id ? [user.id, existing.coordinator_id] : [user.id];
    const published = await getPublisher().publish({
      type: "change.withdrawn",
      eventId: existing.id,
      actorId: user.id,
      recipients: { userIds: recipients, roles: [] },
      data: { eventName, changeRequestId: targetRequestId, fields: revertedFields },
    });
    notificationsFailed = !published;
  } else if (existing.coordinator_id) {
    const published = await getPublisher().publish({
      type: "change.requested",
      eventId: existing.id,
      actorId: user.id,
      recipients: { userIds: [existing.coordinator_id], roles: [] },
      data: {
        eventName,
        changeRequestId: targetRequestId,
        fields: result.changes.map((change) => change.field),
      },
    });
    notificationsFailed = !published;
  }

  res.status(201).json({
    changeRequestId: targetRequestId,
    applied: nonCriticalChanges.map((change) => change.field),
    held: upsertedCritical.map((change) => change.field),
    reverted: revertedFields,
    autoResolved,
    notificationsFailed,
  });
});

/**
 * E3-8 AC2/AC4: what a held critical change would affect — the event's
 * current venue bookings, equipment reservations and registrations, plus
 * whether the requested attendance would exceed a booked venue's capacity.
 * Pure read: nothing here writes anything, matching AC4's "the booking is
 * not released automatically". Not E3-10's own assessment screen (that
 * story still owns its own workflow) — just enough to satisfy E3-8's two
 * ACs for the assigned coordinator reviewing a Pending request.
 */
interface ChangeRequestImpact {
  bookings: { id: number; status: string; venue: { id: number; name: string } | null }[];
  equipmentReservations: { id: number; status: string; items: ArrangementEquipmentItem[] }[];
  registrations: {
    registeredCount: number;
    total: number;
    // E3-10 AC1: "listed", not just counted.
    registrations: { registrationId: number; userId: string; name: string | null; status: string }[];
  };
  capacityConflict: { bookingId: number; venueName: string; capacity: number; requestedAttendance: number } | null;
  // E3-10 AC2's "availability" half — a held schedule change checked
  // against the booked venue's block-out periods and other bookings.
  // null when nothing to check (no schedule held) or nothing clashed.
  availabilityConflict:
    | { bookingId: number; unavailabilityConflict: { reason: string; description: string } | null; bookingConflict: { bookingId: number; status: string; window: string } | null }
    | null;
}

/**
 * What to actually check, from a request's held fields: the requested
 * attendance (for the capacity check) and the proposed schedule (for the
 * availability check) — a partial schedule change (e.g. just endTime)
 * still needs a complete window, so the other two pieces fall back to
 * what's already committed. Shared by the GET route's per-request impact
 * loop and the approve route below, which needs the exact same inputs to
 * decide whether this specific approval actually invalidates a booking.
 */
function deriveImpactInputs(
  fields: { field: string; new_value: string }[],
  committedDetails: Record<string, unknown>,
): {
  requestedAttendance: number | null;
  proposedSchedule: { proposedDate: string; startTime: string | null; endTime: string | null } | null;
} {
  const attendanceField = fields.find((field) => field.field === "expectedAttendance");
  const requestedAttendanceRaw = attendanceField ? Number(attendanceField.new_value) : null;
  const requestedAttendance = Number.isFinite(requestedAttendanceRaw) ? requestedAttendanceRaw : null;

  const heldScheduleField = (field: string) => fields.find((f) => f.field === field)?.new_value;
  const hasScheduleChange = ["proposedDate", "startTime", "endTime"].some((field) =>
    fields.some((f) => f.field === field),
  );
  const proposedSchedule = hasScheduleChange
    ? {
        proposedDate: heldScheduleField("proposedDate") ?? (committedDetails.proposedDate as string),
        startTime: heldScheduleField("startTime") ?? (committedDetails.startTime as string | null) ?? null,
        endTime: heldScheduleField("endTime") ?? (committedDetails.endTime as string | null) ?? null,
      }
    : null;

  return { requestedAttendance, proposedSchedule };
}

async function loadChangeRequestImpact(
  eventId: number,
  requestedAttendance: number | null,
  proposedSchedule: { proposedDate: string; startTime: string | null; endTime: string | null } | null,
  authorization: string,
): Promise<ChangeRequestImpact | null> {
  const [bookingsResult, equipmentResult, registrationsResult] = await Promise.all([
    fetchEventVenueBookings(eventId, authorization),
    fetchEventEquipmentRequests(eventId, authorization),
    fetchEventRegistrations(eventId, authorization),
  ]);

  if (bookingsResult.status !== "ok" || equipmentResult.status !== "ok" || registrationsResult.status !== "ok") {
    return null;
  }

  const bookings = bookingsResult.value;
  const registrations = registrationsResult.value;

  // E3-8 AC4 / E3-10 AC2: only a booking that's actually locked in the
  // venue is worth checking against — a Withdrawn/Rejected/Expired one
  // doesn't hold anything real, so flagging a conflict against it would
  // name a venue the event no longer has. By the time an event reaches
  // Confirmed its bookings should all be Approved anyway (On Hold/
  // Requested never survive to here), so this is the simplest correct
  // filter without needing hold-expiry data this client doesn't carry.
  const activeBookings = bookings.filter((booking) => booking.status === "Approved");

  let capacityConflict: ChangeRequestImpact["capacityConflict"] = null;
  // Stryker disable next-line ConditionalExpression: equivalent - without the check `capacity < null` is `capacity < 0`, still false
  if (requestedAttendance !== null) {
    const overCapacity = activeBookings.find(
      (booking) => typeof booking.venue?.capacity === "number" && booking.venue.capacity < requestedAttendance,
    );
    if (overCapacity?.venue) {
      capacityConflict = {
        bookingId: overCapacity.id,
        venueName: overCapacity.venue.name,
        capacity: overCapacity.venue.capacity as number,
        requestedAttendance,
      };
    }
  }

  // Checked against the first active booking with a venue — same
  // simplicity as the capacity check above, and in practice an event's
  // main booking.
  let availabilityConflict: ChangeRequestImpact["availabilityConflict"] = null;
  const bookingToCheck = activeBookings.find((booking) => booking.venue);
  if (proposedSchedule && bookingToCheck) {
    const availabilityResult = await checkBookingAvailability(bookingToCheck.id, proposedSchedule, authorization);
    if (availabilityResult.status === "ok" && !availabilityResult.value.available) {
      availabilityConflict = {
        bookingId: bookingToCheck.id,
        unavailabilityConflict: availabilityResult.value.unavailabilityConflict,
        bookingConflict: availabilityResult.value.bookingConflict,
      };
    }
  }

  return {
    bookings: bookings.map((booking) => ({
      id: booking.id,
      status: booking.status,
      venue: booking.venue ? { id: booking.venue.id, name: booking.venue.name } : null,
    })),
    equipmentReservations: equipmentResult.value.map((request) => ({
      id: request.id,
      status: request.status,
      items: request.items,
    })),
    registrations: {
      registeredCount: registrations.filter((r) => r.status === "Registered").length,
      total: registrations.length,
      registrations: registrations.map((r) => ({
        registrationId: r.registrationId,
        userId: r.userId,
        name: r.name,
        status: r.status,
      })),
    },
    capacityConflict,
    availabilityConflict,
  };
}

/**
 * E3-9: the organiser's own view of every change request they've raised on
 * this event. E3-8 AC2/AC4: the assigned coordinator gets the same list,
 * plus an `impact` assessment attached to each `Pending` request. Owner or
 * assigned coordinator only, read-only, most recent first.
 */
changeRequestsRouter.get("/:id/change-requests", async (req: AuthedRequest, res) => {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const eventId = routeParam(req.params.id);
  if (!isPositiveInteger(eventId)) {
    res.status(404).json({ error: "Event not found" });
    return;
  }

  const { data: event, error: eventError } = await supabase
    .from("events")
    .select("id, organiser_id, coordinator_id, submitted_details")
    .eq("id", Number(eventId))
    .maybeSingle();

  if (eventError) {
    res.status(500).json({ error: "Failed to load event" });
    return;
  }
  if (!event) {
    res.status(404).json({ error: "Event not found" });
    return;
  }

  const isOwner = event.organiser_id === user.id;
  const isAssignedCoordinator = user.role === "coordinator" && event.coordinator_id === user.id;
  if (!isOwner && !isAssignedCoordinator) {
    await recordAccessDenial(supabase, user.id, eventId, "not_found_or_not_owner");
    res.status(403).json({ error: "Access denied" });
    return;
  }

  const { data: requests, error: requestsError } = await supabase
    .from("change_requests")
    .select("id, status, decided_at, decision_reason, created_at")
    .eq("event_id", event.id)
    .order("created_at", { ascending: false });

  if (requestsError) {
    res.status(500).json({ error: "Failed to load change requests" });
    return;
  }

  const requestIds = (requests ?? []).map((request) => request.id);
  const { data: fieldRows, error: fieldsError } = await supabase
    .from("change_request_fields")
    .select("request_id, field, old_value, new_value, is_critical, applied_at")
    .in("request_id", requestIds.length > 0 ? requestIds : [-1]);

  if (fieldsError) {
    res.status(500).json({ error: "Failed to load change requests" });
    return;
  }

  const fieldsByRequest = new Map<number, typeof fieldRows>();
  // Stryker disable next-line ArrayDeclaration: equivalent - a placeholder row has no request_id, so nothing ever reads its entry
  for (const field of fieldRows ?? []) {
    const list = fieldsByRequest.get(field.request_id) ?? [];
    list.push(field);
    fieldsByRequest.set(field.request_id, list);
  }

  const authorization = req.headers.authorization!;
  const committedDetails = (event.submitted_details ?? {}) as Record<string, unknown>;
  const impactByRequest = new Map<number, ChangeRequestImpact | null>();
  // Stryker disable next-line ArrayDeclaration: equivalent - a placeholder has no status, so it is skipped as not Pending
  for (const request of requests ?? []) {
    if (request.status !== CHANGE_REQUEST_STATUS.Pending) continue;
    // Only the still-open fields count as "requested" for the impact
    // check — one already applied in an earlier partial decision is
    // already reflected in committedDetails itself.
    // Stryker disable next-line ArrayDeclaration: equivalent - a placeholder has no field name, so it asks for no check
    const fields = (fieldsByRequest.get(request.id) ?? []).filter((f) => !f.applied_at);
    const { requestedAttendance, proposedSchedule } = deriveImpactInputs(fields, committedDetails);

    impactByRequest.set(
      request.id,
      await loadChangeRequestImpact(
        event.id,
        requestedAttendance,
        proposedSchedule,
        authorization,
      ),
    );
  }

  res.json({
    changeRequests: (requests ?? []).map((request) => ({
      id: request.id,
      status: request.status,
      decidedAt: request.decided_at,
      decisionReason: request.decision_reason,
      createdAt: request.created_at,
      fields: (fieldsByRequest.get(request.id) ?? []).map((field) => ({
        field: field.field,
        oldValue: field.old_value,
        newValue: field.new_value,
        isCritical: field.is_critical,
        outcome: fieldOutcome(request.status, field.is_critical, !!field.applied_at),
      })),
      impact: impactByRequest.has(request.id) ? impactByRequest.get(request.id) : null,
    })),
  });
});

/**
 * E3-11: what happened to one field — a critical field can be applied
 * (stamped `applied_at`, migration 0041) while its request is still
 * Pending, from an earlier partial approval that left other fields open.
 */
function fieldOutcome(
  requestStatus: string,
  isCritical: boolean,
  alreadyApplied: boolean,
): "pending" | "applied" | "rejected" | "withdrawn" {
  if (!isCritical || alreadyApplied) return "applied";
  if (requestStatus === CHANGE_REQUEST_STATUS.AutoWithdrawn) return "withdrawn";
  if (requestStatus === CHANGE_REQUEST_STATUS.Rejected) return "rejected";
  // Pending, or Approved without the field ever being stamped applied: it
  // has not been confirmed as applied, so don't say it was.
  return "pending";
}

/**
 * Loads a Pending change request that belongs to this event, with its
 * fields — shared by approve and reject below. Returns null (after
 * writing the response itself) for every failure case, so callers can
 * just `if (!loaded) return;`.
 */
async function loadPendingChangeRequest(
  supabase: NonNullable<AuthedRequest["supabase"]>,
  res: Response,
  eventId: number,
  requestId: string,
): Promise<{ id: number; fields: { field: string; old_value: string | null; new_value: string; is_critical: boolean }[] } | null> {
  if (!isPositiveInteger(requestId)) {
    res.status(404).json({ error: "Change request not found" });
    return null;
  }

  const { data: changeRequest, error: requestError } = await supabase
    .from("change_requests")
    .select("id, status")
    .eq("id", Number(requestId))
    .eq("event_id", eventId)
    .maybeSingle();
  if (requestError) {
    res.status(500).json({ error: "Failed to load the change request" });
    return null;
  }
  if (!changeRequest) {
    res.status(404).json({ error: "Change request not found" });
    return null;
  }
  if (changeRequest.status !== CHANGE_REQUEST_STATUS.Pending) {
    res.status(409).json({ error: "This change request has already been decided." });
    return null;
  }

  // Only the fields still open — one already approved in an earlier
  // partial decision (applied_at set, see migration 0041) is resolved and
  // out of scope for a further approve or reject call on this request.
  const { data: fieldRows, error: fieldsError } = await supabase
    .from("change_request_fields")
    .select("field, old_value, new_value, is_critical")
    .eq("request_id", changeRequest.id)
    .is("applied_at", null);
  if (fieldsError) {
    res.status(500).json({ error: "Failed to load the change request" });
    return null;
  }

  // Stryker disable next-line ArrayDeclaration: equivalent - a placeholder row is not critical, so approve sees nothing held either way
  return { id: changeRequest.id, fields: fieldRows ?? [] };
}

/**
 * Loads the event and checks the caller is its assigned coordinator — the
 * same gate both approve and reject below share. Returns null (after
 * writing the response) on any failure.
 */
async function loadEventForDecision(
  req: AuthedRequest,
  res: Response,
  eventId: string,
): Promise<{
  id: number;
  status: string;
  safety_approval_stale?: boolean;
  coordinator_id: string | null;
  submitted_details: Record<string, unknown>;
} | null> {
  const { supabase, user } = req;
  if (!supabase || !user) {
    res.status(401).json({ error: "Unauthenticated" });
    return null;
  }
  if (!isPositiveInteger(eventId)) {
    res.status(404).json({ error: "Event not found" });
    return null;
  }

  const { data: event, error: eventError } = await supabase
    .from("events")
    .select("id, status, safety_approval_stale, coordinator_id, submitted_details")
    .eq("id", Number(eventId))
    .maybeSingle();
  if (eventError) {
    res.status(500).json({ error: "Failed to load event" });
    return null;
  }
  if (!event) {
    res.status(404).json({ error: "Event not found" });
    return null;
  }
  if (user.role !== "coordinator" || event.coordinator_id !== user.id) {
    res.status(403).json({ error: "Only the event's assigned coordinator can decide this change request" });
    return null;
  }

  return event as {
    id: number;
    status: string;
    safety_approval_stale?: boolean;
    coordinator_id: string | null;
    submitted_details: Record<string, unknown>;
  };
}

/**
 * E3-11 AC1/AC2/AC3/AC5: the coordinator approves a held change request.
 * Every held field's value is applied, written to event history (AC1),
 * and the event returns to Planning — AGENTS.md §3's re-review rule,
 * broadened (with the team's sign-off) from "only venue/equipment-
 * affecting approvals" to any held critical field, since a safety
 * approval no longer applies once anything held on it changes.
 *
 * AC2/AC3: only a field that actually invalidates something gets flagged
 * — reusing E3-10's own capacity/availability check (deriveImpactInputs +
 * loadChangeRequestImpact) rather than flagging every venue/schedule/
 * attendance approval regardless of whether it's a real problem. Flagging
 * itself is delegated to venue-service/equipment-service (AGENTS.md §1:
 * each service writes only its own tables); this route just calls them.
 * Neither call blocks the approval itself from succeeding (AC5: no
 * separate re-approval needed for the decision to stand) — a flagging
 * failure is reported back, not retried or rolled back into.
 */
changeRequestsRouter.post("/:id/change-requests/:requestId/approve", async (req: AuthedRequest, res) => {
  const eventId = routeParam(req.params.id);
  const event = await loadEventForDecision(req, res, eventId);
  if (!event) return;

  // Approving writes the event's status back (statusAfterApproval), so it must never
  // run on an event that is closed or hasn't entered the process: that would reopen it.
  if (CHANGE_REQUEST_BLOCKED_STATUSES.has(event.status)) {
    res.status(409).json({ error: `A change request can't be approved while the event is ${event.status}.` });
    return;
  }

  const { supabase, user } = req as Required<Pick<AuthedRequest, "supabase" | "user">>;
  const requestId = routeParam(req.params.requestId);
  const changeRequest = await loadPendingChangeRequest(supabase, res, event.id, requestId);
  if (!changeRequest) return;

  const allCriticalFields = changeRequest.fields.filter((f) => f.is_critical);
  const heldFieldNames = allCriticalFields.map((f) => f.field);

  // E3-11: by default every held field is approved (unchanged behavior).
  // Passing `fields` approves just that subset — the rest are simply left
  // held, not rejected: the coordinator didn't decide on them yet, so the
  // request stays Pending with just those remaining fields, open for a
  // later decision (another partial approve, or an eventual reject of
  // what's left).
  const requestedApproveFields = Array.isArray(req.body?.fields)
    ? (req.body.fields as unknown[]).filter((f): f is string => typeof f === "string")
    : null;

  let fieldsToApproveNames: string[];
  if (requestedApproveFields === null) {
    fieldsToApproveNames = heldFieldNames;
  } else {
    const unique = [...new Set(requestedApproveFields)];
    const unknown = unique.filter((f) => !heldFieldNames.includes(f));
    if (unknown.length > 0) {
      res.status(400).json({ error: `These fields aren't held on this request: ${unknown.join(", ")}` });
      return;
    }
    fieldsToApproveNames = unique;
  }

  if (fieldsToApproveNames.length === 0) {
    res.status(400).json({ error: "Approve at least one field, or use reject to decline the whole request." });
    return;
  }

  const remainingFieldNames = heldFieldNames.filter((f) => !fieldsToApproveNames.includes(f));
  const criticalFields = allCriticalFields.filter((f) => fieldsToApproveNames.includes(f.field));
  const current = event.submitted_details;
  const updatedDetails: Record<string, unknown> = { ...current };
  for (const field of criticalFields) {
    updatedDetails[field.field] = field.field === "expectedAttendance" ? Number(field.new_value) : field.new_value;
  }

  const { data: updatedEvent, error: updateError } = await supabase
    .from("events")
    .update({ submitted_details: updatedDetails, status: statusAfterApproval(event.status), safety_approval_stale: true })
    .eq("id", event.id)
    .select(`${EVENT_COLUMNS}, organiser_id`)
    .single();
  if (updateError) {
    res.status(500).json({ error: "Failed to apply the change request" });
    return;
  }

  // Undo the event write if a later step fails, so a field is never left
  // changed on the event but not recorded as applied (or the reverse).
  const rollback = async (): Promise<void> => {
    await supabase
      .from("events")
      .update({
        submitted_details: current,
        status: event.status,
        safety_approval_stale: event.safety_approval_stale ?? false,
      })
      .eq("id", event.id);
    await supabase
      .from("change_request_fields")
      .update({ applied_at: null })
      .eq("request_id", changeRequest.id)
      .in(
        "field",
        criticalFields.map((f) => f.field),
      );
  };

  // A field only counts as applied once the stored event actually holds the
  // approved value: read it back from the row the update returned.
  const stored = ((updatedEvent as { submitted_details?: Record<string, unknown> } | null)?.submitted_details ?? {}) as Record<
    string,
    unknown
  >;
  const notStored = criticalFields.filter((f) => String(stored[f.field] ?? "") !== String(updatedDetails[f.field] ?? ""));
  if (notStored.length > 0) {
    await rollback();
    res.status(500).json({
      error: `Couldn't apply the change to ${notStored.map((f) => f.field).join(", ")}. Nothing was changed; please try again.`,
    });
    return;
  }

  // The approved fields are resolved — stamp them applied (migration 0041)
  // so they stop showing as held but the row (and its old/new value) stays
  // for the request's own history, instead of being deleted. Whatever's
  // left unstamped stays open, so the status update below only ever
  // closes the request out when nothing remains.
  // criticalFields is never empty here: an empty selection was refused above.
  const { error: applyError } = await supabase
    .from("change_request_fields")
    .update({ applied_at: clock.now().toISOString() })
    .eq("request_id", changeRequest.id)
    .in(
      "field",
      criticalFields.map((f) => f.field),
    );
  if (applyError) {
    await rollback();
    res.status(500).json({ error: "Failed to record the decision" });
    return;
  }

  if (remainingFieldNames.length === 0) {
    const { error: decideError } = await supabase
      .from("change_requests")
      .update({ status: CHANGE_REQUEST_STATUS.Approved, decided_by: user.id, decided_at: clock.now().toISOString() })
      .eq("id", changeRequest.id);
    if (decideError) {
      await rollback();
      res.status(500).json({ error: "Failed to record the decision" });
      return;
    }
  }

  await recordEventHistory(
    supabase,
    event.id,
    criticalFields.map((field) => ({ field: field.field, oldValue: field.old_value, newValue: field.new_value })),
    user.id,
  );

  const authorization = req.headers.authorization!;
  const { requestedAttendance, proposedSchedule } = deriveImpactInputs(criticalFields, current);
  const impact = await loadChangeRequestImpact(event.id, requestedAttendance, proposedSchedule, authorization);

  const bookingIdsToFlag = new Set<number>();
  if (impact?.capacityConflict) bookingIdsToFlag.add(impact.capacityConflict.bookingId);
  if (impact?.availabilityConflict) bookingIdsToFlag.add(impact.availabilityConflict.bookingId);

  const bookingsFlagged: { bookingId: number; staffNotified: boolean }[] = [];
  const fieldNames = criticalFields.map((f) => f.field).join(", ");
  for (const bookingId of bookingIdsToFlag) {
    const result = await flagBookingForRebooking(
      bookingId,
      `An approved change to ${fieldNames} invalidated this booking.`,
      authorization,
    );
    if (result.status === "ok") bookingsFlagged.push({ bookingId, staffNotified: result.value.staffNotified });
  }

  let equipmentFlagged = false;
  if (criticalFields.some((f) => f.field === "equipment")) {
    const result = await flagEquipmentForReassessment(
      event.id,
      `An approved change to equipment requirements may affect the existing reservation.`,
      authorization,
    );
    equipmentFlagged = result.status === "ok" && result.value.flaggedRequestIds.length > 0;
  }

  const eventName = eventDisplayName(updatedEvent as unknown as AssignmentEventRow);
  const approvedEvent = { id: event.id, actorId: user.id, eventName, coordinatorId: event.coordinator_id, details: stored };
  if (criticalFields.some((f) => (SCHEDULE_FIELDS as readonly string[]).includes(f.field))) {
    await announceReschedule(supabase, approvedEvent);
  }
  if (criticalFields.some((f) => f.field === "expectedAttendance")) {
    await announceAttendanceChange(supabase, approvedEvent);
  }
  const published = await getPublisher().publish({
    type: "change.decided",
    eventId: event.id,
    actorId: user.id,
    recipients: { userIds: [(updatedEvent as { organiser_id?: string }).organiser_id ?? ""].filter(Boolean), roles: [] },
    data:
      remainingFieldNames.length > 0
        ? {
            eventName,
            outcome: "partially_approved",
            approvedFields: criticalFields.map((f) => f.field),
            remainingFields: remainingFieldNames,
          }
        : { eventName, outcome: "approved" },
  });

  res.json({
    event: updatedEvent,
    approvedFields: criticalFields.map((f) => f.field),
    remainingFields: remainingFieldNames,
    bookingsFlagged,
    equipmentFlagged,
    notificationsFailed: !published,
  });
});

/**
 * E3-11 AC4: the coordinator rejects a held change request with a
 * required reason. Nothing is applied — the held fields stay recorded on
 * the now-terminal Rejected row as a historical record, event untouched.
 */
changeRequestsRouter.post("/:id/change-requests/:requestId/reject", async (req: AuthedRequest, res) => {
  const eventId = routeParam(req.params.id);
  const event = await loadEventForDecision(req, res, eventId);
  if (!event) return;

  const { supabase, user } = req as Required<Pick<AuthedRequest, "supabase" | "user">>;
  const requestId = routeParam(req.params.requestId);
  const changeRequest = await loadPendingChangeRequest(supabase, res, event.id, requestId);
  if (!changeRequest) return;

  const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
  if (!reason) {
    res.status(400).json({ error: "A reason is required" });
    return;
  }

  const { data: updated, error: decideError } = await supabase
    .from("change_requests")
    .update({
      status: CHANGE_REQUEST_STATUS.Rejected,
      decision_reason: reason,
      decided_by: user.id,
      decided_at: clock.now().toISOString(),
    })
    .eq("id", changeRequest.id)
    .select("id, status, decided_at, decision_reason")
    .single();
  if (decideError) {
    res.status(500).json({ error: "Failed to record the decision" });
    return;
  }

  // Rejecting the last open request on a Needs Review event whose approved
  // arrangements never changed (safety_approval_stale is still false) settles
  // it: the event returns straight to Confirmed, no new safety review.
  let returnedToConfirmed = false;
  if (event.status === EVENT_STATUS.NeedsReview) {
    const { count } = await supabase
      .from("change_requests")
      .select("id", { count: "exact", head: true })
      .eq("event_id", event.id)
      .eq("status", CHANGE_REQUEST_STATUS.Pending);
    if ((count ?? 0) === 0) {
      const { data: reverted } = await supabase
        .from("events")
        .update({ status: EVENT_STATUS.Confirmed })
        .eq("id", event.id)
        .eq("status", EVENT_STATUS.NeedsReview)
        .eq("safety_approval_stale", false)
        .select("id");
      returnedToConfirmed = (reverted ?? []).length > 0;
      if (returnedToConfirmed) {
        await recordEventHistory(
          supabase,
          event.id,
          [{ field: "Status", oldValue: EVENT_STATUS.NeedsReview, newValue: EVENT_STATUS.Confirmed }],
          user.id,
        );
      }
    }
  }

  const { data: eventRow } = await supabase
    .from("events")
    .select(`${EVENT_COLUMNS}, organiser_id`)
    .eq("id", event.id)
    .maybeSingle();
  const organiserId = (eventRow as { organiser_id?: string } | null)?.organiser_id;

  let notificationsFailed = false;
  if (organiserId) {
    const eventName = eventDisplayName(eventRow as unknown as AssignmentEventRow);
    const published = await getPublisher().publish({
      type: "change.decided",
      eventId: event.id,
      actorId: user.id,
      recipients: { userIds: [organiserId], roles: [] },
      data: { eventName, outcome: "rejected", reason },
    });
    notificationsFailed = !published;
  }

  res.json({ changeRequest: updated, returnedToConfirmed, notificationsFailed });
});

/** Statuses a change request can't be approved in: not yet in the process, or already over. */
const CHANGE_REQUEST_BLOCKED_STATUSES: ReadonlySet<string> = new Set([
  EVENT_STATUS.Draft,
  EVENT_STATUS.Unassigned,
  ...CLOSED_EVENT_STATUSES,
]);

/**
 * Where an event goes when its coordinator approves a held change: a
 * Confirmed or Needs Review event stays in Needs Review to be re-arranged
 * and re-checked; a Safety Review event returns to Planning (AGENTS.md
 * section 3); Planning stays in Planning.
 */
function statusAfterApproval(current: string): string {
  if (current === EVENT_STATUS.Confirmed || current === EVENT_STATUS.NeedsReview) return EVENT_STATUS.NeedsReview;
  return EVENT_STATUS.Planning;
}
