import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import VenueFormPanel from "../VenueFormPanel.vue";
import { fetchVenueFormOptions, type VenueRecord } from "../../../lib/venuesApi";

vi.mock("../../../lib/venuesApi", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/venuesApi")>("../../../lib/venuesApi");
  return { ...actual, fetchVenueFormOptions: vi.fn() };
});

const mockedOptions = vi.mocked(fetchVenueFormOptions);

const venue: VenueRecord = {
  id: 1,
  name: "Great Lawn",
  location: "North Campus",
  description: "Outdoor lawn",
  capacity: 300,
  accessibility: [],
  layouts: [],
  facilities: [],
  setupMinutes: 30,
  turnaroundMinutes: 30,
  openingTime: "08:00",
  closingTime: "22:00",
  status: "Available",
};

async function mountPanel(props: { venue?: VenueRecord | null } = {}) {
  mockedOptions.mockResolvedValue({ locations: [], accessibility: [], layouts: [], facilities: [] });
  const wrapper = mount(VenueFormPanel, { props });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("VenueFormPanel", () => {
  it("is a centered modal dialog over a scrim, not a side drawer", async () => {
    const wrapper = await mountPanel();

    const dialog = wrapper.find("[role='dialog']");
    expect(dialog.element.tagName).toBe("DIV");
    expect(dialog.classes()).toContain("modal");
    expect(dialog.attributes("aria-modal")).toBe("true");
    expect(wrapper.find("aside").exists()).toBe(false);
  });

  it("titles itself for adding a new venue, or for editing the one it is given", async () => {
    const adding = await mountPanel();
    expect(adding.find("#venue-form-title").text()).toBe("Add new venue");

    const editing = await mountPanel({ venue });
    expect(editing.find("#venue-form-title").text()).toBe("Edit venue");
    expect(editing.text()).toContain("Great Lawn");
  });

  it("closes when the scrim is clicked, but not when the modal itself is", async () => {
    const wrapper = await mountPanel();

    await wrapper.find(".modal").trigger("click");
    expect(wrapper.emitted("close")).toBeUndefined();

    await wrapper.find(".modal-overlay").trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
  });
});
