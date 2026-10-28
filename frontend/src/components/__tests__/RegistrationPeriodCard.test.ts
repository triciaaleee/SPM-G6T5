import { describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import RegistrationPeriodCard from "../RegistrationPeriodCard.vue";

const DETAILS = { proposedDate: "2026-12-20", startTime: "09:00", endTime: "17:00", expectedAttendance: 100, registrationNeeded: true };
const NOW = new Date("2026-11-01T00:00:00+08:00");

function mountCard(props: Record<string, unknown> = {}) {
  return mount(RegistrationPeriodCard, {
    props: { status: "Confirmed", details: DETAILS, openDate: "2026-11-15", override: "NONE", registeredCount: 0, now: NOW, ...props },
  });
}

describe("RegistrationPeriodCard (organiser)", () => {
  it("shows Not open yet, the open date and the automatic close time before the open date", () => {
    const wrapper = mountCard();
    expect(wrapper.get('[data-testid="registration-period-state"]').text()).toBe("Not open yet");
    expect(wrapper.get('[data-testid="registration-period-opens"]').text()).toContain("November 15, 2026");
    expect(wrapper.get('[data-testid="registration-period-closes"]').text()).toContain("December 15, 2026 at 09:00");
  });

  it("shows Open from the open date until the cutoff", () => {
    const wrapper = mountCard({ now: new Date("2026-11-20T00:00:00+08:00") });
    expect(wrapper.get('[data-testid="registration-period-state"]').text()).toBe("Open");
  });

  it("shows Full once the registered count reaches the expected attendance", () => {
    const wrapper = mountCard({ now: new Date("2026-11-20T00:00:00+08:00"), registeredCount: 100 });
    expect(wrapper.get('[data-testid="registration-period-state"]').text()).toBe("Full");
  });

  it("shows Closed inside the last 5 days, and Closed again once the coordinator closes it", () => {
    expect(mountCard({ now: new Date("2026-12-16T00:00:00+08:00") }).get('[data-testid="registration-period-state"]').text()).toBe("Closed");
    const forced = mountCard({ now: new Date("2026-11-20T00:00:00+08:00"), override: "FORCE_CLOSED" });
    expect(forced.get('[data-testid="registration-period-state"]').text()).toBe("Closed");
    expect(forced.text()).toContain("manually closed");
  });

  it("says the coordinator hasn't set a date when there isn't one", () => {
    expect(mountCard({ openDate: null }).get('[data-testid="registration-period-opens"]').text()).toContain("hasn't set");
  });

  it("explains that registration waits for Confirmed while planning, and is closed in Needs Review", () => {
    expect(mountCard({ status: "Planning" }).get('[data-testid="registration-period-note"]').text()).toContain("once the event is Confirmed");
    const review = mountCard({ status: "Needs Review" });
    expect(review.get('[data-testid="registration-period-state"]').text()).toBe("Closed");
    expect(review.get('[data-testid="registration-period-note"]').text()).toContain("under review");
  });

  it("has no controls", () => {
    expect(mountCard().findAll("button, input")).toHaveLength(0);
  });
});
