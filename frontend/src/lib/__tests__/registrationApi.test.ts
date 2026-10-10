import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccessDeniedError,
  RegistrationRequestError,
  fetchAttendeeEventView,
  fetchMyRegistrations,
  withdraw,
} from "../registrationApi";

vi.mock("../eventsApi", () => ({
  authHeader: () => ({ Authorization: "Bearer test-token" }),
  redirectIfUnauthenticated: vi.fn().mockResolvedValue(undefined),
}));

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchMyRegistrations", () => {
  it("requests the user's registrations with the bearer token", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { registrations: [{ registrationId: 1 }] }));

    const result = await fetchMyRegistrations("ATT-0001");

    expect(result).toEqual([{ registrationId: 1 }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/user\/ATT-0001$/);
    expect(init.headers).toEqual({ Authorization: "Bearer test-token" });
  });

  it("throws on a failed response", async () => {
    fetchMock.mockResolvedValue(jsonResponse(502, {}));

    await expect(fetchMyRegistrations("ATT-0001")).rejects.toThrow("Failed to load your events");
  });
});

describe("fetchAttendeeEventView", () => {
  it("returns the event from the view endpoint", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { event: { id: 7, name: "Fair" } }));

    const result = await fetchAttendeeEventView(7);

    expect(result).toEqual({ id: 7, name: "Fair" });
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/event\/7\/view$/);
  });

  it("throws AccessDeniedError on a 403", async () => {
    fetchMock.mockResolvedValue(jsonResponse(403, { error: "Access denied" }));

    await expect(fetchAttendeeEventView(7)).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("throws a plain error on other failures", async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, {}));

    const error = await fetchAttendeeEventView(7).catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AccessDeniedError);
  });
});

describe("withdraw", () => {
  it("PATCHes the withdraw endpoint", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { registration: {} }));

    await withdraw(7);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/event\/7\/withdraw$/);
    expect(init.method).toBe("PATCH");
  });

  it("surfaces the backend's message and code on a refusal", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(409, { error: "You have already withdrawn from this event", code: "already_withdrawn" }),
    );

    const error = (await withdraw(7).catch((e) => e)) as RegistrationRequestError;

    expect(error).toBeInstanceOf(RegistrationRequestError);
    expect(error.status).toBe(409);
    expect(error.code).toBe("already_withdrawn");
    expect(error.message).toBe("You have already withdrawn from this event");
  });

  it("falls back to a generic message when the error has no body", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("no body");
      },
    } as unknown as Response);

    const error = (await withdraw(7).catch((e) => e)) as RegistrationRequestError;

    expect(error.message).toBe("Failed to withdraw");
    expect(error.code).toBeNull();
  });
});
