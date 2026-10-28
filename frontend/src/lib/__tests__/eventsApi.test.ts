import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const API = "http://events.test/api/events";

/** eventsApi reads its base URL when it loads, so set it first and import a fresh copy. */
async function loadApi() {
  vi.resetModules();
  vi.stubEnv("VITE_EVENTS_API_URL", API);
  return import("../eventsApi");
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ events: [{ id: 1 }] }) });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("fetchMyEvents", () => {
  it("asks for every event this user can see by default", async () => {
    const { fetchMyEvents } = await loadApi();

    const events = await fetchMyEvents();

    expect(fetchMock).toHaveBeenCalledWith(API, expect.anything());
    expect(events).toEqual([{ id: 1 }]);
  });

  it("asks the server for only the coordinator's own events when assignedToMe is set", async () => {
    const { fetchMyEvents } = await loadApi();

    await fetchMyEvents({ assignedToMe: true });

    expect(fetchMock).toHaveBeenCalledWith(`${API}?assignedTo=me`, expect.anything());
  });

  it("does not add the filter when assignedToMe is false", async () => {
    const { fetchMyEvents } = await loadApi();

    await fetchMyEvents({ assignedToMe: false });

    expect(fetchMock).toHaveBeenCalledWith(API, expect.anything());
  });
});
