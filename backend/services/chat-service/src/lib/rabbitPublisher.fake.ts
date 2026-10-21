import type { EventPublisher, OutboundMessage } from "./rabbitPublisher.js";

/** A drop-in for tests (M12) that records what was published instead of using a live broker. */
export function createFakePublisher(): EventPublisher & { published: OutboundMessage[] } {
  const published: OutboundMessage[] = [];
  return {
    published,
    async publish(msg: OutboundMessage) {
      published.push(msg);
      return true;
    },
  };
}
