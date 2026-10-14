// Smoke test: boot every service with the real `npm run dev` and check that
// each GET /health returns {"ok":true} (AGENTS.md §2).
//
// Services are discovered from services/*/ and each port is read from that
// service's src/index.ts (`process.env.X_SERVICE_PORT ?? 4001`), overridden by
// the env var when set. A service missing from the `dev` script therefore
// fails here instead of passing silently.
//
// Usage (from backend/): npm run smoke
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BACKEND_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVICES_DIR = join(BACKEND_DIR, "services");
const TIMEOUT_MS = Number(process.env.SMOKE_TIMEOUT_MS ?? 60_000);
const POLL_MS = 500;

function discoverServices() {
  return readdirSync(SERVICES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(SERVICES_DIR, entry.name, "package.json")))
    .map((entry) => {
      const indexPath = join(SERVICES_DIR, entry.name, "src", "index.ts");
      const source = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
      const match = source.match(/process\.env\.([A-Z_]+_SERVICE_PORT)\s*\?\?\s*(\d+)/);
      if (!match) {
        throw new Error(`${entry.name}: no "process.env.<NAME>_SERVICE_PORT ?? <port>" in src/index.ts`);
      }
      const [, portVar, defaultPort] = match;
      return { name: entry.name, port: Number(process.env[portVar] ?? defaultPort) };
    });
}

/** Resolves to the parsed /health body, or null if nothing answered. */
async function getHealth(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) });
    return { status: res.status, body: await res.text() };
  } catch {
    return null;
  }
}

function isHealthy(result) {
  if (!result || result.status !== 200) return false;
  try {
    const body = JSON.parse(result.body);
    return body !== null && typeof body === "object" && Object.keys(body).length === 1 && body.ok === true;
  } catch {
    return false;
  }
}

function stopTree(child) {
  if (child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGTERM"); // the whole process group (detached below)
    } catch {
      // already gone
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const services = discoverServices();

  // Something already listening would make the check pass against the wrong process.
  const busy = [];
  for (const service of services) {
    if (await getHealth(service.port)) busy.push(`${service.name} (:${service.port})`);
  }
  if (busy.length > 0) {
    console.error(`Ports already in use, stop the running services first: ${busy.join(", ")}`);
    process.exit(1);
  }

  console.log(`Starting ${services.length} services with \`npm run dev\`...`);
  const child = spawn("npm", ["run", "dev"], {
    cwd: BACKEND_DIR,
    stdio: "inherit",
    shell: process.platform === "win32",
    detached: process.platform !== "win32",
  });
  let exited = false;
  child.on("exit", () => (exited = true));

  const healthy = new Set();
  const deadline = Date.now() + TIMEOUT_MS;
  while (healthy.size < services.length && Date.now() < deadline && !exited) {
    for (const service of services) {
      if (!healthy.has(service.name) && isHealthy(await getHealth(service.port))) healthy.add(service.name);
    }
    if (healthy.size < services.length) await sleep(POLL_MS);
  }

  const results = await Promise.all(
    services.map(async (service) => ({ ...service, result: healthy.has(service.name) ? null : await getHealth(service.port) })),
  );
  stopTree(child);

  console.log("\nSmoke test results:");
  for (const { name, port, result } of results) {
    const ok = healthy.has(name);
    const detail = ok ? "" : result ? `  got ${result.status} ${result.body}` : "  no response";
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${name.padEnd(22)} :${port}${detail}`);
  }

  if (healthy.size < services.length) {
    if (exited) console.error("\n`npm run dev` exited early; see its output above.");
    else console.error(`\nNot every service was healthy within ${TIMEOUT_MS / 1000}s.`);
    process.exit(1);
  }
  console.log(`\nAll ${services.length} services healthy.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
