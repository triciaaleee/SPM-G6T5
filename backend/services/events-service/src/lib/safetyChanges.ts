import type { ArrangementBooking, ArrangementEquipmentRequest } from "./arrangementsClient.js";
import { MAX_SAFETY_DECISION_REASON_LENGTH } from "./safetyReview.js";

/**
 * E3-14: the Safety Officer requests changes to specific arrangements of an
 * event in Safety Review, short of rejecting it. The rules are pure, so the
 * routes only fetch and write.
 *
 * An arrangement is either a venue booking (venue-service) or one item of
 * an equipment request (equipment-service). Each flag keeps a snapshot of
 * the arrangement as it was when flagged; the flag clears once the
 * arrangement no longer matches it (AC3). What "changed" means:
 *
 * - venue booking: its status moved on (released, withdrawn, replaced…).
 *   A booking's venue and event can't be edited, so changing it means
 *   releasing it and booking another.
 * - equipment item: its type, quantity or reserved quantity changed, or it
 *   was removed.
 */

export type ArrangementType = "venue_booking" | "equipment_item";

/** An arrangement the Safety Officer can flag. */
export interface ArrangementOption {
  type: ArrangementType;
  id: number;
  label: string;
  /** e.g. "Approved", or "2 of 2 reserved". */
  detail: string;
}

type Snapshot = Record<string, string | number>;

/** Bookings that no longer hold or ask for a venue have nothing to re-review. */
const ENDED_BOOKING_STATUSES = new Set(["Rejected", "Withdrawn", "Expired"]);

function key(type: ArrangementType, id: number): string {
  return `${type}:${id}`;
}

/** The current state of every arrangement, keyed by type and id. */
export function currentArrangements(
  bookings: ArrangementBooking[],
  equipmentRequests: ArrangementEquipmentRequest[],
): Map<string, { option: ArrangementOption; snapshot: Snapshot; flaggable: boolean }> {
  const states = new Map<string, { option: ArrangementOption; snapshot: Snapshot; flaggable: boolean }>();
  for (const booking of bookings) {
    states.set(key("venue_booking", booking.id), {
      option: {
        type: "venue_booking",
        id: booking.id,
        label: booking.venue?.name ?? `Venue booking #${booking.id}`,
        detail: booking.status,
      },
      snapshot: { status: booking.status },
      flaggable: !ENDED_BOOKING_STATUSES.has(booking.status),
    });
  }
  for (const request of equipmentRequests) {
    for (const item of request.items) {
      states.set(key("equipment_item", item.id), {
        option: {
          type: "equipment_item",
          id: item.id,
          label: `${item.equipmentType} × ${item.quantity}`,
          detail: `${item.quantityFulfilled} of ${item.quantity} reserved`,
        },
        snapshot: { equipmentType: item.equipmentType, quantity: item.quantity, quantityFulfilled: item.quantityFulfilled },
        flaggable: true,
      });
    }
  }
  return states;
}

/** AC1: what the Safety Officer may pick from — the event's live venue bookings and its equipment items. */
export function arrangementOptions(
  bookings: ArrangementBooking[],
  equipmentRequests: ArrangementEquipmentRequest[],
): ArrangementOption[] {
  return [...currentArrangements(bookings, equipmentRequests).values()].filter((s) => s.flaggable).map((s) => s.option);
}

/** What must change about one arrangement — or, in general, about the event — is capped like a reason. */
export const MAX_SAFETY_CHANGE_NOTE_LENGTH = MAX_SAFETY_DECISION_REASON_LENGTH;

export interface ChangeRequest {
  /** Each picked arrangement with what must change about it. */
  arrangements: { type: ArrangementType; id: number; note: string }[];
  /** Anything not about one arrangement; optional. */
  generalNote: string | null;
}

export type ParsedChangeRequest = { valid: true; request: ChangeRequest } | { valid: false; fields: Record<string, string> };

/**
 * AC1/AC2: `{ arrangements: [{ type, id, note }], generalNote? }`. At least
 * one arrangement is required, and each picked one needs a note saying what
 * must change about it; the general note is optional. Every problem is
 * reported at once: `arrangements` for the list itself, and
 * `note:<type>:<id>` for a picked arrangement's missing or over-long note.
 */
