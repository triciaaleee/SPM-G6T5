import type { EventSummary } from "./eventsApi";
import type { CoordinatorOption } from "./usersApi";

/**
 * Week 7 change 5: the Event Coordinator Lead's view of who is working on
 * what. Shared by the Assignment overview and the one-coordinator page.
 */

/**
 * Not an active assignment: drafts and the Unassigned queue have no
 * coordinator yet, and the end states (AGENTS.md §3) are no longer
 * under the Lead's supervision.
 */
const NOT_ACTIVE = new Set(["Draft", "Unassigned", "Rejected", "Cancelled", "Completed"]);

export interface CoordinatorGroup {
  id: string;
  name: string;
  /** Soonest event first; events with no date last. */
  events: EventSummary[];
}

export function isActiveAssignment(event: EventSummary): boolean {
  return !NOT_ACTIVE.has(event.status) && !!event.coordinator_id;
}

function detail(event: EventSummary, key: string): string | null {
  const value = (event.submitted_details as Record<string, unknown> | null)?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function eventName(event: EventSummary): string {
  return detail(event, "name") ?? `Event #${event.id}`;
}

function byEventDate(a: EventSummary, b: EventSummary): number {
  const da = detail(a, "proposedDate");
  const db = detail(b, "proposedDate");
  if (da === db) return a.id - b.id;
  if (da === null) return 1;
  if (db === null) return -1;
  return da.localeCompare(db);
}

/**
 * One group per coordinator, including those with no active events (so
 * the Lead can see who is free). A coordinator who holds events but isn't
 * in the list still gets a group, named from the event. Busiest first,
 * then by name.
 */
export function groupByCoordinator(coordinators: CoordinatorOption[], events: EventSummary[]): CoordinatorGroup[] {
  const groups = new Map<string, CoordinatorGroup>();
  for (const coordinator of coordinators) {
    groups.set(coordinator.id, { id: coordinator.id, name: coordinator.name, events: [] });
  }

  for (const event of events) {
    if (!isActiveAssignment(event)) continue;
    const id = event.coordinator_id!;
    if (!groups.has(id)) groups.set(id, { id, name: event.coordinator?.name ?? id, events: [] });
    groups.get(id)!.events.push(event);
  }

  for (const group of groups.values()) group.events.sort(byEventDate);
  return [...groups.values()].sort((a, b) => b.events.length - a.events.length || a.name.localeCompare(b.name));
}

/** "Hui Min Tan" → "HT", "Priya" → "P". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0].charAt(0);
  const last = words.length > 1 ? words[words.length - 1].charAt(0) : "";
  return (first + last).toUpperCase();
}

/** "2026-11-12" → "12 Nov". Parsed as a local date so it never slips a day. */
function shortDate(value: string): string {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** "12 Nov", or null when the event has no date yet. */
export function eventDateLabel(event: EventSummary): string | null {
  const date = detail(event, "proposedDate");
  return date ? shortDate(date) : null;
}

/** "18:00 to 21:00" from the event's start and end time; just the start if there is no end; null if neither. */
export function eventTimeLabel(event: EventSummary): string | null {
  const start = detail(event, "startTime");
  const end = detail(event, "endTime");
  if (start && end) return `${start} to ${end}`;
  return start ?? null;
}

/** The requester's name, or null when it isn't known. */
export function eventOrganiser(event: EventSummary): string | null {
  return event.organiser?.name?.trim() || null;
}

/** The venue the organiser asked for, or null when none was given. */
export function eventVenue(event: EventSummary): string | null {
  return detail(event, "venue");
}

/** "12 Nov, Marina Bay Ballroom" from the event's date and requested venue; either part may be missing. */
export function eventWhen(event: EventSummary): string {
  const parts = [eventDateLabel(event), eventVenue(event)].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : "Date to be confirmed";
}

export function activeEventsLabel(count: number): string {
  return `${count} active ${count === 1 ? "event" : "events"}`;
}
