import { describe, expect, it, vi } from "vitest";

/**
 * TIMING_DECOY_HASH (routes/auth.ts) exists only so a login against an
 * unknown email costs roughly the same bcrypt.compare time as a login
 * against a real one — its value is deliberately never surfaced in any
 * response. That makes it a true equivalent mutant for every ordinary
 * behavioural test: mutating the hashed text to "" changes nothing any
 * assertion on status/body can see. This test instead re-imports the
 * module under a spied bcryptjs to pin the literal string hashed at
 * import time, which is the only way to actually observe it.
 */
vi.mock("../lib/supabaseAdmin.js", () => ({ supabaseAdmin: {} }));

describe("routes/auth.ts module scope — TIMING_DECOY_HASH", () => {
  it("hashes the fixed decoy string at import time, not an empty string", async () => {
    const actualBcrypt = await vi.importActual<typeof import("bcryptjs")>("bcryptjs");
    const hashSyncSpy = vi.fn(actualBcrypt.hashSync);
    vi.doMock("bcryptjs", () => ({ default: { ...actualBcrypt, hashSync: hashSyncSpy } }));

    await import("../routes/auth.js");

    expect(hashSyncSpy).toHaveBeenCalledWith("timing-decoy", 10);
  });
});
