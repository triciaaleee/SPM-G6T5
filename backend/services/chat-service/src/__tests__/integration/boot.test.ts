/**
 * Boots the real src/index.ts as a child process (the only way to exercise
 * the env check, router mounting and /health, since index.ts listens on
 * import). No database traffic — the app only talks to Supabase per request.
 */
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const PORT = 45906;
let child: ReturnType<typeof spawn> | undefined;

function boot(env: Record<string, string>) {
  child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (out += d));
  return { output: () => out, exited: new Promise<number | null>((r) => child!.on("exit", (code) => r(code))) };
}

async function waitForHealth(): Promise<Response> {
  for (let i = 0; i < 60; i++) {
    try {
      return await fetch(`http://127.0.0.1:${PORT}/health`);
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error("service never became healthy");
}

afterEach(() => {
  child?.kill();
  child = undefined;
});

describe("chat-service boot", () => {
  it("exits 1 naming a missing JWT_SECRET", async () => {
    const run = boot({ SUPABASE_URL: "http://127.0.0.1:1", SUPABASE_SERVICE_ROLE_KEY: "k", JWT_SECRET: "", CHAT_SERVICE_PORT: String(PORT) });
    expect(await run.exited).toBe(1);
    expect(run.output()).toContain("Missing required environment variable(s): JWT_SECRET");
  });

  it("exits non-zero when SUPABASE_URL is missing", async () => {
    const run = boot({ SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "k", JWT_SECRET: "s", CHAT_SERVICE_PORT: String(PORT) });
    expect(await run.exited).not.toBe(0);
  });

  it("prints the friendly 'Missing required environment variable(s)' message for SUPABASE_URL", async () => {
    const run = boot({ SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "", JWT_SECRET: "", CHAT_SERVICE_PORT: String(PORT) });
    await run.exited;
    expect(run.output()).toContain("Missing required environment variable(s): SUPABASE_URL");
  });

  it("serves /health and rejects unauthenticated chat requests", async () => {
    boot({ SUPABASE_URL: "http://127.0.0.1:1", SUPABASE_SERVICE_ROLE_KEY: "k", JWT_SECRET: "s", CHAT_SERVICE_PORT: String(PORT) });
    const health = await waitForHealth();
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    const chat = await fetch(`http://127.0.0.1:${PORT}/api/chat/threads`);
    expect(chat.status).toBe(401);
    expect(await chat.json()).toMatchObject({ code: "no_token" });

    const unknown = await fetch(`http://127.0.0.1:${PORT}/api/nope`);
    expect(unknown.status).toBe(404);
  });
});
