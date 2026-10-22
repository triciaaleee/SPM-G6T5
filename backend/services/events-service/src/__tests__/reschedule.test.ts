import { afterEach, describe, expect, it, vi } from "vitest";
import { announceReschedule, scheduleChanged, scheduleOf } from "../lib/reschedule.js";
import { setPublisherForTest } from "../lib/rabbitPublisher.js";

afterEach(() => setPublisherForTest(undefined));

describe("scheduleChanged", () => {
  const base = { proposedDate: "2099-01-01", startTime: "09:00", endTime: "11:00", venue: "Main Hall" };

  it("is true when the date, start time or end time differs", () => {
    expect(scheduleChanged(base, { ...base, proposedDate: "2099-01-02" })).toBe(true);
    expect(scheduleChanged(base, { ...base, startTime: "10:00" })).toBe(true);
    expect(scheduleChanged(base, { ...base, endTime: "12:00" })).toBe(true);
  });

  it("is false for any other change", () => {
    expect(scheduleChanged(base, { ...base, venue: "Other Hall" })).toBe(false);
  });

  it("treats a missing time and an empty one as the same", () => {
    expect(scheduleChanged({ proposedDate: "2099-01-01" }, { proposedDate: "2099-01-01", startTime: "", endTime: null })).toBe(false);
  });

  it("is true when a time is added or removed", () => {
    expect(scheduleChanged({ proposedDate: "2099-01-01" }, { proposedDate: "2099-01-01", startTime: "09:00" })).toBe(true);
  });
});

describe("scheduleOf", () => {
  it("reads only the three schedule fields, null when absent", () => {
    expect(scheduleOf({ proposedDate: "2099-01-01", startTime: " ", venue: "x" })).toEqual({
      proposedDate: "2099-01-01",
      startTime: null,
      endTime: null,
    });
  });
});

describe("announceReschedule", () => {
  it("publishes event.rescheduled with the new schedule, and still resolves when the outbox is unavailable", async () => {
    const publish = vi.fn().mockResolvedValue(true);
    setPublisherForTest({ publish });
    const supabase = { from: vi.fn(() => { throw new Error("no outbox"); }) } as never;

    const ok = await announceReschedule(supabase, {
      id: 7,
      actorId: "ORG-0001",
      eventName: "Spring Gala",
      coordinatorId: "COORD-0001",
      details: { proposedDate: "2099-02-02", startTime: "13:00", endTime: "15:00" },
    });

    expect(ok).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });

  it("publishes directly when the outbox insert fails", async () => {
    const publish = vi.fn().mockResolvedValue(true);
    setPublisherForTest({ publish });
    const single = vi.fn().mockResolvedValue({ data: null, error: { message: "boom" } });
    const supabase = { from: vi.fn(() => ({ insert: () => ({ select: () => ({ single }) }) })) } as never;

    const ok = await announceReschedule(supabase, {
      id: 7,
      actorId: "ORG-0001",
      eventName: "Spring Gala",
      coordinatorId: "COORD-0001",
      details: { proposedDate: "2099-02-02", startTime: "13:00", endTime: "15:00" },
    });

    expect(ok).toBe(true);
    expect(publish).toHaveBeenCalledWith({
      type: "event.rescheduled",
      eventId: 7,
      actorId: "ORG-0001",
      recipients: { userIds: [], roles: [] },
      data: { eventName: "Spring Gala", coordinatorId: "COORD-0001", proposedDate: "2099-02-02", startTime: "13:00", endTime: "15:00" },
    });
  });
});
