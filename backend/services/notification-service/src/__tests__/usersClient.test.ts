import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRoleUserIds } from "../lib/usersClient.js";

const fetchMock = vi.fn();

function reply(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  process.env.INTERNAL_SERVICE_SECRET = "internal-secret";
  delete process.env.USER_SERVICE_URL;
  delete process.env.USER_SERVICE_PORT;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.INTERNAL_SERVICE_SECRET;
  delete process.env.USER_SERVICE_URL;
  delete process.env.USER_SERVICE_PORT;
});

describe("resolveRoleUserIds", () => {
  it("returns the ids of the users holding the role", async () => {
    fetchMock.mockResolvedValue(reply(200, { users: [{ id: "LEAD-0001" }, { id: "LEAD-0002" }] }));
    expect(await resolveRoleUserIds("coordinator_lead")).toEqual(["LEAD-0001", "LEAD-0002"]);
  });

  it("calls USER_SERVICE_URL with the role encoded", async () => {
    process.env.USER_SERVICE_URL = "http://users.test";
    process.env.USER_SERVICE_PORT = "9999";
    fetchMock.mockResolvedValue(reply(200, { users: [] }));
    await resolveRoleUserIds("a role&x");
    expect(fetchMock.mock.calls[0][0]).toBe("http://users.test/api/users?role=a%20role%26x");
  });

  it("falls back to USER_SERVICE_PORT on localhost", async () => {
    process.env.USER_SERVICE_PORT = "9999";
    fetchMock.mockResolvedValue(reply(200, { users: [] }));
    await resolveRoleUserIds("r");
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:9999/api/users?role=r");
  });

  it("falls back to port 4002 when neither is set", async () => {
    fetchMock.mockResolvedValue(reply(200, { users: [] }));
    await resolveRoleUserIds("r");
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:4002/api/users?role=r");
  });

  it("authenticates as notification-service with an internal token", async () => {
    fetchMock.mockResolvedValue(reply(200, { users: [] }));
    await resolveRoleUserIds("r");
    const token = fetchMock.mock.calls[0][1].headers["X-Internal-Auth"];
    expect(jwt.verify(token, "internal-secret")).toMatchObject({ svc: "notification-service" });
  });

  it("returns no ids for a role nobody holds", async () => {
    fetchMock.mockResolvedValue(reply(200, { users: [] }));
    expect(await resolveRoleUserIds("r")).toEqual([]);
  });

  it("returns no ids when the reply has no users field", async () => {
    fetchMock.mockResolvedValue(reply(200, {}));
    expect(await resolveRoleUserIds("r")).toEqual([]);
  });

  // A failed lookup must not read as "nobody holds this role": the consumer would ack the message and lose it.
  it("throws when user-service replies with an error", async () => {
    fetchMock.mockResolvedValue(reply(500, { error: "Failed to load users" }));
    await expect(resolveRoleUserIds("coordinator_lead")).rejects.toThrow(
      'user-service returned 500 resolving role "coordinator_lead"',
    );
  });

  it("throws when user-service can't be reached", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(resolveRoleUserIds("r")).rejects.toThrow("fetch failed");
  });

  it("throws when the internal secret is missing", async () => {
    delete process.env.INTERNAL_SERVICE_SECRET;
    await expect(resolveRoleUserIds("r")).rejects.toThrow("INTERNAL_SERVICE_SECRET is not set");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
