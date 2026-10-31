import { describe, expect, it } from "vitest";
import { renderNotification } from "../lib/messageTemplates.js";
import type { InboundMessage } from "../lib/rabbitConsumer.js";

function buildMsg(type: string, data: Record<string, unknown>, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    messageId: "11111111-1111-1111-1111-111111111111",
    type,
    occurredAt: "2026-10-10T08:15:00Z",
    publisher: "test",
    actorId: "ACTOR",
    eventId: 7,
    recipients: { userIds: ["ME"], roles: [] },
    data,
    ...overrides,
  };
}

const EVENT = "/events/7";
const ATTENDEE = "/attendee/events/7";
const SUPPORT = "/equipment-requests/event/7";

interface Case {
  type: string;
  name: string;
  data?: Record<string, unknown>;
  to?: string;
  actorId?: string;
  title: string;
  body: string;
  link?: string;
}

/** Every branch of every template, with the exact text a recipient reads. `link` is the event page unless a case says otherwise. */
const CASES: Case[] = [
  // booking.withdrawn
  {
    type: "booking.withdrawn",
    name: "event cancelled",
    data: { venueName: "Hall", eventName: "Gala", reason: "event_cancelled" },
    title: "Hall — booking released",
    body: "Gala was cancelled, so its booking for Hall was released and the venue is free again.",
  },
  {
    type: "booking.withdrawn",
    name: "event rejected",
    data: { venueName: "Hall", eventName: "Gala", reason: "event_rejected" },
    title: "Hall — booking released",
    body: "Gala was rejected, so its booking for Hall was released and the venue is free again.",
  },
  {
    type: "booking.withdrawn",
    name: "coordinator released",
    data: { venueName: "Hall", eventName: "Gala", reason: "coordinator_released" },
    title: "Hall — booking released",
    body: "Hall's booking for Gala was released. The venue is free for this period again.",
  },
  {
    type: "booking.withdrawn",
    name: "coordinator withdrew",
    data: { venueName: "Hall", eventName: "Gala", reason: "coordinator_withdrew" },
    title: "Hall — booking withdrawn",
    body: "Hall's booking for Gala was withdrawn. The venue is free for this period again.",
  },
  {
    type: "booking.withdrawn",
    name: "no names",
    title: "A venue — booking withdrawn",
    body: "A venue's booking for your event was withdrawn. The venue is free for this period again.",
  },

  // booking.decided
  {
    type: "booking.decided",
    name: "approved",
    data: { venueName: "Hall", eventName: "Gala", decision: "approved" },
    title: "Hall — booking approved",
    body: "Hall is approved for Gala.",
  },
  {
    type: "booking.decided",
    name: "approved, no names",
    data: { decision: "approved" },
    title: "The venue — booking approved",
    body: "The venue is approved for your event.",
  },
  {
    type: "booking.decided",
    name: "on hold",
    data: { venueName: "Hall", eventName: "Gala", decision: "on_hold" },
    title: "Hall — booking on hold",
    body: "Hall is on hold for Gala while arrangements are finalised.",
  },
  {
    type: "booking.decided",
    name: "auto rejected with a reason",
    data: { venueName: "Hall", eventName: "Gala", decision: "auto_rejected", reason: "Taken." },
    title: "Venue request for Gala was rejected",
    body: "Hall was booked for another event over the same period, so your request for Gala was rejected: Taken. You can request another venue or another time.",
  },
  {
    type: "booking.decided",
    name: "auto rejected, no reason",
    data: { venueName: "Hall", eventName: "Gala", decision: "auto_rejected" },
    title: "Venue request for Gala was rejected",
    body: "Hall was booked for another event over the same period, so your request for Gala was rejected: You can request another venue or another time.",
  },
  {
    type: "booking.decided",
    name: "rejected with a reason",
    data: { venueName: "Hall", eventName: "Gala", decision: "rejected", reason: "No AV" },
    title: "Hall — booking rejected",
    body: "Hall was rejected for Gala: No AV",
  },
  {
    type: "booking.decided",
    name: "rejected, no reason",
    data: { venueName: "Hall", eventName: "Gala", decision: "rejected" },
    title: "Hall — booking rejected",
    body: "Hall was rejected for Gala:",
  },

  // event.cancelled
  {
    type: "event.cancelled",
    name: "with a reason",
    data: { eventName: "Gala", reason: "Rain" },
    title: "Event cancelled",
    body: "Gala was cancelled (Rain).",
  },
  { type: "event.cancelled", name: "no details", title: "Event cancelled", body: "An event was cancelled." },

  // message.sent
  {
    type: "message.sent",
    name: "with details",
    data: { eventName: "Gala", preview: "Hello" },
    title: "New message about Gala",
    body: "Hello",
  },
  { type: "message.sent", name: "no details", title: "New message about an event", body: "" },

  // coordinator.assigned
  {
    type: "coordinator.assigned",
    name: "to the coordinator",
    to: "C1",
    data: { eventName: "Gala", coordinatorId: "C1", coordinatorName: "Sam" },
    title: "New event assigned to you",
    body: '"Gala" has been assigned to you. You are now its coordinator.',
  },
  {
    type: "coordinator.assigned",
    name: "to the organiser",
    data: { eventName: "Gala", coordinatorId: "C1", coordinatorName: "Sam" },
    title: "Your event has a coordinator",
    body: 'Sam is now the coordinator for "Gala".',
  },
  {
    type: "coordinator.assigned",
    name: "no names",
    title: "Your event has a coordinator",
    body: 'a coordinator is now the coordinator for "an event".',
  },

  // request.submitted
  {
    type: "request.submitted",
    name: "to the organiser",
    to: "O1",
    data: { eventName: "Gala", organiserId: "O1" },
    title: "Request submitted",
    body: 'Your request for "Gala" has been submitted and is waiting for a coordinator.',
  },
  {
    type: "request.submitted",
    name: "to a lead",
    data: { eventName: "Gala", organiserId: "O1" },
    title: "New request in the unassigned queue",
    body: '"Gala" needs a coordinator assigned.',
  },
  {
    type: "request.submitted",
    name: "no name",
    title: "New request in the unassigned queue",
    body: '"A request" needs a coordinator assigned.',
  },

  // coordinator.reassigned
  {
    type: "coordinator.reassigned",
    name: "to the previous coordinator",
    to: "C1",
    data: {
      eventName: "Gala",
      previousCoordinatorId: "C1",
      newCoordinatorId: "C2",
      previousCoordinatorName: "Sam",
      newCoordinatorName: "Alex",
    },
    title: "Event reassigned",
    body: '"Gala" has been reassigned to Alex. You can still view it, but you can no longer act on it.',
  },
  {
    type: "coordinator.reassigned",
    name: "to the new coordinator",
    to: "C2",
    data: {
      eventName: "Gala",
      previousCoordinatorId: "C1",
      newCoordinatorId: "C2",
      previousCoordinatorName: "Sam",
      newCoordinatorName: "Alex",
    },
    title: "Event reassigned to you",
    body: '"Gala" has been reassigned to you from Sam. You are now its coordinator.',
  },
  {
    type: "coordinator.reassigned",
    name: "to the organiser",
    data: {
      eventName: "Gala",
      previousCoordinatorId: "C1",
      newCoordinatorId: "C2",
      previousCoordinatorName: "Sam",
      newCoordinatorName: "Alex",
    },
    title: "Your event has a new coordinator",
    body: 'Alex is now the coordinator for "Gala", taking over from Sam.',
  },
  {
    type: "coordinator.reassigned",
    name: "no names",
    title: "Your event has a new coordinator",
    body: 'a coordinator is now the coordinator for "an event", taking over from the previous coordinator.',
  },

  // safety.decided
  {
    type: "safety.decided",
    name: "approved",
    data: { eventName: "Gala", outcome: "approved" },
    title: "Safety review approved",
    body: '"Gala" passed its Operational Safety Check and is now Confirmed.',
  },
  {
    type: "safety.decided",
    name: "rejected with a reason",
    data: { eventName: "Gala", outcome: "rejected", reason: "Exits blocked" },
    title: "Safety review rejected",
    body: '"Gala" failed its Operational Safety Check and is back in Planning. Reason: Exits blocked',
  },
  {
    type: "safety.decided",
    name: "rejected, no reason",
    data: { eventName: "Gala", outcome: "rejected" },
    title: "Safety review rejected",
    body: '"Gala" failed its Operational Safety Check and is back in Planning. Reason:',
  },
  {
    type: "safety.decided",
    name: "changes requested",
    data: { eventName: "Gala", outcome: "changes_requested", reason: "Move the stage" },
    title: "Safety changes requested",
    body: '"Gala" is back in Planning. The Safety Officer asked for changes — Move the stage',
  },
  {
    type: "safety.decided",
    name: "unknown outcome, no name",
    title: "Safety review decision",
    body: '"Your event" received a safety review decision.',
  },

  // request.edited, clarification.*
  {
    type: "request.edited",
    name: "with a name",
    data: { eventName: "Gala" },
    title: "Request edited",
    body: 'The organiser edited "Gala".',
  },
  { type: "request.edited", name: "no name", title: "Request edited", body: 'The organiser edited "a request".' },
  {
    type: "clarification.requested",
    name: "with details",
    data: { eventName: "Gala", message: "What time?" },
    title: "Clarification requested",
    body: 'Your coordinator has a question about "Gala": What time?',
  },
  {
    type: "clarification.requested",
    name: "no details",
    title: "Clarification requested",
    body: 'Your coordinator has a question about "your request": ',
  },
  {
    type: "clarification.answered",
    name: "with a name",
    data: { eventName: "Gala" },
    title: "Organiser responded to your question",
    body: 'The organiser answered your question about "Gala".',
  },
  {
    type: "clarification.answered",
    name: "no name",
    title: "Organiser responded to your question",
    body: 'The organiser answered your question about "the request".',
  },

  // request.decided
  {
    type: "request.decided",
    name: "approved",
    data: { eventName: "Gala", decision: "approved" },
    title: "Request approved",
    body: '"Gala" was approved and has moved into Planning.',
  },
  {
    type: "request.decided",
    name: "rejected with a reason",
    data: { eventName: "Gala", decision: "rejected", reason: "Too big" },
    title: "Request rejected",
    body: '"Gala" was rejected: Too big',
  },
  { type: "request.decided", name: "rejected, no details", title: "Request rejected", body: '"Your request" was rejected.' },

  // event.needs_review, event.returned_to_planning
  {
    type: "event.needs_review",
    name: "with details",
    data: { eventName: "Gala", reason: "its venue was lost" },
    title: "Gala needs review",
    body: '"Gala" is now Needs Review: its venue was lost. It returns to Confirmed once this is settled.',
  },
  {
    type: "event.needs_review",
    name: "no details",
    title: "An event needs review",
    body: '"An event" is now Needs Review: its arrangements changed. It returns to Confirmed once this is settled.',
  },
  {
    type: "event.returned_to_planning",
    name: "with details",
    data: { eventName: "Gala", reason: "its venue was lost" },
    title: "Gala returned to Planning",
    body: '"Gala" was in Safety Review but its venue was lost. It is back in Planning and must be resubmitted for safety review.',
  },
  {
    type: "event.returned_to_planning",
    name: "no details",
    title: "An event returned to Planning",
    body: '"An event" was in Safety Review but its arrangements changed. It is back in Planning and must be resubmitted for safety review.',
  },

  // safety.submitted
  {
    type: "safety.submitted",
    name: "with a name",
    data: { eventName: "Gala" },
    title: "Submitted for safety review",
    body: '"Gala" has been submitted for its Operational Safety Check.',
  },
  {
    type: "safety.submitted",
    name: "no name",
    title: "Submitted for safety review",
    body: '"An event" has been submitted for its Operational Safety Check.',
  },

  // registration.*
  {
    type: "registration.confirmed",
    name: "with a name",
    data: { eventName: "Gala" },
    title: "Registration confirmed",
    body: 'Your registration for "Gala" is confirmed.',
    link: ATTENDEE,
  },
  {
    type: "registration.confirmed",
    name: "no name",
    title: "Registration confirmed",
    body: 'Your registration for "this event" is confirmed.',
    link: ATTENDEE,
  },
  {
    type: "registration.withdrawn",
    name: "with a name",
    data: { eventName: "Gala" },
    title: "Registration withdrawn",
    body: 'You have withdrawn your registration for "Gala".',
    link: ATTENDEE,
  },
  {
    type: "registration.withdrawn",
    name: "no name",
    title: "Registration withdrawn",
    body: "You have withdrawn your registration.",
    link: ATTENDEE,
  },
  {
    type: "registration.cancelled_by_event",
    name: "with a name",
    data: { eventName: "Gala" },
    title: "Event cancelled",
    body: 'Your registration for "Gala" was cancelled because the event itself was cancelled.',
    link: ATTENDEE,
  },
  {
    type: "registration.cancelled_by_event",
    name: "no name",
    title: "Event cancelled",
    body: "Your registration was cancelled because the event itself was cancelled.",
    link: ATTENDEE,
  },

  // booking.requested, hold.*
  {
    type: "booking.requested",
    name: "with details",
    data: { venueName: "Hall", eventName: "Gala", when: "3 Nov" },
    title: "New booking request for Hall",
    body: "Gala has requested Hall for 3 Nov. Hold, approve or reject it from your booking requests.",
    link: "/venue-requests",
  },
  {
    type: "booking.requested",
    name: "no details",
    title: "New booking request for a venue",
    body: "An event has requested a venue for a date to be confirmed. Hold, approve or reject it from your booking requests.",
    link: "/venue-requests",
  },
  {
    type: "hold.expired",
    name: "with details",
    data: { venueName: "Hall", eventName: "Gala" },
    title: "Hall — hold expired",
    body: "The hold on Hall for Gala expired before it was decided. You can request another venue or another time.",
  },
  {
    type: "hold.expired",
    name: "with the expiry time, shown in Singapore time",
    data: { venueName: "Hall", eventName: "Gala", expiresAt: "2026-10-31T22:04:39.075455+00:00" },
    title: "Hall — hold expired",
    body: "The hold on Hall for Gala expired at 1 Nov 2026, 6:04 am before it was decided. You can request another venue or another time.",
  },
  {
    type: "hold.expired",
    name: "no details",
    title: "The venue — hold expired",
    body: "The hold on the venue for your event expired before it was decided. You can request another venue or another time.",
  },
  {
    type: "hold.expiring",
    name: "with details",
    data: { venueName: "Hall", eventName: "Gala", expiresAt: "5pm" },
    title: "Hall — hold expiring soon",
    body: "The hold on Hall for Gala expires at 5pm. Decide or it will be released automatically.",
  },
  {
    type: "hold.expiring",
    name: "formats a timestamp in Singapore time",
    data: { venueName: "Hall", eventName: "Gala", expiresAt: "2026-10-31T22:04:39.075455+00:00" },
    title: "Hall — hold expiring soon",
    body: "The hold on Hall for Gala expires at 1 Nov 2026, 6:04 am. Decide or it will be released automatically.",
  },
  {
    type: "hold.expiring",
    name: "no details",
    title: "The venue — hold expiring soon",
    body: "The hold on the venue for your event expires at soon. Decide or it will be released automatically.",
  },

  // booking.replacement_required, booking.unavailability_clash
  {
    type: "booking.replacement_required",
    name: "with details",
    data: { eventName: "Gala", venueName: "Hall", period: "3 Nov (all day)", reason: "Flood", date: "3 Nov" },
    title: "Alternative venue needed for Gala",
    body: "Hall is unavailable 3 Nov (all day): Flood. Your booking was cancelled, and Gala on 3 Nov needs a replacement venue.",
  },
  {
    type: "booking.replacement_required",
    name: "no details",
    title: "Alternative venue needed for Your event",
    body: "The venue is unavailable : . Your booking was cancelled, and Your event on  needs a replacement venue.",
  },
  {
    type: "booking.unavailability_clash",
    name: "with details",
    data: { eventName: "Gala", venueName: "Hall", period: "3 Nov (all day)", reason: "Flood", date: "3 Nov" },
    title: "Venue request for Gala can't be met",
    body: "Hall is unavailable 3 Nov (all day): Flood. Your pending request for Gala on 3 Nov clashes with it — consider requesting another venue or time.",
  },
  {
    type: "booking.unavailability_clash",
    name: "no details",
    title: "Venue request for your request can't be met",
    body: "The venue is unavailable : . Your pending request for your request on  clashes with it — consider requesting another venue or time.",
  },

  // booking.setup_conflict
  {
    type: "booking.setup_conflict",
    name: "to the venue staff member",
    to: "V1",
    data: {
      venueName: "Hall",
      venueStaffId: "V1",
      first: { eventName: "Gala", window: "09:00–12:00" },
      second: { eventName: "Fair", window: "11:00–14:00" },
    },
    title: "Hall's setup/turnaround change created a conflict",
    body: "Gala (09:00–12:00) now overlaps Fair (11:00–14:00). Neither booking has been removed.",
  },
  {
    type: "booking.setup_conflict",
    name: "to the venue staff member, event names unknown",
    to: "V1",
    data: {
      venueStaffId: "V1",
      first: { eventName: null, window: "09:00–12:00" },
      second: { eventName: null, window: "11:00–14:00" },
    },
    title: "The venue's setup/turnaround change created a conflict",
    body: "One booking (09:00–12:00) now overlaps another booking (11:00–14:00). Neither booking has been removed.",
  },
  {
    type: "booking.setup_conflict",
    name: "to a coordinator",
    data: {
      venueName: "Hall",
      venueStaffId: "V1",
      eventName: "Gala",
      otherEventName: "Fair",
      window: "09:00–12:00",
      otherWindow: "11:00–14:00",
      first: { eventName: "Gala", window: "09:00–12:00" },
      second: { eventName: "Fair", window: "11:00–14:00" },
    },
    title: "Hall booking now overlaps another",
    body: "Hall's setup or turnaround time changed. Gala now needs the venue 09:00–12:00, which overlaps Fair (11:00–14:00). Neither booking has been removed.",
  },
  {
    type: "booking.setup_conflict",
    name: "to the staff member, without first",
    to: "V1",
    data: { venueStaffId: "V1", second: { eventName: "Fair", window: "x" } },
    title: "The venue booking now overlaps another",
    body: "The venue's setup or turnaround time changed. Your event now needs the venue , which overlaps another event (). Neither booking has been removed.",
  },
  {
    type: "booking.setup_conflict",
    name: "to the staff member, without second",
    to: "V1",
    data: { venueStaffId: "V1", first: { eventName: "Fair", window: "x" } },
    title: "The venue booking now overlaps another",
    body: "The venue's setup or turnaround time changed. Your event now needs the venue , which overlaps another event (). Neither booking has been removed.",
  },

  // venue.capacity_reduced
  {
    type: "venue.capacity_reduced",
    name: "with details",
    data: { venueName: "Hall", eventName: "Gala", capacity: 50, date: "3 Nov", expectedAttendance: 80 },
    title: "Hall capacity reduced",
    body: "Hall now holds at most 50 people, but Gala on 3 Nov expects 80. Check whether the event still fits or request another venue.",
  },
  {
    type: "venue.capacity_reduced",
    name: "no details",
    title: "The venue capacity reduced",
    body: "The venue now holds at most fewer people, but your event on  expects more. Check whether the event still fits or request another venue.",
  },

  // equipment.requested
  {
    type: "equipment.requested",
    name: "several items",
    data: { eventName: "Gala", itemCount: 3 },
    title: "New equipment request",
    body: "Gala needs 3 equipment items arranged.",
    link: SUPPORT,
  },
  {
    type: "equipment.requested",
    name: "no details means one item",
    title: "New equipment request",
    body: "An event needs 1 equipment item arranged.",
    link: SUPPORT,
  },

  // equipment.amended
  {
    type: "equipment.amended",
    name: "every kind of change, one released",
    data: {
      eventName: "Gala",
      released: 1,
      changes: [
        { kind: "added", equipmentType: "Microphone", quantity: 2 },
        { kind: "added", equipmentType: "Stand" },
        { kind: "removed", equipmentType: "Screen" },
        { kind: "type", equipmentType: "Microphone", fromType: "Projector", from: 5, to: 4 },
        { kind: "quantity", equipmentType: "Projector", from: 5, to: 3 },
      ],
    },
    title: "Equipment request amended",
    body: "Gala's equipment request was amended: Added Microphone ×2; Added Stand ×1; Removed Screen; Projector ×5 → Microphone ×4; Projector 5 → 3. 1 reserved item was released back to inventory.",
    link: SUPPORT,
  },
  {
    type: "equipment.amended",
    name: "several released",
    data: { eventName: "Gala", released: 2, changes: [] },
    title: "Equipment request amended",
    body: "Gala's equipment request was amended: its items were changed. 2 reserved items were released back to inventory.",
    link: SUPPORT,
  },
  {
    type: "equipment.amended",
    name: "changes that aren't a list, no details",
    data: { changes: "nope" },
    title: "Equipment request amended",
    body: "An event's equipment request was amended: its items were changed.",
    link: SUPPORT,
  },

  // equipment.released
  {
    type: "equipment.released",
    name: "coordinator cancelled, with items",
    data: {
      eventName: "Gala",
      reason: "coordinator_cancelled",
      released: [
        { quantity: 2, equipmentType: "Projector" },
        { quantity: 1, equipmentType: "Screen" },
      ],
    },
    title: "Equipment request cancelled",
    body: "Gala's equipment request was cancelled by its coordinator. Released back to inventory: 2× Projector, 1× Screen.",
    link: "/equipment-requests",
  },
  {
    type: "equipment.released",
    name: "coordinator cancelled, released isn't a list",
    data: { eventName: "Gala", reason: "coordinator_cancelled", released: 3 },
    title: "Equipment request cancelled",
    body: "Gala's equipment request was cancelled by its coordinator.",
    link: "/equipment-requests",
  },
  {
    type: "equipment.released",
    name: "coordinator cancelled, nothing released",
    data: { eventName: "Gala", reason: "coordinator_cancelled", released: [] },
    title: "Equipment request cancelled",
    body: "Gala's equipment request was cancelled by its coordinator.",
    link: "/equipment-requests",
  },
  {
    type: "equipment.released",
    name: "event rejected",
    data: { eventName: "Gala", reason: "event_rejected" },
    title: "Equipment reservations released",
    body: "Gala was rejected, so its equipment reservations were released back to inventory.",
    link: SUPPORT,
  },
  {
    type: "equipment.released",
    name: "event cancelled, no name",
    title: "Equipment reservations released",
    body: "An event was cancelled, so its equipment reservations were released back to inventory.",
    link: SUPPORT,
  },

  // equipment.unusable
  {
    type: "equipment.unusable",
    name: "one unit with an end date",
    data: {
      eventName: "Gala",
      equipmentType: "Projector",
      reason: "Under Maintenance",
      startDate: "2026-11-03",
      endDate: "2026-11-05",
      quantity: 1,
    },
    title: "Reserved equipment unavailable",
    body: "Projector reserved for Gala is under maintenance from 3 Nov 2026 to 5 Nov 2026. Technical Support will need to arrange a replacement.",
  },
  {
    type: "equipment.unusable",
    name: "several units with no end date",
    data: { eventName: "Gala", equipmentType: "Projector", reason: "Broken", startDate: "2026-11-03", endDate: "", quantity: 3 },
    title: "Reserved equipment unavailable",
    body: "3 Projector units reserved for Gala are broken from 3 Nov 2026 until further notice. Technical Support will need to arrange a replacement.",
  },
  {
    type: "equipment.unusable",
    name: "a date that can't be parsed is shown as given",
    data: { eventName: "Gala", equipmentType: "Projector", reason: "Broken", startDate: "soon", quantity: 0 },
    title: "Reserved equipment unavailable",
    body: "Projector reserved for Gala is broken from soon until further notice. Technical Support will need to arrange a replacement.",
  },
  {
    type: "equipment.unusable",
    name: "no details",
    title: "Reserved equipment unavailable",
    body: "A reserved item reserved for Your event is unavailable from  until further notice. Technical Support will need to arrange a replacement.",
  },

  // equipment.reservation_clash
  {
    type: "equipment.reservation_clash",
    name: "to the coordinator, several units",
    to: "C1",
    data: { eventName: "Gala", units: 2, coordinatorId: "C1" },
    title: "Reserved equipment clashes after a reschedule",
    body: "Gala was rescheduled. 2 reserved equipment units now clash with another event's booking or an out-of-use period. Technical Support will need to arrange a replacement.",
  },
  {
    type: "equipment.reservation_clash",
    name: "to Technical Support, one unit",
    data: { eventName: "Gala", units: 1, coordinatorId: "C1" },
    title: "Reserved equipment clashes after a reschedule",
    body: "Gala was rescheduled. A reserved equipment unit now clashes with another event's booking or an out-of-use period. Technical Support will need to arrange a replacement.",
    link: SUPPORT,
  },
  {
    type: "equipment.reservation_clash",
    name: "no details, zero units reads as one",
    data: { units: 0 },
    title: "Reserved equipment clashes after a reschedule",
    body: "An event was rescheduled. A reserved equipment unit now clashes with another event's booking or an out-of-use period. Technical Support will need to arrange a replacement.",
    link: SUPPORT,
  },
  {
    type: "equipment.reservation_clash",
    name: "units missing reads as one",
    title: "Reserved equipment clashes after a reschedule",
    body: "An event was rescheduled. A reserved equipment unit now clashes with another event's booking or an out-of-use period. Technical Support will need to arrange a replacement.",
    link: SUPPORT,
  },

  // booking.invalidated_by_edit
  {
    type: "booking.invalidated_by_edit",
    name: "an approved booking was flagged",
    data: { eventName: "Gala", venueName: "Hall", reason: "it is too small", status: "Replacement Required" },
    title: "Venue booking needs a replacement",
    body: "Gala was edited and its booking at Hall no longer fits: it is too small. The booking was flagged, so find a replacement venue.",
  },
  {
    type: "booking.invalidated_by_edit",
    name: "a pending booking was only reported",
    data: { eventName: "Gala", venueName: "Hall", reason: "it is too small", status: "On Hold" },
    title: "Venue booking no longer fits",
    body: "Gala was edited and its on hold booking at Hall no longer fits: it is too small. The booking was not changed; withdraw it and request another venue if needed.",
  },
  {
    type: "booking.invalidated_by_edit",
    name: "no details",
    title: "Venue booking no longer fits",
    body: "Your event was edited and its pending booking at a venue no longer fits: it no longer fits. The booking was not changed; withdraw it and request another venue if needed.",
  },

  // equipment.status_changed
  {
    type: "equipment.status_changed",
    name: "partially fulfilled",
    data: { eventName: "Gala", status: "Partially Fulfilled", note: "2 of 3" },
    title: "Equipment request partially fulfilled",
    body: "Gala's equipment request is only partially fulfilled: 2 of 3",
  },
  {
    type: "equipment.status_changed",
    name: "partially fulfilled, no note",
    data: { eventName: "Gala", status: "Partially Fulfilled" },
    title: "Equipment request partially fulfilled",
    body: "Gala's equipment request is only partially fulfilled: ",
  },
  {
    type: "equipment.status_changed",
    name: "another status",
    data: { eventName: "Gala", status: "Fulfilled" },
    title: "Equipment request fulfilled",
    body: "Gala's equipment request is now Fulfilled.",
  },
  {
    type: "equipment.status_changed",
    name: "no details",
    title: "Equipment request updated",
    body: "Your event's equipment request is now updated.",
  },

  // change.*
  {
    type: "change.requested",
    name: "with fields",
    data: { eventName: "Gala", fields: ["date", "venue"] },
    title: "Change request raised",
    body: 'The organiser of "Gala" requested a change to date, venue.',
  },
  {
    type: "change.requested",
    name: "fields aren't a list",
    data: { fields: "date" },
    title: "Change request raised",
    body: 'The organiser of "An event" requested a change to its details.',
  },
  {
    type: "change.requested",
    name: "empty fields",
    data: { eventName: "Gala", fields: [] },
    title: "Change request raised",
    body: 'The organiser of "Gala" requested a change to its details.',
  },
  {
    type: "change.withdrawn",
    name: "to the organiser",
    to: "O1",
    actorId: "O1",
    data: { eventName: "Gala", fields: ["date", "venue"] },
    title: "Change request withdrawn",
    body: 'Your requested change to date, venue on "Gala" is back to how it was — nothing is pending anymore.',
  },
  {
    type: "change.withdrawn",
    name: "to the coordinator",
    actorId: "O1",
    data: { eventName: "Gala", fields: ["date", "venue"] },
    title: "Change request withdrawn",
    body: `The organiser's requested change to date, venue on "Gala" was reverted — there's nothing left for you to review.`,
  },
  {
    type: "change.withdrawn",
    name: "fields aren't a list, no name",
    data: { fields: "date" },
    title: "Change request withdrawn",
    body: `The organiser's requested change to its fields on "An event" was reverted — there's nothing left for you to review.`,
  },
  {
    type: "change.withdrawn",
    name: "empty fields",
    data: { eventName: "Gala", fields: [] },
    title: "Change request withdrawn",
    body: `The organiser's requested change to its fields on "Gala" was reverted — there's nothing left for you to review.`,
  },
  {
    type: "change.decided",
    name: "approved",
    data: { eventName: "Gala", outcome: "approved" },
    title: "Change request approved",
    body: 'Your requested change to "Gala" has been approved and applied.',
  },
  {
    type: "change.decided",
    name: "partially approved",
    data: { eventName: "Gala", outcome: "partially_approved", approvedFields: ["date", "time"], remainingFields: ["venue", "budget"] },
    title: "Change request partially approved",
    body: `Your requested change to "Gala" was partially approved — date, time applied. venue, budget still awaiting your coordinator's review.`,
  },
  {
    type: "change.decided",
    name: "partially approved, fields aren't lists",
    data: { eventName: "Gala", outcome: "partially_approved", approvedFields: "date", remainingFields: "venue" },
    title: "Change request partially approved",
    body: `Your requested change to "Gala" was partially approved —  applied.  still awaiting your coordinator's review.`,
  },
  {
    type: "change.decided",
    name: "rejected with a reason",
    data: { eventName: "Gala", outcome: "rejected", reason: "Too late" },
    title: "Change request rejected",
    body: 'Your requested change to "Gala" was rejected: Too late',
  },
  {
    type: "change.decided",
    name: "rejected, no details",
    title: "Change request rejected",
    body: 'Your requested change to "Your event" was rejected.',
  },

  // booking.flagged_for_rebooking, equipment.flagged_for_reassessment
  {
    type: "booking.flagged_for_rebooking",
    name: "with a reason",
    data: { venueName: "Hall", reason: "too small" },
    title: "Hall — needs rebooking",
    body: "An approved change request means this booking for Hall needs to be replaced (too small).",
  },
  {
    type: "booking.flagged_for_rebooking",
    name: "no details",
    title: "A venue — needs rebooking",
    body: "An approved change request means this booking for A venue needs to be replaced.",
  },
  {
    type: "equipment.flagged_for_reassessment",
    name: "with a reason",
    data: { eventName: "Gala", reason: "more attendees." },
    title: "Equipment request needs reassessment",
    body: `"Gala"'s equipment requirements changed: more attendees. Please reassess the existing reservation.`,
  },
  {
    type: "equipment.flagged_for_reassessment",
    name: "no details",
    title: "Equipment request needs reassessment",
    body: `"An event"'s equipment requirements changed. Please reassess the existing reservation.`,
  },
];

describe("renderNotification", () => {
  it.each(CASES.map((c) => [c.type, c.name, c] as const))("%s: %s", (type, _name, c) => {
    const msg = buildMsg(type, c.data ?? {}, c.actorId ? { actorId: c.actorId } : {});
    expect(renderNotification(msg, c.to ?? "ME")).toEqual({ title: c.title, body: c.body, link: c.link ?? EVENT });
  });

  it("has no link to an event page when the message has no event", () => {
    const render = (type: string) => renderNotification(buildMsg(type, {}, { eventId: null }), "ME")?.link;
    expect(render("booking.decided")).toBeNull();
    expect(render("registration.confirmed")).toBeNull();
    expect(render("equipment.requested")).toBeNull();
  });

  it.each(["something.unknown", "constructor", "toString", "__proto__", "hasOwnProperty"])(
    "returns null for %s, which has no template",
    (type) => {
      expect(renderNotification(buildMsg(type, {}), "ME")).toBeNull();
    },
  );
});
