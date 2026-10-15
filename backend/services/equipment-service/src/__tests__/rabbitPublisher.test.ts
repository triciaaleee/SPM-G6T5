import { describe, expect, it } from "vitest";
import { createFakePublisher } from "../lib/rabbitPublisher.fake.js";

describe("createFakePublisher", () => {
  it("records what was published, without a live broker (M12)", async () => {
    const publisher = createFakePublisher();

    const ok = await publisher.publish({
      type: "equipment.requested",
      eventId: 7,
      actorId: "COORD-0001",
      recipients: { userIds: [], roles: ["technical_support"] },
      data: { eventName: "Nut Festival", itemCount: 2 },
    });

    expect(ok).toBe(true);
    expect(publisher.published).toEqual([
      expect.objectContaining({ type: "equipment.requested", eventId: 7 }),
    ]);
  });
});
