import "./lib/env.js";
import cors from "cors";
import express from "express";
import { attendeeInfoRouter } from "./routes/attendeeInfo.js";
import { eventBookingsRouter } from "./routes/eventBookings.js";
import { staffRouter } from "./routes/staff.js";
import { unavailabilityRouter } from "./routes/unavailability.js";
import { venuesRouter } from "./routes/venues.js";
import { sweepExpiringHolds } from "./lib/bookingDecisions.js";
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

// Both mounted before venuesRouter: that router is coordinator-only for
// every path under it, so venue staff requests and an organiser's view of
// their own event's bookings must be answered first.
app.use("/api/venues/staff", staffRouter);
// E4-3: venue staff only, so also mounted ahead of venuesRouter.
app.use("/api/venues/unavailability", unavailabilityRouter);
app.use("/api/venues/events", eventBookingsRouter);
// E6: attendees' view of where an event is held — names only, ahead of venuesRouter.
app.use("/api/venues/attendee-info", attendeeInfoRouter);
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
