import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import AuthSplitLayout from "../AuthSplitLayout.vue";

describe("AuthSplitLayout", () => {
  it("renders the form content beside a decorative graphic", () => {
    const wrapper = mount(AuthSplitLayout, { slots: { default: "<form id='f'>Hello</form>" } });

    expect(wrapper.get("main #f").text()).toBe("Hello");
    const image = wrapper.get("img");
    expect(image.attributes("alt")).toBe("");
  });

  it("shows the brand headline and tagline on the graphic panel", () => {
    const wrapper = mount(AuthSplitLayout);

    expect(wrapper.get(".split__headline").text()).toBe("Less admin.More event.");
    expect(wrapper.get(".split__headline").findAll("br")).toHaveLength(1);
    expect(wrapper.get(".split__tagline").text()).toContain("one place.");
    expect(wrapper.get(".split__tagline").findAll("br")).toHaveLength(1);
  });
});
