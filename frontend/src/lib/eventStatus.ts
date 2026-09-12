/**
 * Maps an event's status to the badge colour class used on both the
 * events list and the event detail page.
 */
export function statusBadgeClass(status: string): string {
  if (status === "Planning") return "status-success";
  if (status === "Rejected") return "status-error";
  if (status === "Clarification Requested") return "status-info";
  return "status-warning"; // Requested
}
