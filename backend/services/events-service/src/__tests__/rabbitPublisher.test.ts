import { describe, expect, it } from "vitest";
import { createFakePublisher } from "../lib/rabbitPublisher.fake.js";

describe("createFakePublisher", () => {
  it("records what was published, without a live broker (M12)", async () => {
    const publisher = createFakePublisher();

    const ok = await publisher.publish({
      type: "coordinator.assigned",
      eventId: 7,
      actorId: "LEAD-0001",
      recipients: { userIds: ["COORD-0002", "ORG-0001"], roles: [] },
      data: { eventName: "Nut Festival" },
    });

    expect(ok).toBe(true);
    expect(publisher.published).toEqual([
      expect.objectContaining({ type: "coordinator.assigned", eventId: 7 }),
    ]);
  });
});
