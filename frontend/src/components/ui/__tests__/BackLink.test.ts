import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { h } from "vue";
import BackLink from "../BackLink.vue";

const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: "/lead", component: { render: () => h("div") } }],
});

const options = (props: Record<string, unknown> = {}, text = "Back") => ({
  props,
  slots: { default: text },
  global: { plugins: [router] },
});

describe("BackLink", () => {
  it("is a router link when given a route", () => {
    const wrapper = mount(BackLink, options({ to: "/lead" }, "Back to overview"));

    expect(wrapper.get("a.back-link").attributes("href")).toBe("/lead");
    expect(wrapper.text()).toBe("Back to overview");
  });

  it("is a plain anchor when given an href", () => {
    const wrapper = mount(BackLink, options({ href: "/events/4" }, "Back to Gala"));

    expect(wrapper.get("a.back-link").attributes("href")).toBe("/events/4");
  });

  it("is a button that passes the click on when it has no destination", async () => {
    const wrapper = mount(BackLink, options());

    await wrapper.get("button.back-link").trigger("click");

    expect(wrapper.emitted("click")).toHaveLength(1);
  });
});
