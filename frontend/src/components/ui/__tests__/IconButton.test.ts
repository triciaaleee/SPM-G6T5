import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import IconButton from "../IconButton.vue";

describe("IconButton", () => {
  it("is a button named by its label, holding the icon from the slot", () => {
    const wrapper = mount(IconButton, { props: { label: "Close" }, slots: { default: "<svg />" } });

    expect(wrapper.get("button").attributes("aria-label")).toBe("Close");
    expect(wrapper.get("button").attributes("type")).toBe("button");
    expect(wrapper.find("svg").exists()).toBe(true);
  });

  it("passes disabled and click through to the button", async () => {
    const disabled = mount(IconButton, { props: { label: "Next" }, attrs: { disabled: true } });
    expect(disabled.get("button").attributes("disabled")).toBeDefined();

    const enabled = mount(IconButton, { props: { label: "Next" } });
    await enabled.get("button").trigger("click");
    expect(enabled.emitted("click")).toHaveLength(1);
  });

  it("takes its size and tone as classes", () => {
    const wrapper = mount(IconButton, { props: { label: "Previous", size: "sm", tone: "brand" } });

    expect(wrapper.get("button").classes()).toEqual(expect.arrayContaining(["icon-button--sm", "icon-button--brand"]));
  });
});
