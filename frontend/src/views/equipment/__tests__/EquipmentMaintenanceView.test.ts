import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import EquipmentMaintenanceView from "../EquipmentMaintenanceView.vue";
import EquipmentUnitsPanel from "../../components/equipment/EquipmentUnitsPanel.vue";

describe("EquipmentMaintenanceView", () => {
  it("is its own page: a title, and the out-of-use panel", () => {
    // The panel has its own tests and loads its own data.
    const wrapper = mount(EquipmentMaintenanceView, { global: { stubs: { EquipmentUnitsPanel: true } } });

    expect(wrapper.find("h1").text()).toBe("Equipment maintenance");
    expect(wrapper.findComponent(EquipmentUnitsPanel).exists()).toBe(true);
  });
});
