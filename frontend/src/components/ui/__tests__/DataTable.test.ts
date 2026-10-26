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

  it("renders a group-header divider only before the first row of each new group", () => {
    const grouped = [
      { id: 1, name: "First", note: "a" },
      { id: 2, name: "Second", note: "b" },
      { id: 3, name: "Third", note: "c" },
    ];
    const wrapper = mount(DataTable, {
      props: {
        columns,
        columnWidths: "10rem 5rem",
        rows: grouped,
        rowKey: (r: unknown) => (r as Row).id,
        rowGroup: (r: unknown) => ({ key: (r as Row).name === "Third" ? "b" : "a", label: "Group", count: 1 }),
      },
      slots: {
        "cell-name": `<template #cell-name="{ row }">{{ row.name }}</template>`,
        "cell-note": `<template #cell-note="{ row }">{{ row.note }}</template>`,
        "group-header": `<template #group-header="{ group }"><span class="hdr">{{ group.key }}</span></template>`,
      },
      global: { plugins: [router] },
    });

    const headers = wrapper.findAll(".row-group-header .hdr").map((h) => h.text());
    expect(headers).toEqual(["a", "b"]);
  });

  it("applies rowClass to each row when given, alongside row--link", () => {
    const wrapper = mountTable({
      rowTo: (r: Row) => ({ name: "item", params: { id: r.id } }),
      rowClass: (r: Row) => ({ "row--flagged": r.name === "Second" }),
    });

    const dataRows = wrapper.findAll(".row:not(.row--header)");
    expect(dataRows[0].classes()).not.toContain("row--flagged");
    expect(dataRows[1].classes()).toContain("row--flagged");
    expect(dataRows[1].classes()).toContain("row--link");
  });

  it("sets data-testid from rowTestId when given", () => {
    const wrapper = mountTable({ rowTestId: (r: Row) => `row-${r.id}` });

    expect(wrapper.find("[data-testid='row-1']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='row-2']").exists()).toBe(true);
  });

  it("renders the row-detail slot right after a row when rowDetail says so, and not otherwise", () => {
    const wrapper = mount(DataTable, {
      props: {
        columns,
        columnWidths: "10rem 5rem",
        rows,
        rowKey: (r: unknown) => (r as Row).id,
        rowDetail: (r: unknown) => (r as Row).id === 2,
      },
      slots: {
        "cell-name": `<template #cell-name="{ row }">{{ row.name }}</template>`,
        "cell-note": `<template #cell-note="{ row }">{{ row.note }}</template>`,
        "row-detail": `<template #row-detail="{ row }"><p class="detail">Detail for {{ row.name }}</p></template>`,
      },
      global: { plugins: [router] },
    });

    expect(wrapper.find(".row-detail .detail").text()).toBe("Detail for Second");
    expect(wrapper.findAll(".row-detail")).toHaveLength(1);
    // It sits right after "Second"'s row, not "First"'s.
    const items = wrapper.findAll("li");
    const secondIndex = items.findIndex((li) => li.text().includes("Secondb"));
    expect(items[secondIndex + 1].classes()).toContain("row-detail");
  });
});
