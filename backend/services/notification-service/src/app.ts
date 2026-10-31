import cors from "cors";
import express from "express";
import { notificationsRouter } from "./routes/notifications.js";

/** The Express app, separate from index.ts so tests can mount it without listening. */
export const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/notifications", notificationsRouter);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});