export function parseChangeRequest(body: unknown): ParsedChangeRequest {
  const raw = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const fields: Record<string, string> = {};

  const arrangements: ChangeRequest["arrangements"] = [];
  const seen = new Set<string>();
  const list = Array.isArray(raw.arrangements) ? raw.arrangements : [];
  for (const entry of list) {
    const item = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const type = item.type;
    const id = item.id;
    if ((type !== "venue_booking" && type !== "equipment_item") || !Number.isInteger(id) || (id as number) < 1) {
      fields.arrangements = "Each arrangement needs a type (venue_booking or equipment_item) and an id.";
      continue;
    }
    const itemKey = key(type, id as number);
    if (seen.has(itemKey)) continue;
    seen.add(itemKey);
    const note = typeof item.note === "string" ? item.note.trim() : "";
    if (!note) fields[`note:${itemKey}`] = "Say what must change here.";
    else if (note.length > MAX_SAFETY_CHANGE_NOTE_LENGTH) {
      fields[`note:${itemKey}`] = `Keep this under ${MAX_SAFETY_CHANGE_NOTE_LENGTH} characters.`;
    }
    arrangements.push({ type, id: id as number, note });
  }
  if (!fields.arrangements && arrangements.length === 0) {
    fields.arrangements = "Select at least one venue booking or equipment reservation that must change.";
  }

  const general = typeof raw.generalNote === "string" ? raw.generalNote.trim() : "";
  if (general.length > MAX_SAFETY_CHANGE_NOTE_LENGTH) {
    fields.generalNote = `Keep this under ${MAX_SAFETY_CHANGE_NOTE_LENGTH} characters.`;
  }

  return Object.keys(fields).length > 0
    ? { valid: false, fields }
    : { valid: true, request: { arrangements, generalNote: general || null } };
}

/** A flag to store: the arrangement, its label, what must change and its state when flagged. */
export interface NewFlag {
  type: ArrangementType;
  id: number;
  label: string;
  note: string;
  snapshot: Snapshot;
}

/** Turns the selection into flags, or names the ones that aren't this event's (live) arrangements. */
export function resolveFlags(
  selected: ChangeRequest["arrangements"],
  bookings: ArrangementBooking[],
  equipmentRequests: ArrangementEquipmentRequest[],
): { ok: true; flags: NewFlag[] } | { ok: false; unknown: ChangeRequest["arrangements"] } {
  const states = currentArrangements(bookings, equipmentRequests);
  const flags: NewFlag[] = [];
  const unknown: ChangeRequest["arrangements"] = [];
  for (const choice of selected) {
    const state = states.get(key(choice.type, choice.id));
    if (!state || !state.flaggable) unknown.push(choice);
    else flags.push({ type: choice.type, id: choice.id, label: state.option.label, note: choice.note, snapshot: state.snapshot });
  }
  return unknown.length > 0 ? { ok: false, unknown } : { ok: true, flags };
}

/**
 * The decision's reason (event_safety_reviews.reason, required there): every
 * note, labelled, then the general note — e.g. "Seminar Room 3-01: exits
 * blocked; PA system × 2: move away from the exit. General: update the
 * crowd plan." Decision history and notifications read it as one text.
 */
export function combinedReason(flags: Pick<NewFlag, "label" | "note">[], generalNote: string | null): string {
  // Trailing punctuation goes, so joining never gives "exit.; " or "exit.. General".
  const items = flags.map((flag) => `${flag.label}: ${flag.note.replace(/[.;\s]+$/, "")}`).join("; ");
  return generalNote ? `${items}. General: ${generalNote}` : items;
}

/** A stored flag, as far as clearing is concerned. */
export interface StoredFlag {
  arrangement_type: ArrangementType;
  arrangement_id: number;
  snapshot: Snapshot;
}

/** AC3: the arrangement no longer looks as it did when flagged (or is gone). */
export function hasChanged(
  flag: StoredFlag,
  states: ReturnType<typeof currentArrangements>,
): boolean {
  const state = states.get(key(flag.arrangement_type, Number(flag.arrangement_id)));
  if (!state) return true;
  const before = flag.snapshot ?? {};
  const keys = new Set([...Object.keys(before), ...Object.keys(state.snapshot)]);
  return [...keys].some((k) => before[k] !== state.snapshot[k]);
}
