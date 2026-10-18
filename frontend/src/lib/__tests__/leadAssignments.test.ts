import { describe, expect, it } from "vitest";
import type { EventSummary } from "../eventsApi";
import { activeEventsLabel, eventOrganiser, eventTimeLabel, eventWhen, groupByCoordinator, initials, isActiveAssignment } from "../leadAssignments";

function makeEvent(overrides: Partial<EventSummary> = {}): EventSummary {
  return {
    id: 1,
    status: "Planning",
    submitted_details: { name: "Robotics Demo Day", proposedDate: "2099-11-12", venue: "Main Hall" },
    coordinator_id: "COORD-0001",
    coordinator: { name: "Priya Nair" },
    organiser: { name: "Organiser Two" },
    review_outcome: null,
    decided_at: null,
    decided_by: null,
    created_at: "2026-10-08T00:00:00Z",
    ...overrides,
  };
}

describe("isActiveAssignment", () => {
  it.each(["Requested", "Clarification Requested", "Planning", "Safety Review", "Confirmed"])(
    "counts %s with a coordinator",
    (status) => {
      expect(isActiveAssignment(makeEvent({ status }))).toBe(true);
    },
  );

  it.each(["Draft", "Unassigned", "Rejected", "Cancelled", "Completed"])("leaves out %s", (status) => {
    expect(isActiveAssignment(makeEvent({ status }))).toBe(false);
  });

  it("leaves out an event with no coordinator", () => {
    expect(isActiveAssignment(makeEvent({ coordinator_id: null, coordinator: null }))).toBe(false);
  });
});

describe("groupByCoordinator", () => {
  const coordinators = [
    { id: "COORD-0001", name: "Priya Nair" },
    { id: "COORD-0002", name: "Aisha Rahman" },
    { id: "COORD-0003", name: "Joel Chua" },
  ];

  it("keeps coordinators with no events, busiest first then by name", () => {
    const groups = groupByCoordinator(coordinators, [
      makeEvent({ id: 1 }),
      makeEvent({ id: 2 }),
      makeEvent({ id: 3, coordinator_id: "COORD-0002", coordinator: { name: "Aisha Rahman" } }),
    ]);

    expect(groups.map((g) => [g.name, g.events.length])).toEqual([
      ["Priya Nair", 2],
      ["Aisha Rahman", 1],
      ["Joel Chua", 0],
    ]);
  });

  it("orders each coordinator's events soonest first, undated last", () => {
    const groups = groupByCoordinator(coordinators, [
      makeEvent({ id: 1, submitted_details: { name: "Later", proposedDate: "2099-12-01" } }),
      makeEvent({ id: 2, submitted_details: { name: "No date" } }),
      makeEvent({ id: 3, submitted_details: { name: "Sooner", proposedDate: "2099-11-01" } }),
    ]);

    expect(groups[0].events.map((e) => e.id)).toEqual([3, 1, 2]);
  });

  it("still shows a coordinator who holds events but is missing from the list", () => {
    const groups = groupByCoordinator([], [makeEvent({ coordinator_id: "COORD-0099", coordinator: { name: "Former Staff" } })]);

    expect(groups).toEqual([expect.objectContaining({ id: "COORD-0099", name: "Former Staff" })]);
  });
});

describe("formatting", () => {
  it("builds initials from the first and last word", () => {
    expect(initials("Hui Min Tan")).toBe("HT");
    expect(initials("priya nair")).toBe("PN");
    expect(initials("Priya")).toBe("P");
  });

  it("shows date and venue, dropping whichever is missing", () => {
    expect(eventWhen(makeEvent())).toBe("12 Nov, Main Hall");
    expect(eventWhen(makeEvent({ submitted_details: { proposedDate: "2099-11-12" } }))).toBe("12 Nov");
    expect(eventWhen(makeEvent({ submitted_details: { venue: "Main Hall" } }))).toBe("Main Hall");
    expect(eventWhen(makeEvent({ submitted_details: {} }))).toBe("Date to be confirmed");
  });

  it("shows the time range, the start alone, or nothing", () => {
    const at = (details: Record<string, unknown>) => makeEvent({ submitted_details: details });
    expect(eventTimeLabel(at({ startTime: "18:00", endTime: "21:00" }))).toBe("18:00 to 21:00");
    expect(eventTimeLabel(at({ startTime: "18:00" }))).toBe("18:00");
    expect(eventTimeLabel(at({}))).toBeNull();
  });

  it("shows the organiser's name, or null when unknown", () => {
    expect(eventOrganiser(makeEvent())).toBe("Organiser Two");
    expect(eventOrganiser(makeEvent({ organiser: null }))).toBeNull();
  });

  it("pluralises the active event count", () => {
    expect(activeEventsLabel(0)).toBe("0 active events");
    expect(activeEventsLabel(1)).toBe("1 active event");
  });
});
