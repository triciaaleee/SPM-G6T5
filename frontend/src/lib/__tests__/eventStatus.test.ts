import { describe, expect, it } from "vitest";
import { reviewOutcomeLabel, statusBadgeClass } from "../eventStatus";

describe("reviewOutcomeLabel", () => {
  it.each(["Planning", "Safety Review", "Confirmed", "Needs Review", "Completed"])("shows %s as Approved by the coordinator", (status) => {
    expect(reviewOutcomeLabel(status)).toBe("Approved");
  });

  it("shows Requested as Pending", () => {
    expect(reviewOutcomeLabel("Requested")).toBe("Pending");
  });
});

describe("statusBadgeClass", () => {
  it("shows Needs Review as info, distinct from Confirmed's success", () => {
    expect(statusBadgeClass("Needs Review")).toBe("status-info");
    expect(statusBadgeClass("Confirmed")).toBe("status-success");
  });
});
