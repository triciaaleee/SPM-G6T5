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
