import { vi } from "vitest";

/**
 * What the other services answer, for suites that run equipment-service's
 * routers end to end. `installWorld()` stubs global `fetch`; callers undo it
 * with `vi.unstubAllGlobals()` / `vi.unstubAllEnvs()` in afterEach.
 *
 * - events-service `GET /api/events/:id` answers from `eventDetail` (404 when absent)
 * - events-service `GET /api/events/venue-booking-info?ids=` answers from `info`
 * - events-service `POST /api/events/:id/arrangements-changed` is recorded
 * - user-service `GET /api/users/names` answers from `names`
 */
export interface World {
  info: Record<string, any>[];
  infoOk: boolean;
  /** Answer the venue-booking-info batch with every event in `info`, not only the ones asked for. */
  infoUnfiltered: boolean;
  eventDetail: Map<number, { status: number; body?: unknown }>;
  names: { id: string; name: string }[] | null;
  namesOk: boolean;
  urls: string[];
  arrangementsChanged: { eventId: number; reason: string }[];
}

export const detailEvent = (id: number, over: Record<string, any> = {}) => ({
  id,
  status: "Planning",
  coordinator_id: "COORD-1",
  submitted_details: { name: "Fest", proposedDate: "2026-12-01", startTime: "10:00", endTime: "12:00" },
  ...over,
});

export const infoEvent = (id: number, over: Record<string, any> = {}) => ({
  id, name: `E${id}`, proposedDate: "2026-12-01", startTime: "10:00", endTime: "12:00",
  equipment: null, venue: "Hall A", technicalSupport: null, coordinatorId: "COORD-1", ...over,
});

export function installWorld(): World {
  const world: World = { info: [], infoOk: true, infoUnfiltered: false, eventDetail: new Map(), names: [], namesOk: true, urls: [], arrangementsChanged: [] };
  vi.stubEnv("EVENTS_SERVICE_URL", "http://events.test");
  vi.stubEnv("USER_SERVICE_URL", "http://users.test");
  vi.stubEnv("INTERNAL_SERVICE_SECRET", "internal");
  vi.stubGlobal("fetch", async (input: string, init?: any) => {
    const url = new URL(String(input));
    world.urls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    const reply = (status: number, body: unknown = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

    if (url.pathname === "/api/events/venue-booking-info") {
      if (!world.infoOk) return reply(500);
      if (world.infoUnfiltered) return reply(200, { events: world.info });
      const ids = url.searchParams.get("ids")!.split(",").map(Number);
      return reply(200, { events: world.info.filter((e) => ids.includes(e.id)) });
    }
    if (url.pathname === "/api/users/names") {
      if (!world.namesOk || world.names === null) return reply(500);
      return reply(200, { users: world.names });
    }
    const changed = /^\/api\/events\/(\d+)\/arrangements-changed$/.exec(url.pathname);
    if (changed) {
      world.arrangementsChanged.push({ eventId: Number(changed[1]), reason: JSON.parse(init.body).reason });
      return reply(200);
    }
    const detail = /^\/api\/events\/(\d+)$/.exec(url.pathname);
    if (detail) {
      const found = world.eventDetail.get(Number(detail[1]));
      return found ? reply(found.status, found.body) : reply(404);
    }
    return reply(404);
  });
  return world;
}
