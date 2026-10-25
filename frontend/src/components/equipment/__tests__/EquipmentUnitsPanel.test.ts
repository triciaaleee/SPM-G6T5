import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import EquipmentUnitsPanel from "../EquipmentUnitsPanel.vue";
import {
  EquipmentRequestError,
  EquipmentValidationError,
  clearUnavailability,
  fetchEquipmentUnits,
  fetchUnitImpact,
  markUnitUsable,
  markUnitsUnusable,
  setUnitLabel,
  type EquipmentUnit,
  type UnitImpact,
  type UnitImpactPreview,
} from "../../../lib/equipmentApi";

vi.mock("../../../lib/equipmentApi", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/equipmentApi")>("../../../lib/equipmentApi");
  return {
    EquipmentRequestError: actual.EquipmentRequestError,
    EquipmentValidationError: actual.EquipmentValidationError,
    UNIT_UNAVAILABILITY_REASONS: actual.UNIT_UNAVAILABILITY_REASONS,
    clearUnavailability: vi.fn(),
    fetchEquipmentUnits: vi.fn(),
    fetchUnitImpact: vi.fn(),
    markUnitUsable: vi.fn(),
    markUnitsUnusable: vi.fn(),
    setUnitLabel: vi.fn(),
  };
});

const mockedUnits = vi.mocked(fetchEquipmentUnits);
const mockedImpact = vi.mocked(fetchUnitImpact);
const mockedMark = vi.mocked(markUnitsUnusable);
const mockedUsable = vi.mocked(markUnitUsable);
const mockedClear = vi.mocked(clearUnavailability);
const mockedLabel = vi.mocked(setUnitLabel);

function unit(overrides: Partial<EquipmentUnit> = {}): EquipmentUnit {
  return { id: 12, type: "Projector", status: "Available", label: null, periods: [], ...overrides };
}

type Wrapper = Awaited<ReturnType<typeof mountPanel>>;

async function mountPanel(units: EquipmentUnit[]) {
  mockedUnits.mockResolvedValue(units);
  const wrapper = mount(EquipmentUnitsPanel, { global: { stubs: { RouterLink: true } } });
  await flushPromises();
  return wrapper;
}

const type = (wrapper: Wrapper, name = "Projector") => wrapper.find(`[data-testid='type-${name}']`);
const unitRow = (wrapper: Wrapper, id: number) => wrapper.find(`[data-testid='unit-${id}']`);

function impactUnit(id: number, state: UnitImpact["state"], extra: Partial<UnitImpact> = {}): UnitImpact {
  return { id, label: null, state, reason: null, events: [], ...extra };
}

const galaEvent = { eventId: 1, eventName: "Alumni Gala", proposedDate: "2099-06-12", startTime: "09:00" };
const careerEvent = { eventId: 2, eventName: "Career Night", proposedDate: "2099-06-15", startTime: "18:00" };

