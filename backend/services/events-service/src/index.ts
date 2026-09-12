import "dotenv/config";
import cors from "cors";
import express from "express";
import { eventsRouter } from "./routes/events.js";
import { authRouter } from "./routes/auth.js";

const app = express();
app.use(cors());
app.use(express.json());

app.use("/api/auth", authRouter);
app.use("/api/events", eventsRouter);

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const port = Number(process.env.PORT ?? 4001);
app.listen(port, () => {
  console.log(`events-service listening on :${port}`);
});
