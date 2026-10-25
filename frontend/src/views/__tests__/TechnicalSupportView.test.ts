import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { h } from "vue";
import TechnicalSupportView from "../TechnicalSupportView.vue";
import {
  fetchAllEquipmentRequests,
  fetchEquipmentCatalog,
  updateEquipmentRequestStatus,
  type EquipmentRequestWithEvent,
} from "../../lib/equipmentApi";

vi.mock("../../lib/equipmentApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/equipmentApi")>("../../lib/equipmentApi");
  return {
    ...actual,
    fetchAllEquipmentRequests: vi.fn(),
    fetchEquipmentCatalog: vi.fn(),
    updateEquipmentRequestStatus: vi.fn(),
  };
});

const mockedList = vi.mocked(fetchAllEquipmentRequests);
const mockedCatalog = vi.mocked(fetchEquipmentCatalog);
const mockedUpdateStatus = vi.mocked(updateEquipmentRequestStatus);

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", component: { render: () => h("div") } },
    {
      path: "/equipment-requests/event/:eventId",
      name: "equipment-request-detail",
      component: { render: () => h("div") },
    },
  ],
});

/** A "YYYY-MM-DD" key for today plus an offset in days, in local time. */
function dayKey(offset: number): string {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${m}-${d}`;
}

interface Options {
  id?: number;
  eventId?: number;
  name?: string;
  offset?: number;
  start?: string;
  end?: string;
  venue?: string | null;
  status?: string;
  items?: { type: string; quantity: number; fulfilled?: number }[];
}

function makeRequest(options: Options = {}): EquipmentRequestWithEvent {
  const { id = 1, eventId = id, name = "Alumni Gala", offset = 10, start = "18:00", end = "21:00" } = options;
  const { venue = "Grand Ballroom", status = "Requested", items = [{ type: "Projector", quantity: 2 }] } = options;
  return {
    id,
    eventId,
    status,
    fulfillmentNote: null,
    createdAt: "2099-01-01T00:00:00Z",
    items: items.map((item, index) => ({
      id: id * 100 + index,
      equipmentType: item.type,
      quantity: item.quantity,
      quantityFulfilled: item.fulfilled ?? 0,
      reservationFlag: { flagged: false, reason: null },
    })),
    event: { id: eventId, name, proposedDate: dayKey(offset), startTime: start, endTime: end, venue },
  };
}

async function mountView(requests: EquipmentRequestWithEvent[]) {
  mockedList.mockResolvedValue(requests);
  const wrapper = mount(TechnicalSupportView, { global: { plugins: [router] } });
  await flushPromises();
  return wrapper;
}

const groupTitles = (wrapper: Awaited<ReturnType<typeof mountView>>) =>
  wrapper.findAll(".group .h5").map((title) => title.text());

/** Data rows only — excludes each group's column-header row. */
const dataRows = (wrapper: Awaited<ReturnType<typeof mountView>>) => wrapper.findAll(".row:not(.row--header)");

beforeEach(() => {
  vi.clearAllMocks();
  mockedCatalog.mockResolvedValue([
    { id: 1, name: "Projector", totalStock: 5, availableStock: 3 },
    { id: 2, name: "Microphones", totalStock: 10, availableStock: 6 },
  ]);
  mockedUpdateStatus.mockResolvedValue({
    equipmentRequest: makeRequest({ status: "Arranged" }),
    notified: true,
  });
});

describe("TechnicalSupportView", () => {
  it("groups the queue by event, listing each event's equipment needed and in stock", async () => {
    const wrapper = await mountView([
      makeRequest({ id: 1, name: "Gala", offset: 5, items: [{ type: "Projector", quantity: 2 }] }),
      makeRequest({
        id: 2,
        name: "Demo Day",
        offset: 6,
        items: [
          { type: "Projector", quantity: 3 },
          { type: "Microphones", quantity: 1 },
        ],
      }),
    ]);

    expect(groupTitles(wrapper)).toEqual(["Gala", "Demo Day"]);
    const [gala, demoDay] = wrapper.findAll(".group");

    const galaRows = gala.findAll(".row:not(.row--header)");
    expect(galaRows).toHaveLength(1);
    expect(galaRows[0].find(".cell-equipment").text()).toBe("Projector");
    expect(galaRows[0].find(".cell-stock").text()).toBe("3");

    expect(demoDay.findAll(".row:not(.row--header)")).toHaveLength(2);
  });

  it("shows the date, time and venue in the group's header", async () => {
    const wrapper = await mountView([makeRequest({ start: "09:00", end: "10:00", venue: "Grand Ballroom" })]);

    const meta = wrapper.find(".group-header__meta").text();
    expect(meta).toContain("09:00 to 10:00");
    expect(meta).toContain("Grand Ballroom");
    expect(meta).toMatch(/^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}/);
  });

  it("has no sort label, but keeps the soonest-first subheading", async () => {
    const wrapper = await mountView([makeRequest()]);

    expect(wrapper.text()).not.toContain("Sorted by event date");
    expect(wrapper.find(".subheading").text()).toBe("Everything still to arrange, soonest event first");
  });

  it("lists groups (events) by date, then by start time", async () => {
    const wrapper = await mountView([
      makeRequest({ id: 1, name: "Late", offset: 8, start: "09:00" }),
      makeRequest({ id: 2, name: "Evening", offset: 5, start: "19:00" }),
      makeRequest({ id: 3, name: "Morning", offset: 5, start: "08:00" }),
    ]);

    expect(groupTitles(wrapper)).toEqual(["Morning", "Evening", "Late"]);
  });

  it("shows the event name and venue in the header, with a placeholder when the venue is not set", async () => {
    const wrapper = await mountView([
      makeRequest({ id: 1, name: "Alumni Gala", offset: 5 }),
      makeRequest({ id: 2, name: "No Venue Event", offset: 6, venue: null, items: [{ type: "Projector", quantity: 1 }] }),
    ]);

    const [first, second] = wrapper.findAll(".group");
    expect(first.find(".h5").text()).toBe("Alumni Gala");
    expect(first.find(".cell-qty").text()).toBe("2×");
    expect(second.find(".group-header__meta .cell-venue--empty").text()).toBe("Venue not set");
  });

  it("makes the event title a link to its request's details", async () => {
    const wrapper = await mountView([makeRequest({ id: 4, eventId: 7, name: "Alumni Gala" })]);

    const link = wrapper.find("a.group-title-link");
    expect(link.text()).toContain("Alumni Gala");
    expect(link.attributes("href")).toBe("/equipment-requests/event/7");
  });

  it("counts and filters by event, not by equipment row", async () => {
    const wrapper = await mountView([
      makeRequest({ id: 1, status: "Requested", items: [{ type: "Projector", quantity: 1 }, { type: "Microphones", quantity: 1 }] }),
      makeRequest({ id: 2, status: "Arranged", offset: 4 }),
    ]);

    const tabs = wrapper.findAll("[role='tab']").map((t) => t.text().replace(/\s+/g, " "));
    // One event (two rows) in Requested, one event in Arranged — tab counts are events, not rows.
    expect(tabs).toEqual(["Requested 1", "Arranged 1", "Partially Fulfilled 0", "Cancelled / Past 0"]);
    expect(dataRows(wrapper)).toHaveLength(2);

    await wrapper.findAll("[role='tab']")[1].trigger("click");
    expect(dataRows(wrapper)).toHaveLength(1);
  });

  it("opens on the first tab that has requests", async () => {
    const wrapper = await mountView([makeRequest({ status: "Arranged" })]);

    expect(wrapper.find(".tab--active").text()).toContain("Arranged");
  });

  it("shows a partly fulfilled row as how much is arranged and how much is still needed", async () => {
    const wrapper = await mountView([
      makeRequest({ status: "Partially Fulfilled", items: [{ type: "Projector", quantity: 3, fulfilled: 1 }] }),
    ]);

    expect(wrapper.find(".cell-qty").text()).toBe("1 of 3");
  });

  it("shows each row's own status as a badge", async () => {
    const wrapper = await mountView([
      makeRequest({ id: 1, eventId: 1, status: "Arranged", items: [{ type: "Projector", quantity: 1 }] }),
      makeRequest({ id: 2, eventId: 1, status: "Requested", items: [{ type: "Microphones", quantity: 1 }] }),
    ]);

    // Mixed event -> Partially Fulfilled tab (opened by default since it's the first non-empty one in status order... see below).
    await wrapper.find("[role='tab']").element; // no-op, just ensures mount settled
    const tab = wrapper.findAll("[role='tab']").find((t) => t.text().startsWith("Partially Fulfilled"))!;
    await tab.trigger("click");

    const badges = dataRows(wrapper).map((r) => r.find(".badge").text());
    expect(badges.sort()).toEqual(["Arranged", "Requested"]);
  });

  describe("event-level aggregation across multiple requests", () => {
    it("merges every request of one event into a single table, never split across tabs", async () => {
      const wrapper = await mountView([
        makeRequest({ id: 1, eventId: 1, name: "Gala", status: "Arranged", items: [{ type: "Projector", quantity: 1 }] }),
        makeRequest({ id: 2, eventId: 1, name: "Gala", status: "Requested", items: [{ type: "Microphones", quantity: 1 }] }),
      ]);

      // Only one "Gala" table should ever exist, across every tab.
      for (const tab of wrapper.findAll("[role='tab']")) {
        await tab.trigger("click");
        expect(groupTitles(wrapper).filter((t) => t === "Gala").length).toBeLessThanOrEqual(1);
      }
    });

    it("Arranged tab only shows events where every request is fulfilled", async () => {
      const wrapper = await mountView([
        makeRequest({ id: 1, eventId: 1, name: "Mixed Event", status: "Arranged" }),
        makeRequest({ id: 2, eventId: 1, name: "Mixed Event", status: "Requested" }),
        makeRequest({ id: 3, eventId: 2, name: "Fully Arranged Event", status: "Arranged" }),
      ]);

      const arrangedTab = wrapper.findAll("[role='tab']").find((t) => t.text().startsWith("Arranged"))!;
      expect(arrangedTab.text().replace(/\s+/g, " ")).toBe("Arranged 1");
      await arrangedTab.trigger("click");

      expect(groupTitles(wrapper)).toEqual(["Fully Arranged Event"]);
    });

    it("puts an event with a mix of request statuses under Partially Fulfilled", async () => {
      const wrapper = await mountView([
        makeRequest({ id: 1, eventId: 1, name: "Mixed Event", status: "Arranged" }),
        makeRequest({ id: 2, eventId: 1, name: "Mixed Event", status: "Requested" }),
      ]);

      const partialTab = wrapper.findAll("[role='tab']").find((t) => t.text().startsWith("Partially Fulfilled"))!;
      expect(partialTab.text().replace(/\s+/g, " ")).toBe("Partially Fulfilled 1");
      await partialTab.trigger("click");

      expect(groupTitles(wrapper)).toEqual(["Mixed Event"]);
    });

    it("Requested tab only shows events where no request has been touched", async () => {
      const wrapper = await mountView([
        makeRequest({ id: 1, eventId: 1, name: "Untouched Event", status: "Requested" }),
        makeRequest({ id: 2, eventId: 2, name: "Mixed Event", status: "Arranged" }),
        makeRequest({ id: 3, eventId: 2, name: "Mixed Event", status: "Requested" }),
      ]);

      expect(groupTitles(wrapper)).toEqual(["Untouched Event"]);
    });
  });

  describe("date range", () => {
    const requests = () => [
      makeRequest({ id: 1, name: "Overdue Event", offset: -5 }),
      makeRequest({ id: 2, name: "Soon Event", offset: 5 }),
      makeRequest({ id: 3, name: "Month Event", offset: 20 }),
      makeRequest({ id: 4, name: "Far Event", offset: 60 }),
    ];

    it("defaults to the next 30 days", async () => {
      const wrapper = await mountView(requests());

      expect((wrapper.find("select[aria-label='Date range']").element as HTMLSelectElement).value).toBe("30");
      expect(groupTitles(wrapper)).toEqual(["Overdue Event", "Soon Event", "Month Event"]);
    });

    it("narrows to the next 7 days but still shows what is overdue", async () => {
      const wrapper = await mountView(requests());

      await wrapper.find("select[aria-label='Date range']").setValue("7");

      expect(groupTitles(wrapper)).toEqual(["Overdue Event", "Soon Event"]);
    });

    it("widens to 90 days and to all dates", async () => {
      const wrapper = await mountView(requests());
      const select = wrapper.find("select[aria-label='Date range']");

      await select.setValue("90");
      expect(groupTitles(wrapper)).toHaveLength(4);

      await wrapper.find("select[aria-label='Date range']").setValue("all");
      expect(groupTitles(wrapper)).toHaveLength(4);
    });

    it("updates the tab counts to match the range", async () => {
      const wrapper = await mountView(requests());

      expect(wrapper.find("[role='tab']").text()).toContain("3");
      await wrapper.find("select[aria-label='Date range']").setValue("90");
      expect(wrapper.find("[role='tab']").text()).toContain("4");
    });
  });

  describe("equipment filter", () => {
    it("lists the equipment types and narrows to the event that has one", async () => {
      const wrapper = await mountView([
        makeRequest({ id: 1, name: "Gala", items: [{ type: "Projector", quantity: 1 }, { type: "Microphones", quantity: 1 }] }),
      ]);
      const select = wrapper.find("select[aria-label='Equipment']");

      expect(select.findAll("option").map((option) => option.text())).toEqual([
        "All equipment",
        "Microphones",
        "Projector",
      ]);

      await select.setValue("Microphones");
      expect(groupTitles(wrapper)).toEqual(["Gala"]);
      expect(dataRows(wrapper)).toHaveLength(1);
      expect(dataRows(wrapper)[0].find(".cell-equipment").text()).toBe("Microphones");
    });

    it("never moves an event to a different tab just because the filter hides some of its rows", async () => {
      const wrapper = await mountView([
        makeRequest({ id: 1, eventId: 1, status: "Arranged", items: [{ type: "Projector", quantity: 1 }] }),
        makeRequest({ id: 2, eventId: 1, status: "Requested", items: [{ type: "Microphones", quantity: 1 }] }),
      ]);
      // Mixed-status event -> Partially Fulfilled. Filtering to just the Arranged item must not
      // make the event look "fully arranged" and jump to the Arranged tab.
      const partialTab = wrapper.findAll("[role='tab']").find((t) => t.text().startsWith("Partially Fulfilled"))!;
      await partialTab.trigger("click");

      await wrapper.find("select[aria-label='Equipment']").setValue("Projector");

      expect(groupTitles(wrapper)).toHaveLength(1);
      expect(dataRows(wrapper)).toHaveLength(1);

      const arrangedTab = wrapper.findAll("[role='tab']").find((t) => t.text().startsWith("Arranged"))!;
      await arrangedTab.trigger("click");
      expect(groupTitles(wrapper)).toHaveLength(0);
    });
  });

  it("explains an empty tab for the chosen range", async () => {
    const wrapper = await mountView([makeRequest({ status: "Arranged" })]);

    await wrapper.findAll("[role='tab']")[0].trigger("click");
    expect(wrapper.find(".empty-state").text()).toContain("Nothing to arrange in the next 30 days.");

    await wrapper.find("select[aria-label='Date range']").setValue("all");
    expect(wrapper.find(".empty-state").text()).toContain("Nothing to arrange.");
  });

  it("still lists requests when the stock levels cannot be loaded, just without a stock figure", async () => {
    mockedCatalog.mockRejectedValue(new Error("boom"));
    const wrapper = await mountView([makeRequest()]);

    expect(dataRows(wrapper)).toHaveLength(1);
    expect(wrapper.find(".cell-stock").text()).toBe("—");
  });

  it("shows an error when loading fails", async () => {
    mockedList.mockRejectedValue(new Error("boom"));
    const wrapper = mount(TechnicalSupportView, { global: { plugins: [router] } });
    await flushPromises();

    expect(wrapper.find("[role='alert']").text()).toContain("couldn't load equipment requests");
  });

  describe("quick status update", () => {
    it("shows one 'Update status' button per row, not once per event", async () => {
      const wrapper = await mountView([
        makeRequest({ id: 1, name: "Gala", items: [{ type: "Projector", quantity: 1 }, { type: "Microphones", quantity: 1 }] }),
      ]);

      expect(dataRows(wrapper)).toHaveLength(2);
      expect(wrapper.findAll(".status-menu")).toHaveLength(2);
    });

    it("opens a menu listing Requested and Arranged, with the current status checked", async () => {
      const wrapper = await mountView([makeRequest({ status: "Requested" })]);

      await wrapper.find("[data-status-trigger]").trigger("click");

      const options = wrapper.findAll(".status-menu__option");
      expect(options.map((o) => o.text())).toEqual(["Requested", "Arranged"]);
      expect(options[0].attributes("aria-checked")).toBe("true");
      expect(options[1].attributes("aria-checked")).toBe("false");
    });

    it("picking the other option calls the API for that row's request and moves the event to its new tab", async () => {
      const wrapper = await mountView([makeRequest({ id: 1, status: "Requested" })]);

      await wrapper.find("[data-status-trigger]").trigger("click");
      await wrapper.findAll(".status-menu__option").find((o) => o.text() === "Arranged")!.trigger("click");
      await flushPromises();

      expect(mockedUpdateStatus).toHaveBeenCalledWith(1, "Arranged");
      // The menu closes and the event leaves the Requested tab (now empty) once moved.
      expect(wrapper.find(".status-menu__popover").exists()).toBe(false);
      expect(wrapper.find(".empty-state").exists()).toBe(true);

      await wrapper.findAll("[role='tab']").find((t) => t.text().startsWith("Arranged"))!.trigger("click");
      expect(groupTitles(wrapper)).toHaveLength(1);
    });

    it("acts on only the clicked row's request when an event has more than one", async () => {
      const wrapper = await mountView([
        makeRequest({ id: 1, eventId: 1, status: "Requested", items: [{ type: "Projector", quantity: 1 }] }),
        makeRequest({ id: 2, eventId: 1, status: "Requested", items: [{ type: "Microphones", quantity: 1 }] }),
      ]);

      // Rows sort alphabetically by equipment type within a group, so the first row/trigger
      // is Microphones (request 2), not Projector (request 1).
      const triggers = wrapper.findAll("[data-status-trigger]");
      expect(triggers).toHaveLength(2);

      await triggers[0].trigger("click");
      await wrapper.findAll(".status-menu__option").find((o) => o.text() === "Arranged")!.trigger("click");
      await flushPromises();

      expect(mockedUpdateStatus).toHaveBeenCalledTimes(1);
      expect(mockedUpdateStatus).toHaveBeenCalledWith(2, "Arranged");
    });

    it("clicking the already-selected status is a no-op", async () => {
      const wrapper = await mountView([makeRequest({ status: "Requested" })]);

      await wrapper.find("[data-status-trigger]").trigger("click");
      await wrapper.find(".status-menu__option[aria-checked='true']").trigger("click");
      await flushPromises();

      expect(mockedUpdateStatus).not.toHaveBeenCalled();
    });

    it("shows an inline error and keeps the row in place when the update fails", async () => {
      mockedUpdateStatus.mockRejectedValue(new Error("boom"));
      const wrapper = await mountView([makeRequest({ id: 1, status: "Requested" })]);

      await wrapper.find("[data-status-trigger]").trigger("click");
      await wrapper.findAll(".status-menu__option").find((o) => o.text() === "Arranged")!.trigger("click");
      await flushPromises();

      expect(wrapper.find(".status-menu__error").text()).toContain("Couldn't update the status");
      expect(dataRows(wrapper)).toHaveLength(1);
    });

    it("closes when clicking outside, without changing anything", async () => {
      const wrapper = await mountView([makeRequest({ status: "Requested" })]);

      await wrapper.find("[data-status-trigger]").trigger("click");
      expect(wrapper.find(".status-menu__popover").exists()).toBe(true);

      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      await wrapper.vm.$nextTick();

      expect(wrapper.find(".status-menu__popover").exists()).toBe(false);
      expect(mockedUpdateStatus).not.toHaveBeenCalled();
    });
  });
});

describe("TechnicalSupportView: Cancelled / Past tab", () => {
  const tabNames = (wrapper: Awaited<ReturnType<typeof mountView>>) =>
    wrapper.findAll("[role='tab']").map((t) => t.text().replace(/\s+/g, " ").replace(/\d+$/, "").trim());
  const openHistory = async (wrapper: Awaited<ReturnType<typeof mountView>>) => {
    await wrapper.findAll("[role='tab']")[3].trigger("click");
  };

  it("adds a last tab after the three statuses", async () => {
    const wrapper = await mountView([makeRequest()]);
    expect(tabNames(wrapper)).toEqual(["Requested", "Arranged", "Partially Fulfilled", "Cancelled / Past"]);
  });

  it("holds cancelled events, and arranged or partly arranged ones whose date has passed, and keeps them out of the other tabs", async () => {
    const wrapper = await mountView([
      makeRequest({ id: 1, name: "Upcoming", offset: 5 }),
      makeRequest({ id: 2, name: "Cancelled Gala", offset: 5, status: "Cancelled" }),
      makeRequest({ id: 3, name: "Done Last Week", offset: -7, status: "Arranged", items: [{ type: "Projector", quantity: 2, fulfilled: 2 }] }),
      makeRequest({ id: 4, name: "Partly Last Week", offset: -3, status: "Partially Fulfilled", items: [{ type: "Projector", quantity: 4, fulfilled: 1 }] }),
      makeRequest({ id: 5, name: "Arranged Next Week", offset: 7, status: "Arranged", items: [{ type: "Projector", quantity: 2, fulfilled: 2 }] }),
    ]);

    expect(groupTitles(wrapper)).toEqual(["Upcoming"]);
    await wrapper.findAll("[role='tab']")[1].trigger("click");
    expect(groupTitles(wrapper)).toEqual(["Arranged Next Week"]);

    await openHistory(wrapper);
    // Newest event first.
    expect(groupTitles(wrapper)).toEqual(["Cancelled Gala", "Partly Last Week", "Done Last Week"]);
    expect(wrapper.findAll("[data-testid='history-label']").map((l) => l.text())).toEqual(["Cancelled", "Past event", "Past event"]);
    expect(wrapper.findAll("[role='tab']")[3].text()).toContain("3");
  });

  it("leaves an unarranged event that has passed under Requested, as overdue", async () => {
    const wrapper = await mountView([makeRequest({ id: 1, name: "Missed", offset: -2 })]);

    expect(groupTitles(wrapper)).toEqual(["Missed"]);
    await openHistory(wrapper);
    expect(groupTitles(wrapper)).toEqual([]);
  });

  it("drops a cancelled request from an event that still has live ones, and shows only the live ones", async () => {
    const wrapper = await mountView([
      makeRequest({ id: 1, eventId: 1, name: "Mixed", offset: 5, status: "Requested", items: [{ type: "Projector", quantity: 2 }] }),
      makeRequest({ id: 2, eventId: 1, name: "Mixed", offset: 5, status: "Cancelled", items: [{ type: "Microphones", quantity: 1 }] }),
    ]);

    expect(groupTitles(wrapper)).toEqual(["Mixed"]);
    expect(dataRows(wrapper)).toHaveLength(1);
    expect(dataRows(wrapper)[0].text()).toContain("Projector");
    await openHistory(wrapper);
    expect(groupTitles(wrapper)).toEqual([]);
  });

  it("shows everything in it whatever date range is chosen, and still filters by equipment", async () => {
    const wrapper = await mountView([
      makeRequest({ id: 1, name: "Far Cancelled", offset: 200, status: "Cancelled" }),
      makeRequest({ id: 2, name: "Mics Cancelled", offset: 3, status: "Cancelled", items: [{ type: "Microphones", quantity: 1 }] }),
    ]);
    await openHistory(wrapper);
    expect(groupTitles(wrapper)).toEqual(["Far Cancelled", "Mics Cancelled"]);

    await wrapper.find("select[aria-label='Equipment']").setValue("Microphones");
    expect(groupTitles(wrapper)).toEqual(["Mics Cancelled"]);
  });

  it("is read-only: a cancelled request shows a Cancelled badge and no Update status button", async () => {
    const wrapper = await mountView([
      makeRequest({ id: 1, name: "Cancelled Gala", offset: 5, status: "Cancelled" }),
      makeRequest({ id: 2, name: "Done", offset: -5, status: "Arranged", items: [{ type: "Projector", quantity: 1, fulfilled: 1 }] }),
    ]);
    await openHistory(wrapper);

    expect(wrapper.findAll(".badge").some((b) => b.text() === "Cancelled")).toBe(true);
    expect(wrapper.findAll("[data-status-trigger]")).toHaveLength(0);
  });

  it("says so when there is nothing in it", async () => {
    const wrapper = await mountView([makeRequest()]);
    await openHistory(wrapper);
    expect(wrapper.find(".empty-state").text()).toContain("No cancelled or past requests.");
  });
});
