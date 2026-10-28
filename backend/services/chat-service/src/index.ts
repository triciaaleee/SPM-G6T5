import "./lib/env.js";
import "./lib/checkEnv.js";
import { app } from "./app.js";

const port = Number(process.env.CHAT_SERVICE_PORT ?? 4006);
app.listen(port, () => {
  console.log(`chat-service listening on :${port}`);
});
