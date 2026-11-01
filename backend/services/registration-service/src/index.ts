import "./lib/env.js";
import "./lib/checkEnv.js";
import { app } from "./app.js";
import { connectAndConsume } from "./lib/rabbitConsumer.js";
import { handleEventCancelled } from "./lib/eventCancelledHandler.js";
import { supabaseAdmin } from "./lib/supabaseAdmin.js";

const port = Number(process.env.REGISTRATION_SERVICE_PORT ?? 4007);
app.listen(port, () => {
  console.log(`registration-service listening on :${port}`);
});

/**
 * E3-6: consumes `event.cancelled` to withdraw every registered place for
 * a cancelled event and notify those attendees. A missing RABBITMQ_URL or
 * a broker that's down must not break the REST API — only log, never
 * process.exit.
 */
async function startRabbit(): Promise<void> {
  const url = process.env.RABBITMQ_URL;
  if (!url) {
    console.log("registration-service: RABBITMQ_URL not set, consumer idle");
    return;
  }

  try {
    const consumer = connectAndConsume(url, (msg) => handleEventCancelled(msg, { supabase: supabaseAdmin }));
    await consumer.start();
    console.log("registration-service: connected to RabbitMQ, consuming event.cancelled");
  } catch (err) {
    console.error("registration-service: failed to connect to RabbitMQ, consumer idle", err);
  }
}

void startRabbit();