/** Opens the mark form, fills in the quantity, and runs "Check impact". */
async function checkImpact(wrapper: Wrapper, preview: UnitImpactPreview, quantity = "2") {
  mockedImpact.mockResolvedValue(preview);
  await type(wrapper).find("[data-testid='type-mark']").trigger("click");
  await wrapper.find("#qty-Projector").setValue(quantity);
  await wrapper.find("#from-Projector").setValue("2099-06-01");
  await wrapper.find("#until-Projector").setValue("2099-06-30");
  await wrapper.find("[data-testid='mark-form']").trigger("submit");
  await flushPromises();
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("EquipmentUnitsPanel — one mark button per type (E5-5)", () => {
  it("lists the types with how many units are unusable now, and one Mark unusable button each", async () => {
    const wrapper = await mountPanel([
      unit({ id: 12 }),
      unit({ id: 13, status: "Damaged" }),
      unit({ id: 14, periods: [{ id: 1, reason: "Damaged", startDate: "2000-01-01", endDate: null, note: null }] }),
      unit({ id: 20, type: "Screen" }),
    ]);

    expect(type(wrapper).find("[data-testid='type-total']").text()).toBe("3");
    expect(type(wrapper).find("[data-testid='type-unusable']").text()).toBe("2");
    expect(type(wrapper, "Screen").find("[data-testid='type-mark']").exists()).toBe(true);
    // Hundreds of units never make you scroll: the per-unit list stays collapsed.
    expect(wrapper.find("[data-testid='unit-12']").exists()).toBe(false);
  });

  it("sorts types with units out of use first, then alphabetically", async () => {
    const wrapper = await mountPanel([
      unit({ id: 1, type: "Chairs" }),
      unit({ id: 2, type: "Lectern" }),
      unit({ id: 3, type: "Screen", status: "Damaged" }),
      unit({ id: 4, type: "Amp" }),
    ]);

    const names = wrapper.findAll("div.row[data-testid^='type-']").map((row) => row.attributes("data-testid"));
    expect(names).toEqual(["type-Screen", "type-Amp", "type-Chairs", "type-Lectern"]);
  });

  it("says when there are no units, and when loading fails", async () => {
    expect((await mountPanel([])).text()).toContain("There are no equipment units yet.");

    mockedUnits.mockRejectedValue(new Error("down"));
    const failed = mount(EquipmentUnitsPanel, { global: { stubs: { RouterLink: true } } });
    await flushPromises();
    expect(failed.find("[role='alert']").text()).toContain("couldn't load the equipment units");
  });
});

describe("EquipmentUnitsPanel — check impact, then confirm (E5-5 AC1, AC2)", () => {
  it("starts with a quantity of 1, today's date and an optional end date", async () => {
    const wrapper = await mountPanel([unit()]);

    await type(wrapper).find("[data-testid='type-mark']").trigger("click");

    expect((wrapper.find("#qty-Projector").element as HTMLInputElement).value).toBe("1");
    expect((wrapper.find("#from-Projector").element as HTMLInputElement).value).toBe(new Date().toLocaleDateString("en-CA"));
    expect((wrapper.find("#until-Projector").element as HTMLInputElement).value).toBe("");
    expect(wrapper.find("[data-testid='impact']").exists()).toBe(false);
  });

  it("checks the quantity and the start date before asking for the impact", async () => {
    const wrapper = await mountPanel([unit()]);
    await type(wrapper).find("[data-testid='type-mark']").trigger("click");

    await wrapper.find("#qty-Projector").setValue("0");
    await wrapper.find("#from-Projector").setValue("");
    await wrapper.find("[data-testid='mark-form']").trigger("submit");

    expect(wrapper.find("[data-testid='mark-form']").text()).toContain("Enter a whole number, 1 or more.");
    expect(wrapper.find("[data-testid='mark-form']").text()).toContain("Start date is required.");
    expect(mockedImpact).not.toHaveBeenCalled();
  });

  it("asks for the impact of that quantity and those dates, and shows nothing as saved", async () => {
    const wrapper = await mountPanel([unit()]);
    await checkImpact(wrapper, { type: "Projector", units: [impactUnit(12, "free")], pickable: 1, suggested: [12] }, "1");

    expect(mockedImpact).toHaveBeenCalledWith("Projector", { startDate: "2099-06-01", endDate: "2099-06-30", quantity: 1 });
    expect(mockedMark).not.toHaveBeenCalled();
    expect(wrapper.find("[data-testid='impact-none']").text()).toBe("No reserved events are affected.");
  });

  // The case that matters: all units reserved, two broke — which events are hit?
  it("when every unit is reserved, shows which events the suggested units would hit before anything is saved", async () => {
    const units = [unit({ id: 1 }), unit({ id: 2 }), unit({ id: 3 })];
    const wrapper = await mountPanel(units);
    await checkImpact(wrapper, {
      type: "Projector",
      units: [
        impactUnit(1, "reserved", { events: [galaEvent] }),
        impactUnit(2, "reserved", { events: [careerEvent] }),
        impactUnit(3, "reserved", { events: [careerEvent] }),
      ],
      pickable: 3,
      suggested: [2, 3],
    });

    expect(wrapper.find("[data-testid='pick-1']").element).toHaveProperty("checked", false);
    expect(wrapper.find("[data-testid='pick-2']").element).toHaveProperty("checked", true);
    expect(wrapper.find("[data-testid='pick-3']").element).toHaveProperty("checked", true);
    const events = wrapper.find("[data-testid='impact-events']").text();
    expect(events).toContain("This will affect:");
    expect(events).toContain("Career Night (15 Jun 2099) — 2 units. Its coordinator will be notified.");
    expect(events).not.toContain("Alumni Gala");
    expect(wrapper.find("[data-testid='mark-form']").text()).toContain("Reserved for Career Night (15 Jun 2099)");
    expect(wrapper.find("[data-testid='confirm-mark']").text()).toBe("Confirm — mark 2 unusable");
  });

  it("lets the user tick other units, and updates which events are affected as they do", async () => {
    const wrapper = await mountPanel([unit({ id: 1 }), unit({ id: 2 })]);
    await checkImpact(
      wrapper,
      {
        type: "Projector",
        units: [impactUnit(1, "reserved", { events: [galaEvent] }), impactUnit(2, "reserved", { events: [careerEvent] })],
        pickable: 2,
        suggested: [2],
      },
      "1",
    );
    expect(wrapper.find("[data-testid='impact-events']").text()).toContain("Career Night");

    await wrapper.find("[data-testid='pick-2']").setValue(false);
    expect(wrapper.find("[data-testid='impact-none']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='confirm-mark']").attributes("disabled")).toBeDefined();

    await wrapper.find("[data-testid='pick-1']").setValue(true);
    const events = wrapper.find("[data-testid='impact-events']").text();
    expect(events).toContain("Alumni Gala (12 Jun 2099) — 1 unit");
    expect(events).not.toContain("Career Night");

    await wrapper.find("[data-testid='reset-suggestion']").trigger("click");
    expect(wrapper.find("[data-testid='pick-2']").element).toHaveProperty("checked", true);
    expect(wrapper.find("[data-testid='pick-1']").element).toHaveProperty("checked", false);
  });

  it("can't tick a unit that is already out of use, and warns when fewer can be marked than asked", async () => {
    const wrapper = await mountPanel([unit({ id: 1 }), unit({ id: 2 })]);
    await checkImpact(wrapper, {
      type: "Projector",
      units: [impactUnit(1, "free"), impactUnit(2, "unavailable", { reason: "Damaged" })],
      pickable: 1,
      suggested: [1],
    });

    expect(wrapper.find("[data-testid='pick-2']").attributes("disabled")).toBeDefined();
    expect(wrapper.find(".pick--disabled").text()).toContain("Already out of use (Damaged)");
    expect(wrapper.find("[data-testid='impact-short']").text()).toBe("Only 1 of the 2 can be marked: the rest are already out of use for those dates.");
  });

  it("forgets the preview when the quantity or dates change, since it no longer applies", async () => {
    const wrapper = await mountPanel([unit()]);
    await checkImpact(wrapper, { type: "Projector", units: [impactUnit(12, "free")], pickable: 1, suggested: [12] }, "1");
    expect(wrapper.find("[data-testid='impact']").exists()).toBe(true);

    await wrapper.find("#until-Projector").setValue("2099-07-15");

    expect(wrapper.find("[data-testid='impact']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='check-impact']").exists()).toBe(true);
  });

  it("saves only when confirmed, with the ticked units and the form's reason, dates and note", async () => {
    mockedMark.mockResolvedValue({
      periods: [
        { unitId: 2, label: null, period: { id: 5, reason: "Under Maintenance", startDate: "2099-06-01", endDate: "2099-06-30", note: "service" } },
        { unitId: 3, label: null, period: { id: 6, reason: "Under Maintenance", startDate: "2099-06-01", endDate: "2099-06-30", note: "service" } },
      ],
      affectedEvents: [{ eventId: 2, eventName: "Career Night", units: 2 }],
      notified: true,
    });
    const wrapper = await mountPanel([unit({ id: 1 }), unit({ id: 2 }), unit({ id: 3 })]);
    await checkImpact(wrapper, {
      type: "Projector",
      units: [impactUnit(1, "free"), impactUnit(2, "reserved", { events: [careerEvent] }), impactUnit(3, "reserved", { events: [careerEvent] })],
      pickable: 3,
      suggested: [1, 2],
    });
    await wrapper.find("[data-testid='pick-1']").setValue(false);
    await wrapper.find("[data-testid='pick-3']").setValue(true);
    await wrapper.find("#reason-Projector").setValue("Under Maintenance");
    await wrapper.find("#note-Projector").setValue("service");
    expect(mockedMark).not.toHaveBeenCalled();

    mockedUnits.mockResolvedValue([unit({ id: 1 }), unit({ id: 2 }), unit({ id: 3 })]);
    await wrapper.find("[data-testid='confirm-mark']").trigger("click");
    await flushPromises();

    expect(mockedMark).toHaveBeenCalledWith({
      type: "Projector",
      unitIds: [2, 3],
      reason: "Under Maintenance",
      startDate: "2099-06-01",
      endDate: "2099-06-30",
      note: "service",
    });
    expect(wrapper.find("[data-testid='mark-form']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='units-notice']").text()).toBe(
      "Marked 2 Projector units unusable (#2, #3). Reserved for Career Night; the coordinator has been notified.",
    );
    // The page re-reads the available numbers, which now have these units taken off.
    expect(wrapper.emitted("changed")).toHaveLength(1);
  });

  it("says nobody is affected when no reserved event was touched, and refreshes the list", async () => {
    mockedMark.mockResolvedValue({
      periods: [{ unitId: 12, label: null, period: { id: 5, reason: "Damaged", startDate: "2099-06-01", endDate: null, note: null } }],
      affectedEvents: [],
      notified: true,
    });
    const wrapper = await mountPanel([unit()]);
    await checkImpact(wrapper, { type: "Projector", units: [impactUnit(12, "free")], pickable: 1, suggested: [12] }, "1");
    mockedUnits.mockResolvedValue([
      unit({ periods: [{ id: 5, reason: "Damaged", startDate: "2099-06-01", endDate: null, note: null }] }),
    ]);

    await wrapper.find("[data-testid='confirm-mark']").trigger("click");
    await flushPromises();

    expect(wrapper.find("[data-testid='units-notice']").text()).toBe("Marked 1 Projector unit unusable (#12). No reserved events are affected.");
    expect(wrapper.find("[data-testid='out-group']").text()).toContain("1× Damaged");
  });

  it("warns when a coordinator couldn't be told", async () => {
    mockedMark.mockResolvedValue({
      periods: [{ unitId: 12, label: null, period: { id: 5, reason: "Damaged", startDate: "2099-06-01", endDate: null, note: null } }],
      affectedEvents: [{ eventId: 1, eventName: "Alumni Gala", units: 1 }],
      notified: false,
    });
    const wrapper = await mountPanel([unit()]);
    await checkImpact(wrapper, { type: "Projector", units: [impactUnit(12, "reserved", { events: [galaEvent] })], pickable: 1, suggested: [12] }, "1");

    await wrapper.find("[data-testid='confirm-mark']").trigger("click");
    await flushPromises();

    expect(wrapper.find("[data-testid='units-notice']").text()).toContain("couldn't notify every coordinator");
    expect(wrapper.find("[data-testid='units-notice']").classes()).toContain("notice--warning");
    expect(wrapper.emitted("changed")).toHaveLength(1);
  });

  it("keeps the preview open with the backend's message when saving is refused", async () => {
    mockedMark.mockRejectedValue(new EquipmentRequestError("Projector #12 is already out of use for those dates."));
    const wrapper = await mountPanel([unit()]);
    await checkImpact(wrapper, { type: "Projector", units: [impactUnit(12, "free")], pickable: 1, suggested: [12] }, "1");

    await wrapper.find("[data-testid='confirm-mark']").trigger("click");
    await flushPromises();

    expect(wrapper.find("[data-testid='impact']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='mark-form'] [role='alert']").text()).toBe("Projector #12 is already out of use for those dates.");
  });

  it("shows validation errors from the impact check, and its failure", async () => {
    const wrapper = await mountPanel([unit()]);
    await type(wrapper).find("[data-testid='type-mark']").trigger("click");

    mockedImpact.mockRejectedValueOnce(new EquipmentValidationError({ endDate: "End date can't be before the start date." }));
    await wrapper.find("[data-testid='mark-form']").trigger("submit");
    await flushPromises();
    expect(wrapper.find("[data-testid='mark-form']").text()).toContain("End date can't be before the start date.");

    mockedImpact.mockRejectedValueOnce(new EquipmentRequestError("Couldn't check which events these units are reserved for. Please try again."));
    await wrapper.find("[data-testid='mark-form']").trigger("submit");
    await flushPromises();
    expect(wrapper.find("[data-testid='mark-form'] [role='alert']").text()).toContain("Couldn't check which events");
  });

  it("discards the form on Cancel", async () => {
    const wrapper = await mountPanel([unit()]);
    await type(wrapper).find("[data-testid='type-mark']").trigger("click");

    const cancel = wrapper.findAll("[data-testid='mark-form'] button").find((b) => b.text() === "Cancel")!;
    await cancel.trigger("click");

    expect(wrapper.find("[data-testid='mark-form']").exists()).toBe(false);
  });
});

describe("EquipmentUnitsPanel — what is out of use", () => {
  const damaged = (id: number) => ({ id, reason: "Damaged" as const, startDate: "2099-06-01", endDate: "2099-06-30", note: "cracked" });

  it("groups units marked together, so there is one line and one Mark usable again", async () => {
    const wrapper = await mountPanel([
      unit({ id: 4, periods: [damaged(1)] }),
      unit({ id: 9, periods: [damaged(2)] }),
      unit({ id: 17, periods: [{ id: 3, reason: "Under Maintenance", startDate: "2099-08-01", endDate: null, note: null }] }),
    ]);

    const groups = wrapper.findAll("[data-testid='out-group']");
    expect(groups).toHaveLength(2);
    expect(groups[0].text()).toContain("2× Damaged");
    expect(groups[0].text()).toContain("1 Jun 2099 to 30 Jun 2099");
    expect(groups[0].text()).toContain("cracked");
    expect(groups[0].text()).toContain("#4, #9");
    expect(groups[1].text()).toContain("1× Under Maintenance");
    expect(groups[1].text()).toContain("From 1 Aug 2099 until marked usable again");
  });

  it("clears the whole group at once", async () => {
    mockedClear.mockResolvedValue(2);
    const wrapper = await mountPanel([unit({ id: 4, periods: [damaged(1)] }), unit({ id: 9, periods: [damaged(2)] })]);

    await wrapper.find("[data-testid='group-usable']").trigger("click");
    await flushPromises();

    expect(mockedClear).toHaveBeenCalledWith([1, 2]);
    expect(wrapper.emitted("changed")).toHaveLength(1);
    expect(wrapper.find("[data-testid='out-group']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='units-notice']").text()).toBe("2 Projector units marked usable again.");
  });

  it("keeps the group and says why when it can't be cleared", async () => {
    mockedClear.mockRejectedValue(new EquipmentRequestError("Failed to mark the equipment usable again"));
    const wrapper = await mountPanel([unit({ id: 4, periods: [damaged(1)] })]);

    await wrapper.find("[data-testid='group-usable']").trigger("click");
    await flushPromises();

    expect(wrapper.find("[data-testid='out-group']").exists()).toBe(true);
    expect(wrapper.emitted("changed")).toBeUndefined();
    expect(wrapper.find("[data-testid='units-notice']").classes()).toContain("notice--warning");
  });
});

describe("EquipmentUnitsPanel — the per-unit list", () => {
  const units = [
    unit({ id: 12, label: "A-012" }),
    unit({ id: 13, status: "Damaged" }),
    unit({ id: 140 }),
    unit({ id: 15, periods: [{ id: 7, reason: "Damaged", startDate: "2000-01-01", endDate: null, note: null }] }),
  ];

  async function openList(list = units) {
    const wrapper = await mountPanel(list);
    await type(wrapper).find(".type__name-btn").trigger("click");
    return wrapper;
  }

  it("shows each unit's number, label and state when opened", async () => {
    const wrapper = await openList();

    expect(unitRow(wrapper, 12).text()).toContain("Projector #12 · A-012");
    expect(unitRow(wrapper, 12).find(".chip").text()).toBe("Available");
    expect(unitRow(wrapper, 13).find(".chip").text()).toBe("Damaged");
    expect(unitRow(wrapper, 15).find(".chip").classes()).toContain("chip--bad");
    expect(type(wrapper).find(".type__name-btn").attributes("aria-expanded")).toBe("true");
  });

  it("finds a unit by number or label, without hunting through the list", async () => {
    const wrapper = await openList();

    await wrapper.find("input[type='search']").setValue("14");
    expect(wrapper.findAll("[data-testid^='unit-']").map((u) => u.attributes("data-testid"))).toEqual(["unit-140"]);

    await wrapper.find("input[type='search']").setValue("a-012");
    expect(wrapper.findAll("[data-testid^='unit-']").map((u) => u.attributes("data-testid"))).toEqual(["unit-12"]);

    await wrapper.find("input[type='search']").setValue("#13");
    expect(wrapper.findAll("[data-testid^='unit-']").map((u) => u.attributes("data-testid"))).toEqual(["unit-13"]);

    await wrapper.find("input[type='search']").setValue("zzz");
    expect(wrapper.text()).toContain("No units match.");
  });

  it("can show only the unusable units", async () => {
    const wrapper = await openList();

    await wrapper.find(".check input").setValue(true);

    expect(wrapper.findAll("[data-testid^='unit-']").map((u) => u.attributes("data-testid"))).toEqual(["unit-13", "unit-15"]);
  });

  it("marks one unit's period usable again, from its own row", async () => {
    mockedUsable.mockResolvedValue(undefined);
    const wrapper = await openList();

    await unitRow(wrapper, 15).find("[data-testid='mark-usable']").trigger("click");
    await flushPromises();

    expect(mockedUsable).toHaveBeenCalledWith(15, 7);
    expect(wrapper.emitted("changed")).toHaveLength(1);
    expect(unitRow(wrapper, 15).find(".chip").text()).toBe("Available");
    expect(wrapper.find("[data-testid='units-notice']").text()).toBe("Projector #15 marked usable again.");
  });

  it("adds or edits a unit's label, so it can be matched to the physical item", async () => {
    mockedLabel.mockResolvedValue({ id: 140, label: "Sticker 140" });
    const wrapper = await openList();

    await unitRow(wrapper, 140).find("[data-testid='edit-label']").trigger("click");
    await unitRow(wrapper, 140).find("[data-testid='label-input']").setValue("Sticker 140");
    await unitRow(wrapper, 140).find("[data-testid='save-label']").trigger("click");
    await flushPromises();

    expect(mockedLabel).toHaveBeenCalledWith(140, "Sticker 140");
    expect(unitRow(wrapper, 140).text()).toContain("Projector #140 · Sticker 140");
    expect(unitRow(wrapper, 140).find("[data-testid='label-input']").exists()).toBe(false);
    expect(unitRow(wrapper, 12).find("[data-testid='edit-label']").text()).toBe("Edit label");
  });

  it("says so when a label can't be saved", async () => {
    mockedLabel.mockRejectedValue(new EquipmentValidationError({ label: "Use at most 50 characters." }));
    const wrapper = await openList();

    await unitRow(wrapper, 140).find("[data-testid='edit-label']").trigger("click");
    await unitRow(wrapper, 140).find("[data-testid='save-label']").trigger("click");
    await flushPromises();

    expect(wrapper.find("[data-testid='units-notice']").text()).toBe("Use at most 50 characters.");
  });
});
