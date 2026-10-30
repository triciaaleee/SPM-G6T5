import type { InboundMessage } from "./rabbitConsumer.js";

export interface RenderedNotification {
  title: string;
  body: string;
  link: string | null;
}

/**
 * Most triggers notify everyone with the same text. A few (e.g.
 * `coordinator.assigned`, where the coordinator and the organiser read
 * different sentences about the same event) need to know which recipient
 * is being rendered for — `recipientId` is that recipient's id, always
 * passed, ignored by templates that don't need it.
 */
type Template = (msg: InboundMessage, recipientId: string) => RenderedNotification;

function eventLink(msg: InboundMessage): string | null {
  return msg.eventId !== null ? `/events/${msg.eventId}` : null;
}

/** Attendees can't open `/events/:id` (staff only); their view of an event lives under `/attendee/events/:id`. */
function attendeeEventLink(msg: InboundMessage): string | null {
  return msg.eventId !== null ? `/attendee/events/${msg.eventId}` : null;
}

/** Technical Support can't open `/events/:id` (staff only); their view of an event's requests is `/equipment-requests/event/:id`. */
function supportEventLink(msg: InboundMessage): string | null {
  return msg.eventId !== null ? `/equipment-requests/event/${msg.eventId}` : null;
}

/** "2026-11-03" → "3 Nov 2026"; anything else is shown as given, and nothing gives "". */
function formatUnavailabilityDate(value: unknown): string {
  if (typeof value !== "string" || value === "") return "";
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

interface AmendedChange {
  kind: "quantity" | "type" | "added" | "removed";
  equipmentType: string;
  fromType?: string;
  from?: number;
  to?: number;
  quantity?: number;
}

/** "Projector 5 → 3", "Added Microphone ×2", "Removed Screen", "Projector ×5 → Microphone ×5". */
function describeAmendedChange(change: AmendedChange): string {
  switch (change.kind) {
    case "added":
      return `Added ${change.equipmentType} ×${change.quantity ?? 1}`;
    case "removed":
      return `Removed ${change.equipmentType}`;
    case "type":
      return `${change.fromType} ×${change.from} → ${change.equipmentType} ×${change.to}`;
    default:
      return `${change.equipmentType} ${change.from} → ${change.to}`;
  }
}

/**
 * One entry per message type notification-service is ready to render
 * (RabbitMQ.md section 3). A representative subset for the initial
 * idle-ready consumer — add the rest as their publishers come online
 * (ARD section 1.1: triggers move over one at a time).
 */
const TEMPLATES: Record<string, Template> = {
  /**
   * #18/#33 in RabbitMQ.md section 3.3. The coordinator-driven reasons
   * (E4-9: `coordinator_withdrew`/`coordinator_released`) and the E3-6
   * cancellation reason (`event_cancelled`) and the rejection reason (`event_rejected`) each read differently; #19's
   * `replaced` still falls back to generic "withdrawn" wording, since
   * that publisher hasn't landed.
   */
  "booking.withdrawn": (msg) => {
    const venueName = String(msg.data.venueName ?? "A venue");
    const eventName = String(msg.data.eventName ?? "your event");
    const link = eventLink(msg);
    if (msg.data.reason === "event_cancelled") {
      return {
        title: `${venueName} — booking released`,
        body: `${eventName} was cancelled, so its booking for ${venueName} was released and the venue is free again.`,
        link,
      };
    }
    if (msg.data.reason === "event_rejected") {
      return {
        title: `${venueName} — booking released`,
        body: `${eventName} was rejected, so its booking for ${venueName} was released and the venue is free again.`,
        link,
      };
    }
    const released = msg.data.reason === "coordinator_released";
    const verb = released ? "released" : "withdrawn";
    return {
      title: `${venueName} — booking ${verb}`,
      body: `${venueName}'s booking for ${eventName} was ${verb}. The venue is free for this period again.`,
      link,
    };
  },
  /** #106 rows 2/3, RabbitMQ.md #16/#17 — `data.decision` is on_hold/approved/rejected/auto_rejected. */
  "booking.decided": (msg) => {
    const venueName = String(msg.data.venueName ?? "The venue");
    const eventName = String(msg.data.eventName ?? "your event");
    const reason = msg.data.reason ? ` ${msg.data.reason}` : "";
    const decision = msg.data.decision;

    if (decision === "approved") {
      return { title: `${venueName} — booking approved`, body: `${venueName} is approved for ${eventName}.`, link: eventLink(msg) };
    }
    if (decision === "on_hold") {
      return {
        title: `${venueName} — booking on hold`,
        body: `${venueName} is on hold for ${eventName} while arrangements are finalised.`,
        link: eventLink(msg),
      };
    }
    if (decision === "auto_rejected") {
      return {
        title: `Venue request for ${eventName} was rejected`,
        body:
          `${venueName} was booked for another event over the same period, so your request for ${eventName} ` +
          `was rejected:${reason} You can request another venue or another time.`,
        link: eventLink(msg),
      };
    }
    // "rejected"
    return {
      title: `${venueName} — booking rejected`,
      body: `${venueName} was rejected for ${eventName}:${reason}`,
      link: eventLink(msg),
    };
  },
  /** #14 in RabbitMQ.md section 3.2 (E3-6) — the organiser's confirmation and the notified coordinator/leads read the same text. */
  "event.cancelled": (msg) => {
    const eventName = String(msg.data.eventName ?? "An event");
    return {
      title: "Event cancelled",
      body: `${eventName} was cancelled${msg.data.reason ? ` (${msg.data.reason})` : ""}.`,
      link: eventLink(msg),
    };
  },

  /** #36 in RabbitMQ.md section 3.7 (E2-15) — chat-service's first RabbitMQ trigger. Always the other party, so one rendering for everyone. */
  "message.sent": (msg) => {
    const eventName = String(msg.data.eventName ?? "an event");
    return {
      title: `New message about ${eventName}`,
      body: String(msg.data.preview ?? ""),
      link: eventLink(msg),
    };
  },

  /**
   * #104 (E7-2a): first trigger migrated off direct REST (ARD section
   * 1.1) — events-service's `POST /:id/assign` now publishes this instead
   * of calling notification-service's API directly. The coordinator and
   * organiser read different text about the same assignment, so this
   * templates per recipientId rather than once for everyone.
   */
  "coordinator.assigned": (msg, recipientId) => {
    const eventName = String(msg.data.eventName ?? "an event");
    const coordinatorName = String(msg.data.coordinatorName ?? "a coordinator");
    const link = eventLink(msg);

    if (recipientId === msg.data.coordinatorId) {
      return {
        title: "New event assigned to you",
        body: `"${eventName}" has been assigned to you. You are now its coordinator.`,
        link,
      };
    }
    return {
      title: "Your event has a coordinator",
      body: `${coordinatorName} is now the coordinator for "${eventName}".`,
      link,
    };
  },

  /**
   * #1 in RabbitMQ.md section 3.1. The organiser's confirmation and the
   * leads' triage notice are different sentences about the same
   * submission, told apart by comparing recipientId to data.organiserId
   * (#104 row 1).
   */
  "request.submitted": (msg, recipientId) => {
    const eventName = String(msg.data.eventName ?? "A request");
    const link = eventLink(msg);
    if (recipientId === msg.data.organiserId) {
      return {
        title: "Request submitted",
        body: `Your request for "${eventName}" has been submitted and is waiting for a coordinator.`,
        link,
      };
    }
    return {
      title: "New request in the unassigned queue",
      body: `"${eventName}" needs a coordinator assigned.`,
      link,
    };
  },

  /** #4 in RabbitMQ.md section 3.1 — three different readers, same message. */
  "coordinator.reassigned": (msg, recipientId) => {
    const eventName = String(msg.data.eventName ?? "an event");
    const newCoordinatorName = String(msg.data.newCoordinatorName ?? "a coordinator");
    const previousCoordinatorName = String(msg.data.previousCoordinatorName ?? "the previous coordinator");
    const link = eventLink(msg);

    if (recipientId === msg.data.previousCoordinatorId) {
      return {
        title: "Event reassigned",
        body: `"${eventName}" has been reassigned to ${newCoordinatorName}. You can still view it, but you can no longer act on it.`,
        link,
      };
    }
    if (recipientId === msg.data.newCoordinatorId) {
      return {
        title: "Event reassigned to you",
        body: `"${eventName}" has been reassigned to you from ${previousCoordinatorName}. You are now its coordinator.`,
        link,
      };
    }
    return {
      title: "Your event has a new coordinator",
      body: `${newCoordinatorName} is now the coordinator for "${eventName}", taking over from ${previousCoordinatorName}.`,
      link,
    };
  },

  /** #9/#10 in RabbitMQ.md section 3.2 (#105). All three outcomes (approved/rejected/changes_requested) now publish. */
  "safety.decided": (msg) => {
    const eventName = String(msg.data.eventName ?? "Your event");
    const link = eventLink(msg);
    const reason = msg.data.reason ? ` ${msg.data.reason}` : "";

    if (msg.data.outcome === "approved") {
      return {
        title: "Safety review approved",
        body: `"${eventName}" passed its Operational Safety Check and is now Confirmed.`,
        link,
      };
    }
    if (msg.data.outcome === "rejected") {
      return {
        title: "Safety review rejected",
        body: `"${eventName}" failed its Operational Safety Check and is back in Planning. Reason:${reason}`,
        link,
      };
    }
    if (msg.data.outcome === "changes_requested") {
      return {
        title: "Safety changes requested",
        body: `"${eventName}" is back in Planning. The Safety Officer asked for changes —${reason}`,
        link,
      };
    }
    return {
      title: "Safety review decision",
      body: `"${eventName}" received a safety review decision.`,
      link,
    };
  },

  /** #2 in RabbitMQ.md section 3.1 (#104 row 2). Same text whether it's sent to the one assigned coordinator or every Lead. */
  "request.edited": (msg) => ({
    title: "Request edited",
    body: `The organiser edited "${msg.data.eventName ?? "a request"}".`,
    link: eventLink(msg),
  }),

  /** #5 in RabbitMQ.md section 3.1 (#104 row 5) — to the organiser only. */
  "clarification.requested": (msg) => ({
    title: "Clarification requested",
    body: `Your coordinator has a question about "${msg.data.eventName ?? "your request"}": ${msg.data.message ?? ""}`,
    link: eventLink(msg),
  }),

  /** #6 in RabbitMQ.md section 3.1 (#104 row 6) — to the assigned coordinator only. */
  "clarification.answered": (msg) => ({
    title: "Organiser responded to your question",
    body: `The organiser answered your question about "${msg.data.eventName ?? "the request"}".`,
    link: eventLink(msg),
  }),

  /** #7 in RabbitMQ.md section 3.1 (#104 row 7) — to the organiser only. */
  "request.decided": (msg) => {
    const eventName = String(msg.data.eventName ?? "Your request");
    if (msg.data.decision === "approved") {
      return {
        title: "Request approved",
        body: `"${eventName}" was approved and has moved into Planning.`,
        link: eventLink(msg),
      };
    }
    return {
      title: "Request rejected",
      body: `"${eventName}" was rejected${msg.data.reason ? `: ${msg.data.reason}` : "."}`,
      link: eventLink(msg),
    };
  },

  /** #8 in RabbitMQ.md section 3.2 (#105 row 1) — same text for the organiser and every Safety Officer. */
  /**
   * A Confirmed event lost something it was approved on (a venue, a reserved
   * equipment unit) or the organiser raised a change request: it moves to
   * Needs Review until the coordinator settles it. Sent to the coordinator
   * and the organiser.
   */
  "event.needs_review": (msg) => {
    const eventName = String(msg.data.eventName ?? "An event");
    return {
      title: `${eventName} needs review`,
      body: `"${eventName}" is now Needs Review: ${msg.data.reason ?? "its arrangements changed"}. It returns to Confirmed once this is settled.`,
      link: eventLink(msg),
    };
  },

  /** The same loss while the event was in Safety Review: it goes back to Planning (and the Safety Officer is told). */
  "event.returned_to_planning": (msg) => {
    const eventName = String(msg.data.eventName ?? "An event");
    return {
      title: `${eventName} returned to Planning`,
      body: `"${eventName}" was in Safety Review but ${msg.data.reason ?? "its arrangements changed"}. It is back in Planning and must be resubmitted for safety review.`,
      link: eventLink(msg),
    };
  },

  "safety.submitted": (msg) => ({
    title: "Submitted for safety review",
    body: `"${msg.data.eventName ?? "An event"}" has been submitted for its Operational Safety Check.`,
    link: eventLink(msg),
  }),

  /** #31 in RabbitMQ.md section 3.5 (#105 row 6) — to the registering attendee. registration-service's first broker publisher, built straight onto RabbitMQ (no REST step to migrate off). */
  "registration.confirmed": (msg) => ({
    title: "Registration confirmed",
    body: `Your registration for "${msg.data.eventName ?? "this event"}" is confirmed.`,
    link: attendeeEventLink(msg),
  }),

  /** #32 in RabbitMQ.md section 3.5 (#105 row 7) — to the withdrawing attendee. Generic wording if eventName is missing. */
  "registration.withdrawn": (msg) => ({
    title: "Registration withdrawn",
    body: `You have withdrawn your registration${msg.data.eventName ? ` for "${msg.data.eventName}"` : ""}.`,
    link: attendeeEventLink(msg),
  }),

  /** #15 in RabbitMQ.md section 3.3 (#106 row 1) — to the venue's assigned staff member. */
  "booking.requested": (msg) => ({
    title: `New booking request for ${msg.data.venueName ?? "a venue"}`,
    body: `${msg.data.eventName ?? "An event"} has requested ${msg.data.venueName ?? "a venue"} for ${
      msg.data.when ?? "a date to be confirmed"
    }. Hold, approve or reject it from your booking requests.`,
    link: "/venue-requests",
  }),

  /** #21 in RabbitMQ.md section 3.3 (#106 row 4a) — to the assigned coordinator. */
  "hold.expired": (msg) => ({
    title: `${msg.data.venueName ?? "The venue"} — hold expired`,
    body:
      `The hold on ${msg.data.venueName ?? "the venue"} for ${msg.data.eventName ?? "your event"} expired before it was decided. ` +
      "You can request another venue or another time.",
    link: eventLink(msg),
  }),

  /** #20 in RabbitMQ.md section 3.3 (#106 row 4b) — to the assigned coordinator, before the hold lapses. */
  "hold.expiring": (msg) => ({
    title: `${msg.data.venueName ?? "The venue"} — hold expiring soon`,
    body:
      `The hold on ${msg.data.venueName ?? "the venue"} for ${msg.data.eventName ?? "your event"} expires at ` +
      `${msg.data.expiresAt ?? "soon"}. Decide or it will be released automatically.`,
    link: eventLink(msg),
  }),

  /** #22 in RabbitMQ.md section 3.3 (#107 row 1) — an Approved booking lost its venue. */
  "booking.replacement_required": (msg) => {
    const eventName = String(msg.data.eventName ?? "Your event");
    const venueName = String(msg.data.venueName ?? "The venue");
    return {
      title: `Alternative venue needed for ${eventName}`,
      body: `${venueName} is unavailable ${msg.data.period ?? ""}: ${msg.data.reason ?? ""}. Your booking was cancelled, and ${eventName} on ${msg.data.date ?? ""} needs a replacement venue.`,
      link: eventLink(msg),
    };
  },

  /** #23 in RabbitMQ.md section 3.3 (#107 row 1) — a pending booking clashes but keeps its status. */
  "booking.unavailability_clash": (msg) => {
    const eventName = String(msg.data.eventName ?? "your request");
    const venueName = String(msg.data.venueName ?? "The venue");
    return {
      title: `Venue request for ${eventName} can't be met`,
      body:
        `${venueName} is unavailable ${msg.data.period ?? ""}: ${msg.data.reason ?? ""}. Your pending request for ${eventName} on ${msg.data.date ?? ""} ` +
        "clashes with it — consider requesting another venue or time.",
      link: eventLink(msg),
    };
  },

  /**
   * #24 in RabbitMQ.md section 3.3 (#107 row 2) — the venue staff member
   * gets a neutral notice; each coordinator reads the existing wording
   * naming the other event. Told apart by comparing recipientId to
   * data.venueStaffId (same pattern as coordinator.assigned).
   */
  "booking.setup_conflict": (msg, recipientId) => {
    const venueName = String(msg.data.venueName ?? "The venue");
    if (recipientId === msg.data.venueStaffId && msg.data.first && msg.data.second) {
      const first = msg.data.first as { eventName: string | null; window: string };
      const second = msg.data.second as { eventName: string | null; window: string };
      return {
        title: `${venueName}'s setup/turnaround change created a conflict`,
        body: `${first.eventName ?? "One booking"} (${first.window}) now overlaps ${second.eventName ?? "another booking"} (${second.window}). Neither booking has been removed.`,
        link: eventLink(msg),
      };
    }
    const eventName = String(msg.data.eventName ?? "Your event");
    const otherEventName = String(msg.data.otherEventName ?? "another event");
    return {
      title: `${venueName} booking now overlaps another`,
      body: `${venueName}'s setup or turnaround time changed. ${eventName} now needs the venue ${msg.data.window ?? ""}, which overlaps ${otherEventName} (${msg.data.otherWindow ?? ""}). Neither booking has been removed.`,
      link: eventLink(msg),
    };
  },

  /** #25 in RabbitMQ.md section 3.3 (#107 row 3) — to each affected coordinator. */
  "venue.capacity_reduced": (msg) => {
    const venueName = String(msg.data.venueName ?? "The venue");
    const eventName = String(msg.data.eventName ?? "your event");
    return {
      title: `${venueName} capacity reduced`,
      body: `${venueName} now holds at most ${msg.data.capacity ?? "fewer"} people, but ${eventName} on ${msg.data.date ?? ""} expects ${msg.data.expectedAttendance ?? "more"}. Check whether the event still fits or request another venue.`,
      link: eventLink(msg),
    };
  },

  /** #26 in RabbitMQ.md section 3.4 (#107 row 4, "raised") — to every Technical Support Staff member. */
  "equipment.requested": (msg) => {
    const count = Number(msg.data.itemCount ?? 1);
    return {
      title: "New equipment request",
      body: `${msg.data.eventName ?? "An event"} needs ${count} equipment item${count === 1 ? "" : "s"} arranged.`,
      link: supportEventLink(msg),
    };
  },

  /** #27 in RabbitMQ.md section 3.4 (E5-2 AC1) — to every Technical Support Staff member; `data.changes` says what changed. */
  "equipment.amended": (msg) => {
    const eventName = String(msg.data.eventName ?? "An event");
    const changes = Array.isArray(msg.data.changes) ? (msg.data.changes as AmendedChange[]) : [];
    const released = Number(msg.data.released ?? 0);
    const lines = changes.map(describeAmendedChange);
    const summary = lines.length > 0 ? lines.join("; ") : "its items were changed";
    const releasedNote =
      released > 0 ? ` ${released} reserved ${released === 1 ? "item was" : "items were"} released back to inventory.` : "";
    return {
      title: "Equipment request amended",
      body: `${eventName}'s equipment request was amended: ${summary}.${releasedNote}`,
      link: supportEventLink(msg),
    };
  },

  /**
   * #34 (E3-6 AC3, the event was cancelled) and #30 (E5-2 AC3,
   * `reason: coordinator_cancelled`, the coordinator cancelled one request) in
   * RabbitMQ.md section 3.4 — to every Technical Support Staff member.
   */
  "equipment.released": (msg) => {
    const eventName = String(msg.data.eventName ?? "An event");
    if (msg.data.reason === "coordinator_cancelled") {
      const released = Array.isArray(msg.data.released)
        ? (msg.data.released as { equipmentType: string; quantity: number }[])
        : [];
      const detail =
        released.length > 0
          ? ` Released back to inventory: ${released.map((item) => `${item.quantity}× ${item.equipmentType}`).join(", ")}.`
          : "";
      return {
        title: "Equipment request cancelled",
        body: `${eventName}'s equipment request was cancelled by its coordinator.${detail}`,
        // The cancelled request is no longer in Technical Support's queue, so land on the queue.
        link: "/equipment-requests",
      };
    }
    const outcome = msg.data.reason === "event_rejected" ? "rejected" : "cancelled";
    return {
      title: "Equipment reservations released",
      body: `${eventName} was ${outcome}, so its equipment reservations were released back to inventory.`,
      // The event's requests are cancelled with it; Technical Support can still open them, under Cancelled / Past.
      link: supportEventLink(msg),
    };
  },

  /** #35 in RabbitMQ.md section 3.5 (E3-6 AC4) — to each attendee who held a place. */
  "registration.cancelled_by_event": (msg) => ({
    title: "Event cancelled",
    body: `Your registration${msg.data.eventName ? ` for "${msg.data.eventName}"` : ""} was cancelled because the event itself was cancelled.`,
    link: attendeeEventLink(msg),
  }),

  /**
   * #29 in RabbitMQ.md section 3.4 (E5-5 AC2) — to the assigned coordinator of
   * each event holding a reservation on a unit Technical Support just marked
   * unusable. `data.quantity` is how many of that event's units are affected
   * (1 if absent). `data.startDate` / `data.endDate` are YYYY-MM-DD; no end date
   * means "until it is marked usable again".
   */
  "equipment.unusable": (msg) => {
    const eventName = String(msg.data.eventName ?? "Your event");
    const equipmentType = String(msg.data.equipmentType ?? "A reserved item");
    const reason = String(msg.data.reason ?? "unavailable").toLowerCase();
    const from = formatUnavailabilityDate(msg.data.startDate);
    const to = formatUnavailabilityDate(msg.data.endDate);
    const period = to ? `from ${from} to ${to}` : `from ${from} until further notice`;
    const quantity = Math.max(1, Number(msg.data.quantity ?? 1));
    const subject =
      quantity > 1 ? `${quantity} ${equipmentType} units reserved for ${eventName} are` : `${equipmentType} reserved for ${eventName} is`;
    return {
      title: "Reserved equipment unavailable",
      body: `${subject} ${reason} ${period}. Technical Support will need to arrange a replacement.`,
      link: eventLink(msg),
    };
  },

  /**
   * #28a in RabbitMQ.md section 3.4 — an event was rescheduled and the units
   * reserved for it now clash with another event's booking or an out-of-use
   * period. To the event's coordinator (`data.coordinatorId`, who opens the event
   * page) and to Technical Support (who open the request). `data.units` is how
   * many reserved units clash (1 if absent).
   */
  "equipment.reservation_clash": (msg, recipientId) => {
    const eventName = String(msg.data.eventName ?? "An event");
    const units = Math.max(1, Number(msg.data.units ?? 1));
    const subject = units > 1 ? `${units} reserved equipment units now clash` : "A reserved equipment unit now clashes";
    return {
      title: "Reserved equipment clashes after a reschedule",
      body: `${eventName} was rescheduled. ${subject} with another event's booking or an out-of-use period. Technical Support will need to arrange a replacement.`,
      link: recipientId === msg.data.coordinatorId ? eventLink(msg) : supportEventLink(msg),
    };
  },

  /**
   * #25a in RabbitMQ.md section 3.3 — the event was edited (its date, time or
   * expected attendance) and one of its venue bookings no longer fits: the venue
   * is blocked out then, another event holds it, or it is too small. To the
   * event's coordinator. `data.status` is the booking's status afterwards: an
   * Approved booking was flagged `Replacement Required`; a pending one
   * (`Requested`, `On Hold`) was only reported and keeps its status.
   */
  "booking.invalidated_by_edit": (msg) => {
    const eventName = String(msg.data.eventName ?? "Your event");
    const venueName = String(msg.data.venueName ?? "a venue");
    const reason = String(msg.data.reason ?? "it no longer fits");
    const flagged = msg.data.status === "Replacement Required";
    return {
      title: flagged ? "Venue booking needs a replacement" : "Venue booking no longer fits",
      body: flagged
        ? `${eventName} was edited and its booking at ${venueName} no longer fits: ${reason}. The booking was flagged, so find a replacement venue.`
        : `${eventName} was edited and its ${String(msg.data.status ?? "pending").toLowerCase()} booking at ${venueName} no longer fits: ${reason}. The booking was not changed; withdraw it and request another venue if needed.`,
      link: eventLink(msg),
    };
  },

  /** #28 in RabbitMQ.md section 3.4 (#107 row 5) — to the assigned coordinator. */
  "equipment.status_changed": (msg) => {
    const status = String(msg.data.status ?? "updated");
    const eventName = String(msg.data.eventName ?? "Your event");
    const body =
      status === "Partially Fulfilled"
        ? `${eventName}'s equipment request is only partially fulfilled: ${msg.data.note ?? ""}`
        : `${eventName}'s equipment request is now ${status}.`;
    return { title: `Equipment request ${status.toLowerCase()}`, body, link: eventLink(msg) };
  },

  /** RabbitMQ.md #12 (E3-9 AC1) — to the assigned coordinator. */
  "change.requested": (msg) => {
    const eventName = String(msg.data.eventName ?? "An event");
    const fields = Array.isArray(msg.data.fields) ? (msg.data.fields as string[]) : [];
    const fieldList = fields.length > 0 ? fields.join(", ") : "its details";
    return {
      title: "Change request raised",
      body: `The organiser of "${eventName}" requested a change to ${fieldList}.`,
      link: eventLink(msg),
    };
  },

  /**
   * E3-9: a pending change request auto-resolved because every held field
   * was reverted back to its committed value — nothing's left for the
   * coordinator to decide. Organiser and coordinator read different
   * sentences about the same event.
   */
  "change.withdrawn": (msg, recipientId) => {
    const eventName = String(msg.data.eventName ?? "An event");
    const fields = Array.isArray(msg.data.fields) ? (msg.data.fields as string[]) : [];
    const fieldList = fields.length > 0 ? fields.join(", ") : "its fields";
    const link = eventLink(msg);

    if (recipientId === msg.actorId) {
      return {
        title: "Change request withdrawn",
        body: `Your requested change to ${fieldList} on "${eventName}" is back to how it was — nothing is pending anymore.`,
        link,
      };
    }
    return {
      title: "Change request withdrawn",
      body: `The organiser's requested change to ${fieldList} on "${eventName}" was reverted — there's nothing left for you to review.`,
      link,
    };
  },

  /** RabbitMQ.md #13 (E3-11 AC1/AC4) — the coordinator's decision on a held change request, to the organiser. */
  "change.decided": (msg) => {
    const eventName = String(msg.data.eventName ?? "Your event");
    const link = eventLink(msg);
    if (msg.data.outcome === "approved") {
      return {
        title: "Change request approved",
        body: `Your requested change to "${eventName}" has been approved and applied.`,
        link,
      };
    }
    if (msg.data.outcome === "partially_approved") {
      const approved = Array.isArray(msg.data.approvedFields) ? msg.data.approvedFields.join(", ") : "";
      const remaining = Array.isArray(msg.data.remainingFields) ? msg.data.remainingFields.join(", ") : "";
      return {
        title: "Change request partially approved",
        body: `Your requested change to "${eventName}" was partially approved — ${approved} applied. ${remaining} still awaiting your coordinator's review.`,
        link,
      };
    }
    const reason = msg.data.reason ? `: ${msg.data.reason}` : ".";
    return {
      title: "Change request rejected",
      body: `Your requested change to "${eventName}" was rejected${reason}`,
      link,
    };
  },

  /**
   * E3-11 AC2 — distinct from the existing `booking.replacement_required`
   * (that one tells the *coordinator* a venue block-out caught their
   * booking); this tells the *venue's own staff* that a coordinator's
   * approved change request invalidated one of theirs.
   */
  "booking.flagged_for_rebooking": (msg) => {
    const venueName = String(msg.data.venueName ?? "A venue");
    const reason = msg.data.reason ? ` (${msg.data.reason})` : "";
    return {
      title: `${venueName} — needs rebooking`,
      body: `An approved change request means this booking for ${venueName} needs to be replaced${reason}.`,
      link: eventLink(msg),
    };
  },

  /** E3-11 AC3 — to every Technical Support member; the coordinator already knows (they just approved it). */
  "equipment.flagged_for_reassessment": (msg) => {
    const eventName = String(msg.data.eventName ?? "An event");
    const reason = msg.data.reason ? `: ${msg.data.reason}` : ".";
    return {
      title: "Equipment request needs reassessment",
      body: `"${eventName}"'s equipment requirements changed${reason} Please reassess the existing reservation.`,
      link: eventLink(msg),
    };
  },
};

/** `null` for a type with no template yet — the caller logs and skips it. */
export function renderNotification(msg: InboundMessage, recipientId: string): RenderedNotification | null {
  const template = TEMPLATES[msg.type];
  return template ? template(msg, recipientId) : null;
}
