import "./lib/env.js";
import cors from "cors";
import express from "express";
import { notificationsRouter } from "./routes/notifications.js";
import { connectAndConsume } from "./lib/rabbitConsumer.js";
import { handleInboundMessage } from "./lib/notificationFromMessage.js";
import { resolveRoleUserIds } from "./lib/usersClient.js";
import { supabaseAdmin } from "./lib/supabaseAdmin.js";

/**
 * Fail loudly at boot instead of at the first request — a missing secret
 * otherwise surfaces as an opaque 500 from deep inside jsonwebtoken or
 * supabase-js.
 */
const REQUIRED_ENV = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "JWT_SECRET"] as const;
const missing = REQUIRED_ENV.filter((key) => !process.env[key]);

if (missing.length > 0) {
  console.error(
    `Missing required environment variable(s): ${missing.join(", ")}\n` +
      `Set them in backend/.env (see backend/.env.example).`,
  );
  process.exit(1);
}

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/notifications", notificationsRouter);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

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
