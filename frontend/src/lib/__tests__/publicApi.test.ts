import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PublicEventNotFoundError,
  byStartTime,
  fetchPublicEvent,
  fetchPublicEventVenues,
  fetchPublicEvents,
  fetchPublicVenues,
  type PublicEvent,
} from "../publicApi";

const fetchMock = vi.fn();

function jsonResponse(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => vi.unstubAllGlobals());

describe("publicApi", () => {
  it("lists public events without an auth header", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { events: [{ id: 1 }] }));

    expect(await fetchPublicEvents()).toEqual([{ id: 1 }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/public$/);
    expect(init).toBeUndefined();
  });

  it("throws PublicEventNotFoundError for an event that isn't listed", async () => {
    fetchMock.mockResolvedValue(jsonResponse(404, { error: "Event not found" }));

    await expect(fetchPublicEvent(9)).rejects.toBeInstanceOf(PublicEventNotFoundError);
  });

  it("throws a plain error when the event can't be loaded", async () => {
    fetchMock.mockResolvedValue(jsonResponse(500, {}));

    await expect(fetchPublicEvent(9)).rejects.not.toBeInstanceOf(PublicEventNotFoundError);
  });

  it("lists public venues", async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { venues: [{ id: 3 }] }));

    expect(await fetchPublicVenues()).toEqual([{ id: 3 }]);
    expect(fetchMock.mock.calls[0][0]).toMatch(/\/public$/);
  });

  it("groups venue names by event, and skips the request when there are no ids", async () => {
    expect((await fetchPublicEventVenues([])).size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();

    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        venues: [
          { eventId: 1, venueName: "Hall" },
          { eventId: 1, venueName: "Lawn" },
          { eventId: 2, venueName: "Studio" },
        ],
      }),
    );
    const byEvent = await fetchPublicEventVenues([1, 2]);

    expect(fetchMock.mock.calls[0][0]).toMatch(/\/public\/event-venues\?eventIds=1,2$/);
    expect(byEvent.get(1)).toEqual(["Hall", "Lawn"]);
    expect(byEvent.get(2)).toEqual(["Studio"]);
  });

  it("sorts soonest first, with undated events last", () => {
    const event = (id: number, proposedDate: string | null, startTime: string | null = "10:00") =>
      ({ id, proposedDate, startTime }) as PublicEvent;
    const sorted = [event(1, null), event(2, "2099-02-01"), event(3, "2099-01-01", "18:00"), event(4, "2099-01-01", "09:00")]
      .sort(byStartTime)
      .map((e) => e.id);

    expect(sorted).toEqual([4, 3, 2, 1]);
  });
});
