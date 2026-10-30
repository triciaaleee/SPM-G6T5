import { describe, expect, it } from "vitest";
import { listingBadge } from "../registrationStatus";

describe("listingBadge", () => {
  it("says no registration is needed for an event that takes none, whatever its registration state", () => {
    expect(listingBadge({ registrationNeeded: false, registrationState: "CLOSED" })).toEqual({
      label: "No registration needed",
      className: "status-neutral",
    });
  });

  it("falls back to the registration state for an event that takes registration, or when the field is absent", () => {
    expect(listingBadge({ registrationNeeded: true, registrationState: "OPEN" }).label).toBe("Open");
    expect(listingBadge({ registrationState: "FULL" }).label).toBe("Full");
    expect(listingBadge({ registrationState: "CLOSED" }).label).toBe("Registration closed");
  });
});
