import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { h } from "vue";
import NotificationBell from "../NotificationBell.vue";
import { fetchNotifications, markNotificationsRead, type AppNotification } from "../../../lib/notificationsApi";

vi.mock("../../../lib/notificationsApi", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/notificationsApi")>("../../../lib/notificationsApi");
  return {
    ...actual,
    fetchNotifications: vi.fn(),
    markNotificationsRead: vi.fn(),
  };
});

const mockedFetch = vi.mocked(fetchNotifications);
const mockedMarkRead = vi.mocked(markNotificationsRead);

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", component: { render: () => h("div") } },
    { path: "/notifications", name: "notifications", component: { render: () => h("div") } },
  ],
});

function notification(id: number): AppNotification {
  return {
    id,
    type: "event.approved",
    title: `Update ${id}`,
    body: "Something changed",
    link: null,
    eventId: null,
    read: false,
    createdAt: new Date().toISOString(),
  };
}

let wrapper: ReturnType<typeof mount> | null = null;

async function mountBell() {
  await router.push("/");
  await router.isReady();
  // The toast is teleported to <body>, so the bell has to be in the real document.
  wrapper = mount(NotificationBell, { global: { plugins: [router] }, attachTo: document.body });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedFetch.mockResolvedValue({ notifications: [notification(2), notification(1)], unreadCount: 2, nextCursor: null });
  mockedMarkRead.mockResolvedValue();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe("NotificationBell — the 'You have unread notifications' toast", () => {
  it("shows the toast on load, and View goes to the notifications page", async () => {
    await mountBell();

    const toast = document.body.querySelector(".toast");
    expect(toast?.textContent).toContain("You have 2 unread notifications");

    document.body.querySelector<HTMLButtonElement>(".toast__action")!.click();
    await flushPromises();

    expect(router.currentRoute.value.name).toBe("notifications");
    expect(document.body.querySelector(".toast")).toBeNull();
    // It goes to the page, not the dropdown, and leaves reading to the page.
    expect(wrapper!.find(".dropdown").exists()).toBe(false);
    expect(mockedMarkRead).not.toHaveBeenCalled();
  });

  it("the dropdown's See more still goes to the same page", async () => {
    await mountBell();

    await wrapper!.find(".bell__button").trigger("click");
    await flushPromises();
    const seeMore = wrapper!.findAll(".dropdown__footer button").find((b) => b.text() === "See more")!;
    await router.push("/");
    await seeMore.trigger("click");
    await flushPromises();

    expect(router.currentRoute.value.name).toBe("notifications");
  });
});
