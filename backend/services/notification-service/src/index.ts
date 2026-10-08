import "./lib/env.js";
import cors from "cors";
import express from "express";
import { notificationsRouter } from "./routes/notifications.js";

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
