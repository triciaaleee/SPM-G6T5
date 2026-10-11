import { describe, expect, it } from "vitest";
import { reviewOutcomeLabel } from "../eventStatus";

describe("reviewOutcomeLabel", () => {
  it.each(["Planning", "Safety Review", "Confirmed", "Completed"])("shows %s as Approved by the coordinator", (status) => {
    expect(reviewOutcomeLabel(status)).toBe("Approved");
  });

  it("shows Requested as Pending", () => {
    expect(reviewOutcomeLabel("Requested")).toBe("Pending");
  });
});
