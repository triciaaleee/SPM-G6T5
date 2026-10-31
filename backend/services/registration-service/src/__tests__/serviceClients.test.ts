import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canViewEvent, fetchAttendeeEvents, fetchOpenEvents } from "../lib/eventsClient.js";
import { fetchUserNames } from "../lib/usersClient.js";
import { fetchVenueNames } from "../lib/venuesClient.js";

const fetchMock = vi.fn();
const AUTH = "Bearer caller-token";
const ENV_KEYS = ["EVENTS_SERVICE_URL", "EVENTS_SERVICE_PORT", "VENUE_SERVICE_URL", "VENUE_SERVICE_PORT", "USER_SERVICE_URL", "USER_SERVICE_PORT"];

const reply = (status: number, body: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
/** An OK reply whose body isn't JSON, as a proxy's HTML page would be. */
const notJson = () => ({
  ok: true,
  status: 200,
  json: async () => {
    throw new SyntaxError("Unexpected token <");
  },
});

const url = () => fetchMock.mock.calls[0][0];
const options = () => fetchMock.mock.calls[0][1];

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) delete process.env[key];
});

describe("service URLs", () => {
  it.each([
    ["events", "EVENTS_SERVICE_URL", "EVENTS_SERVICE_PORT", 4001, () => fetchOpenEvents(AUTH), "/api/events/open-for-registration"],
    ["venues", "VENUE_SERVICE_URL", "VENUE_SERVICE_PORT", 4003, () => fetchVenueNames([1], AUTH), "/api/venues/attendee-info?eventIds=1"],
    ["users", "USER_SERVICE_URL", "USER_SERVICE_PORT", 4002, () => fetchUserNames(["A"], AUTH), "/api/users/names?ids=A"],
  ] as const)("%s: prefers the URL, then the port, then the default", async (_name, urlKey, portKey, port, call, path) => {
    fetchMock.mockResolvedValue(reply(200, {}));

    await call();
    expect(fetchMock.mock.calls[0][0]).toBe(`http://localhost:${port}${path}`);

    process.env[portKey] = "9999";
    await call();
    expect(fetchMock.mock.calls[1][0]).toBe(`http://localhost:9999${path}`);

    process.env[urlKey] = "http://service.test";
    await call();
    expect(fetchMock.mock.calls[2][0]).toBe(`http://service.test${path}`);
  });
});

describe("fetchAttendeeEvents", () => {
  it("asks for the ids with the caller's token", async () => {
    const events = [{ id: 1 }, { id: 2 }];
    fetchMock.mockResolvedValue(reply(200, { events }));

    expect(await fetchAttendeeEvents([1, 2], AUTH)).toEqual({ status: "ok", events });

    expect(url()).toBe("http://localhost:4001/api/events/attendee-info?ids=1,2");
    expect(options()).toEqual({ headers: { Authorization: AUTH } });
  });

  it("doesn't call events-service for no ids", async () => {
    expect(await fetchAttendeeEvents([], AUTH)).toEqual({ status: "ok", events: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads a reply with no events field as empty", async () => {
    fetchMock.mockResolvedValue(reply(200, {}));
    expect(await fetchAttendeeEvents([1], AUTH)).toEqual({ status: "ok", events: [] });
  });

  it("is an error on a failed reply, an unreachable service and a body that isn't JSON", async () => {
    fetchMock.mockResolvedValueOnce(reply(500, {}));
    expect(await fetchAttendeeEvents([1], AUTH)).toEqual({ status: "error" });
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await fetchAttendeeEvents([1], AUTH)).toEqual({ status: "error" });
    fetchMock.mockResolvedValueOnce(notJson());
    expect(await fetchAttendeeEvents([1], AUTH)).toEqual({ status: "error" });
  });
});

describe("fetchOpenEvents", () => {
  it("passes the caller's token and returns the events", async () => {
    fetchMock.mockResolvedValue(reply(200, { events: [{ id: 3 }] }));
    expect(await fetchOpenEvents(AUTH)).toEqual({ status: "ok", events: [{ id: 3 }] });
    expect(options()).toEqual({ headers: { Authorization: AUTH } });
  });
});

describe("canViewEvent", () => {
  it("asks for the event with the caller's token", async () => {
    fetchMock.mockResolvedValue(reply(200, {}));
    expect(await canViewEvent(7, AUTH)).toEqual({ status: "ok" });
    expect(url()).toBe("http://localhost:4001/api/events/7");
    expect(options()).toEqual({ headers: { Authorization: AUTH } });
  });

  it.each([403, 404])("reads %i as denied", async (status) => {
    fetchMock.mockResolvedValue(reply(status, {}));
    expect(await canViewEvent(7, AUTH)).toEqual({ status: "denied" });
  });

  it("is an error on any other failure", async () => {
    fetchMock.mockResolvedValueOnce(reply(500, {}));
    expect(await canViewEvent(7, AUTH)).toEqual({ status: "error" });
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await canViewEvent(7, AUTH)).toEqual({ status: "error" });
  });
});

