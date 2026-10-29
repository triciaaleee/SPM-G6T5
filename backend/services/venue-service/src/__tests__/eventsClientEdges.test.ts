import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  VENUE_BOOKING_INFO_BATCH,
  fetchEvent,
  fetchPublicEvents,
  fetchVenueBookingInfo,
  fetchVenueBookingInfoInternal,
  reportArrangementsChanged,
} from "../lib/eventsClient.js";

/** fetch is stubbed; every response is built by hand so no network is involved. */
const fetchMock = vi.fn();
const json = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe("eventsClient", () => {
  const saved = { ...process.env };
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    delete process.env.EVENTS_SERVICE_URL;
    delete process.env.EVENTS_SERVICE_PORT;
    process.env.INTERNAL_SERVICE_SECRET = "internal-test-secret";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = { ...saved };
  });

  describe("service URL", () => {
    it("defaults to localhost:4001", async () => {
      fetchMock.mockResolvedValue(json(200, { events: [] }));
      await fetchPublicEvents();
      expect(fetchMock).toHaveBeenCalledWith("http://localhost:4001/api/events/public");
    });
    it("uses EVENTS_SERVICE_PORT, and EVENTS_SERVICE_URL wins over it", async () => {
      fetchMock.mockResolvedValue(json(200, { events: [] }));
      process.env.EVENTS_SERVICE_PORT = "5555";
      await fetchPublicEvents();
      expect(fetchMock).toHaveBeenLastCalledWith("http://localhost:5555/api/events/public");
      process.env.EVENTS_SERVICE_URL = "http://events.internal";
      await fetchPublicEvents();
      expect(fetchMock).toHaveBeenLastCalledWith("http://events.internal/api/events/public");
    });
  });

  describe("fetchEvent", () => {
    it("forwards the caller's token and returns the event", async () => {
      fetchMock.mockResolvedValue(json(200, { event: { id: 7, status: "Planning", submitted_details: {} } }));
      expect(await fetchEvent(7, "Bearer abc")).toEqual({ status: "ok", event: { id: 7, status: "Planning", submitted_details: {} } });
      expect(fetchMock).toHaveBeenCalledWith("http://localhost:4001/api/events/7", { headers: { Authorization: "Bearer abc" } });
    });
    it.each([403, 404])("maps %i to not_found", async (code) => {
      fetchMock.mockResolvedValue(json(code, {}));
      expect(await fetchEvent(7, "t")).toEqual({ status: "not_found" });
    });
    it.each([400, 401, 500, 502])("maps %i to error", async (code) => {
      fetchMock.mockResolvedValue(json(code, {}));
      expect(await fetchEvent(7, "t")).toEqual({ status: "error" });
    });
    it("maps a network failure to error", async () => {
      fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
      expect(await fetchEvent(7, "t")).toEqual({ status: "error" });
    });
    it("treats a 200 with no event as not_found", async () => {
      fetchMock.mockResolvedValue(json(200, {}));
      expect(await fetchEvent(7, "t")).toEqual({ status: "not_found" });
    });
  });

  describe("fetchVenueBookingInfo", () => {
    const info = (id: number) => ({ id, name: `E${id}` });
    it("does not call out for an empty list", async () => {
      expect(await fetchVenueBookingInfo([], "t")).toEqual({ status: "ok", events: [] });
      expect(fetchMock).not.toHaveBeenCalled();
    });
    it("sends ids comma-joined with the caller's token", async () => {
      fetchMock.mockResolvedValue(json(200, { events: [info(1), info(2)] }));
      expect(await fetchVenueBookingInfo([1, 2], "Bearer t")).toEqual({ status: "ok", events: [info(1), info(2)] });
      expect(fetchMock).toHaveBeenCalledWith("http://localhost:4001/api/events/venue-booking-info?ids=1,2", { headers: { Authorization: "Bearer t" } });
    });
    it("batches at exactly VENUE_BOOKING_INFO_BATCH ids per request: 100 → 1 call, 101 → 2 calls", async () => {
      expect(VENUE_BOOKING_INFO_BATCH).toBe(100);
      fetchMock.mockImplementation(async (url: string) => {
        const ids = url.split("ids=")[1].split(",").map(Number);
        return json(200, { events: ids.map(info) });
      });
      const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
      await fetchVenueBookingInfo(hundred, "t");
      expect(fetchMock).toHaveBeenCalledTimes(1);

      fetchMock.mockClear();
      const result = await fetchVenueBookingInfo([...hundred, 101], "t");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0].split("ids=")[1].split(",")).toHaveLength(100);
      expect(fetchMock.mock.calls[1][0].split("ids=")[1]).toBe("101");
      expect(result.status === "ok" && result.events.map((e) => e.id)).toEqual([...hundred, 101]);
    });
    it("fails the whole lookup if any batch fails (non-OK or network)", async () => {
      const ids = Array.from({ length: 101 }, (_, i) => i + 1);
      fetchMock.mockResolvedValueOnce(json(200, { events: [] })).mockResolvedValueOnce(json(500, {}));
      expect(await fetchVenueBookingInfo(ids, "t")).toEqual({ status: "error" });
      fetchMock.mockReset();
      fetchMock.mockRejectedValue(new Error("down"));
      expect(await fetchVenueBookingInfo([1], "t")).toEqual({ status: "error" });
    });
    it("treats a body with no events array as empty", async () => {
      fetchMock.mockResolvedValue(json(200, {}));
      expect(await fetchVenueBookingInfo([1], "t")).toEqual({ status: "ok", events: [] });
    });
    it("the internal variant sends a signed X-Internal-Auth header instead of a bearer token", async () => {
      fetchMock.mockResolvedValue(json(200, { events: [info(3)] }));
      expect(await fetchVenueBookingInfoInternal([3])).toEqual({ status: "ok", events: [info(3)] });
      const headers = fetchMock.mock.calls[0][1].headers;
      expect(Object.keys(headers)).toEqual(["X-Internal-Auth"]);
      expect(headers["X-Internal-Auth"].split(".")).toHaveLength(3);
      expect(jwt.verify(headers["X-Internal-Auth"], "internal-test-secret")).toMatchObject({ svc: "venue-service" });
    });
  });

  describe("reportArrangementsChanged", () => {
    it("POSTs the reason with an internal token and reports success", async () => {
      fetchMock.mockResolvedValue(json(200, {}));
      expect(await reportArrangementsChanged(9, "Hall is unavailable")).toBe(true);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe("http://localhost:4001/api/events/9/arrangements-changed");
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({ reason: "Hall is unavailable" });
      expect(init.headers["Content-Type"]).toBe("application/json");
      expect(jwt.verify(init.headers["X-Internal-Auth"], "internal-test-secret")).toMatchObject({ svc: "venue-service" });
    });
    it("is false on a non-OK reply and on a network error, and never throws", async () => {
      fetchMock.mockResolvedValue(json(409, {}));
      expect(await reportArrangementsChanged(9, "r")).toBe(false);
      fetchMock.mockRejectedValue(new Error("down"));
      expect(await reportArrangementsChanged(9, "r")).toBe(false);
    });
    it("is false (not a crash) when the internal secret is missing", async () => {
      delete process.env.INTERNAL_SERVICE_SECRET;
      expect(await reportArrangementsChanged(9, "r")).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("fetchPublicEvents", () => {
    it("returns the listed events; a body with none is empty", async () => {
      fetchMock.mockResolvedValue(json(200, { events: [{ id: 1, name: "A", proposedDate: null, startTime: null }] }));
      expect(await fetchPublicEvents()).toEqual({ status: "ok", events: [{ id: 1, name: "A", proposedDate: null, startTime: null }] });
      fetchMock.mockResolvedValue(json(200, {}));
      expect(await fetchPublicEvents()).toEqual({ status: "ok", events: [] });
    });
    it("is an error on non-OK or a network failure", async () => {
      fetchMock.mockResolvedValue(json(503, {}));
      expect(await fetchPublicEvents()).toEqual({ status: "error" });
      fetchMock.mockRejectedValue(new Error("down"));
      expect(await fetchPublicEvents()).toEqual({ status: "error" });
    });
  });
});

describe("fetchVenueBookingInfo with nothing to ask for", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("answers ok with no events and never calls events-service", async () => {
    expect(await fetchVenueBookingInfo([], "Bearer t")).toEqual({ status: "ok", events: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
