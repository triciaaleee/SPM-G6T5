import cors from "cors";
import express from "express";
import { chatRouter } from "./routes/chatMessages.js";

/** The Express app, separate from index.ts so tests can mount it without listening. */
export const app = express();

/**
 * CORS_ORIGIN (comma-separated) pins the browser origins allowed to call the
 * chat API. Unset keeps local dev open, as before.
 */
const allowedOrigins = (process.env.CORS_ORIGIN ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
app.use(cors(allowedOrigins.length > 0 ? { origin: allowedOrigins } : undefined));
app.use(express.json());

app.use("/api/chat", chatRouter);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});
