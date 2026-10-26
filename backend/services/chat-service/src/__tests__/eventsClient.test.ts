import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchEvent, fetchEventsForRole } from "../lib/eventsClient.js";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.EVENTS_SERVICE_URL;
  delete process.env.EVENTS_SERVICE_PORT;
});

function stubFetch(impl: (url: string, init?: RequestInit) => unknown) {
  const mock = vi.fn(async (url: string, init?: RequestInit) => impl(url, init));
  vi.stubGlobal("fetch", mock);
  return mock;
}

const res = (status: number, body: unknown = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

describe("fetchEvent", () => {
  it("forwards the caller's bearer token and returns the event", async () => {
    const event = { id: 7, status: "Planning", organiser_id: "o", coordinator_id: "c", submitted_details: {} };
    const mock = stubFetch(() => res(200, { event }));
    const result = await fetchEvent(7, "Bearer abc");
    expect(result).toEqual({ status: "ok", event });
    expect(mock).toHaveBeenCalledWith("http://localhost:4001/api/events/7", { headers: { Authorization: "Bearer abc" } });
  });

  it.each([403, 404])("maps %i to not_found", async (code) => {
    stubFetch(() => res(code));
    expect(await fetchEvent(1, "Bearer x")).toEqual({ status: "not_found" });
  });

  it.each([400, 401, 500, 503])("maps %i to error", async (code) => {
    stubFetch(() => res(code));
    expect(await fetchEvent(1, "Bearer x")).toEqual({ status: "error" });
  });

  it("maps a network failure to error", async () => {
    stubFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    expect(await fetchEvent(1, "Bearer x")).toEqual({ status: "error" });
  });

  it("maps a 200 with no event to not_found", async () => {
    stubFetch(() => res(200, {}));
    expect(await fetchEvent(1, "Bearer x")).toEqual({ status: "not_found" });
  });

  it("uses EVENTS_SERVICE_URL when set", async () => {
    process.env.EVENTS_SERVICE_URL = "http://events.internal:9000";
    const mock = stubFetch(() => res(404));
    await fetchEvent(3, "Bearer x");
    expect(mock.mock.calls[0][0]).toBe("http://events.internal:9000/api/events/3");
  });

  it("falls back to EVENTS_SERVICE_PORT", async () => {
    process.env.EVENTS_SERVICE_PORT = "5555";
    const mock = stubFetch(() => res(404));
    await fetchEvent(3, "Bearer x");
    expect(mock.mock.calls[0][0]).toBe("http://localhost:5555/api/events/3");
  });

  it("maps a non-JSON 2xx body to error instead of rejecting", async () => {
    stubFetch(() => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("bad json");
      },
    }));
    expect(await fetchEvent(1, "Bearer x")).toEqual({ status: "error" });
  });
});

describe("fetchEventsForRole", () => {
  it("calls GET /api/events with the caller's bearer token", async () => {
    const mock = stubFetch(() => res(200, { events: [] }));
    await fetchEventsForRole("Bearer abc");
    expect(mock).toHaveBeenCalledWith("http://localhost:4001/api/events", { headers: { Authorization: "Bearer abc" } });
  });

  it("maps raw events to thread-list rows", async () => {
    stubFetch(() =>
      res(200, {
        events: [
          {
            id: 1,
            status: "Planning",
            coordinator_id: "c1",
            coordinator: { name: "Cora" },
            organiser: { name: "Olly" },
            submitted_details: { name: "Gala" },
            created_at: "2026-01-01T00:00:00Z",
          },
          {
            id: 2,
            status: "Confirmed",
            coordinator_id: null,
            coordinator: null,
            organiser: null,
            submitted_details: {},
            created_at: "2026-01-02T00:00:00Z",
          },
        ],
      }),
    );
    const result = await fetchEventsForRole("Bearer x");
    expect(result).toEqual({
      status: "ok",
      events: [
        { id: 1, status: "Planning", coordinatorId: "c1", coordinatorName: "Cora", organiserName: "Olly", name: "Gala", createdAt: "2026-01-01T00:00:00Z" },
        { id: 2, status: "Confirmed", coordinatorId: null, coordinatorName: null, organiserName: null, name: null, createdAt: "2026-01-02T00:00:00Z" },
      ],
    });
  });

  it("returns an empty list when the body has no events key", async () => {
    stubFetch(() => res(200, {}));
    expect(await fetchEventsForRole("Bearer x")).toEqual({ status: "ok", events: [] });
  });

  it("returns error on a non-2xx", async () => {
    stubFetch(() => res(500));
    expect(await fetchEventsForRole("Bearer x")).toEqual({ status: "error" });
  });

  it("returns error on a network failure", async () => {
    stubFetch(() => {
      throw new Error("down");
    });
    expect(await fetchEventsForRole("Bearer x")).toEqual({ status: "error" });
  });

  it("maps a non-JSON 2xx body to error instead of rejecting", async () => {
    stubFetch(() => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("bad json");
      },
    }));
    expect(await fetchEventsForRole("Bearer x")).toEqual({ status: "error" });
  });

  it("tolerates a null submitted_details", async () => {
    stubFetch(() =>
      res(200, { events: [{ id: 1, status: "Planning", coordinator_id: null, coordinator: null, organiser: null, submitted_details: null, created_at: "x" }] }),
    );
    const result = await fetchEventsForRole("Bearer x");
    expect(result.status === "ok" && result.events[0].name).toBeNull();
  });
});
