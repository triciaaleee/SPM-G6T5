import cors from "cors";
import express from "express";
import { registrationsRouter } from "./routes/registrations.js";

/** The Express app, separate from index.ts so tests can mount it without listening. */
export const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/registrations", registrationsRouter);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});
