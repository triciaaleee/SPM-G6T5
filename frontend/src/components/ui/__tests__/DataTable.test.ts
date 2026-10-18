import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import DataTable from "../DataTable.vue";

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", component: { template: "<div/>" } },
    { path: "/items/:id", name: "item", component: { template: "<div/>" } },
  ],
});

const columns = [
  { key: "name", label: "Name" },
  { key: "note", label: "Note", hideOnNarrow: true },
];
const rows = [
  { id: 1, name: "First", note: "a" },
  { id: 2, name: "Second", note: "b" },
];

type Row = (typeof rows)[number];

function mountTable(props: Record<string, unknown> = {}) {
  return mount(DataTable, {
    props: { columns, columnWidths: "10rem 5rem", rows, rowKey: (r: unknown) => (r as Row).id, ...props },
    slots: {
      "cell-name": `<template #cell-name="{ row }"><strong>{{ row.name }}</strong></template>`,
      "cell-note": `<template #cell-note="{ row }">{{ row.note }}</template>`,
    },
    global: { plugins: [router] },
  });
}

describe("DataTable", () => {
  it("renders a header row of labels and one row per item, filled from the cell slots", () => {
    const wrapper = mountTable();

    expect(wrapper.findAll(".cell-header").map((h) => h.text())).toEqual(["Name", "Note"]);
    const dataRows = wrapper.findAll(".row:not(.row--header)");
    expect(dataRows.map((r) => r.text())).toEqual(["Firsta", "Secondb"]);
    expect(dataRows[0].find("strong").text()).toBe("First");
  });

  it("applies the column widths to every row", () => {
    const wrapper = mountTable();

    expect(wrapper.find(".rows").attributes("style")).toContain("--table-columns: 10rem 5rem");
  });

  it("marks columns that hide on narrow screens, in the header and every row", () => {
    const wrapper = mountTable();

    expect(wrapper.findAll(".cell--narrow-hidden")).toHaveLength(3);
  });

  it("renders plain rows by default and link rows when rowTo is given", () => {
    expect(mountTable().find("a").exists()).toBe(false);

    const linked = mountTable({ rowTo: (r: Row) => ({ name: "item", params: { id: r.id } }) });
    const links = linked.findAll("a.row--link");
    expect(links.map((l) => l.attributes("href"))).toEqual(["/items/1", "/items/2"]);
  });
});
