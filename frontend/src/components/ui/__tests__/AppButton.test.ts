import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { h } from "vue";
import AppButton from "../AppButton.vue";

const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: "/", component: { render: () => h("div") } }, { path: "/go", name: "go", component: { render: () => h("div") } }],
});

function mountButton(props: Record<string, unknown> = {}, attrs: Record<string, unknown> = {}) {
  return mount(AppButton, {
    props,
    attrs,
    slots: { default: "Save" },
    global: { plugins: [router] },
  });
}

describe("AppButton", () => {
  it("renders a primary, medium <button type=button> by default", () => {
    const wrapper = mountButton();

    expect(wrapper.element.tagName).toBe("BUTTON");
    expect(wrapper.attributes("type")).toBe("button");
    expect(wrapper.classes()).toEqual(expect.arrayContaining(["btn", "btn--primary", "btn--md"]));
    expect(wrapper.text()).toBe("Save");
  });

  it.each(["primary", "outline", "ghost", "danger", "danger-solid"] as const)("has a %s variant class", (variant) => {
    expect(mountButton({ variant }).classes()).toContain(`btn--${variant}`);
  });

  it("has an extra-large size for a page's main call to action", () => {
    expect(mountButton({ size: "xl" }).classes()).toContain("btn--xl");
  });

  it("supports the small size and block width", () => {
    const wrapper = mountButton({ size: "sm", block: true });

    expect(wrapper.classes()).toEqual(expect.arrayContaining(["btn--sm", "btn--block"]));
  });

  it("emits click", async () => {
    const wrapper = mountButton();

    await wrapper.trigger("click");
    expect(wrapper.emitted("click")).toHaveLength(1);
  });

  it("is a real disabled button that does not click", async () => {
    const wrapper = mountButton({ disabled: true });

    expect(wrapper.attributes("disabled")).toBeDefined();
    expect(wrapper.classes()).toContain("btn--disabled");
  });

  it("can submit a form it is not inside of, through forwarded attributes", () => {
    const wrapper = mountButton({ type: "submit" }, { form: "my-form", "aria-label": "Save it" });

    expect(wrapper.attributes("type")).toBe("submit");
    expect(wrapper.attributes("form")).toBe("my-form");
    expect(wrapper.attributes("aria-label")).toBe("Save it");
  });

  it("renders a link styled as a button when given a route", () => {
    const wrapper = mountButton({ to: { name: "go" }, variant: "outline" });

    expect(wrapper.element.tagName).toBe("A");
    expect(wrapper.attributes("href")).toBe("/go");
    expect(wrapper.classes()).toEqual(expect.arrayContaining(["btn", "btn--outline"]));
  });

  it("takes a disabled link out of keyboard focus and marks it disabled", () => {
    const wrapper = mountButton({ to: "/go", disabled: true });

    expect(wrapper.attributes("aria-disabled")).toBe("true");
    expect(wrapper.attributes("tabindex")).toBe("-1");
  });
});
