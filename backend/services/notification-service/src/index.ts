import "./lib/env.js";
import "./lib/checkEnv.js";
import { app } from "./app.js";
import { connectAndConsume } from "./lib/rabbitConsumer.js";
import { handleInboundMessage } from "./lib/notificationFromMessage.js";
import { resolveRoleUserIds } from "./lib/usersClient.js";
import { supabaseAdmin } from "./lib/supabaseAdmin.js";

const port = Number(process.env.NOTIFICATION_SERVICE_PORT ?? 4004);
app.listen(port, () => {
  console.log(`notification-service listening on :${port}`);
});

/**
 * Idle-ready: no publishers exist yet (ARD section 1.1), so a missing
 * RABBITMQ_URL or a broker that's down must not break the REST API —
 * only log, never process.exit.
 */
async function startRabbit(): Promise<void> {
  const url = process.env.RABBITMQ_URL;
  if (!url) {
    console.log("notification-service: RABBITMQ_URL not set, consumer idle");
    return;
  }

  try {
    const consumer = connectAndConsume(url, (msg) =>
      handleInboundMessage(msg, { supabase: supabaseAdmin, resolveRoleUserIds }),
    );
    await consumer.start();
    console.log("notification-service: connected to RabbitMQ, consuming connectsphere.events");
  } catch (err) {
    console.error("notification-service: failed to connect to RabbitMQ, consumer idle", err);
  }
}

void startRabbit();
