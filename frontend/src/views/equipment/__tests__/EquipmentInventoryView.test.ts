import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import EquipmentInventoryView from "../EquipmentInventoryView.vue";
import {
  EquipmentRequestError,
  EquipmentValidationError,
  changeStock,
  createCatalogItem,
  fetchEquipmentCatalog,
  fetchStockHistory,
} from "../../lib/equipmentApi";

vi.mock("../../lib/equipmentApi", async () => {
  const actual = await vi.importActual<typeof import("../../lib/equipmentApi")>("../../lib/equipmentApi");
  return {
    ...actual,
    fetchEquipmentCatalog: vi.fn(),
    createCatalogItem: vi.fn(),
    changeStock: vi.fn(),
    fetchStockHistory: vi.fn(),
  };
});

const mockedCatalog = vi.mocked(fetchEquipmentCatalog);
const mockedCreate = vi.mocked(createCatalogItem);
const mockedChange = vi.mocked(changeStock);
const mockedHistory = vi.mocked(fetchStockHistory);

type CatalogItem = { id: number; name: string; totalStock: number; availableStock: number; unusableNow?: number; bookedCount?: number };
const projector: CatalogItem = { id: 1, name: "Projector", totalStock: 10, availableStock: 6 };
const microphones: CatalogItem = { id: 2, name: "Microphones", totalStock: 4, availableStock: 0 };

async function mountView(items: CatalogItem[] = [projector, microphones]) {
  mockedCatalog.mockResolvedValue(items.map((item) => ({ ...item })));
  const wrapper = mount(EquipmentInventoryView, { global: { stubs: { RouterLink: true } } });
  await flushPromises();
  return wrapper;
}

const row = (wrapper: Awaited<ReturnType<typeof mountView>>, id: number) => wrapper.find(`[data-testid='item-${id}']`);

