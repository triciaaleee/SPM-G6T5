import { describe, expect, it } from "vitest";
import { GROUP_DEFS } from "../eventGroups";

/** Every status an event can be in once it has left Draft (AGENTS.md section 3). */
const ALL_STATUSES = [
  "Unassigned",
  "Requested",
  "Clarification Requested",
  "Planning",
  "Rejected",
  "Safety Review",
  "Confirmed",
  "Needs Review",
  "Completed",
  "Cancelled",
];

describe("GROUP_DEFS", () => {
  it("puts every status in exactly one group", () => {
    for (const status of ALL_STATUSES) {
      const owners = GROUP_DEFS.filter((g) => g.statuses.includes(status));
      expect(owners, status).toHaveLength(1);
    }
  });

  it("only names statuses that exist", () => {
    for (const group of GROUP_DEFS) {
      for (const status of group.statuses) expect(ALL_STATUSES).toContain(status);
    }
  });
});
