import { describe, expect, it, vi } from "vitest";
import { createFakeConsumer } from "../lib/rabbitConsumer.fake.js";
import type { InboundMessage } from "../lib/rabbitConsumer.js";

const msg: InboundMessage = {
  messageId: "11111111-1111-1111-1111-111111111111",
  type: "booking.withdrawn",
  occurredAt: "2026-10-10T08:15:00Z",
  publisher: "venue-service",
  actorId: "COORD-0003",
  eventId: 7,
  recipients: { userIds: ["VEN-0001"], roles: [] },
  data: {},
};

describe("createFakeConsumer", () => {
  it("calls the handler directly, without a live broker (M12)", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const consumer = createFakeConsumer(handler);

    await consumer.start();
    await consumer.publishForTest(msg);

    expect(handler).toHaveBeenCalledWith(msg);
  });
});
