import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import AppPanel from "../AppPanel.vue";
import EmptyState from "../EmptyState.vue";

describe("AppPanel", () => {
  it("is a div at the medium size unless told otherwise", () => {
    const wrapper = mount(AppPanel, { slots: { default: "Hello" } });

    expect(wrapper.element.tagName).toBe("DIV");
    expect(wrapper.classes()).toEqual(expect.arrayContaining(["panel", "panel--md"]));
    expect(wrapper.text()).toBe("Hello");
  });

  it("renders the element and size it is given, keeping the page's own classes", () => {
    const wrapper = mount(AppPanel, { props: { as: "li", size: "lg" }, attrs: { class: "request-card" } });

    expect(wrapper.element.tagName).toBe("LI");
    expect(wrapper.classes()).toEqual(expect.arrayContaining(["panel--lg", "request-card"]));
  });
});

describe("EmptyState", () => {
  it("shows its message in an empty-state box", () => {
    const wrapper = mount(EmptyState, { slots: { default: "<p>Nothing here</p>" } });

    expect(wrapper.classes()).toContain("empty-state");
    expect(wrapper.text()).toBe("Nothing here");
  });
});
