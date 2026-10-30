import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { h } from "vue";
import NewEventRequestView from "../NewEventRequestView.vue";
import { submitEventRequest, ValidationError, type EventSummary } from "../../../lib/eventsApi";

vi.mock("../../../lib/eventsApi", () => {
  class ValidationError extends Error {
    fields: Record<string, string>;
    constructor(fields: Record<string, string>) {
      super("Validation failed");
      this.fields = fields;
    }
  }
  return {
    ValidationError,
    submitEventRequest: vi.fn(),
    saveDraft: vi.fn(),
    updateDraft: vi.fn(),
    updateEventDetails: vi.fn(),
    fetchEventById: vi.fn(),
  };
});

const mockedSubmit = vi.mocked(submitEventRequest);

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", name: "events-list", component: { render: () => h("div") } },
    { path: "/events/new", name: "new-event-request", component: { render: () => h("div") } },
    { path: "/events/:id", name: "event-detail", component: { render: () => h("div") } },
  ],
});

function mountForm() {
  return mount(NewEventRequestView, { global: { plugins: [router] } });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("NewEventRequestView", () => {
  it("shows the request form with a link back to my events", async () => {
    const wrapper = mountForm();
    await flushPromises();

    expect(wrapper.get("h1").text()).toBe("Submit an event request");
    expect(wrapper.get(".back-link").attributes("href")).toBe("/");
    expect(wrapper.find("form").exists()).toBe(true);
  });

  it("flags each field the server rejects, with its message, and leaves the others alone", async () => {
    mockedSubmit.mockRejectedValue(new ValidationError({ name: "Event name is required." }));
    const wrapper = mountForm();
    await flushPromises();

    await wrapper.get("form").trigger("submit");
    await flushPromises();

    expect(wrapper.get("#name").attributes("aria-invalid")).toBe("true");
    expect(wrapper.get("#name-error").text()).toBe("Event name is required.");
    expect(wrapper.get("#purpose").attributes("aria-invalid")).toBe("false");
    expect(wrapper.find("#purpose-error").exists()).toBe(false);
  });

  it("sends registrationNeeded as true once Yes is chosen", async () => {
    mockedSubmit.mockResolvedValue({ id: 9 } as EventSummary);
    const wrapper = mountForm();
    await flushPromises();

    const yes = wrapper.findAll(".toggle-btn").find((b) => b.text() === "Yes")!;
    await yes.trigger("click");
    await wrapper.get("form").trigger("submit");
    await flushPromises();

    expect(mockedSubmit).toHaveBeenCalledWith(expect.objectContaining({ registrationNeeded: true }));
    expect(wrapper.text()).toContain("Request submitted");
  });
});
