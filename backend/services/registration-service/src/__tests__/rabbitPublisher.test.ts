import { describe, expect, it } from "vitest";
import { createFakePublisher } from "../lib/rabbitPublisher.fake.js";

describe("createFakePublisher", () => {
  it("records what was published, without a live broker (M12)", async () => {
    const publisher = createFakePublisher();

    const ok = await publisher.publish({
      type: "registration.confirmed",
      eventId: 1,
      actorId: "ATT-0001",
      recipients: { userIds: ["ATT-0001"], roles: [] },
      data: { eventName: "Freshman Orientation Fair" },
    });

    expect(ok).toBe(true);
    expect(publisher.published).toEqual([
      expect.objectContaining({ type: "registration.confirmed", eventId: 1 }),
    ]);
  });
});