describe("fetchVenueNames", () => {
  it("groups venue names by event, with the caller's token", async () => {
    fetchMock.mockResolvedValue(
      reply(200, {
        venues: [
          { eventId: 1, venueName: "Hall" },
          { eventId: 1, venueName: "Lawn" },
          { eventId: 2, venueName: "Studio" },
        ],
      }),
    );

    const result = await fetchVenueNames([1, 2], AUTH);

    expect(result).toEqual({
      status: "ok",
      venuesByEvent: new Map([
        [1, ["Hall", "Lawn"]],
        [2, ["Studio"]],
      ]),
    });
    expect(url()).toBe("http://localhost:4003/api/venues/attendee-info?eventIds=1,2");
    expect(options()).toEqual({ headers: { Authorization: AUTH } });
  });

  it("doesn't call venue-service for no ids", async () => {
    expect(await fetchVenueNames([], AUTH)).toEqual({ status: "ok", venuesByEvent: new Map() });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads a reply with no venues field as empty", async () => {
    fetchMock.mockResolvedValue(reply(200, {}));
    expect(await fetchVenueNames([1], AUTH)).toEqual({ status: "ok", venuesByEvent: new Map() });
  });

  it("is an error on a failed reply, an unreachable service and a body that isn't JSON", async () => {
    fetchMock.mockResolvedValueOnce(reply(500, {}));
    expect(await fetchVenueNames([1], AUTH)).toEqual({ status: "error" });
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await fetchVenueNames([1], AUTH)).toEqual({ status: "error" });
    fetchMock.mockResolvedValueOnce(notJson());
    expect(await fetchVenueNames([1], AUTH)).toEqual({ status: "error" });
  });
});

describe("fetchUserNames", () => {
  it("maps ids to names, encoding each id, with the caller's token", async () => {
    fetchMock.mockResolvedValue(reply(200, { users: [{ id: "A&1", name: "Ann" }] }));

    expect(await fetchUserNames(["A&1", "B"], AUTH)).toEqual(new Map([["A&1", "Ann"]]));

    expect(url()).toBe("http://localhost:4002/api/users/names?ids=A%261,B");
    expect(options()).toEqual({ headers: { Authorization: AUTH } });
  });

  it("doesn't call user-service for no ids", async () => {
    expect(await fetchUserNames([], AUTH)).toEqual(new Map());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gives an empty map on any failure: the roster still renders without names", async () => {
    fetchMock.mockResolvedValueOnce(reply(500, { users: [{ id: "A", name: "Ann" }] }));
    expect(await fetchUserNames(["A"], AUTH)).toEqual(new Map());
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await fetchUserNames(["A"], AUTH)).toEqual(new Map());
    fetchMock.mockResolvedValueOnce(notJson());
    expect(await fetchUserNames(["A"], AUTH)).toEqual(new Map());
    fetchMock.mockResolvedValueOnce(reply(200, {}));
    expect(await fetchUserNames(["A"], AUTH)).toEqual(new Map());
  });
});
