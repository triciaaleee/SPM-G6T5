import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchEvent,
  fetchEventBookingInfo,
  reportArrangementsChanged,
  toSupportEventInfo,
} from "../lib/eventsClient.js";
import { fetchUserNames } from "../lib/usersClient.js";

const fetchMock = vi.fn();
const reply = (status: number, body?: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubEnv("EVENTS_SERVICE_URL", "http://events.test");
  vi.stubEnv("USER_SERVICE_URL", "http://users.test");
  vi.stubEnv("INTERNAL_SERVICE_SECRET", "internal");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("fetchEvent", () => {
  const event = { id: 7, status: "Planning", coordinator_id: "C1", submitted_details: {} };

  it("returns the event and forwards the caller's token", async () => {
    fetchMock.mockResolvedValue(reply(200, { event }));
    expect(await fetchEvent(7, "Bearer abc")).toEqual({ status: "ok", event });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("http://events.test/api/events/7", { headers: { Authorization: "Bearer abc" } });
  });

  it("is not_found for 403 and 404", async () => {
    fetchMock.mockResolvedValueOnce(reply(403));
    expect(await fetchEvent(7, "t")).toEqual({ status: "not_found" });
    fetchMock.mockResolvedValueOnce(reply(404));
    expect(await fetchEvent(7, "t")).toEqual({ status: "not_found" });
  });

  it("is error for any other failure status or a network error", async () => {
    fetchMock.mockResolvedValueOnce(reply(500));
    expect(await fetchEvent(7, "t")).toEqual({ status: "error" });
    fetchMock.mockResolvedValueOnce(reply(401));
    expect(await fetchEvent(7, "t")).toEqual({ status: "error" });
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    expect(await fetchEvent(7, "t")).toEqual({ status: "error" });
  });

  it("is not_found when the body carries no event", async () => {
    fetchMock.mockResolvedValue(reply(200, {}));
    expect(await fetchEvent(7, "t")).toEqual({ status: "not_found" });
  });

  it("falls back to localhost and the events port", async () => {
    vi.stubEnv("EVENTS_SERVICE_URL", undefined);
    vi.stubEnv("EVENTS_SERVICE_PORT", undefined);
    fetchMock.mockResolvedValue(reply(404));
    await fetchEvent(1, "t");
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:4001/api/events/1");

    vi.stubEnv("EVENTS_SERVICE_PORT", "5001");
    await fetchEvent(1, "t");
    expect(fetchMock.mock.calls[1][0]).toBe("http://localhost:5001/api/events/1");
  });
});

describe("reportArrangementsChanged", () => {
  it("posts the reason with an internal service token", async () => {
    fetchMock.mockResolvedValue(reply(200));
    expect(await reportArrangementsChanged(7, "a unit broke")).toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://events.test/api/events/7/arrangements-changed");
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ reason: "a unit broke" });
    const claims = jwt.verify(init.headers["X-Internal-Auth"], "internal") as jwt.JwtPayload;
    expect(claims.svc).toBe("equipment-service");
  });

  it("is false when events-service refuses", async () => {
    fetchMock.mockResolvedValue(reply(500));
    expect(await reportArrangementsChanged(7, "r")).toBe(false);
  });

  it("is false, never throwing, when events-service is unreachable", async () => {
    fetchMock.mockRejectedValue(new Error("down"));
    expect(await reportArrangementsChanged(7, "r")).toBe(false);
  });

  it("is false when the token can't even be signed", async () => {
    vi.stubEnv("INTERNAL_SERVICE_SECRET", "");
    expect(await reportArrangementsChanged(7, "r")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fetchEventBookingInfo", () => {
  it("does not call events-service for no ids", async () => {
    expect(await fetchEventBookingInfo([], "t")).toEqual({ status: "ok", events: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks for all ids in one call and returns the events", async () => {
    const events = [{ id: 1, name: "A" }, { id: 2, name: "B" }];
    fetchMock.mockResolvedValue(reply(200, { events }));
    expect(await fetchEventBookingInfo([1, 2], "Bearer x")).toEqual({ status: "ok", events });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("http://events.test/api/events/venue-booking-info?ids=1,2", {
      headers: { Authorization: "Bearer x" },
    });
  });

  it("is an empty list when the body has no events", async () => {
    fetchMock.mockResolvedValue(reply(200, {}));
    expect(await fetchEventBookingInfo([1], "t")).toEqual({ status: "ok", events: [] });
  });

  it("is error on a failure status or a network error", async () => {
    fetchMock.mockResolvedValueOnce(reply(403));
    expect(await fetchEventBookingInfo([1], "t")).toEqual({ status: "error" });
    fetchMock.mockRejectedValueOnce(new Error("down"));
    expect(await fetchEventBookingInfo([1], "t")).toEqual({ status: "error" });
  });
});

describe("toSupportEventInfo", () => {
  it("keeps only what Technical Support may see", () => {
    const out = toSupportEventInfo({
      id: 1,
      name: "Fest",
      proposedDate: "2026-11-01",
      startTime: "09:00",
      endTime: "10:00",
      venue: "Hall",
      equipment: "secret notes",
      technicalSupport: "secret",
      coordinatorId: "C1",
    });
    expect(out).toEqual({ id: 1, name: "Fest", proposedDate: "2026-11-01", startTime: "09:00", endTime: "10:00", venue: "Hall" });
  });

  it("fills missing fields with null", () => {
    expect(toSupportEventInfo({ id: 2 } as any)).toEqual({ id: 2, name: null, proposedDate: null, startTime: null, endTime: null, venue: null });
    expect(toSupportEventInfo({ id: 3, name: null, proposedDate: null, startTime: null, endTime: null, equipment: null })).toEqual({
      id: 3, name: null, proposedDate: null, startTime: null, endTime: null, venue: null,
    });
  });
});

describe("fetchUserNames", () => {
  it("makes no call for no ids", async () => {
    expect((await fetchUserNames([], "t")).size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps ids to names, forwarding the token and encoding the id list", async () => {
    fetchMock.mockResolvedValue(reply(200, { users: [{ id: "C1", name: "Ann" }, { id: "C2", name: "Bo" }] }));
    const names = await fetchUserNames(["C1", "C2"], "Bearer z");
    expect(Object.fromEntries(names)).toEqual({ C1: "Ann", C2: "Bo" });
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("http://users.test/api/users/names?ids=C1%2CC2", {
      headers: { Authorization: "Bearer z" },
    });
  });

  it("is empty when the response has no users", async () => {
    fetchMock.mockResolvedValue(reply(200, {}));
    expect((await fetchUserNames(["C1"], "t")).size).toBe(0);
  });

  it("is empty on a failure status or a network error", async () => {
    fetchMock.mockResolvedValueOnce(reply(500));
    expect((await fetchUserNames(["C1"], "t")).size).toBe(0);
    fetchMock.mockRejectedValueOnce(new Error("down"));
    expect((await fetchUserNames(["C1"], "t")).size).toBe(0);
  });

  it("falls back to localhost and the user-service port", async () => {
    vi.stubEnv("USER_SERVICE_URL", undefined);
    vi.stubEnv("USER_SERVICE_PORT", undefined);
    fetchMock.mockResolvedValue(reply(200, {}));
    await fetchUserNames(["C1"], "t");
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:4002/api/users/names?ids=C1");

    vi.stubEnv("USER_SERVICE_PORT", "5002");
    await fetchUserNames(["C1"], "t");
    expect(fetchMock.mock.calls[1][0]).toBe("http://localhost:5002/api/users/names?ids=C1");
  });
});
