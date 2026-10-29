import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import PaginationBar from "../PaginationBar.vue";

function mountBar(page: number, total: number, pageSize = 20) {
  return mount(PaginationBar, { props: { page, pageSize, total } });
}

/** The page buttons and gaps, left to right, as the user reads them. */
const sequence = (wrapper: ReturnType<typeof mountBar>) =>
  wrapper.findAll(".pagination__page, .pagination__gap").map((el) => el.text());

const summary = (wrapper: ReturnType<typeof mountBar>) =>
  wrapper.get("[data-testid='pagination-summary']").text();

describe("PaginationBar", () => {
  it("renders nothing when everything fits on one page", () => {
    expect(mountBar(1, 20).find("nav").exists()).toBe(false);
    expect(mountBar(1, 0).find("nav").exists()).toBe(false);
    expect(mountBar(1, 21).find("nav").exists()).toBe(true);
  });

  it("says which rows are showing, on the first, a middle and the last page", () => {
    expect(summary(mountBar(1, 47))).toBe("Showing 1–20 of 47");
    expect(summary(mountBar(2, 47))).toBe("Showing 21–40 of 47");
    expect(summary(mountBar(3, 47))).toBe("Showing 41–47 of 47");
  });

  it("names what it is counting when given a noun", () => {
    const wrapper = mount(PaginationBar, { props: { page: 2, pageSize: 10, total: 24, noun: "events" } });

    expect(summary(wrapper)).toBe("Showing 11–20 of 24 events");
  });

  it("disables Previous on the first page and Next on the last", () => {
    const first = mountBar(1, 47);
    expect(first.get("[data-testid='pagination-prev']").attributes("disabled")).toBeDefined();
    expect(first.get("[data-testid='pagination-next']").attributes("disabled")).toBeUndefined();

    const last = mountBar(3, 47);
    expect(last.get("[data-testid='pagination-prev']").attributes("disabled")).toBeUndefined();
    expect(last.get("[data-testid='pagination-next']").attributes("disabled")).toBeDefined();
  });

  it("emits the new page for Next, Previous and a numbered page", async () => {
    const wrapper = mountBar(2, 100);

    await wrapper.get("[data-testid='pagination-next']").trigger("click");
    await wrapper.get("[data-testid='pagination-prev']").trigger("click");
    await wrapper.get("[aria-label='Page 5']").trigger("click");

    expect(wrapper.emitted("update:page")).toEqual([[3], [1], [5]]);
  });

  it("does not emit for the page already showing", async () => {
    const wrapper = mountBar(2, 100);

    await wrapper.get("[aria-label='Page 2']").trigger("click");

    expect(wrapper.emitted("update:page")).toBeUndefined();
  });

  it("marks the current page with aria-current", () => {
    const current = mountBar(3, 100).findAll("[aria-current='page']");

    expect(current).toHaveLength(1);
    expect(current[0].text()).toBe("3");
  });

  it("shows every page when there are few", () => {
    expect(sequence(mountBar(1, 60))).toEqual(["1", "2", "3"]);
    expect(sequence(mountBar(2, 100))).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("collapses a long range to the ends and the pages around the current one", () => {
    // 12 pages
    expect(sequence(mountBar(1, 240))).toEqual(["1", "2", "…", "12"]);
    expect(sequence(mountBar(6, 240))).toEqual(["1", "…", "5", "6", "7", "…", "12"]);
    expect(sequence(mountBar(12, 240))).toEqual(["1", "…", "11", "12"]);
  });

  it("shows a single hidden page rather than an ellipsis for it", () => {
    // 6 pages, on page 4
    expect(sequence(mountBar(4, 120))).toEqual(["1", "2", "3", "4", "5", "6"]);
  });

  it("clamps a page that is out of range", () => {
    const wrapper = mountBar(99, 47);

    expect(summary(wrapper)).toBe("Showing 41–47 of 47");
    expect(wrapper.get("[aria-current='page']").text()).toBe("3");
  });
});
