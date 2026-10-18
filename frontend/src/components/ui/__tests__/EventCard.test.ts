import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";
import { createMemoryHistory, createRouter } from "vue-router";
import { h } from "vue";
import EventCard from "../EventCard.vue";

const router = createRouter({
  history: createMemoryHistory(),
  routes: [
    { path: "/", component: { render: () => h("div") } },
    { path: "/events/:id", name: "event", component: { render: () => h("div") } },
  ],
});

function mountCard(props: Record<string, unknown> = {}, slots: Record<string, string> = {}) {
  return mount(EventCard, {
    props: {
      to: { name: "event", params: { id: 7 } },
      thumbnail: "/thumb.jpg",
      title: "Freshman Orientation Fair",
      statusLabel: "Requested",
      statusClass: "status-warning",
      ...props,
    },
    slots,
    global: { plugins: [router] },
  });
}

describe("EventCard", () => {
  it("is one link to the event, with the thumbnail, title and status badge", () => {
    const wrapper = mountCard();

    expect(wrapper.element.tagName).toBe("A");
    expect(wrapper.attributes("href")).toBe("/events/7");
    expect(wrapper.find("img.card-thumbnail").attributes("src")).toBe("/thumb.jpg");
    expect(wrapper.find("h2.card-title").text()).toBe("Freshman Orientation Fair");
    const badge = wrapper.find(".badge");
    expect(badge.text()).toBe("Requested");
    expect(badge.classes()).toContain("status-warning");
  });

  it("puts a dot on the status badge by default, and can leave it off", () => {
    expect(mountCard().find(".badge__dot").exists()).toBe(true);
    expect(mountCard({ dot: false }).find(".badge__dot").exists()).toBe(false);
  });

  it("shows extra badges beside the status", () => {
    const wrapper = mountCard({ extraBadges: ["Registration Required"] });

    expect(wrapper.findAll(".badge").map((b) => b.text())).toEqual(["Requested", "Registration Required"]);
  });

  it("shows a description under the title only when one is given", () => {
    expect(mountCard().find(".card-description").exists()).toBe(false);
    expect(mountCard({ description: null }).find(".card-description").exists()).toBe(false);
    expect(mountCard({ description: "Meet clubs and new friends." }).find(".card-description").text()).toBe(
      "Meet clubs and new friends.",
    );
  });

  it("lists the facts, with date and time able to share one line", () => {
    const wrapper = mountCard({
      facts: [
        { icon: "calendar", text: "14 Nov 2026 · 10:00 AM to 4:00 PM" },
        { icon: "pin", text: "Great Lawn" },
      ],
    });

    const facts = wrapper.findAll(".fact");
    expect(facts.map((f) => f.text())).toEqual(["14 Nov 2026 · 10:00 AM to 4:00 PM", "Great Lawn"]);
    expect(facts[0].findAll("svg")).toHaveLength(1);
  });

  it("marks an alert fact and clamps a long one, and forwards a test id", () => {
    const wrapper = mountCard({
      facts: [
        { icon: "people", text: "Full", alert: true, testid: "slots-left" },
        { icon: "accessibility", text: "Step-free entry and a hearing loop.", clamp: true },
      ],
    });

    const alert = wrapper.find("[data-testid='slots-left']");
    expect(alert.classes()).toContain("fact--alert");
    expect(wrapper.findAll(".fact")[1].classes()).toContain("fact--clamp");
  });

  it("puts an aside (places left) at the right end of the title row, outside the facts", () => {
    const wrapper = mountCard({
      facts: [{ icon: "calendar", text: "14 Nov 2026" }],
      titleAside: { icon: "people", text: "Full", alert: true, testid: "slots-left" },
    });

    const aside = wrapper.find(".card-title-row [data-testid='slots-left']");
    expect(aside.text()).toBe("Full");
    expect(aside.classes()).toContain("card-aside--alert");
    expect(wrapper.find(".card-title-row .card-title").exists()).toBe(true);
    expect(wrapper.findAll(".fact")).toHaveLength(1);
  });

  it("has no aside by default", () => {
    expect(mountCard().find(".card-aside").exists()).toBe(false);
  });

  describe("person line", () => {
    it("says who is in charge, with their initial", () => {
      const wrapper = mountCard({ personLabel: "Organiser", personName: "Pat Organiser" });

      expect(wrapper.find(".card-person").text()).toContain("Organiser: Pat Organiser");
      expect(wrapper.find(".person-avatar").text()).toBe("P");
    });

    it("uses the empty text when there is no name, with no avatar", () => {
      const wrapper = mountCard({ personLabel: "Coordinator", personName: null, personEmpty: "Unassigned" });

      expect(wrapper.find(".card-person").text()).toBe("Coordinator: Unassigned");
      expect(wrapper.find(".person-avatar").exists()).toBe(false);
    });

    it("is hidden when there is no name and no empty text, or no label", () => {
      expect(mountCard({ personLabel: "Organiser", personName: null }).find(".card-person").exists()).toBe(false);
      expect(mountCard({ personName: "Pat" }).find(".card-person").exists()).toBe(false);
    });

    it("sits below the divider, in the footer", () => {
      const wrapper = mountCard({ personLabel: "Organiser", personName: "Pat Organiser" });

      expect(wrapper.find(".card-divider").exists()).toBe(true);
      expect(wrapper.find(".card-footer .card-person").exists()).toBe(true);
    });
  });

  describe("footer", () => {
    it("has no divider or footer without a person, meta or actions", () => {
      const wrapper = mountCard({ facts: [{ icon: "pin", text: "Great Lawn" }] });

      expect(wrapper.find(".card-divider").exists()).toBe(false);
      expect(wrapper.find(".card-footer").exists()).toBe(false);
    });

    it("shows the meta line under a divider", () => {
      const wrapper = mountCard({ meta: "Submitted: 12/10/2026" });

      expect(wrapper.find(".card-divider").exists()).toBe(true);
      expect(wrapper.find(".card-footer__meta").text()).toBe("Submitted: 12/10/2026");
    });

    it("renders footer actions from the slot", () => {
      const wrapper = mountCard({}, { "footer-actions": "<button class='delete'>Delete</button>" });

      expect(wrapper.find(".card-footer__actions .delete").text()).toBe("Delete");
      expect(wrapper.find(".card-divider").exists()).toBe(true);
    });
  });
});
