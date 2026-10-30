import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import SearchBox from "../SearchBox.vue";

describe("SearchBox", () => {
  it("is a search field named by its label, with the placeholder", () => {
    const wrapper = mount(SearchBox, { props: { modelValue: "", label: "Search events", placeholder: "Search events" } });
    const input = wrapper.get("input[type='search']");

    expect(input.attributes("aria-label")).toBe("Search events");
    expect(input.attributes("placeholder")).toBe("Search events");
  });

  it("emits what is typed", async () => {
    const wrapper = mount(SearchBox, { props: { modelValue: "", label: "Search" } });

    await wrapper.get("input").setValue("gala");

    expect(wrapper.emitted("update:modelValue")).toEqual([["gala"]]);
  });

  it("shows a clear button only once there is text, and clearing empties the field", async () => {
    const empty = mount(SearchBox, { props: { modelValue: "", label: "Search" } });
    expect(empty.find("[aria-label='Clear search']").exists()).toBe(false);

    const filled = mount(SearchBox, { props: { modelValue: "gala", label: "Search" } });
    await filled.get("[aria-label='Clear search']").trigger("click");

    expect(filled.emitted("update:modelValue")).toEqual([[""]]);
    expect(filled.emitted("clear")).toHaveLength(1);
  });
});
