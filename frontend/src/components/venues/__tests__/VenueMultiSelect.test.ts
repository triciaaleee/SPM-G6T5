import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import VenueMultiSelect from "../VenueMultiSelect.vue";

const venues = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, name: `Venue ${i + 1}` }));

async function mountPicker(modelValue: number[] | null, list = venues) {
  const wrapper = mount(VenueMultiSelect, { props: { venues: list, modelValue } });
  await wrapper.get(".picker__trigger").trigger("click");
  return wrapper;
}

/** The checkbox of a venue option, by venue name. */
const box = (wrapper: Awaited<ReturnType<typeof mountPicker>>, name: string) =>
  wrapper.findAll(".picker__option").find((o) => o.text() === name)!.get("input");

const lastEmitted = (wrapper: Awaited<ReturnType<typeof mountPicker>>) => wrapper.emitted("update:modelValue")!.at(-1)![0];

describe("VenueMultiSelect", () => {
  it("is just a label when there is a single venue", () => {
    const wrapper = mount(VenueMultiSelect, { props: { venues: [venues[0]], modelValue: null } });

    expect(wrapper.find(".picker__trigger").exists()).toBe(false);
    expect(wrapper.text()).toBe("Venue 1");
  });

  it("starts on All venues, and choosing one venue narrows to just that one", async () => {
    const wrapper = await mountPicker(null);
    expect(wrapper.get(".picker__trigger").text()).toContain("All venues (6)");

    await box(wrapper, "Venue 3").setValue(true);
    expect(lastEmitted(wrapper)).toEqual([3]);
  });

  it("lets four venues be picked, then locks the rest so a fifth can't be", async () => {
    const wrapper = await mountPicker([1, 2, 3]);
    expect(box(wrapper, "Venue 4").attributes("disabled")).toBeUndefined();

    await box(wrapper, "Venue 4").setValue(true);
    expect(lastEmitted(wrapper)).toEqual([1, 2, 3, 4]);

    await wrapper.setProps({ modelValue: [1, 2, 3, 4] });
    expect(box(wrapper, "Venue 5").attributes("disabled")).toBeDefined();
    expect(box(wrapper, "Venue 6").attributes("disabled")).toBeDefined();
    expect(wrapper.findAll(".picker__option--locked")).toHaveLength(2);

    // Already-picked venues stay clearable, and clearing one frees the rest again.
    expect(box(wrapper, "Venue 2").attributes("disabled")).toBeUndefined();
    await box(wrapper, "Venue 2").setValue(false);
    expect(lastEmitted(wrapper)).toEqual([1, 3, 4]);
    await wrapper.setProps({ modelValue: [1, 3, 4] });
    expect(box(wrapper, "Venue 5").attributes("disabled")).toBeUndefined();
  });

  it("ignores an attempt to go past the limit even if the box is forced", async () => {
    const wrapper = await mountPicker([1, 2, 3, 4]);

    await box(wrapper, "Venue 5").trigger("change");
    expect(wrapper.emitted("update:modelValue")).toBeUndefined();
  });

  it("goes back to All venues when the last tick is cleared, or All venues is chosen", async () => {
    const one = await mountPicker([2]);
    await box(one, "Venue 2").setValue(false);
    expect(lastEmitted(one)).toBeNull();

    const some = await mountPicker([1, 2]);
    await some.findAll(".picker__option")[0].get("input").setValue(true);
    expect(lastEmitted(some)).toBeNull();
  });

  it("keeps ticking every venue an explicit choice, so the calendar still has venues to draw", async () => {
    const three = venues.slice(0, 3);
    const wrapper = await mountPicker([1, 2], three);

    await box(wrapper, "Venue 3").setValue(true);
    expect(lastEmitted(wrapper)).toEqual([1, 2, 3]);
  });

  it("explains the limit inside the dropdown; the calendar's rule lives on the page, not here", async () => {
    const wrapper = await mountPicker(null);
    const hint = wrapper.get("[data-testid='venue-picker-hint']").text();

    expect(hint).toContain("Choose up to 4 venues");
    expect(hint).not.toContain("The calendar shows nothing");
    expect(hint).not.toContain("untick one");

    await wrapper.setProps({ modelValue: [1, 2, 3, 4] });
    expect(wrapper.get("[data-testid='venue-picker-hint']").text()).toContain("untick one to choose another");
  });
});
