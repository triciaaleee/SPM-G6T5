// @ts-nocheck
import "./lib/env.js";
import cors from "cors";
import express from "express";
import { eventsRouter } from "./routes/events.js";
import { publicEventsRouter } from "./routes/publicEvents.js";
import { startOutboxRelay } from "./lib/outbox.js";
import { supabaseAdmin } from "./lib/supabaseAdmin.js";

/**
 * Fail loudly at boot instead of at the first login. A missing JWT_SECRET
 * or service-role key otherwise surfaces as an opaque 500 from deep inside
 * jsonwebtoken or supabase-js, which is a miserable first run for anyone
 * who just cloned the repo.
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

// Guests' view of listed events — no login, so mounted ahead of eventsRouter's blanket requireAuth.
app.use("/api/events/public", publicEventsRouter);
app.use("/api/events", eventsRouter);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const port = Number(process.env.EVENTS_SERVICE_PORT ?? 4001);
app.listen(port, () => {
  console.log(`events-service listening on :${port}`);
});

// Retries any action message (e.g. event.cancelled) the broker hasn't confirmed yet.
startOutboxRelay(supabaseAdmin);
