/**
 * Who acts next on an event, by status. Each status belongs to exactly one group; the Coordinator
 * dashboard and the Lead's one-coordinator page both group and filter by these.
 *
 * Matches the design's status-to-group mapping, except Requested (here, in Needs your action) — the design's
 * own doc flags excluding it as unconfirmed, and it conflicts with this codebase's needsAction() precedent.
 *
 * The labels are the coordinator's own point of view ("Needs your action"); a page that isn't the
 * coordinator's relabels the group it shows.
 */
export interface EventGroupDef {
  key: string;
  label: string;
  statuses: string[];
}

export const GROUP_DEFS: EventGroupDef[] = [
  { key: "action", label: "Needs your action", statuses: ["Requested", "Needs Review", "Planning"] },
  { key: "wait", label: "Waiting on others", statuses: ["Clarification Requested", "Safety Review"] },
  { key: "ontrack", label: "On track", statuses: ["Confirmed"] },
  // Statuses with no coordinator action to wait on or take: an unassigned request, or one that is over.
  { key: "other", label: "Other", statuses: ["Unassigned", "Rejected", "Cancelled", "Completed"] },
];
