import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import StatusBadge from "../StatusBadge.vue";

describe("StatusBadge", () => {
  it("shows its text as a badge carrying the tone class it is given", () => {
    const wrapper = mount(StatusBadge, { props: { statusClass: "status-success" }, slots: { default: "Approved" } });

    expect(wrapper.text()).toBe("Approved");
    expect(wrapper.classes()).toEqual(expect.arrayContaining(["badge", "status-success"]));
  });
});
