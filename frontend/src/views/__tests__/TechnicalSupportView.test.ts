import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { h } from "vue";
import TechnicalSupportView from "../TechnicalSupportView.vue";
import {
  fetchAllEquipmentRequests,
  fetchEquipmentCatalog,
  type EquipmentRequestWithEvent,
} from "../../lib/equipmentApi";

vi.mock("../../lib/equipmentApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/equipmentApi")>("../../lib/equipmentApi");
  return { ...actual, fetchAllEquipmentRequests: vi.fn(), fetchEquipmentCatalog: vi.fn() };
});

const mockedList = vi.mocked(fetchAllEquipmentRequests);
const mockedCatalog = vi.mocked(fetchEquipmentCatalog);

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
  wrapper.findAll(".group .h4").map((title) => title.text());

beforeEach(() => {
  vi.clearAllMocks();
  mockedCatalog.mockResolvedValue([
    { id: 1, name: "Projector", totalStock: 5, availableStock: 3 },
    { id: 2, name: "Microphones", totalStock: 10, availableStock: 6 },
  ]);
});

describe("TechnicalSupportView", () => {
  it("groups the queue by equipment with how many are needed and in stock", async () => {
    const wrapper = await mountView([
      makeRequest({ id: 1, offset: 5, items: [{ type: "Projector", quantity: 2 }] }),
      makeRequest({ id: 2, offset: 6, items: [{ type: "Projector", quantity: 3 }, { type: "Microphones", quantity: 1 }] }),
    ]);

    expect(groupTitles(wrapper)).toEqual(["Projector", "Microphones"]);
    const [projector, microphones] = wrapper.findAll(".group");
    expect(projector.find(".count-badge").text()).toBe("5 needed");
    expect(projector.find(".stock").text()).toBe("3 in stock");
    expect(projector.findAll(".row")).toHaveLength(2);
    expect(microphones.find(".count-badge").text()).toBe("1 needed");
    expect(microphones.find(".stock").text()).toBe("6 in stock");
  });

  it("shows the date and the time in separate columns", async () => {
    const wrapper = await mountView([makeRequest({ start: "09:00", end: "10:00" })]);

    const row = wrapper.find(".row");
    expect(row.find(".cell-time").text()).toBe("09:00 to 10:00");
    expect(row.find(".cell-date").text()).not.toContain("09:00");
    expect(row.find(".cell-date").text()).toMatch(/^[A-Z][a-z]{2} \d{1,2} [A-Z][a-z]{2}$/);
  });

  it("has no sort label, but keeps the soonest-first subheading", async () => {
    const wrapper = await mountView([makeRequest()]);

    expect(wrapper.text()).not.toContain("Sorted by event date");
    expect(wrapper.find(".subheading").text()).toBe("Everything still to arrange, soonest event first");
  });

  it("lists each group's rows by date, then by start time", async () => {
    const wrapper = await mountView([
      makeRequest({ id: 1, name: "Late", offset: 8, start: "09:00" }),
      makeRequest({ id: 2, name: "Evening", offset: 5, start: "19:00" }),
      makeRequest({ id: 3, name: "Morning", offset: 5, start: "08:00" }),
    ]);

    expect(wrapper.findAll(".cell-event").map((cell) => cell.text())).toEqual(["Morning", "Evening", "Late"]);
  });

  it("shows the event, venue and quantity, with a placeholder when the venue is not set", async () => {
    const wrapper = await mountView([
      makeRequest({ id: 1, name: "Alumni Gala", offset: 5 }),
      makeRequest({ id: 2, name: "No Venue Event", offset: 6, venue: null, items: [{ type: "Projector", quantity: 1 }] }),
    ]);

    const [first, second] = wrapper.findAll(".row");
    expect(first.find(".cell-event").text()).toBe("Alumni Gala");
    expect(first.find(".cell-venue").text()).toBe("Grand Ballroom");
    expect(first.find(".cell-qty").text()).toBe("2×");
    expect(second.find(".cell-venue").text()).toBe("Venue not set");
    expect(second.find(".cell-venue").classes()).toContain("cell-venue--empty");
  });

  it("links every row to its request's details", async () => {
    const wrapper = await mountView([makeRequest({ id: 4, eventId: 7 })]);

    const link = wrapper.find("a.cell-link");
    expect(link.text()).toBe("View details");
    expect(link.attributes("href")).toBe("/equipment-requests/event/7");
  });

  it("counts rows in each status tab and filters by tab", async () => {
    const wrapper = await mountView([
      makeRequest({ id: 1, status: "Requested", items: [{ type: "Projector", quantity: 1 }, { type: "Microphones", quantity: 1 }] }),
      makeRequest({ id: 2, status: "Arranged", offset: 4 }),
    ]);

    const tabs = wrapper.findAll("[role='tab']").map((t) => t.text().replace(/\s+/g, " "));
    expect(tabs).toEqual(["Requested 2", "Arranged 1", "Partially Fulfilled 0"]);
    expect(wrapper.findAll(".row")).toHaveLength(2);

    await wrapper.findAll("[role='tab']")[1].trigger("click");
    expect(wrapper.findAll(".row")).toHaveLength(1);
    expect(wrapper.find(".count-badge").text()).toBe("2 arranged");
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
    expect(wrapper.find(".count-badge").text()).toBe("2 still needed");
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
      expect(wrapper.findAll(".cell-event").map((cell) => cell.text())).toEqual([
        "Overdue Event",
        "Soon Event",
        "Month Event",
      ]);
    });

    it("narrows to the next 7 days but still shows what is overdue", async () => {
      const wrapper = await mountView(requests());

      await wrapper.find("select[aria-label='Date range']").setValue("7");

      expect(wrapper.findAll(".cell-event").map((cell) => cell.text())).toEqual(["Overdue Event", "Soon Event"]);
    });

    it("widens to 90 days and to all dates", async () => {
      const wrapper = await mountView(requests());
      const select = wrapper.find("select[aria-label='Date range']");

      await select.setValue("90");
      expect(wrapper.findAll(".row")).toHaveLength(4);

      await wrapper.find("select[aria-label='Date range']").setValue("all");
      expect(wrapper.findAll(".row")).toHaveLength(4);
    });

    it("updates the tab counts to match the range", async () => {
      const wrapper = await mountView(requests());

      expect(wrapper.find("[role='tab']").text()).toContain("3");
      await wrapper.find("select[aria-label='Date range']").setValue("90");
      expect(wrapper.find("[role='tab']").text()).toContain("4");
    });
  });

  describe("equipment filter", () => {
    it("lists the equipment types and narrows to one", async () => {
      const wrapper = await mountView([
        makeRequest({ id: 1, items: [{ type: "Projector", quantity: 1 }, { type: "Microphones", quantity: 1 }] }),
      ]);
      const select = wrapper.find("select[aria-label='Equipment']");

      expect(select.findAll("option").map((option) => option.text())).toEqual([
        "All equipment",
        "Microphones",
        "Projector",
      ]);

      await select.setValue("Microphones");
      expect(groupTitles(wrapper)).toEqual(["Microphones"]);
    });
  });

  describe("urgency badge", () => {
    const label = async (offset: number, status = "Requested") => {
      const wrapper = await mountView([makeRequest({ offset, status })]);
      const badge = wrapper.find(".urgency");
      return badge.exists() ? badge.text() : null;
    };

    it("flags an unarranged event that is overdue, today, tomorrow or within three days", async () => {
      expect(await label(-2)).toBe("Overdue");
      expect(await label(0)).toBe("Today");
      expect(await label(1)).toBe("Tomorrow");
      expect(await label(2)).toBe("In 2 days");
      expect(await label(3)).toBe("In 3 days");
    });

    it("says nothing for an event further out, or one already arranged", async () => {
      expect(await label(4)).toBeNull();
      expect(await label(1, "Arranged")).toBeNull();
    });
  });

  it("explains an empty tab for the chosen range", async () => {
    const wrapper = await mountView([makeRequest({ status: "Arranged" })]);

    await wrapper.findAll("[role='tab']")[0].trigger("click");
    expect(wrapper.find(".empty-state").text()).toContain("Nothing to arrange in the next 30 days.");

    await wrapper.find("select[aria-label='Date range']").setValue("all");
    expect(wrapper.find(".empty-state").text()).toContain("Nothing to arrange.");
  });

  it("still lists requests when the stock levels cannot be loaded, just without the stock figure", async () => {
    mockedCatalog.mockRejectedValue(new Error("boom"));
    const wrapper = await mountView([makeRequest()]);

    expect(wrapper.findAll(".row")).toHaveLength(1);
    expect(wrapper.find(".stock").exists()).toBe(false);
  });

  it("shows an error when loading fails", async () => {
    mockedList.mockRejectedValue(new Error("boom"));
    const wrapper = mount(TechnicalSupportView, { global: { plugins: [router] } });
    await flushPromises();

    expect(wrapper.find("[role='alert']").text()).toContain("couldn't load equipment requests");
  });
});
