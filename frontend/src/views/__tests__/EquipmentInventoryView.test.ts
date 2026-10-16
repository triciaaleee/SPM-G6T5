import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import EquipmentInventoryView from "../EquipmentInventoryView.vue";
import {
  EquipmentValidationError,
  createCatalogItem,
  fetchEquipmentCatalog,
  updateCatalogItem,
} from "../../lib/equipmentApi";

vi.mock("../../lib/equipmentApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/equipmentApi")>("../../lib/equipmentApi");
  return {
    ...actual,
    fetchEquipmentCatalog: vi.fn(),
    createCatalogItem: vi.fn(),
    updateCatalogItem: vi.fn(),
  };
});

const mockedCatalog = vi.mocked(fetchEquipmentCatalog);
const mockedCreate = vi.mocked(createCatalogItem);
const mockedUpdate = vi.mocked(updateCatalogItem);

const projector = { id: 1, name: "Projector", totalStock: 10, availableStock: 6 };
const microphones = { id: 2, name: "Microphones", totalStock: 4, availableStock: 0 };

async function mountView(items = [projector, microphones]) {
  mockedCatalog.mockResolvedValue(items.map((item) => ({ ...item })));
  const wrapper = mount(EquipmentInventoryView);
  await flushPromises();
  return wrapper;
}

function rowOf(wrapper: Awaited<ReturnType<typeof mountView>>, name: string) {
  return wrapper.findAll("tbody tr").find((row) => row.find("th").text() === name)!;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("EquipmentInventoryView", () => {
  it("lists every item with its total and available stock", async () => {
    const wrapper = await mountView();

    expect(wrapper.findAll("tbody tr")).toHaveLength(2);
    const row = rowOf(wrapper, "Projector");
    const inputs = row.findAll("input").map((input) => (input.element as HTMLInputElement).value);
    expect(inputs).toEqual(["10", "6"]);
  });

  it("flags an item with nothing available", async () => {
    const wrapper = await mountView();

    expect(rowOf(wrapper, "Microphones").findAll("input")[1].classes()).toContain("input--low");
    expect(rowOf(wrapper, "Projector").findAll("input")[1].classes()).not.toContain("input--low");
  });

  it("only enables Save once a number has changed", async () => {
    const wrapper = await mountView();
    const row = rowOf(wrapper, "Projector");

    expect(row.find("button").attributes("disabled")).toBeDefined();
    await row.findAll("input")[0].setValue("12");
    expect(row.find("button").attributes("disabled")).toBeUndefined();
  });

  it("saves new stock numbers and shows them as saved", async () => {
    mockedUpdate.mockResolvedValue({ ...projector, totalStock: 12, availableStock: 9 });
    const wrapper = await mountView();
    const row = rowOf(wrapper, "Projector");

    await row.findAll("input")[0].setValue("12");
    await row.findAll("input")[1].setValue("9");
    await row.find("button").trigger("click");
    await flushPromises();

    expect(mockedUpdate).toHaveBeenCalledWith(1, { totalStock: 12, availableStock: 9 });
    expect(row.text()).toContain("Saved");
    expect(row.find("button").attributes("disabled")).toBeDefined();
  });

  it("refuses available stock above total stock without calling the API", async () => {
    const wrapper = await mountView();
    const row = rowOf(wrapper, "Projector");

    await row.findAll("input")[1].setValue("11");
    await row.find("button").trigger("click");

    expect(mockedUpdate).not.toHaveBeenCalled();
    expect(row.text()).toContain("Cannot be more than total stock.");
  });

  it("refuses negative and non-numeric entries without calling the API", async () => {
    const wrapper = await mountView();
    const row = rowOf(wrapper, "Projector");

    await row.findAll("input")[0].setValue("-3");
    await row.find("button").trigger("click");
    expect(row.text()).toContain("Whole number, 0 or more.");

    await row.findAll("input")[0].setValue("abc");
    await row.find("button").trigger("click");
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("shows the backend's field message when it refuses a change", async () => {
    mockedUpdate.mockRejectedValue(new EquipmentValidationError({ availableStock: "Not allowed." }));
    const wrapper = await mountView();
    const row = rowOf(wrapper, "Projector");

    await row.findAll("input")[1].setValue("5");
    await row.find("button").trigger("click");
    await flushPromises();

    expect(row.text()).toContain("Not allowed.");
  });

  it("adds an item and lists it in name order", async () => {
    mockedCreate.mockResolvedValue({ id: 3, name: "Lectern", totalStock: 4, availableStock: 4 });
    const wrapper = await mountView();

    await wrapper.find("#new-name").setValue("Lectern");
    await wrapper.find("#new-total").setValue("4");
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(mockedCreate).toHaveBeenCalledWith("Lectern", 4);
    expect(wrapper.findAll("tbody th").map((th) => th.text())).toEqual(["Lectern", "Microphones", "Projector"]);
    expect((wrapper.find("#new-name").element as HTMLInputElement).value).toBe("");
  });

  it("needs a name before it can add", async () => {
    const wrapper = await mountView();

    expect(wrapper.find("form button").attributes("disabled")).toBeDefined();
  });

  it("shows a duplicate-name error from the backend", async () => {
    mockedCreate.mockRejectedValue(new EquipmentValidationError({ name: "Already in use." }));
    const wrapper = await mountView();

    await wrapper.find("#new-name").setValue("Projector");
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(wrapper.find("#new-name-error").text()).toBe("Already in use.");
  });

  it("shows an error when the inventory cannot be loaded", async () => {
    mockedCatalog.mockRejectedValue(new Error("boom"));
    const wrapper = mount(EquipmentInventoryView);
    await flushPromises();

    expect(wrapper.find("[role='alert']").text()).toContain("couldn't load the equipment inventory");
  });
});
