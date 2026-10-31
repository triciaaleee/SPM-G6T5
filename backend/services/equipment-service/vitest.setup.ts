import net from "node:net";
import { afterEach, beforeEach, vi } from "vitest";
import { TEST_NOW } from "./src/__tests__/helpers/testClock.js";

/**
 * supertest starts each test app with `app.listen(0)`, which binds every
 * interface, and then calls it on 127.0.0.1. On macOS another app can already
 * own that port on loopback only (Notion, VS Code, Figma): the OS lets both
 * bind, the request reaches the other app, and the test fails at random with
 * a 404 or "socket hang up". Binding the ephemeral port to 127.0.0.1 makes
 * the kernel pick a port that is free there, so the collision cannot happen.
 *
 * supertest reads `app.address()` straight after `listen(0)`, so the bind has
 * to be synchronous; `listen(0, "127.0.0.1")` resolves the host first and is
 * not. net's own server-handle helper binds synchronously. Only the bare
 * `listen(0)` supertest uses is changed, and anything unexpected falls back to
 * the original behaviour.
 */
const originalListen = net.Server.prototype.listen;
const createServerHandle = (net as unknown as { _createServerHandle?: (host: string, port: number, family: number) => unknown })._createServerHandle;

net.Server.prototype.listen = function (this: net.Server, ...args: unknown[]) {
  if (args.length === 1 && args[0] === 0 && createServerHandle) {
    const handle = createServerHandle("127.0.0.1", 0, 4);
    if (typeof handle === "object" && handle !== null) return originalListen.call(this, handle as never);
  }
  return originalListen.apply(this, args as never);
} as typeof net.Server.prototype.listen;

/**
 * Every test starts on the same fixed date, so nothing depends on the day or
 * time it happens to run. Only `Date` is faked: timers, promises and the lock's
 * retry delays still run for real. A test that needs another instant calls
 * `vi.setSystemTime(...)` itself and wins, because this runs first.
 */

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: TEST_NOW });
});

afterEach(() => {
  vi.useRealTimers();
});
