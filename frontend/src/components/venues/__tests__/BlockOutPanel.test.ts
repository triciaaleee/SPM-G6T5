import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import BlockOutPanel from "../BlockOutPanel.vue";
import { previewUnavailability, type UnavailabilityPeriod } from "../../../lib/unavailabilityApi";

vi.mock("../../../lib/unavailabilityApi", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/unavailabilityApi")>("../../../lib/unavailabilityApi");
  return { ...actual, previewUnavailability: vi.fn() };
});

const mockedPreview = vi.mocked(previewUnavailability);

const venues = [{ id: 1, name: "Great Lawn" }];

const period: UnavailabilityPeriod = {
  id: 9,
  venueId: 1,
  startDate: "2099-06-01",
  endDate: "2099-06-02",
  allDay: true,
  startTime: null,
  endTime: null,
  reason: "Maintenance",
};

async function mountPanel(extra: { period?: UnavailabilityPeriod | null } = {}) {
  mockedPreview.mockResolvedValue({ affected: [], setupMinutes: 0, turnaroundMinutes: 0 });
  const wrapper = mount(BlockOutPanel, { props: { venueId: 1, venues, initialDate: "2099-06-01", ...extra } });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BlockOutPanel", () => {
  it("is a centered modal dialog over a scrim, not a side drawer", async () => {
    const wrapper = await mountPanel();

    const dialog = wrapper.find("[role='dialog']");
    expect(dialog.element.tagName).toBe("DIV");
    expect(dialog.classes()).toContain("modal");
    expect(dialog.attributes("aria-modal")).toBe("true");
    expect(wrapper.find("aside").exists()).toBe(false);
  });

  it("titles itself for blocking out time, or for editing the block-out it is given", async () => {
    expect((await mountPanel()).find("#block-out-title").text()).toBe("Block out time");
    expect((await mountPanel({ period })).find("#block-out-title").text()).toBe("Edit block-out");
  });

  it("closes when the scrim is clicked, but not when the modal itself is", async () => {
    const wrapper = await mountPanel();

    await wrapper.find(".modal").trigger("click");
    expect(wrapper.emitted("close")).toBeUndefined();

    await wrapper.find(".overlay").trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
  });
});
