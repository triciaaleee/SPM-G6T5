import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import UnderlineTabs from "../UnderlineTabs.vue";

const TABS = [
  { key: "a", label: "Upcoming", count: 3 },
  { key: "b", label: "Past", count: 0 },
  { key: "c", label: "Cancelled" },
];

const mountTabs = (props: Record<string, unknown> = {}) =>
  mount(UnderlineTabs, { props: { tabs: TABS, modelValue: "a", ariaLabel: "Events", ...props }, attachTo: document.body });

describe("UnderlineTabs", () => {
  it("is a tablist with the selected tab marked and the only one in the Tab order", () => {
    const wrapper = mountTabs();
    const tabs = wrapper.findAll("[role='tab']");

    expect(wrapper.get("[role='tablist']").attributes("aria-label")).toBe("Events");
    expect(tabs.map((t) => t.attributes("aria-selected"))).toEqual(["true", "false", "false"]);
    expect(tabs.map((t) => t.attributes("tabindex"))).toEqual(["0", "-1", "-1"]);
    expect(tabs[0].classes()).toContain("tab--active");
    wrapper.unmount();
  });

  it("shows a count pill only for tabs that have a count, including zero", () => {
    const wrapper = mountTabs();

    expect(wrapper.findAll(".tab__count").map((c) => c.text())).toEqual(["3", "0"]);
    wrapper.unmount();
  });

  it("shows the count as text in brackets with the inline style", () => {
    const wrapper = mountTabs({ countStyle: "inline" });

    expect(wrapper.findAll("[role='tab']")[0].text().replace(/\s+/g, " ")).toBe("Upcoming (3)");
    expect(wrapper.find(".tab__count").exists()).toBe(false);
    wrapper.unmount();
  });

  it("emits the clicked tab's key, and nothing for the tab already selected", async () => {
    const wrapper = mountTabs();

    await wrapper.findAll("[role='tab']")[0].trigger("click");
    await wrapper.findAll("[role='tab']")[1].trigger("click");

    expect(wrapper.emitted("update:modelValue")).toEqual([["b"]]);
    wrapper.unmount();
  });

  it("moves with the arrow keys, wrapping at the ends, and with Home and End", async () => {
    const wrapper = mountTabs({ modelValue: "c" });
    const list = wrapper.get("[role='tablist']");

    await list.trigger("keydown", { key: "ArrowRight" });
    await list.trigger("keydown", { key: "Home" });
    await list.trigger("keydown", { key: "End" });

    expect(wrapper.emitted("update:modelValue")).toEqual([["a"], ["a"]]);
    wrapper.unmount();
  });

  it("gives each tab an id from the prefix, and points them at the panel", () => {
    const wrapper = mountTabs({ idPrefix: "events-tab", panelId: "events-panel" });

    expect(wrapper.findAll("[role='tab']")[1].attributes("id")).toBe("events-tab-b");
    expect(wrapper.findAll("[role='tab']")[1].attributes("aria-controls")).toBe("events-panel");
    wrapper.unmount();
  });
});
