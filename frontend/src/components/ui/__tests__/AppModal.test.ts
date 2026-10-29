import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import AppModal from "../AppModal.vue";

const mountModal = (props: Record<string, unknown> = {}) =>
  mount(AppModal, {
    props,
    slots: { title: "Delete draft?", default: "<p>It will be removed.</p>", actions: "<button>Delete</button>" },
    attachTo: document.body,
  });

describe("AppModal", () => {
  it("names the dialog by its title and shows the content and actions", () => {
    const wrapper = mountModal({ role: "alertdialog" });
    const dialog = wrapper.get("[role='alertdialog']");
    const titleId = wrapper.get(".modal-title").attributes("id");

    expect(dialog.attributes("aria-modal")).toBe("true");
    expect(dialog.attributes("aria-labelledby")).toBe(titleId);
    expect(wrapper.text()).toContain("It will be removed.");
    expect(wrapper.get(".modal-actions").text()).toBe("Delete");
    wrapper.unmount();
  });

  it("closes on a click on the scrim, but not on a click inside the panel", async () => {
    const wrapper = mountModal();

    await wrapper.get(".modal").trigger("click");
    expect(wrapper.emitted("close")).toBeUndefined();

    await wrapper.get(".modal-overlay").trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
    wrapper.unmount();
  });

  it("closes on Escape", () => {
    const wrapper = mountModal();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(wrapper.emitted("close")).toHaveLength(1);
    wrapper.unmount();
  });

  it("ignores the scrim and Escape while it is not dismissible", async () => {
    const wrapper = mountModal({ dismissible: false });

    await wrapper.get(".modal-overlay").trigger("click");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(wrapper.emitted("close")).toBeUndefined();
    wrapper.unmount();
  });

  it("stops listening for Escape once it is unmounted", () => {
    const wrapper = mountModal();
    wrapper.unmount();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(wrapper.emitted("close")).toBeUndefined();
  });

  it("uses the size class it is given", () => {
    const wrapper = mountModal({ size: "lg" });

    expect(wrapper.get(".modal").classes()).toContain("modal--lg");
    wrapper.unmount();
  });
});
