import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import ChatDrawer from "../ChatDrawer.vue";
import { fetchChatMessages, fetchChatThreads, markChatThreadRead } from "../../../lib/chatApi";

vi.mock("../../../lib/chatApi", async () => {
  const actual = await vi.importActual<typeof import("../../../lib/chatApi")>("../../../lib/chatApi");
  return {
    ...actual,
    fetchChatThreads: vi.fn(),
    fetchChatMessages: vi.fn(),
    markChatThreadRead: vi.fn(),
    sendChatMessage: vi.fn(),
  };
});

const router = createRouter({
  history: createMemoryHistory(),
  routes: [{ path: "/", component: { template: "<div/>" } }],
});

const thread = {
  eventId: 7,
  eventName: "Book Club Panel",
  status: "Planning",
  otherParty: "Benny",
  lastMessage: null,
  unreadCount: 0,
};

let wrapper: ReturnType<typeof mount> | null = null;

async function mountDrawer() {
  const outside = document.createElement("button");
  outside.id = "outside";
  document.body.appendChild(outside);
  wrapper = mount(ChatDrawer, { attachTo: document.body, global: { plugins: [router] } });
  await router.isReady();
  await flushPromises();
  return wrapper;
}

const pointerDown = (el: Element) => el.dispatchEvent(new Event("pointerdown", { bubbles: true }));
const panel = () => document.querySelector(".panel");

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchChatThreads).mockResolvedValue([thread]);
  vi.mocked(fetchChatMessages).mockResolvedValue({
    event: { id: 7, name: "Book Club Panel" },
    messages: [],
    unreadCount: 0,
    hasMore: false,
    nextBefore: null,
  } as never);
  vi.mocked(markChatThreadRead).mockResolvedValue(undefined as never);
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = "";
});

describe("ChatDrawer — closing", () => {
  it("closes when the page outside it is clicked", async () => {
    const w = await mountDrawer();
    await w.get(".tab").trigger("click");
    expect(panel()).not.toBeNull();

    pointerDown(document.getElementById("outside")!);
    await flushPromises();

    expect(panel()).toBeNull();
  });

  it("stays open when something inside the panel is clicked", async () => {
    const w = await mountDrawer();
    await w.get(".tab").trigger("click");

    pointerDown(panel()!);
    pointerDown(document.querySelector(".thread-row")!);
    await flushPromises();

    expect(panel()).not.toBeNull();
  });

  it("still toggles from its own icon, without closing and reopening", async () => {
    const w = await mountDrawer();

    await w.get(".tab").trigger("click");
    expect(panel()).not.toBeNull();

    pointerDown(w.get(".tab").element);
    await w.get(".tab").trigger("click");
    await flushPromises();

    expect(panel()).toBeNull();
  });

  it("closes on Escape and puts focus back on the icon", async () => {
    const w = await mountDrawer();
    await w.get(".tab").trigger("click");

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flushPromises();

    expect(panel()).toBeNull();
    expect(document.activeElement).toBe(w.get(".tab").element);
  });

  it("keeps an unsent message when it is closed and reopened", async () => {
    const w = await mountDrawer();
    await w.get(".tab").trigger("click");
    await w.get(".thread-row").trigger("click");
    await flushPromises();
    await w.get("textarea").setValue("hello there");

    pointerDown(document.getElementById("outside")!);
    await flushPromises();
    await w.get(".tab").trigger("click");
    await flushPromises();

    expect((w.get("textarea").element as HTMLTextAreaElement).value).toBe("hello there");
  });
});
