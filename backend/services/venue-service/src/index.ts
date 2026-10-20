import "./lib/env.js";
import cors from "cors";
import express from "express";
import { attendeeInfoRouter } from "./routes/attendeeInfo.js";
import { publicVenuesRouter } from "./routes/publicVenues.js";
import { eventBookingsRouter } from "./routes/eventBookings.js";
import { staffRouter } from "./routes/staff.js";
import { suitabilityRouter } from "./routes/suitability.js";
import { unavailabilityRouter } from "./routes/unavailability.js";
import { venuesRouter } from "./routes/venues.js";
import { sweepExpiringHolds } from "./lib/bookingDecisions.js";
import { supabaseAdmin } from "./lib/supabaseAdmin.js";
import { connectAndConsume } from "./lib/rabbitConsumer.js";
import { handleEventCancelled } from "./lib/eventCancelledHandler.js";

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

// Both mounted before venuesRouter: that router is coordinator-only for
// every path under it, so venue staff requests and an organiser's view of
// their own event's bookings must be answered first.
app.use("/api/venues/staff", staffRouter);
// E4-3: venue staff only, so also mounted ahead of venuesRouter.
app.use("/api/venues/unavailability", unavailabilityRouter);
app.use("/api/venues/events", eventBookingsRouter);
// E4-17: coordinator-only, its own path so it never shadows venuesRouter.
app.use("/api/venues/suitability", suitabilityRouter);
// E6: attendees' view of where an event is held — names only, ahead of venuesRouter.
app.use("/api/venues/attendee-info", attendeeInfoRouter);
// Guests' view of venues and of where listed events are held — no login, ahead of venuesRouter.
app.use("/api/venues/public", publicVenuesRouter);
app.use("/api/venues", venuesRouter);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const port = Number(process.env.VENUE_SERVICE_PORT ?? 4003);
app.listen(port, () => {
  console.log(`venue-service listening on :${port}`);
});

/**
 * #106 row 4b: venue-service's first background job — everything else
 * here is request-triggered. Runs independently of any queue view, so a
 * hold still warns its coordinator even if nobody opens the staff queue
 * before it lapses. Failures are caught and logged; a bad sweep must never
 * crash the service, since the REST API has nothing to do with it.
 */
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;
setInterval(() => {
  sweepExpiringHolds(supabaseAdmin).catch((err) => {
    console.error("venue-service: expiring-hold sweep failed", err);
  });
}, SWEEP_INTERVAL_MS);

/**
 * E3-6: consumes `event.cancelled` to release every active booking of a
 * cancelled event (AGENTS.md §3a). A missing RABBITMQ_URL or a broker
 * that's down must not break the REST API — only log, never process.exit.
 */
async function startRabbit(): Promise<void> {
  const url = process.env.RABBITMQ_URL;
  if (!url) {
    console.log("venue-service: RABBITMQ_URL not set, consumer idle");
    return;
  }

  try {
    const consumer = connectAndConsume(url, (msg) => handleEventCancelled(msg, { supabase: supabaseAdmin }));
    await consumer.start();
    console.log("venue-service: connected to RabbitMQ, consuming event.cancelled");
  } catch (err) {
    console.error("venue-service: failed to connect to RabbitMQ, consumer idle", err);
  }
}

void startRabbit();
