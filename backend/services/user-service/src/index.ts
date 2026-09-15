import "./lib/env.js";
import cors from "cors";
import express from "express";
import { usersRouter } from "./routes/users.js";
import { authRouter } from "./routes/auth.js";

/**
 * Fail loudly at boot instead of at the first request. Mirrors the same
 * check in events-service/src/index.ts.
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

app.use("/api/auth", authRouter);
app.use("/api/users", usersRouter);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const port = Number(process.env.USER_SERVICE_PORT ?? 4002);
app.listen(port, () => {
  console.log(`user-service listening on :${port}`);
});