/** Opens the change form for an item and fills it in (the form opens in a modal, not the row). */
async function fillChange(
  wrapper: Awaited<ReturnType<typeof mountView>>,
  id: number,
  action: "add-stock" | "remove-stock",
  quantity: string,
  reason: string,
) {
  await row(wrapper, id).find(`[data-testid='${action}']`).trigger("click");
  await wrapper.find("#change-qty").setValue(quantity);
  await wrapper.find("#change-reason").setValue(reason);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("EquipmentInventoryView — stock table", () => {
  it("lists every item with its total and available stock as plain numbers, not editable fields", async () => {
    const wrapper = await mountView();

    expect(wrapper.findAll("[data-testid^='item-']")).toHaveLength(2);
    expect(row(wrapper, 1).find("[data-testid='total']").text()).toBe("10");
    expect(row(wrapper, 1).find("[data-testid='available']").text()).toBe("6");
    expect(row(wrapper, 1).findAll("input")).toHaveLength(0);
  });

  it("flags an item with nothing available", async () => {
    const wrapper = await mountView();

    expect(row(wrapper, 2).find("[data-testid='available']").classes()).toContain("count--low");
    expect(row(wrapper, 1).find("[data-testid='available']").classes()).not.toContain("count--low");
  });

  it("says when there is no equipment yet", async () => {
    const wrapper = await mountView([]);
    expect(wrapper.text()).toContain("No equipment has been added yet.");
    expect(wrapper.find("[data-testid^='item-']").exists()).toBe(false);
  });
});

describe("EquipmentInventoryView — units out of use come off the available number (E5-5)", () => {
  it("shows how many units are booked by events, out of use and available, in their own columns", async () => {
    const wrapper = await mountView([
      { ...projector, availableStock: 4, unusableNow: 2, bookedCount: 4 },
      { ...microphones, unusableNow: 0 },
    ]);

    expect(wrapper.text()).toContain("Booked by events");
    expect(wrapper.text()).toContain("Out of use");
    expect(row(wrapper, 1).find("[data-testid='booked']").text()).toBe("4");
    expect(row(wrapper, 1).find("[data-testid='out-of-use']").text()).toBe("2");
    expect(row(wrapper, 1).find("[data-testid='available']").text()).toBe("4");
    // An older response without the counts reads as none.
    expect(row(wrapper, 2).find("[data-testid='booked']").text()).toBe("0");
    expect(row(wrapper, 2).find("[data-testid='out-of-use']").text()).toBe("0");
  });

  it("flags out of use with a warning badge only once there is at least one unit", async () => {
    const wrapper = await mountView([
      { ...projector, unusableNow: 1 },
      { ...microphones, unusableNow: 0 },
    ]);

    expect(row(wrapper, 1).find("[data-testid='out-of-use']").classes()).toContain("out-of-use-badge");
    expect(row(wrapper, 2).find("[data-testid='out-of-use']").classes()).not.toContain("out-of-use-badge");
  });

});

describe("EquipmentInventoryView — stock on a chosen day", () => {
  it("starts on today and asks for today's stock", async () => {
    const wrapper = await mountView();

    expect(mockedCatalog).toHaveBeenCalledTimes(1);
    expect((wrapper.find("[data-testid='stock-date']").element as HTMLInputElement).value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(wrapper.find("[data-testid='stock-today']").attributes("disabled")).toBeDefined();
  });

  it("reloads the table for the day picked", async () => {
    const wrapper = await mountView();
    mockedCatalog.mockResolvedValue([{ ...projector, availableStock: 1, bookedCount: 9 }, { ...microphones }]);

    await wrapper.find("[data-testid='stock-date']").setValue("2026-11-12");
    await flushPromises();

    expect(mockedCatalog).toHaveBeenLastCalledWith("2026-11-12");
    expect(row(wrapper, 1).find("[data-testid='booked']").text()).toBe("9");
    expect(row(wrapper, 1).find("[data-testid='available']").text()).toBe("1");
    expect((wrapper.find("[data-testid='stock-date']").element as HTMLInputElement).value).toBe("2026-11-12");
    expect(wrapper.find("[data-testid='stock-today']").attributes("disabled")).toBeUndefined();
  });

  it("goes back to today's numbers with the Today button", async () => {
    const wrapper = await mountView();
    await wrapper.find("[data-testid='stock-date']").setValue("2026-11-12");
    await flushPromises();

    await wrapper.find("[data-testid='stock-today']").trigger("click");
    await flushPromises();

    const today = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    expect(mockedCatalog).toHaveBeenLastCalledWith(today);
  });

  it("keeps the day and numbers it had, and says so, when the new day can't be loaded", async () => {
    const wrapper = await mountView();
    const before = (wrapper.find("[data-testid='stock-date']").element as HTMLInputElement).value;
    mockedCatalog.mockRejectedValue(new Error("down"));

    await wrapper.find("[data-testid='stock-date']").setValue("2026-11-12");
    await flushPromises();

    expect(wrapper.find("[data-testid='stock-date-error']").text()).toContain("couldn't load the stock for that day");
    expect(row(wrapper, 1).find("[data-testid='available']").text()).toBe("6");
    expect((wrapper.find("[data-testid='stock-date']").element as HTMLInputElement).value).toBe(before);
  });

  it("re-reads the chosen day, not today, after a stock change", async () => {
    mockedChange.mockResolvedValue({ ...projector, totalStock: 12, availableStock: 99 });
    const wrapper = await mountView();
    await wrapper.find("[data-testid='stock-date']").setValue("2026-11-12");
    await flushPromises();
    mockedCatalog.mockResolvedValue([{ ...projector, totalStock: 12, availableStock: 7 }, { ...microphones }]);

    await fillChange(wrapper, 1, "add-stock", "2", "New delivery");
    await wrapper.find("[data-testid='change-form']").trigger("submit");
    await flushPromises();

    expect(mockedCatalog).toHaveBeenLastCalledWith("2026-11-12");
    expect(row(wrapper, 1).find("[data-testid='available']").text()).toBe("7");
  });
});

describe("EquipmentInventoryView — changing stock needs a reason (E5-5)", () => {
  it("opens a form with a quantity and a reason, and warns that only free units can be removed", async () => {
    const wrapper = await mountView();

    await row(wrapper, 1).find("[data-testid='remove-stock']").trigger("click");

    const form = wrapper.find("[data-testid='change-form']");
    expect(form.text()).toContain("Remove stock");
    expect(form.text()).toContain("Only free units can be removed");
    expect(form.find("#change-reason").exists()).toBe(true);

    await row(wrapper, 1).find("[data-testid='add-stock']").trigger("click");
    expect(wrapper.find("[data-testid='change-form']").text()).not.toContain("Only free units can be removed");
  });

  it("won't go further without a reason, or with a bad quantity, and never calls the API", async () => {
    const wrapper = await mountView();

    await fillChange(wrapper, 1, "add-stock", "0", "  ");
    await wrapper.find("[data-testid='change-form']").trigger("submit");

    expect(wrapper.find("[data-testid='change-form']").text()).toContain("Enter a whole number, 1 or more.");
    expect(wrapper.find("[data-testid='change-form']").text()).toContain("A reason is required.");
    expect(wrapper.find("[role='alertdialog']").exists()).toBe(false);
    expect(mockedChange).not.toHaveBeenCalled();
  });

  it("asks for confirmation, showing the new total and the reason, before changing anything", async () => {
    const wrapper = await mountView();

    await fillChange(wrapper, 1, "remove-stock", "3", "Sold off");
    await wrapper.find("[data-testid='change-form']").trigger("submit");

    const dialog = wrapper.find("[role='alertdialog']");
    expect(dialog.text()).toContain("Remove 3 Projector?");
    expect(dialog.text()).toContain("Total stock goes from 10 to 7. Reason: Sold off");
    expect(mockedChange).not.toHaveBeenCalled();

    const back = dialog.findAll("button").find((b) => b.text() === "Back")!;
    await back.trigger("click");
    expect(wrapper.find("[role='alertdialog']").exists()).toBe(false);
    expect(mockedChange).not.toHaveBeenCalled();
  });

  it("adds stock right away, without a confirmation step, updating the counts and saying so", async () => {
    mockedChange.mockResolvedValue({ ...projector, totalStock: 12, availableStock: 8 });
    const wrapper = await mountView();

    await fillChange(wrapper, 1, "add-stock", "2", "  New delivery ");
    await wrapper.find("[data-testid='change-form']").trigger("submit");
    await flushPromises();

    expect(wrapper.find("[role='alertdialog']").exists()).toBe(false);
    expect(mockedChange).toHaveBeenCalledWith(1, { direction: "add", quantity: 2, reason: "New delivery" });
    expect(row(wrapper, 1).find("[data-testid='total']").text()).toBe("12");
    expect(row(wrapper, 1).find("[data-testid='available']").text()).toBe("8");
    expect(wrapper.find("[data-testid='stock-notice']").text()).toBe("Added 2 Projector. Total stock is now 12.");
    expect(wrapper.find("[data-testid='change-form']").exists()).toBe(false);
    expect(wrapper.find("[role='alertdialog']").exists()).toBe(false);
  });

  it("removes stock, confirming with a destructive button", async () => {
    mockedChange.mockResolvedValue({ ...projector, totalStock: 7, availableStock: 3 });
    const wrapper = await mountView();

    await fillChange(wrapper, 1, "remove-stock", "3", "Sold off");
    await wrapper.find("[data-testid='change-form']").trigger("submit");
    expect(wrapper.find("[data-testid='confirm-change']").classes()).toContain("btn--danger-solid");
    await wrapper.find("[data-testid='confirm-change']").trigger("click");
    await flushPromises();

    expect(mockedChange).toHaveBeenCalledWith(1, { direction: "remove", quantity: 3, reason: "Sold off" });
    expect(wrapper.find("[data-testid='stock-notice']").text()).toBe("Removed 3 Projector. Total stock is now 7.");
  });

  it("returns to the form with the backend's message when too much is removed, keeping the counts", async () => {
    mockedChange.mockRejectedValue(new EquipmentRequestError("Only 2 can be removed: the rest is reserved, out of use or held by requests."));
    const wrapper = await mountView();

    await fillChange(wrapper, 1, "remove-stock", "5", "Sold off");
    await wrapper.find("[data-testid='change-form']").trigger("submit");
    await wrapper.find("[data-testid='confirm-change']").trigger("click");
    await flushPromises();

    expect(wrapper.find("[role='alertdialog']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='change-form'] [role='alert']").text()).toContain("Only 2 can be removed");
    expect(row(wrapper, 1).find("[data-testid='total']").text()).toBe("10");
  });

  it("shows field errors from the backend against the right field", async () => {
    mockedChange.mockRejectedValue(new EquipmentValidationError({ reason: "A reason is required." }));
    const wrapper = await mountView();

    await fillChange(wrapper, 1, "add-stock", "1", "x");
    await wrapper.find("[data-testid='change-form']").trigger("submit");
    await flushPromises();

    expect(wrapper.find("[data-testid='change-form']").text()).toContain("A reason is required.");
  });

  it("discards the form on Cancel", async () => {
    const wrapper = await mountView();

    await row(wrapper, 1).find("[data-testid='add-stock']").trigger("click");
    const cancel = wrapper.findAll("[data-testid='change-form'] button").find((b) => b.text() === "Cancel")!;
    await cancel.trigger("click");

    expect(wrapper.find("[data-testid='change-form']").exists()).toBe(false);
  });
});

describe("EquipmentInventoryView — stock history", () => {
  const changes = [
    { id: 2, changeType: "Removed" as const, quantity: 3, totalBefore: 12, totalAfter: 9, reason: "Sold off", changedBy: "TS-0001", createdAt: "2026-10-19T03:00:00Z" },
    { id: 1, changeType: "Added" as const, quantity: 2, totalBefore: 10, totalAfter: 12, reason: "New delivery", changedBy: "TS-0002", createdAt: "2026-10-18T03:00:00Z" },
  ];

  it("lists who changed the stock, by how much, why and when", async () => {
    mockedHistory.mockResolvedValue(changes);
    const wrapper = await mountView();

    await row(wrapper, 1).find("[data-testid='toggle-history']").trigger("click");
    await flushPromises();

    const entries = wrapper.findAll("[data-testid='history-entry']");
    expect(mockedHistory).toHaveBeenCalledWith(1);
    expect(entries).toHaveLength(2);
    expect(entries[0].text()).toContain("Removed 3");
    expect(entries[0].text()).toContain("12 → 9");
    expect(entries[0].text()).toContain("Sold off");
    expect(entries[0].text()).toContain("TS-0001");
    expect(entries[1].text()).toContain("Added 2");
  });

  it("says when nothing has changed yet, and when the history can't be loaded", async () => {
    mockedHistory.mockResolvedValueOnce([]);
    const wrapper = await mountView();
    await row(wrapper, 1).find("[data-testid='toggle-history']").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("No stock changes recorded yet.");

    mockedHistory.mockRejectedValueOnce(new Error("down"));
    await row(wrapper, 2).find("[data-testid='toggle-history']").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain("We couldn't load the history.");
  });

  it("closes again, and refreshes after a change when it is open", async () => {
    mockedHistory.mockResolvedValue(changes);
    mockedChange.mockResolvedValue({ ...projector, totalStock: 11, availableStock: 7 });
    const wrapper = await mountView();

    await row(wrapper, 1).find("[data-testid='toggle-history']").trigger("click");
    await flushPromises();
    await fillChange(wrapper, 1, "add-stock", "1", "Top up");
    await wrapper.find("[data-testid='change-form']").trigger("submit");
    await flushPromises();
    expect(mockedHistory).toHaveBeenCalledTimes(2);

    await row(wrapper, 1).find("[data-testid='toggle-history']").trigger("click");
    expect(wrapper.find("[data-testid='history-entry']").exists()).toBe(false);
  });
});

describe("EquipmentInventoryView — adding an item", () => {
  it("opens the add-item modal from the header button, and Cancel closes it again", async () => {
    const wrapper = await mountView();

    expect(wrapper.find("#new-name").exists()).toBe(false);
    await wrapper.find("[data-testid='open-add-item']").trigger("click");
    expect(wrapper.find("#new-name").exists()).toBe(true);

    await wrapper.findAll("form button").find((b) => b.text() === "Cancel")!.trigger("click");
    expect(wrapper.find("#new-name").exists()).toBe(false);
  });

  it("adds an item and lists it in name order", async () => {
    mockedCreate.mockResolvedValue({ id: 3, name: "Lectern", totalStock: 4, availableStock: 4 });
    const wrapper = await mountView();

    await wrapper.find("[data-testid='open-add-item']").trigger("click");
    await wrapper.find("#new-name").setValue("Lectern");
    await wrapper.find("#new-total").setValue("4");
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(mockedCreate).toHaveBeenCalledWith("Lectern", 4);
    expect(wrapper.findAll("[data-testid^='item-'] .item-name").map((el) => el.text())).toEqual([
      "Lectern",
      "Microphones",
      "Projector",
    ]);
    // The modal closes on success, ready to open blank next time.
    expect(wrapper.find("#new-name").exists()).toBe(false);
    expect(wrapper.find("[data-testid='stock-notice']").text()).toBe('Added "Lectern". Starting stock 4.');
  });

  it("needs a name before it can add, and says so as soon as the field is blank", async () => {
    const wrapper = await mountView();

    await wrapper.find("[data-testid='open-add-item']").trigger("click");
    expect(wrapper.find("form button[type='submit']").attributes("disabled")).toBeDefined();
    expect(wrapper.find("#new-name-error").text()).toBe("Enter an item name.");
    expect(wrapper.find("#new-name").attributes("aria-invalid")).toBe("true");

    await wrapper.find("#new-name").setValue("Lectern");
    expect(wrapper.find("#new-name-error").text()).toBe("");
    expect(wrapper.find("form button[type='submit']").attributes("disabled")).toBeUndefined();
  });

  it("shows a duplicate-name error from the backend", async () => {
    mockedCreate.mockRejectedValue(new EquipmentValidationError({ name: "Already in use." }));
    const wrapper = await mountView();

    await wrapper.find("[data-testid='open-add-item']").trigger("click");
    await wrapper.find("#new-name").setValue("Projector");
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(wrapper.find("#new-name-error").text()).toBe("Already in use.");
  });

  it("shows an error when the inventory cannot be loaded", async () => {
    mockedCatalog.mockRejectedValue(new Error("boom"));
    const wrapper = mount(EquipmentInventoryView, { global: { stubs: { RouterLink: true } } });
    await flushPromises();

    expect(wrapper.find("[role='alert']").text()).toContain("couldn't load the equipment inventory");
  });
});
