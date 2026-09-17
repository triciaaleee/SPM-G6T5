/**
 * Maps an event's status to the badge colour class used on both the
 * events list and the event detail page.
 */
export function statusBadgeClass(status: string): string {
  if (status === "Planning" || status === "Confirmed" || status === "Completed") return "status-success";
  if (status === "Rejected") return "status-error";
  if (status === "Clarification Requested") return "status-info";
  return "status-warning"; // Requested
}

/**
 * E3-1 AC1: the date a status last changed. decided_at is set the moment a
 * coordinator approves/rejects/requests clarification (see 0007 migration);
 * before any decision, the status hasn't changed since submission, so
 * created_at is the honest "last changed" date.
 */
export function statusLastChangedAt(event: { decided_at: string | null; created_at: string }): string {
  return event.decided_at ?? event.created_at;
}

export function formatEventDate(value: string | null | undefined): string {
  if (!value) return "Not provided";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString("en-US", { day: "numeric", month: "long", year: "numeric" });
}

/**
 * The events list flags an event awaiting the Organiser's reply with
 * "Awaiting Clarification" rather than the raw "Clarification Requested"
 * status value, so it reads as an action prompt rather than internal state.
 */
export function statusLabel(status: string): string {
  if (status === "Clarification Requested") return "Awaiting Clarification";
  return status;
}

/**
 * The "Review outcome" field shows one of a fixed set of labels rather
 * than the free-text review_outcome column (which holds the rejection
 * reason or clarification message — detail that belongs to the
 * rejection note / clarification thread, not this summary field).
 */
export function reviewOutcomeLabel(status: string): string {
  if (status === "Planning" || status === "Confirmed" || status === "Completed") return "Approved";
  if (status === "Rejected") return "Rejected";
  if (status === "Clarification Requested") return "Clarification Ongoing";
  return "Pending"; // Requested / Unassigned
}
