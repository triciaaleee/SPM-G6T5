/**
 * change_requests.status values, spelled exactly as the
 * change_request_status Postgres enum (migrations 0036, 0038) spells
 * them. `Auto-Withdrawn` is its own status, not a flavour of `Approved` —
 * when every held field gets reverted before anyone decides on it,
 * nothing was actually approved, so calling it `Approved` would be a
 * lie. Named "Auto-" rather than plain "Withdrawn" because there is no
 * manual withdraw-this-request action anywhere in the system yet; one
 * gets its own plain `Withdrawn` value if that's ever built, with no
 * collision.
 */
export const CHANGE_REQUEST_STATUS = {
  Pending: "Pending",
  Approved: "Approved",
  Rejected: "Rejected",
  AutoWithdrawn: "Auto-Withdrawn",
} as const;

export type ChangeRequestStatus = (typeof CHANGE_REQUEST_STATUS)[keyof typeof CHANGE_REQUEST_STATUS];

/**
 * E3-9 AC3: a purely non-critical submission is `Approved` immediately —
 * truthfully, since it really was applied, no coordinator decision
 * pending or skipped. But `decided_by` stays null just like a future
 * coordinator's own approval (E3-11) would look different only once that
 * exists, so this reason prefix is what tells the two apart on both
 * sides in the meantime; `Approved` itself needs no separate status for
 * this, unlike the withdrawn case above.
 */
export const AUTO_APPLIED_REASON_PREFIX = "Applied automatically — ";
