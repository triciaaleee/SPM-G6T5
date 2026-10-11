/**
 * The event lifecycle's status values (AGENTS.md §3), spelled exactly as
 * the `event_status` Postgres enum (migration 0014) spells them. New code
 * reads them from here rather than repeating string literals.
 */
export const EVENT_STATUS = {
  Draft: "Draft",
  Unassigned: "Unassigned",
  Requested: "Requested",
  ClarificationRequested: "Clarification Requested",
  Planning: "Planning",
  SafetyReview: "Safety Review",
  Confirmed: "Confirmed",
  Completed: "Completed",
  Rejected: "Rejected",
  Cancelled: "Cancelled",
} as const;

export type EventStatus = (typeof EVENT_STATUS)[keyof typeof EVENT_STATUS];

/**
 * End states: no transitions out (§3). E2-12 AC3: an event in one of these
 * can no longer be reassigned.
 */
export const CLOSED_EVENT_STATUSES: ReadonlySet<string> = new Set([
  EVENT_STATUS.Rejected,
  EVENT_STATUS.Cancelled,
  EVENT_STATUS.Completed,
]);
