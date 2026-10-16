import type { InboundMessage, MessageHandler, RabbitConsumer } from "./rabbitConsumer.js";

/**
 * A drop-in for `connectAndConsume` that tests use instead of a live
 * broker. `start`/`stop` are no-ops; `publishForTest` calls the handler
 * directly, the same way the real consumer would after parsing a
 * delivered message.
 */
export interface FakeRabbitConsumer extends RabbitConsumer {
  publishForTest(msg: InboundMessage): Promise<void>;
}

export function createFakeConsumer(handler: MessageHandler): FakeRabbitConsumer {
  return {
    async start() {},
    async stop() {},
    async publishForTest(msg: InboundMessage) {
      await handler(msg);
    },
  };
}
