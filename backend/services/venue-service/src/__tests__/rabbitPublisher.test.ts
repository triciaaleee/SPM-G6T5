import { describe, expect, it } from "vitest";
import { createFakePublisher } from "../lib/rabbitPublisher.fake.js";

describe("createFakePublisher", () => {
  it("records what was published, without a live broker (M12)", async () => {
    const publisher = createFakePublisher();

    const ok = await publisher.publish({
      type: "booking.requested",
      eventId: 7,
      actorId: "COORD-0001",
      recipients: { userIds: ["VEN-0001"], roles: [] },
      data: { eventName: "Nut Festival", venueName: "Grand Ballroom" },
    });

    expect(ok).toBe(true);
    expect(publisher.published).toEqual([
      expect.objectContaining({ type: "booking.requested", eventId: 7 }),
    ]);
  });
});
