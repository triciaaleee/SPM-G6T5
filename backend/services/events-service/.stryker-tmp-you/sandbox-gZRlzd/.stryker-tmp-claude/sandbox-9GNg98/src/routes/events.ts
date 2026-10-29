// @ts-nocheck
// 
function stryNS_9fa48() {
  var g = typeof globalThis === 'object' && globalThis && globalThis.Math === Math && globalThis || new Function("return this")();
  var ns = g.__stryker__ || (g.__stryker__ = {});
  if (ns.activeMutant === undefined && g.process && g.process.env && g.process.env.__STRYKER_ACTIVE_MUTANT__) {
    ns.activeMutant = g.process.env.__STRYKER_ACTIVE_MUTANT__;
  }
  function retrieveNS() {
    return ns;
  }
  stryNS_9fa48 = retrieveNS;
  return retrieveNS();
}
stryNS_9fa48();
function stryCov_9fa48() {
  var ns = stryNS_9fa48();
  var cov = ns.mutantCoverage || (ns.mutantCoverage = {
    static: {},
    perTest: {}
  });
  function cover() {
    var c = cov.static;
    if (ns.currentTestId) {
      c = cov.perTest[ns.currentTestId] = cov.perTest[ns.currentTestId] || {};
    }
    var a = arguments;
    for (var i = 0; i < a.length; i++) {
      c[a[i]] = (c[a[i]] || 0) + 1;
    }
  }
  stryCov_9fa48 = cover;
  cover.apply(null, arguments);
}
function stryMutAct_9fa48(id) {
  var ns = stryNS_9fa48();
  function isActive(id) {
    if (ns.activeMutant === id) {
      if (ns.hitCount !== void 0 && ++ns.hitCount > ns.hitLimit) {
        throw new Error('Stryker: Hit count limit reached (' + ns.hitCount + ')');
      }
      return true;
    }
    return false;
  }
  stryMutAct_9fa48 = isActive;
  return isActive(id);
}
import { Router } from "express";
import type { Response } from "express";
import type { AuthedRequest } from "../middleware/auth.js";
import { requireAuth, requireAuthOrInternal } from "../middleware/auth.js";
import { requireInternal } from "../middleware/internal.js";
import { normaliseDraftEventRequest, validateEventRequest } from "../lib/validateEventRequest.js";
import type { ValidatedEventRequest } from "../lib/validateEventRequest.js";
import { isPositiveInteger } from "../lib/validation.js";
import { diffSubmittedDetails, diffSubmittedDetailsStructured } from "../lib/diffSubmittedDetails.js";
import { CLOSED_EVENT_STATUSES, EVENT_STATUS } from "../lib/eventStatus.js";
import { committedFieldValue, validateChangeRequestFields, withHeldValues } from "../lib/changeRequestFields.js";
import { AUTO_APPLIED_REASON_PREFIX, CHANGE_REQUEST_STATUS } from "../lib/changeRequestStatus.js";
import { publishDurably } from "../lib/outbox.js";
import { announceAttendanceChange, announceReschedule, attendanceChanged, scheduleChanged, SCHEDULE_FIELDS } from "../lib/reschedule.js";
import { getPublisher } from "../lib/rabbitPublisher.js";
import { fetchCoordinators } from "../lib/usersClient.js";
import { checkBookingAvailability, fetchEventEquipmentRequests, fetchEventVenueBookings, flagBookingForRebooking, flagEquipmentForReassessment } from "../lib/arrangementsClient.js";
import type { ArrangementEquipmentItem } from "../lib/arrangementsClient.js";
import { fetchEventRegistrations } from "../lib/registrationsClient.js";
import { describeOutstanding, findOutstandingArrangements, hasOutstanding, MAX_SAFETY_DECISION_REASON_LENGTH, parseSafetyNotes } from "../lib/safetyReview.js";
import { eventEndsAt, eventStartsAt, hasEventEnded, hasEventStarted, localDateStart } from "../lib/eventTiming.js";
import { getRegistrationState, isListed, REGISTRATION_CUTOFF_DAYS, REGISTRATION_DATE_EDITABLE_STATUSES, REGISTRATION_OVERRIDE, REGISTRATION_STATE } from "../lib/registrationPeriod.js";
import type { RegistrationOverride } from "../lib/registrationPeriod.js";
import { arrangementOptions, combinedReason, currentArrangements, hasChanged, parseChangeRequest, resolveFlags, type StoredFlag } from "../lib/safetyChanges.js";
import { clock } from "../lib/clock.js";

/**
 * Week 7 change 5: the Event Coordinator Lead oversees incoming requests,
 * assigns them (E2-13) and reassigns them (E2-12). Read-only on the event
 * itself: the Lead never edits, approves or rejects (E1-8 AC2).
 */
const COORDINATOR_LEAD_ROLE = stryMutAct_9fa48("1360") ? "" : (stryCov_9fa48("1360"), "coordinator_lead");

/** A route parameter as a single string (Express types a repeated one as an array). */
export function routeParam(value: string | string[]): string {
  if (stryMutAct_9fa48("1361")) {
    {}
  } else {
    stryCov_9fa48("1361");
    return Array.isArray(value) ? value[0] : value;
  }
}
async function recordAccessDenial(supabase: NonNullable<AuthedRequest["supabase"]>, userId: string, eventId: string, reason: string): Promise<void> {
  if (stryMutAct_9fa48("1362")) {
    {}
  } else {
    stryCov_9fa48("1362");
    const {
      error
    } = await supabase.from(stryMutAct_9fa48("1363") ? "" : (stryCov_9fa48("1363"), "access_denials")).insert(stryMutAct_9fa48("1364") ? {} : (stryCov_9fa48("1364"), {
      user_id: userId,
      event_id: eventId,
      reason
    }));
    if (stryMutAct_9fa48("1366") ? false : stryMutAct_9fa48("1365") ? true : (stryCov_9fa48("1365", "1366"), error)) {
      if (stryMutAct_9fa48("1367")) {
        {}
      } else {
        stryCov_9fa48("1367");
        console.error(stryMutAct_9fa48("1369") ? "" : (stryCov_9fa48("1369"), "Failed to record access_denials row"), stryMutAct_9fa48("1370") ? {} : (stryCov_9fa48("1370"), {
          userId,
          eventId,
          reason,
          error
        }));
      }
    }
  }
}

/**
 * E2-7 AC3: writes one event_history row per changed field. Best-effort —
 * the submitted_details update above is what actually matters, so a
 * failure here is logged, not fatal to the request.
 */
async function recordEventHistory(supabase: NonNullable<AuthedRequest["supabase"]>, eventId: number, changes: {
  field: string;
  oldValue: string | null;
  newValue: string;
}[], changedBy: string): Promise<void> {
  if (stryMutAct_9fa48("1371")) {
    {}
  } else {
    stryCov_9fa48("1371");
    if (stryMutAct_9fa48("1374") ? changes.length !== 0 : stryMutAct_9fa48("1373") ? false : stryMutAct_9fa48("1372") ? true : (stryCov_9fa48("1372", "1373", "1374"), changes.length === 0)) return;
    const {
      error
    } = await supabase.from(stryMutAct_9fa48("1375") ? "" : (stryCov_9fa48("1375"), "event_history")).insert(changes.map(stryMutAct_9fa48("1376") ? () => undefined : (stryCov_9fa48("1376"), change => stryMutAct_9fa48("1377") ? {} : (stryCov_9fa48("1377"), {
      event_id: eventId,
      field: change.field,
      old_value: change.oldValue,
      new_value: change.newValue,
      changed_by: changedBy
    }))));
    if (stryMutAct_9fa48("1379") ? false : stryMutAct_9fa48("1378") ? true : (stryCov_9fa48("1378", "1379"), error)) {
      if (stryMutAct_9fa48("1380")) {
        {}
      } else {
        stryCov_9fa48("1380");
        console.error(stryMutAct_9fa48("1382") ? "" : (stryCov_9fa48("1382"), "Failed to record event_history rows"), stryMutAct_9fa48("1383") ? {} : (stryCov_9fa48("1383"), {
          eventId,
          changedBy,
          error
        }));
      }
    }
  }
}

/**
 * E2-14: a newly-unassigned request waits in the Lead's queue (E1-8) until
 * assigned (E2-13) — notify every Lead so they know there's something to
 * triage, and the submitting organiser with a confirmation (#104 row 1).
 * Best-effort: a notification failure never blocks the submission that
 * already committed.
 *
 * Lead ids are resolved by notification-service after this publishes
 * (`recipients.roles`), not fetched from user-service here first — events-
 * service has no REST dependency on user-service in this path at all.
 */
async function notifyCoordinatorLeads(eventId: number, eventName: string, actorId: string): Promise<void> {
  if (stryMutAct_9fa48("1384")) {
    {}
  } else {
    stryCov_9fa48("1384");
    await getPublisher().publish(stryMutAct_9fa48("1385") ? {} : (stryCov_9fa48("1385"), {
      type: stryMutAct_9fa48("1386") ? "" : (stryCov_9fa48("1386"), "request.submitted"),
      eventId,
      actorId,
      recipients: stryMutAct_9fa48("1387") ? {} : (stryCov_9fa48("1387"), {
        userIds: stryMutAct_9fa48("1388") ? [] : (stryCov_9fa48("1388"), [actorId]),
        roles: stryMutAct_9fa48("1389") ? [] : (stryCov_9fa48("1389"), [stryMutAct_9fa48("1390") ? "" : (stryCov_9fa48("1390"), "coordinator_lead")])
      }),
      data: stryMutAct_9fa48("1391") ? {} : (stryCov_9fa48("1391"), {
        eventName,
        organiserId: actorId
      })
    }));
  }
}
export const eventsRouter = Router();

// Registered ahead of the blanket requireAuth below: venue-service's
// scheduled expiring-hold sweep (#106 row 4b) has no end-user token to
// forward, so this one route accepts an internal token too. Every other
// route keeps requireAuth only.
eventsRouter.get(stryMutAct_9fa48("1393") ? "" : (stryCov_9fa48("1393"), "/venue-booking-info"), requireAuthOrInternal, venueBookingInfoHandler);

// venue-service and equipment-service tell us an arrangement the event was
// approved on was lost (see arrangementsChangedHandler). Internal callers only.
eventsRouter.post(stryMutAct_9fa48("1395") ? "" : (stryCov_9fa48("1395"), "/:id/arrangements-changed"), requireInternal, arrangementsChangedHandler);
if (stryMutAct_9fa48("1396")) {
  ;
} else {
  stryCov_9fa48("1396");
  eventsRouter.use(requireAuth);
}
/**
 * E1-4.2: shared column list for every route that returns an event to the
 * client, including decided_at/decided_by so the Organiser can see who
 * decided and when (AC4) — created_at is submission time, not decision
 * time. E2-6 AC2: `coordinator:coordinator_id(name)` embeds the assigned
 * coordinator's display name via the FK on events.coordinator_id (added
 * in migration 0004), so the frontend can show a name instead of a raw
 * id — coordinator_id itself is kept too, since other logic (e.g. "is the
 * viewer the assigned coordinator?") needs the id, not the name.
 * `organiser:organiser_id(name)` embeds the requester's name the same way,
 * for the "Event Requestor" field on the detail view.
 */
const EVENT_COLUMNS = stryMutAct_9fa48("1397") ? "" : (stryCov_9fa48("1397"), "id, status, submitted_details, coordinator_id, coordinator:coordinator_id(name), organiser:organiser_id(name), review_outcome, decided_at, decided_by, created_at, registration_open_date, registration_override");

/**
 * E2-1: submit a new event request. Validates the mandatory fields per the
 * story's acceptance criteria, then inserts. Authorization is enforced
 * here in application code — the service-role client bypasses RLS, so
 * organiser_id is always set from the verified JWT's subject, never
 * trusted from the request body.
 *
 * E2-14: every submitted request enters the unassigned queue (E1-8) with
 * no coordinator — replaces E2-6's round-robin auto-assignment, which used
 * to set the request straight to "Requested". The Event Coordinator Lead
 * assigns it from the queue instead (E2-13), and is notified here so they
 * know there's something to triage. Restricted to organisers: notifying
 * the Lead means events-service must resolve Lead ids from user-service
 * using the submitter's own token, and user-service only grants that
 * lookup to the organiser role (see LISTABLE_ROLES_BY_CALLER in
 * user-service's users.ts).
 */
// Stryker disable next-line StringLiteral: equivalent - the router treats the path "" exactly like "/"
if (stryMutAct_9fa48("1398")) {
  ;
} else {
  stryCov_9fa48("1398");
  eventsRouter.post("/", async (req: AuthedRequest, res) => {
    if (stryMutAct_9fa48("1400")) {
      {}
    } else {
      stryCov_9fa48("1400");
      const {
        supabase,
        user
      } = req;
      if (stryMutAct_9fa48("1403") ? !supabase && !user : stryMutAct_9fa48("1402") ? false : stryMutAct_9fa48("1401") ? true : (stryCov_9fa48("1401", "1402", "1403"), (stryMutAct_9fa48("1404") ? supabase : (stryCov_9fa48("1404"), !supabase)) || (stryMutAct_9fa48("1405") ? user : (stryCov_9fa48("1405"), !user)))) {
        if (stryMutAct_9fa48("1406")) {
          {}
        } else {
          stryCov_9fa48("1406");
          res.status(401).json(stryMutAct_9fa48("1408") ? {} : (stryCov_9fa48("1408"), {
            error: stryMutAct_9fa48("1409") ? "" : (stryCov_9fa48("1409"), "Unauthenticated")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("1412") ? user.role !== "attendee" : stryMutAct_9fa48("1411") ? false : stryMutAct_9fa48("1410") ? true : (stryCov_9fa48("1410", "1411", "1412"), user.role === (stryMutAct_9fa48("1413") ? "" : (stryCov_9fa48("1413"), "attendee")))) {
        if (stryMutAct_9fa48("1414")) {
          {}
        } else {
          stryCov_9fa48("1414");
          res.status(403).json(stryMutAct_9fa48("1416") ? {} : (stryCov_9fa48("1416"), {
            error: stryMutAct_9fa48("1417") ? "" : (stryCov_9fa48("1417"), "Attendees cannot manage events")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("1420") ? user.role === "organiser" : stryMutAct_9fa48("1419") ? false : stryMutAct_9fa48("1418") ? true : (stryCov_9fa48("1418", "1419", "1420"), user.role !== (stryMutAct_9fa48("1421") ? "" : (stryCov_9fa48("1421"), "organiser")))) {
        if (stryMutAct_9fa48("1422")) {
          {}
        } else {
          stryCov_9fa48("1422");
          res.status(403).json(stryMutAct_9fa48("1424") ? {} : (stryCov_9fa48("1424"), {
            error: stryMutAct_9fa48("1425") ? "" : (stryCov_9fa48("1425"), "Only organisers can submit event requests")
          }));
          return;
        }
      }
      const result = validateEventRequest(stryMutAct_9fa48("1426") ? req.body && {} : (stryCov_9fa48("1426"), req.body ?? {}));
      if (stryMutAct_9fa48("1429") ? false : stryMutAct_9fa48("1428") ? true : stryMutAct_9fa48("1427") ? result.valid : (stryCov_9fa48("1427", "1428", "1429"), !result.valid)) {
        if (stryMutAct_9fa48("1430")) {
          {}
        } else {
          stryCov_9fa48("1430");
          res.status(400).json(stryMutAct_9fa48("1432") ? {} : (stryCov_9fa48("1432"), {
            error: stryMutAct_9fa48("1433") ? "" : (stryCov_9fa48("1433"), "Validation failed"),
            fields: result.fields
          }));
          return;
        }
      }
      const {
        data,
        error
      } = await supabase.from(stryMutAct_9fa48("1434") ? "" : (stryCov_9fa48("1434"), "events")).insert(stryMutAct_9fa48("1435") ? {} : (stryCov_9fa48("1435"), {
        organiser_id: user.id,
        status: EVENT_STATUS.Unassigned,
        coordinator_id: null,
        submitted_details: result.value
      })).select(EVENT_COLUMNS).single();
      if (stryMutAct_9fa48("1437") ? false : stryMutAct_9fa48("1436") ? true : (stryCov_9fa48("1436", "1437"), error)) {
        if (stryMutAct_9fa48("1438")) {
          {}
        } else {
          stryCov_9fa48("1438");
          res.status(500).json(stryMutAct_9fa48("1440") ? {} : (stryCov_9fa48("1440"), {
            error: stryMutAct_9fa48("1441") ? "" : (stryCov_9fa48("1441"), "Failed to submit event request")
          }));
          return;
        }
      }
      await notifyCoordinatorLeads(data.id, eventDisplayName(data as unknown as AssignmentEventRow), user.id);
      res.status(201).json(stryMutAct_9fa48("1443") ? {} : (stryCov_9fa48("1443"), {
        event: data,
        message: stryMutAct_9fa48("1444") ? "" : (stryCov_9fa48("1444"), "Your event request has been submitted.")
      }));
    }
  });
}
/**
 * E2-4 AC1: save a new draft. Skips E2-1's validation entirely — a draft
 * may be missing any or all of its mandatory fields — and never assigns a
 * coordinator, since a draft hasn't reached the review pipeline yet.
 */
if (stryMutAct_9fa48("1445")) {
  ;
} else {
  stryCov_9fa48("1445");
  eventsRouter.post(stryMutAct_9fa48("1446") ? "" : (stryCov_9fa48("1446"), "/draft"), async (req: AuthedRequest, res) => {
    if (stryMutAct_9fa48("1447")) {
      {}
    } else {
      stryCov_9fa48("1447");
      const {
        supabase,
        user
      } = req;
      if (stryMutAct_9fa48("1450") ? !supabase && !user : stryMutAct_9fa48("1449") ? false : stryMutAct_9fa48("1448") ? true : (stryCov_9fa48("1448", "1449", "1450"), (stryMutAct_9fa48("1451") ? supabase : (stryCov_9fa48("1451"), !supabase)) || (stryMutAct_9fa48("1452") ? user : (stryCov_9fa48("1452"), !user)))) {
        if (stryMutAct_9fa48("1453")) {
          {}
        } else {
          stryCov_9fa48("1453");
          res.status(401).json(stryMutAct_9fa48("1455") ? {} : (stryCov_9fa48("1455"), {
            error: stryMutAct_9fa48("1456") ? "" : (stryCov_9fa48("1456"), "Unauthenticated")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("1459") ? user.role !== "attendee" : stryMutAct_9fa48("1458") ? false : stryMutAct_9fa48("1457") ? true : (stryCov_9fa48("1457", "1458", "1459"), user.role === (stryMutAct_9fa48("1460") ? "" : (stryCov_9fa48("1460"), "attendee")))) {
        if (stryMutAct_9fa48("1461")) {
          {}
        } else {
          stryCov_9fa48("1461");
          res.status(403).json(stryMutAct_9fa48("1463") ? {} : (stryCov_9fa48("1463"), {
            error: stryMutAct_9fa48("1464") ? "" : (stryCov_9fa48("1464"), "Attendees cannot manage events")
          }));
          return;
        }
      }
      const {
        data,
        error
      } = await supabase.from(stryMutAct_9fa48("1465") ? "" : (stryCov_9fa48("1465"), "events")).insert(stryMutAct_9fa48("1466") ? {} : (stryCov_9fa48("1466"), {
        organiser_id: user.id,
        status: stryMutAct_9fa48("1467") ? "" : (stryCov_9fa48("1467"), "Draft"),
        submitted_details: normaliseDraftEventRequest(stryMutAct_9fa48("1468") ? req.body && {} : (stryCov_9fa48("1468"), req.body ?? {}))
      })).select(EVENT_COLUMNS).single();
      if (stryMutAct_9fa48("1470") ? false : stryMutAct_9fa48("1469") ? true : (stryCov_9fa48("1469", "1470"), error)) {
        if (stryMutAct_9fa48("1471")) {
          {}
        } else {
          stryCov_9fa48("1471");
          res.status(500).json(stryMutAct_9fa48("1473") ? {} : (stryCov_9fa48("1473"), {
            error: stryMutAct_9fa48("1474") ? "" : (stryCov_9fa48("1474"), "Failed to save draft")
          }));
          return;
        }
      }
      res.status(201).json(stryMutAct_9fa48("1476") ? {} : (stryCov_9fa48("1476"), {
        event: data
      }));
    }
  });
}
/**
 * E2-4 AC1/AC2: save progress on an existing draft without submitting it —
 * same relaxed validation as creating one. Only the owning organiser may
 * update it, and only while it's still a draft (once submitted, further
 * changes go through the normal PATCH /:id edit rules instead).
 */
if (stryMutAct_9fa48("1477")) {
  ;
} else {
  stryCov_9fa48("1477");
  eventsRouter.patch(stryMutAct_9fa48("1478") ? "" : (stryCov_9fa48("1478"), "/:id/draft"), async (req: AuthedRequest, res) => {
    if (stryMutAct_9fa48("1479")) {
      {}
    } else {
      stryCov_9fa48("1479");
      const {
        supabase,
        user
      } = req;
      if (stryMutAct_9fa48("1482") ? !supabase && !user : stryMutAct_9fa48("1481") ? false : stryMutAct_9fa48("1480") ? true : (stryCov_9fa48("1480", "1481", "1482"), (stryMutAct_9fa48("1483") ? supabase : (stryCov_9fa48("1483"), !supabase)) || (stryMutAct_9fa48("1484") ? user : (stryCov_9fa48("1484"), !user)))) {
        if (stryMutAct_9fa48("1485")) {
          {}
        } else {
          stryCov_9fa48("1485");
          res.status(401).json(stryMutAct_9fa48("1487") ? {} : (stryCov_9fa48("1487"), {
            error: stryMutAct_9fa48("1488") ? "" : (stryCov_9fa48("1488"), "Unauthenticated")
          }));
          return;
        }
      }
      const eventId = routeParam(req.params.id);
      if (stryMutAct_9fa48("1491") ? false : stryMutAct_9fa48("1490") ? true : stryMutAct_9fa48("1489") ? isPositiveInteger(eventId) : (stryCov_9fa48("1489", "1490", "1491"), !isPositiveInteger(eventId))) {
        if (stryMutAct_9fa48("1492")) {
          {}
        } else {
          stryCov_9fa48("1492");
          res.status(404).json(stryMutAct_9fa48("1494") ? {} : (stryCov_9fa48("1494"), {
            error: stryMutAct_9fa48("1495") ? "" : (stryCov_9fa48("1495"), "Event not found")
          }));
          return;
        }
      }
      const {
        data: existing,
        error: fetchError
      } = await supabase.from(stryMutAct_9fa48("1496") ? "" : (stryCov_9fa48("1496"), "events")).select(stryMutAct_9fa48("1497") ? "" : (stryCov_9fa48("1497"), "id, status, organiser_id")).eq(stryMutAct_9fa48("1498") ? "" : (stryCov_9fa48("1498"), "id"), Number(eventId)).maybeSingle();
      if (stryMutAct_9fa48("1500") ? false : stryMutAct_9fa48("1499") ? true : (stryCov_9fa48("1499", "1500"), fetchError)) {
        if (stryMutAct_9fa48("1501")) {
          {}
        } else {
          stryCov_9fa48("1501");
          res.status(500).json(stryMutAct_9fa48("1503") ? {} : (stryCov_9fa48("1503"), {
            error: stryMutAct_9fa48("1504") ? "" : (stryCov_9fa48("1504"), "Failed to load draft")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("1507") ? !existing && existing.organiser_id !== user.id : stryMutAct_9fa48("1506") ? false : stryMutAct_9fa48("1505") ? true : (stryCov_9fa48("1505", "1506", "1507"), (stryMutAct_9fa48("1508") ? existing : (stryCov_9fa48("1508"), !existing)) || (stryMutAct_9fa48("1510") ? existing.organiser_id === user.id : stryMutAct_9fa48("1509") ? false : (stryCov_9fa48("1509", "1510"), existing.organiser_id !== user.id)))) {
        if (stryMutAct_9fa48("1511")) {
          {}
        } else {
          stryCov_9fa48("1511");
          await recordAccessDenial(supabase, user.id, eventId, stryMutAct_9fa48("1512") ? "" : (stryCov_9fa48("1512"), "not_found_or_not_owner"));
          res.status(403).json(stryMutAct_9fa48("1514") ? {} : (stryCov_9fa48("1514"), {
            error: stryMutAct_9fa48("1515") ? "" : (stryCov_9fa48("1515"), "Access denied")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("1518") ? existing.status === "Draft" : stryMutAct_9fa48("1517") ? false : stryMutAct_9fa48("1516") ? true : (stryCov_9fa48("1516", "1517", "1518"), existing.status !== (stryMutAct_9fa48("1519") ? "" : (stryCov_9fa48("1519"), "Draft")))) {
        if (stryMutAct_9fa48("1520")) {
          {}
        } else {
          stryCov_9fa48("1520");
          res.status(409).json(stryMutAct_9fa48("1522") ? {} : (stryCov_9fa48("1522"), {
            error: stryMutAct_9fa48("1523") ? "" : (stryCov_9fa48("1523"), "This request is no longer a draft")
          }));
          return;
        }
      }
      const {
        data,
        error
      } = await supabase.from(stryMutAct_9fa48("1524") ? "" : (stryCov_9fa48("1524"), "events")).update(stryMutAct_9fa48("1525") ? {} : (stryCov_9fa48("1525"), {
        submitted_details: normaliseDraftEventRequest(stryMutAct_9fa48("1526") ? req.body && {} : (stryCov_9fa48("1526"), req.body ?? {}))
      })).eq(stryMutAct_9fa48("1527") ? "" : (stryCov_9fa48("1527"), "id"), existing.id).select(EVENT_COLUMNS).single();
      if (stryMutAct_9fa48("1529") ? false : stryMutAct_9fa48("1528") ? true : (stryCov_9fa48("1528", "1529"), error)) {
        if (stryMutAct_9fa48("1530")) {
          {}
        } else {
          stryCov_9fa48("1530");
          res.status(500).json(stryMutAct_9fa48("1532") ? {} : (stryCov_9fa48("1532"), {
            error: stryMutAct_9fa48("1533") ? "" : (stryCov_9fa48("1533"), "Failed to save draft")
          }));
          return;
        }
      }
      res.json(stryMutAct_9fa48("1535") ? {} : (stryCov_9fa48("1535"), {
        event: data
      }));
    }
  });
}
/**
 * E2-5.2 AC1: delete a draft. Same ownership/status guard as the draft
 * PATCH above — only the owning organiser, and only while it's still a
 * draft (a submitted request isn't deletable through this route).
 */
if (stryMutAct_9fa48("1536")) {
  ;
} else {
  stryCov_9fa48("1536");
  eventsRouter.delete(stryMutAct_9fa48("1537") ? "" : (stryCov_9fa48("1537"), "/:id/draft"), async (req: AuthedRequest, res) => {
    if (stryMutAct_9fa48("1538")) {
      {}
    } else {
      stryCov_9fa48("1538");
      const {
        supabase,
        user
      } = req;
      if (stryMutAct_9fa48("1541") ? !supabase && !user : stryMutAct_9fa48("1540") ? false : stryMutAct_9fa48("1539") ? true : (stryCov_9fa48("1539", "1540", "1541"), (stryMutAct_9fa48("1542") ? supabase : (stryCov_9fa48("1542"), !supabase)) || (stryMutAct_9fa48("1543") ? user : (stryCov_9fa48("1543"), !user)))) {
        if (stryMutAct_9fa48("1544")) {
          {}
        } else {
          stryCov_9fa48("1544");
          res.status(401).json(stryMutAct_9fa48("1546") ? {} : (stryCov_9fa48("1546"), {
            error: stryMutAct_9fa48("1547") ? "" : (stryCov_9fa48("1547"), "Unauthenticated")
          }));
          return;
        }
      }
      const eventId = routeParam(req.params.id);
      if (stryMutAct_9fa48("1550") ? false : stryMutAct_9fa48("1549") ? true : stryMutAct_9fa48("1548") ? isPositiveInteger(eventId) : (stryCov_9fa48("1548", "1549", "1550"), !isPositiveInteger(eventId))) {
        if (stryMutAct_9fa48("1551")) {
          {}
        } else {
          stryCov_9fa48("1551");
          res.status(404).json(stryMutAct_9fa48("1553") ? {} : (stryCov_9fa48("1553"), {
            error: stryMutAct_9fa48("1554") ? "" : (stryCov_9fa48("1554"), "Event not found")
          }));
          return;
        }
      }
      const {
        data: existing,
        error: fetchError
      } = await supabase.from(stryMutAct_9fa48("1555") ? "" : (stryCov_9fa48("1555"), "events")).select(stryMutAct_9fa48("1556") ? "" : (stryCov_9fa48("1556"), "id, status, organiser_id")).eq(stryMutAct_9fa48("1557") ? "" : (stryCov_9fa48("1557"), "id"), Number(eventId)).maybeSingle();
      if (stryMutAct_9fa48("1559") ? false : stryMutAct_9fa48("1558") ? true : (stryCov_9fa48("1558", "1559"), fetchError)) {
        if (stryMutAct_9fa48("1560")) {
          {}
        } else {
          stryCov_9fa48("1560");
          res.status(500).json(stryMutAct_9fa48("1562") ? {} : (stryCov_9fa48("1562"), {
            error: stryMutAct_9fa48("1563") ? "" : (stryCov_9fa48("1563"), "Failed to load draft")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("1566") ? !existing && existing.organiser_id !== user.id : stryMutAct_9fa48("1565") ? false : stryMutAct_9fa48("1564") ? true : (stryCov_9fa48("1564", "1565", "1566"), (stryMutAct_9fa48("1567") ? existing : (stryCov_9fa48("1567"), !existing)) || (stryMutAct_9fa48("1569") ? existing.organiser_id === user.id : stryMutAct_9fa48("1568") ? false : (stryCov_9fa48("1568", "1569"), existing.organiser_id !== user.id)))) {
        if (stryMutAct_9fa48("1570")) {
          {}
        } else {
          stryCov_9fa48("1570");
          await recordAccessDenial(supabase, user.id, eventId, stryMutAct_9fa48("1571") ? "" : (stryCov_9fa48("1571"), "not_found_or_not_owner"));
          res.status(403).json(stryMutAct_9fa48("1573") ? {} : (stryCov_9fa48("1573"), {
            error: stryMutAct_9fa48("1574") ? "" : (stryCov_9fa48("1574"), "Access denied")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("1577") ? existing.status === "Draft" : stryMutAct_9fa48("1576") ? false : stryMutAct_9fa48("1575") ? true : (stryCov_9fa48("1575", "1576", "1577"), existing.status !== (stryMutAct_9fa48("1578") ? "" : (stryCov_9fa48("1578"), "Draft")))) {
        if (stryMutAct_9fa48("1579")) {
          {}
        } else {
          stryCov_9fa48("1579");
          res.status(409).json(stryMutAct_9fa48("1581") ? {} : (stryCov_9fa48("1581"), {
            error: stryMutAct_9fa48("1582") ? "" : (stryCov_9fa48("1582"), "This request is no longer a draft")
          }));
          return;
        }
      }
      const {
        error
      } = await supabase.from(stryMutAct_9fa48("1583") ? "" : (stryCov_9fa48("1583"), "events")).delete().eq(stryMutAct_9fa48("1584") ? "" : (stryCov_9fa48("1584"), "id"), existing.id);
      if (stryMutAct_9fa48("1586") ? false : stryMutAct_9fa48("1585") ? true : (stryCov_9fa48("1585", "1586"), error)) {
        if (stryMutAct_9fa48("1587")) {
          {}
        } else {
          stryCov_9fa48("1587");
          res.status(500).json(stryMutAct_9fa48("1589") ? {} : (stryCov_9fa48("1589"), {
            error: stryMutAct_9fa48("1590") ? "" : (stryCov_9fa48("1590"), "Failed to delete draft")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("1591")) {
        ;
      } else {
        stryCov_9fa48("1591");
        res.status(204).send();
      }
    }
  });
}
/**
 * List events. Coordinators get full pipeline visibility (all events) but
 * never see drafts — a draft hasn't been submitted, so it's not yet part
 * of the review pipeline (E2-5.1 AC2). The Event Coordinator Lead sees the
 * same set: change 5 has the Lead view every coordinator assignment and
 * active event. Everyone else sees only events they organised, drafts
 * included (E2-5.1 AC1 relies on the Organiser's own list containing
 * both). Since the service-role client bypasses RLS, this filter is the
 * actual enforcement, not just defense-in-depth.
 */
// Stryker disable next-line StringLiteral: equivalent - the router treats the path "" exactly like "/"
if (stryMutAct_9fa48("1592")) {
  ;
} else {
  stryCov_9fa48("1592");
  eventsRouter.get("/", async (req: AuthedRequest, res) => {
    if (stryMutAct_9fa48("1594")) {
      {}
    } else {
      stryCov_9fa48("1594");
      const {
        supabase,
        user
      } = req;
      if (stryMutAct_9fa48("1597") ? !supabase && !user : stryMutAct_9fa48("1596") ? false : stryMutAct_9fa48("1595") ? true : (stryCov_9fa48("1595", "1596", "1597"), (stryMutAct_9fa48("1598") ? supabase : (stryCov_9fa48("1598"), !supabase)) || (stryMutAct_9fa48("1599") ? user : (stryCov_9fa48("1599"), !user)))) {
        if (stryMutAct_9fa48("1600")) {
          {}
        } else {
          stryCov_9fa48("1600");
          res.status(401).json(stryMutAct_9fa48("1602") ? {} : (stryCov_9fa48("1602"), {
            error: stryMutAct_9fa48("1603") ? "" : (stryCov_9fa48("1603"), "Unauthenticated")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("1606") ? user.role !== "attendee" : stryMutAct_9fa48("1605") ? false : stryMutAct_9fa48("1604") ? true : (stryCov_9fa48("1604", "1605", "1606"), user.role === (stryMutAct_9fa48("1607") ? "" : (stryCov_9fa48("1607"), "attendee")))) {
        if (stryMutAct_9fa48("1608")) {
          {}
        } else {
          stryCov_9fa48("1608");
          res.status(403).json(stryMutAct_9fa48("1610") ? {} : (stryCov_9fa48("1610"), {
            error: stryMutAct_9fa48("1611") ? "" : (stryCov_9fa48("1611"), "Attendees cannot manage events")
          }));
          return;
        }
      }
      let query = supabase.from(stryMutAct_9fa48("1612") ? "" : (stryCov_9fa48("1612"), "events")).select(EVENT_COLUMNS);
      if (stryMutAct_9fa48("1615") ? user.role !== "coordinator" || user.role !== COORDINATOR_LEAD_ROLE : stryMutAct_9fa48("1614") ? false : stryMutAct_9fa48("1613") ? true : (stryCov_9fa48("1613", "1614", "1615"), (stryMutAct_9fa48("1617") ? user.role === "coordinator" : stryMutAct_9fa48("1616") ? true : (stryCov_9fa48("1616", "1617"), user.role !== (stryMutAct_9fa48("1618") ? "" : (stryCov_9fa48("1618"), "coordinator")))) && (stryMutAct_9fa48("1620") ? user.role === COORDINATOR_LEAD_ROLE : stryMutAct_9fa48("1619") ? true : (stryCov_9fa48("1619", "1620"), user.role !== COORDINATOR_LEAD_ROLE)))) {
        if (stryMutAct_9fa48("1621")) {
          {}
        } else {
          stryCov_9fa48("1621");
          query = query.eq(stryMutAct_9fa48("1622") ? "" : (stryCov_9fa48("1622"), "organiser_id"), user.id);
        }
      } else {
        if (stryMutAct_9fa48("1623")) {
          {}
        } else {
          stryCov_9fa48("1623");
          query = query.neq(stryMutAct_9fa48("1624") ? "" : (stryCov_9fa48("1624"), "status"), stryMutAct_9fa48("1625") ? "" : (stryCov_9fa48("1625"), "Draft"));
        }
      }
      const {
        data,
        error
      } = await query;
      if (stryMutAct_9fa48("1627") ? false : stryMutAct_9fa48("1626") ? true : (stryCov_9fa48("1626", "1627"), error)) {
        if (stryMutAct_9fa48("1628")) {
          {}
        } else {
          stryCov_9fa48("1628");
          res.status(500).json(stryMutAct_9fa48("1630") ? {} : (stryCov_9fa48("1630"), {
            error: stryMutAct_9fa48("1631") ? "" : (stryCov_9fa48("1631"), "Failed to load events")
          }));
          return;
        }
      }
      res.json(stryMutAct_9fa48("1633") ? {} : (stryCov_9fa48("1633"), {
        events: data
      }));
    }
  });
}
/**
 * E1-5: the only fields venue staff may see about an event — what they need
 * to set the venue up. Everything else in submitted_details (purpose,
 * description) and on the row (organiser, coordinator, review outcome) is
 * left out, and clarifications/history are never joined in. The free-text
 * requirement fields are included because venue-service reads layout and
 * facility needs out of them; it drops the text before replying to the
 * browser.
 *
 * E5-1: equipment-service reuses this same batch lookup for Technical
 * Support's equipment request list — it needs exactly the same shape
 * (event name/date/time, plus the Organiser's original equipment note as
 * AC2's reference text), so technical_support is included below rather
 * than standing up a near-duplicate endpoint.
 */
/* Zo note: built a new endpoint instead of just using the existing one but only extracting the needed info for venue because of security purposes. This is more secure compared to using the existing one to fetch and filter.
 */
const VENUE_BOOKING_INFO_FIELDS = ["name", "proposedDate", "startTime", "endTime", "expectedAttendance", "venue", "accessibility", "equipment", "technicalSupport"] as const;
const MAX_VENUE_BOOKING_INFO_IDS = 100;
const VENUE_BOOKING_INFO_ROLES = new Set(stryMutAct_9fa48("1634") ? [] : (stryCov_9fa48("1634"), [stryMutAct_9fa48("1635") ? "" : (stryCov_9fa48("1635"), "venue_staff"), stryMutAct_9fa48("1636") ? "" : (stryCov_9fa48("1636"), "coordinator"), stryMutAct_9fa48("1637") ? "" : (stryCov_9fa48("1637"), "technical_support")]));

/**
 * E1-5: booking-relevant info for the events booked at a venue, called by
 * venue-service with the caller's own token. venue_bookings only links a
 * venue to an event, so the event is where a booking's date and times
 * live: venue staff need them for their schedule, and coordinators for
 * venue availability in search/recommendations (coordinators already see
 * every event in full, so this exposes nothing new to them). Declared
 * before GET /:id so "venue-booking-info" isn't
 * read as an event id. Drafts are never returned: a draft can't have been
 * booked, and it isn't anyone's business but the organiser's.
 */
/**
 * A hoisted function declaration (not registered inline) so it can be
 * referenced by the early, internal-auth-aware route registration above
 * requireAuth — see the comment there. `user` is absent for a trusted
 * internal caller (venue-service's sweep); that skips the role check
 * entirely rather than rejecting it, same reasoning as user-service's
 * requireAuthOrInternal routes.
 */
async function venueBookingInfoHandler(req: AuthedRequest, res: Response): Promise<void> {
  if (stryMutAct_9fa48("1638")) {
    {}
  } else {
    stryCov_9fa48("1638");
    const {
      supabase,
      user
    } = req;
    if (stryMutAct_9fa48("1641") ? false : stryMutAct_9fa48("1640") ? true : stryMutAct_9fa48("1639") ? supabase : (stryCov_9fa48("1639", "1640", "1641"), !supabase)) {
      if (stryMutAct_9fa48("1642")) {
        {}
      } else {
        stryCov_9fa48("1642");
        res.status(401).json(stryMutAct_9fa48("1644") ? {} : (stryCov_9fa48("1644"), {
          error: stryMutAct_9fa48("1645") ? "" : (stryCov_9fa48("1645"), "Unauthenticated")
        }));
        return;
      }
    }
    const rawIds = (stryMutAct_9fa48("1648") ? typeof req.query.ids !== "string" : stryMutAct_9fa48("1647") ? false : stryMutAct_9fa48("1646") ? true : (stryCov_9fa48("1646", "1647", "1648"), typeof req.query.ids === (stryMutAct_9fa48("1649") ? "" : (stryCov_9fa48("1649"), "string")))) ? req.query.ids : stryMutAct_9fa48("1650") ? "Stryker was here!" : (stryCov_9fa48("1650"), "");
    if (stryMutAct_9fa48("1653") ? user || !VENUE_BOOKING_INFO_ROLES.has(user.role) : stryMutAct_9fa48("1652") ? false : stryMutAct_9fa48("1651") ? true : (stryCov_9fa48("1651", "1652", "1653"), user && (stryMutAct_9fa48("1654") ? VENUE_BOOKING_INFO_ROLES.has(user.role) : (stryCov_9fa48("1654"), !VENUE_BOOKING_INFO_ROLES.has(user.role))))) {
      if (stryMutAct_9fa48("1655")) {
        {}
      } else {
        stryCov_9fa48("1655");
        await recordAccessDenial(supabase, user.id, rawIds, stryMutAct_9fa48("1656") ? "" : (stryCov_9fa48("1656"), "venue_booking_info_role_not_allowed"));
        res.status(403).json(stryMutAct_9fa48("1658") ? {} : (stryCov_9fa48("1658"), {
          error: stryMutAct_9fa48("1659") ? "" : (stryCov_9fa48("1659"), "Access denied")
        }));
        return;
      }
    }
    const idStrings = rawIds.split(stryMutAct_9fa48("1660") ? "" : (stryCov_9fa48("1660"), ",")).map(stryMutAct_9fa48("1661") ? () => undefined : (stryCov_9fa48("1661"), id => stryMutAct_9fa48("1662") ? id : (stryCov_9fa48("1662"), id.trim())));
    // An absent or empty list splits to [""], which is not a positive integer, so it is refused here too.
    if (stryMutAct_9fa48("1665") ? !idStrings.every(isPositiveInteger) && idStrings.length > MAX_VENUE_BOOKING_INFO_IDS : stryMutAct_9fa48("1664") ? false : stryMutAct_9fa48("1663") ? true : (stryCov_9fa48("1663", "1664", "1665"), (stryMutAct_9fa48("1666") ? idStrings.every(isPositiveInteger) : (stryCov_9fa48("1666"), !(stryMutAct_9fa48("1667") ? idStrings.some(isPositiveInteger) : (stryCov_9fa48("1667"), idStrings.every(isPositiveInteger))))) || (stryMutAct_9fa48("1670") ? idStrings.length <= MAX_VENUE_BOOKING_INFO_IDS : stryMutAct_9fa48("1669") ? idStrings.length >= MAX_VENUE_BOOKING_INFO_IDS : stryMutAct_9fa48("1668") ? false : (stryCov_9fa48("1668", "1669", "1670"), idStrings.length > MAX_VENUE_BOOKING_INFO_IDS)))) {
      if (stryMutAct_9fa48("1671")) {
        {}
      } else {
        stryCov_9fa48("1671");
        res.status(400).json(stryMutAct_9fa48("1673") ? {} : (stryCov_9fa48("1673"), {
          error: stryMutAct_9fa48("1674") ? `` : (stryCov_9fa48("1674"), `ids must be 1–${MAX_VENUE_BOOKING_INFO_IDS} comma-separated event ids`)
        }));
        return;
      }
    }
    const ids = stryMutAct_9fa48("1675") ? [] : (stryCov_9fa48("1675"), [...new Set(idStrings.map(Number))]);
    const {
      data,
      error
    } = await supabase.from(stryMutAct_9fa48("1676") ? "" : (stryCov_9fa48("1676"), "events")).select(stryMutAct_9fa48("1677") ? "" : (stryCov_9fa48("1677"), "id, status, submitted_details, coordinator_id")).in(stryMutAct_9fa48("1678") ? "" : (stryCov_9fa48("1678"), "id"), ids).neq(stryMutAct_9fa48("1679") ? "" : (stryCov_9fa48("1679"), "status"), stryMutAct_9fa48("1680") ? "" : (stryCov_9fa48("1680"), "Draft"));
    if (stryMutAct_9fa48("1682") ? false : stryMutAct_9fa48("1681") ? true : (stryCov_9fa48("1681", "1682"), error)) {
      if (stryMutAct_9fa48("1683")) {
        {}
      } else {
        stryCov_9fa48("1683");
        res.status(500).json(stryMutAct_9fa48("1685") ? {} : (stryCov_9fa48("1685"), {
          error: stryMutAct_9fa48("1686") ? "" : (stryCov_9fa48("1686"), "Failed to load events")
        }));
        return;
      }
    }

    // The lifecycle status rides along because venue-service needs it to
    // decide on a booking (E4-10 AC2: a venue can only be held or approved
    // while the event is still in "Planning"). Venue staff can't call
    // GET /:id — it is owner-or-coordinator only — and the status says
    // nothing about the event's content, so it belongs in this narrow view
    // rather than widening that one.
    const events = (stryMutAct_9fa48("1687") ? data && [] : (stryCov_9fa48("1687"), data ?? (stryMutAct_9fa48("1688") ? ["Stryker was here"] : (stryCov_9fa48("1688"), [])))).map(row => {
      if (stryMutAct_9fa48("1689")) {
        {}
      } else {
        stryCov_9fa48("1689");
        const details = (row.submitted_details ?? {}) as Record<string, unknown>;
        // E4-3: venue-service needs the assigned coordinator's id (only the id,
        // never their name or contact details) to tell them a blocked-out
        // venue means their booking needs a replacement.
        const info: Record<string, unknown> = stryMutAct_9fa48("1690") ? {} : (stryCov_9fa48("1690"), {
          id: row.id,
          status: row.status,
          coordinatorId: stryMutAct_9fa48("1691") ? row.coordinator_id && null : (stryCov_9fa48("1691"), row.coordinator_id ?? null)
        });
        for (const field of VENUE_BOOKING_INFO_FIELDS) info[field] = stryMutAct_9fa48("1692") ? details[field] && null : (stryCov_9fa48("1692"), details[field] ?? null);
        return info;
      }
    });
    res.json(stryMutAct_9fa48("1694") ? {} : (stryCov_9fa48("1694"), {
      events
    }));
  }
}

/**
 * E6: the only fields an Attendee may see about an event — what is safe to
 * show someone who is not part of the planning. Built as a whitelist, never
 * by filtering a fuller object, so a field added to submitted_details later
 * stays private until it is listed here. No coordinator, purpose, equipment,
 * review outcome, history or clarifications, and of the organiser only their
 * display name (never their id, email or contact details). The accessibility
 * note and the capacity (expected attendance) are added explicitly by the
 * routes below.
 */
export const ATTENDEE_INFO_FIELDS = ["name", "description", "proposedDate", "startTime", "endTime"] as const;

/** Whole-field answers that mean "nothing to note" (same list venue-service uses for requirements). */
const NO_ACCESSIBILITY_INFO_PATTERN = stryMutAct_9fa48("1700") ? /^(n\/?a|nil|none|no|nope|-+|not applicable|no preference|no requirements?|not required|not needed)\.$/i : stryMutAct_9fa48("1699") ? /^(n\/?a|nil|none|no|nope|-+|not applicable|no preference|no requirements|not required|not needed)\.?$/i : stryMutAct_9fa48("1698") ? /^(n\/?a|nil|none|no|nope|-|not applicable|no preference|no requirements?|not required|not needed)\.?$/i : stryMutAct_9fa48("1697") ? /^(n\/a|nil|none|no|nope|-+|not applicable|no preference|no requirements?|not required|not needed)\.?$/i : stryMutAct_9fa48("1696") ? /^(n\/?a|nil|none|no|nope|-+|not applicable|no preference|no requirements?|not required|not needed)\.?/i : stryMutAct_9fa48("1695") ? /(n\/?a|nil|none|no|nope|-+|not applicable|no preference|no requirements?|not required|not needed)\.?$/i : (stryCov_9fa48("1695", "1696", "1697", "1698", "1699", "1700"), /^(n\/?a|nil|none|no|nope|-+|not applicable|no preference|no requirements?|not required|not needed)\.?$/i);

/**
 * The organiser's accessibility note, as written, for attendees. Blank or a
 * "NA"/"None" style answer is no note at all, so the card shows nothing
 * rather than "None".
 */
export function attendeeAccessibility(value: unknown): string | null {
  if (stryMutAct_9fa48("1701")) {
    {}
  } else {
    stryCov_9fa48("1701");
    if (stryMutAct_9fa48("1704") ? typeof value === "string" : stryMutAct_9fa48("1703") ? false : stryMutAct_9fa48("1702") ? true : (stryCov_9fa48("1702", "1703", "1704"), typeof value !== (stryMutAct_9fa48("1705") ? "" : (stryCov_9fa48("1705"), "string")))) return null;
    const text = stryMutAct_9fa48("1706") ? value : (stryCov_9fa48("1706"), value.trim());
    return (stryMutAct_9fa48("1709") ? text === "" && NO_ACCESSIBILITY_INFO_PATTERN.test(text) : stryMutAct_9fa48("1708") ? false : stryMutAct_9fa48("1707") ? true : (stryCov_9fa48("1707", "1708", "1709"), (stryMutAct_9fa48("1711") ? text !== "" : stryMutAct_9fa48("1710") ? false : (stryCov_9fa48("1710", "1711"), text === (stryMutAct_9fa48("1712") ? "Stryker was here!" : (stryCov_9fa48("1712"), "")))) || NO_ACCESSIBILITY_INFO_PATTERN.test(text))) ? null : text;
  }
}

/**
 * How many attendees may register, shown to attendees as slots left. The
 * single place capacity is decided: today it is the organiser's expected
 * attendance; a dedicated registration limit would be read here instead.
 * Null when there is no usable number (older events), meaning no cap.
 */
export function attendeeCapacity(details: Record<string, unknown>): number | null {
  if (stryMutAct_9fa48("1713")) {
    {}
  } else {
    stryCov_9fa48("1713");
    const value = Number(details.expectedAttendance);
    return (stryMutAct_9fa48("1716") ? Number.isInteger(value) || value > 0 : stryMutAct_9fa48("1715") ? false : stryMutAct_9fa48("1714") ? true : (stryCov_9fa48("1714", "1715", "1716"), Number.isInteger(value) && (stryMutAct_9fa48("1719") ? value <= 0 : stryMutAct_9fa48("1718") ? value >= 0 : stryMutAct_9fa48("1717") ? true : (stryCov_9fa48("1717", "1718", "1719"), value > 0)))) ? value : null;
  }
}

/**
 * The organiser's display name for attendees, from the `organiser:organiser_id(name)`
 * embed. Name only: nothing else about the organiser is read or returned.
 */
export function attendeeOrganiserName(organiser: unknown): string | null {
  if (stryMutAct_9fa48("1720")) {
    {}
  } else {
    stryCov_9fa48("1720");
    const record = (Array.isArray(organiser) ? organiser[0] : organiser) as {
      name?: unknown;
    } | null | undefined;
    const name = stryMutAct_9fa48("1721") ? record.name : (stryCov_9fa48("1721"), record?.name);
    return (stryMutAct_9fa48("1724") ? typeof name === "string" || name.trim() !== "" : stryMutAct_9fa48("1723") ? false : stryMutAct_9fa48("1722") ? true : (stryCov_9fa48("1722", "1723", "1724"), (stryMutAct_9fa48("1726") ? typeof name !== "string" : stryMutAct_9fa48("1725") ? true : (stryCov_9fa48("1725", "1726"), typeof name === (stryMutAct_9fa48("1727") ? "" : (stryCov_9fa48("1727"), "string")))) && (stryMutAct_9fa48("1729") ? name.trim() === "" : stryMutAct_9fa48("1728") ? true : (stryCov_9fa48("1728", "1729"), (stryMutAct_9fa48("1730") ? name : (stryCov_9fa48("1730"), name.trim())) !== (stryMutAct_9fa48("1731") ? "Stryker was here!" : (stryCov_9fa48("1731"), "")))))) ? stryMutAct_9fa48("1732") ? name : (stryCov_9fa48("1732"), name.trim()) : null;
  }
}
const MAX_ATTENDEE_INFO_IDS = 100;
interface RegistrationRowFields {
  status: string;
  registration_open_date?: unknown;
  registration_override?: unknown;
}

/**
 * The registration period as attendees need it: the state (NOT_OPEN, OPEN or
 * CLOSED — registration-service turns OPEN into FULL when no places are left,
 * since it owns the count), whether the event is listed, and `open` (state is
 * OPEN). Lives here, with the event data, so registration-service doesn't
 * re-derive it. Times are Singapore time (lib/eventTiming.ts); the rules are
 * in lib/registrationPeriod.ts.
 */
export function registrationInfo(row: RegistrationRowFields, details: Record<string, unknown>, now: Date = clock.now()) {
  if (stryMutAct_9fa48("1733")) {
    {}
  } else {
    stryCov_9fa48("1733");
    const inputs = stryMutAct_9fa48("1734") ? {} : (stryCov_9fa48("1734"), {
      status: row.status,
      details,
      openDate: row.registration_open_date,
      override: row.registration_override
    });
    const registrationState = getRegistrationState(inputs, now);
    return stryMutAct_9fa48("1735") ? {} : (stryCov_9fa48("1735"), {
      registrationState,
      listed: isListed(inputs, now),
      open: stryMutAct_9fa48("1738") ? registrationState !== REGISTRATION_STATE.Open : stryMutAct_9fa48("1737") ? false : stryMutAct_9fa48("1736") ? true : (stryCov_9fa48("1736", "1737", "1738"), registrationState === REGISTRATION_STATE.Open)
    });
  }
}

/**
 * E6: attendee-facing info for a batch of events, called by
 * registration-service with the caller's own token. Attendees only — other
 * roles have fuller routes. Declared before GET /:id so "attendee-info"
 * isn't read as an event id. Drafts are never returned.
 *
 * An event is returned whether or not it is open: registration-service
 * decides whether *this* attendee may see it (registered, or open), using
 * the `open` flag computed here. Ids that don't exist are simply absent.
 */
if (stryMutAct_9fa48("1739")) {
  ;
} else {
  stryCov_9fa48("1739");
  eventsRouter.get(stryMutAct_9fa48("1740") ? "" : (stryCov_9fa48("1740"), "/attendee-info"), async (req: AuthedRequest, res) => {
    if (stryMutAct_9fa48("1741")) {
      {}
    } else {
      stryCov_9fa48("1741");
      const {
        supabase,
        user
      } = req;
      if (stryMutAct_9fa48("1744") ? !supabase && !user : stryMutAct_9fa48("1743") ? false : stryMutAct_9fa48("1742") ? true : (stryCov_9fa48("1742", "1743", "1744"), (stryMutAct_9fa48("1745") ? supabase : (stryCov_9fa48("1745"), !supabase)) || (stryMutAct_9fa48("1746") ? user : (stryCov_9fa48("1746"), !user)))) {
        if (stryMutAct_9fa48("1747")) {
          {}
        } else {
          stryCov_9fa48("1747");
          res.status(401).json(stryMutAct_9fa48("1749") ? {} : (stryCov_9fa48("1749"), {
            error: stryMutAct_9fa48("1750") ? "" : (stryCov_9fa48("1750"), "Unauthenticated")
          }));
          return;
        }
      }
      const rawIds = (stryMutAct_9fa48("1753") ? typeof req.query.ids !== "string" : stryMutAct_9fa48("1752") ? false : stryMutAct_9fa48("1751") ? true : (stryCov_9fa48("1751", "1752", "1753"), typeof req.query.ids === (stryMutAct_9fa48("1754") ? "" : (stryCov_9fa48("1754"), "string")))) ? req.query.ids : stryMutAct_9fa48("1755") ? "Stryker was here!" : (stryCov_9fa48("1755"), "");
      if (stryMutAct_9fa48("1758") ? user.role === "attendee" : stryMutAct_9fa48("1757") ? false : stryMutAct_9fa48("1756") ? true : (stryCov_9fa48("1756", "1757", "1758"), user.role !== (stryMutAct_9fa48("1759") ? "" : (stryCov_9fa48("1759"), "attendee")))) {
        if (stryMutAct_9fa48("1760")) {
          {}
        } else {
          stryCov_9fa48("1760");
          await recordAccessDenial(supabase, user.id, rawIds, stryMutAct_9fa48("1761") ? "" : (stryCov_9fa48("1761"), "attendee_info_role_not_allowed"));
          res.status(403).json(stryMutAct_9fa48("1763") ? {} : (stryCov_9fa48("1763"), {
            error: stryMutAct_9fa48("1764") ? "" : (stryCov_9fa48("1764"), "Access denied")
          }));
          return;
        }
      }
      const idStrings = rawIds.split(stryMutAct_9fa48("1765") ? "" : (stryCov_9fa48("1765"), ",")).map(stryMutAct_9fa48("1766") ? () => undefined : (stryCov_9fa48("1766"), id => stryMutAct_9fa48("1767") ? id : (stryCov_9fa48("1767"), id.trim())));
      // An absent or empty list splits to [""], which is not a positive integer, so it is refused here too.
      if (stryMutAct_9fa48("1770") ? !idStrings.every(isPositiveInteger) && idStrings.length > MAX_ATTENDEE_INFO_IDS : stryMutAct_9fa48("1769") ? false : stryMutAct_9fa48("1768") ? true : (stryCov_9fa48("1768", "1769", "1770"), (stryMutAct_9fa48("1771") ? idStrings.every(isPositiveInteger) : (stryCov_9fa48("1771"), !(stryMutAct_9fa48("1772") ? idStrings.some(isPositiveInteger) : (stryCov_9fa48("1772"), idStrings.every(isPositiveInteger))))) || (stryMutAct_9fa48("1775") ? idStrings.length <= MAX_ATTENDEE_INFO_IDS : stryMutAct_9fa48("1774") ? idStrings.length >= MAX_ATTENDEE_INFO_IDS : stryMutAct_9fa48("1773") ? false : (stryCov_9fa48("1773", "1774", "1775"), idStrings.length > MAX_ATTENDEE_INFO_IDS)))) {
        if (stryMutAct_9fa48("1776")) {
          {}
        } else {
          stryCov_9fa48("1776");
          res.status(400).json(stryMutAct_9fa48("1778") ? {} : (stryCov_9fa48("1778"), {
            error: stryMutAct_9fa48("1779") ? `` : (stryCov_9fa48("1779"), `ids must be 1–${MAX_ATTENDEE_INFO_IDS} comma-separated event ids`)
          }));
          return;
        }
      }
      const ids = stryMutAct_9fa48("1780") ? [] : (stryCov_9fa48("1780"), [...new Set(idStrings.map(Number))]);
      const {
        data,
        error
      } = await supabase.from(stryMutAct_9fa48("1781") ? "" : (stryCov_9fa48("1781"), "events")).select(stryMutAct_9fa48("1782") ? "" : (stryCov_9fa48("1782"), "id, status, submitted_details, registration_open_date, registration_override, organiser:organiser_id(name)")).in(stryMutAct_9fa48("1783") ? "" : (stryCov_9fa48("1783"), "id"), ids).neq(stryMutAct_9fa48("1784") ? "" : (stryCov_9fa48("1784"), "status"), stryMutAct_9fa48("1785") ? "" : (stryCov_9fa48("1785"), "Draft"));
      if (stryMutAct_9fa48("1787") ? false : stryMutAct_9fa48("1786") ? true : (stryCov_9fa48("1786", "1787"), error)) {
        if (stryMutAct_9fa48("1788")) {
          {}
        } else {
          stryCov_9fa48("1788");
          res.status(500).json(stryMutAct_9fa48("1790") ? {} : (stryCov_9fa48("1790"), {
            error: stryMutAct_9fa48("1791") ? "" : (stryCov_9fa48("1791"), "Failed to load events")
          }));
          return;
        }
      }
      const events = (stryMutAct_9fa48("1792") ? data && [] : (stryCov_9fa48("1792"), data ?? (stryMutAct_9fa48("1793") ? ["Stryker was here"] : (stryCov_9fa48("1793"), [])))).map(row => {
        if (stryMutAct_9fa48("1794")) {
          {}
        } else {
          stryCov_9fa48("1794");
          const details = (row.submitted_details ?? {}) as Record<string, unknown>;
          const info: Record<string, unknown> = stryMutAct_9fa48("1795") ? {} : (stryCov_9fa48("1795"), {
            id: row.id,
            registrationNeeded: stryMutAct_9fa48("1798") ? details.registrationNeeded !== true : stryMutAct_9fa48("1797") ? false : stryMutAct_9fa48("1796") ? true : (stryCov_9fa48("1796", "1797", "1798"), details.registrationNeeded === (stryMutAct_9fa48("1799") ? false : (stryCov_9fa48("1799"), true))),
            ...registrationInfo(row, details),
            accessibility: attendeeAccessibility(details.accessibility),
            capacity: attendeeCapacity(details),
            organiserName: attendeeOrganiserName(row.organiser),
            // E6-4: an attendee may withdraw until the event starts.
            hasStarted: hasEventStarted(details)
          });
          for (const field of ATTENDEE_INFO_FIELDS) info[field] = stryMutAct_9fa48("1800") ? details[field] && null : (stryCov_9fa48("1800"), details[field] ?? null);
          return info;
        }
      });
      res.json(stryMutAct_9fa48("1802") ? {} : (stryCov_9fa48("1802"), {
        events
      }));
    }
  });
}
/**
 * E6: Confirmed events currently open for registration, so an attendee can
 * find something to register for. Same whitelist as GET /attendee-info.
 * Declared before GET /:id.
 */
if (stryMutAct_9fa48("1803")) {
  ;
} else {
  stryCov_9fa48("1803");
  eventsRouter.get(stryMutAct_9fa48("1804") ? "" : (stryCov_9fa48("1804"), "/open-for-registration"), async (req: AuthedRequest, res) => {
    if (stryMutAct_9fa48("1805")) {
      {}
    } else {
      stryCov_9fa48("1805");
      const {
        supabase,
        user
      } = req;
      if (stryMutAct_9fa48("1808") ? !supabase && !user : stryMutAct_9fa48("1807") ? false : stryMutAct_9fa48("1806") ? true : (stryCov_9fa48("1806", "1807", "1808"), (stryMutAct_9fa48("1809") ? supabase : (stryCov_9fa48("1809"), !supabase)) || (stryMutAct_9fa48("1810") ? user : (stryCov_9fa48("1810"), !user)))) {
        if (stryMutAct_9fa48("1811")) {
          {}
        } else {
          stryCov_9fa48("1811");
          res.status(401).json(stryMutAct_9fa48("1813") ? {} : (stryCov_9fa48("1813"), {
            error: stryMutAct_9fa48("1814") ? "" : (stryCov_9fa48("1814"), "Unauthenticated")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("1817") ? user.role === "attendee" : stryMutAct_9fa48("1816") ? false : stryMutAct_9fa48("1815") ? true : (stryCov_9fa48("1815", "1816", "1817"), user.role !== (stryMutAct_9fa48("1818") ? "" : (stryCov_9fa48("1818"), "attendee")))) {
        if (stryMutAct_9fa48("1819")) {
          {}
        } else {
          stryCov_9fa48("1819");
          await recordAccessDenial(supabase, user.id, stryMutAct_9fa48("1820") ? "Stryker was here!" : (stryCov_9fa48("1820"), ""), stryMutAct_9fa48("1821") ? "" : (stryCov_9fa48("1821"), "open_for_registration_role_not_allowed"));
          res.status(403).json(stryMutAct_9fa48("1823") ? {} : (stryCov_9fa48("1823"), {
            error: stryMutAct_9fa48("1824") ? "" : (stryCov_9fa48("1824"), "Access denied")
          }));
          return;
        }
      }
      const {
        data,
        error
      } = await supabase.from(stryMutAct_9fa48("1825") ? "" : (stryCov_9fa48("1825"), "events")).select(stryMutAct_9fa48("1826") ? "" : (stryCov_9fa48("1826"), "id, status, submitted_details, registration_open_date, registration_override, organiser:organiser_id(name)")).eq(stryMutAct_9fa48("1827") ? "" : (stryCov_9fa48("1827"), "status"), stryMutAct_9fa48("1828") ? "" : (stryCov_9fa48("1828"), "Confirmed"));
      if (stryMutAct_9fa48("1830") ? false : stryMutAct_9fa48("1829") ? true : (stryCov_9fa48("1829", "1830"), error)) {
        if (stryMutAct_9fa48("1831")) {
          {}
        } else {
          stryCov_9fa48("1831");
          res.status(500).json(stryMutAct_9fa48("1833") ? {} : (stryCov_9fa48("1833"), {
            error: stryMutAct_9fa48("1834") ? "" : (stryCov_9fa48("1834"), "Failed to load events")
          }));
          return;
        }
      }

      // Stryker disable next-line ArrayDeclaration: equivalent - a placeholder row has no status, so it is never listed
      const events = stryMutAct_9fa48("1835") ? (data ?? []).map(row => ({
        row,
        details: (row.submitted_details ?? {}) as Record<string, unknown>
      })).map(({
        row,
        details
      }) => {
        const info: Record<string, unknown> = {
          id: row.id,
          registrationNeeded: true,
          ...registrationInfo(row, details),
          accessibility: attendeeAccessibility(details.accessibility),
          capacity: attendeeCapacity(details),
          organiserName: attendeeOrganiserName(row.organiser)
        };
        for (const field of ATTENDEE_INFO_FIELDS) info[field] = details[field] ?? null;
        return info;
      }) : (stryCov_9fa48("1835"), (stryMutAct_9fa48("1836") ? data && [] : (stryCov_9fa48("1836"), data ?? [])).map(stryMutAct_9fa48("1838") ? () => undefined : (stryCov_9fa48("1838"), row => stryMutAct_9fa48("1839") ? {} : (stryCov_9fa48("1839"), {
        row,
        details: (row.submitted_details ?? {}) as Record<string, unknown>
      }))).filter(stryMutAct_9fa48("1840") ? () => undefined : (stryCov_9fa48("1840"), ({
        row,
        details
      }) => registrationInfo(row, details).listed)).map(({
        row,
        details
      }) => {
        if (stryMutAct_9fa48("1841")) {
          {}
        } else {
          stryCov_9fa48("1841");
          const info: Record<string, unknown> = stryMutAct_9fa48("1842") ? {} : (stryCov_9fa48("1842"), {
            id: row.id,
            registrationNeeded: stryMutAct_9fa48("1843") ? false : (stryCov_9fa48("1843"), true),
            ...registrationInfo(row, details),
            accessibility: attendeeAccessibility(details.accessibility),
            capacity: attendeeCapacity(details),
            organiserName: attendeeOrganiserName(row.organiser)
          });
          for (const field of ATTENDEE_INFO_FIELDS) info[field] = stryMutAct_9fa48("1844") ? details[field] && null : (stryCov_9fa48("1844"), details[field] ?? null);
          return info;
        }
      }));
      res.json(stryMutAct_9fa48("1846") ? {} : (stryCov_9fa48("1846"), {
        events
      }));
    }
  });
}
/**
 * E1-8 AC1/AC3: the Event Coordinator Lead's unassigned queue — every
 * submitted request still waiting for a coordinator, oldest submission
 * first so the longest-waiting request is allocated first. Lead only; any
 * other role is denied and the attempt recorded, same as a direct-URL
 * attempt on someone else's event. Declared before GET /:id so
 * "unassigned" isn't read as an event id.
 */
if (stryMutAct_9fa48("1847")) {
  ;
} else {
  stryCov_9fa48("1847");
  eventsRouter.get(stryMutAct_9fa48("1848") ? "" : (stryCov_9fa48("1848"), "/unassigned"), async (req: AuthedRequest, res) => {
    if (stryMutAct_9fa48("1849")) {
      {}
    } else {
      stryCov_9fa48("1849");
      const {
        supabase,
        user
      } = req;
      if (stryMutAct_9fa48("1852") ? !supabase && !user : stryMutAct_9fa48("1851") ? false : stryMutAct_9fa48("1850") ? true : (stryCov_9fa48("1850", "1851", "1852"), (stryMutAct_9fa48("1853") ? supabase : (stryCov_9fa48("1853"), !supabase)) || (stryMutAct_9fa48("1854") ? user : (stryCov_9fa48("1854"), !user)))) {
        if (stryMutAct_9fa48("1855")) {
          {}
        } else {
          stryCov_9fa48("1855");
          res.status(401).json(stryMutAct_9fa48("1857") ? {} : (stryCov_9fa48("1857"), {
            error: stryMutAct_9fa48("1858") ? "" : (stryCov_9fa48("1858"), "Unauthenticated")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("1861") ? user.role === COORDINATOR_LEAD_ROLE : stryMutAct_9fa48("1860") ? false : stryMutAct_9fa48("1859") ? true : (stryCov_9fa48("1859", "1860", "1861"), user.role !== COORDINATOR_LEAD_ROLE)) {
        if (stryMutAct_9fa48("1862")) {
          {}
        } else {
          stryCov_9fa48("1862");
          await recordAccessDenial(supabase, user.id, stryMutAct_9fa48("1863") ? "" : (stryCov_9fa48("1863"), "unassigned_queue"), stryMutAct_9fa48("1864") ? "" : (stryCov_9fa48("1864"), "unassigned_queue_role_not_allowed"));
          res.status(403).json(stryMutAct_9fa48("1866") ? {} : (stryCov_9fa48("1866"), {
            error: stryMutAct_9fa48("1867") ? "" : (stryCov_9fa48("1867"), "Access denied")
          }));
          return;
        }
      }
      const {
        data,
        error
      } = await supabase.from(stryMutAct_9fa48("1868") ? "" : (stryCov_9fa48("1868"), "events")).select(EVENT_COLUMNS).eq(stryMutAct_9fa48("1869") ? "" : (stryCov_9fa48("1869"), "status"), EVENT_STATUS.Unassigned).is(stryMutAct_9fa48("1870") ? "" : (stryCov_9fa48("1870"), "coordinator_id"), null).order(stryMutAct_9fa48("1871") ? "" : (stryCov_9fa48("1871"), "created_at"), stryMutAct_9fa48("1872") ? {} : (stryCov_9fa48("1872"), {
        ascending: stryMutAct_9fa48("1873") ? false : (stryCov_9fa48("1873"), true)
      }));
      if (stryMutAct_9fa48("1875") ? false : stryMutAct_9fa48("1874") ? true : (stryCov_9fa48("1874", "1875"), error)) {
        if (stryMutAct_9fa48("1876")) {
          {}
        } else {
          stryCov_9fa48("1876");
          res.status(500).json(stryMutAct_9fa48("1878") ? {} : (stryCov_9fa48("1878"), {
            error: stryMutAct_9fa48("1879") ? "" : (stryCov_9fa48("1879"), "Failed to load the unassigned queue")
          }));
          return;
        }
      }
      res.json(stryMutAct_9fa48("1881") ? {} : (stryCov_9fa48("1881"), {
        events: stryMutAct_9fa48("1882") ? data && [] : (stryCov_9fa48("1882"), data ?? (stryMutAct_9fa48("1883") ? ["Stryker was here"] : (stryCov_9fa48("1883"), [])))
      }));
    }
  });
}
/**
 * E1-10: the Safety Officer's queue — every event awaiting an Operational
 * Safety Check, with the coordinator's safety notes from their latest
 * submission (E3-4), so the Safety Officer can assess without a second
 * request. Any Safety Officer sees every event in Safety Review — there's
 * no per-officer assignment. Declared before GET /:id so
 * "safety-review-queue" isn't read as an event id.
 */
if (stryMutAct_9fa48("1884")) {
  ;
} else {
  stryCov_9fa48("1884");
  eventsRouter.get(stryMutAct_9fa48("1885") ? "" : (stryCov_9fa48("1885"), "/safety-review-queue"), async (req: AuthedRequest, res) => {
    if (stryMutAct_9fa48("1886")) {
      {}
    } else {
      stryCov_9fa48("1886");
      const {
        supabase,
        user
      } = req;
      if (stryMutAct_9fa48("1889") ? !supabase && !user : stryMutAct_9fa48("1888") ? false : stryMutAct_9fa48("1887") ? true : (stryCov_9fa48("1887", "1888", "1889"), (stryMutAct_9fa48("1890") ? supabase : (stryCov_9fa48("1890"), !supabase)) || (stryMutAct_9fa48("1891") ? user : (stryCov_9fa48("1891"), !user)))) {
        if (stryMutAct_9fa48("1892")) {
          {}
        } else {
          stryCov_9fa48("1892");
          res.status(401).json(stryMutAct_9fa48("1894") ? {} : (stryCov_9fa48("1894"), {
            error: stryMutAct_9fa48("1895") ? "" : (stryCov_9fa48("1895"), "Unauthenticated")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("1898") ? user.role === "safety_officer" : stryMutAct_9fa48("1897") ? false : stryMutAct_9fa48("1896") ? true : (stryCov_9fa48("1896", "1897", "1898"), user.role !== (stryMutAct_9fa48("1899") ? "" : (stryCov_9fa48("1899"), "safety_officer")))) {
        if (stryMutAct_9fa48("1900")) {
          {}
        } else {
          stryCov_9fa48("1900");
          await recordAccessDenial(supabase, user.id, stryMutAct_9fa48("1901") ? "" : (stryCov_9fa48("1901"), "safety_review_queue"), stryMutAct_9fa48("1902") ? "" : (stryCov_9fa48("1902"), "safety_review_queue_role_not_allowed"));
          res.status(403).json(stryMutAct_9fa48("1904") ? {} : (stryCov_9fa48("1904"), {
            error: stryMutAct_9fa48("1905") ? "" : (stryCov_9fa48("1905"), "Access denied")
          }));
          return;
        }
      }
      const {
        data: events,
        error
      } = await supabase.from(stryMutAct_9fa48("1906") ? "" : (stryCov_9fa48("1906"), "events")).select(EVENT_COLUMNS).eq(stryMutAct_9fa48("1907") ? "" : (stryCov_9fa48("1907"), "status"), EVENT_STATUS.SafetyReview).order(stryMutAct_9fa48("1908") ? "" : (stryCov_9fa48("1908"), "created_at"), stryMutAct_9fa48("1909") ? {} : (stryCov_9fa48("1909"), {
        ascending: stryMutAct_9fa48("1910") ? false : (stryCov_9fa48("1910"), true)
      }));
      if (stryMutAct_9fa48("1912") ? false : stryMutAct_9fa48("1911") ? true : (stryCov_9fa48("1911", "1912"), error)) {
        if (stryMutAct_9fa48("1913")) {
          {}
        } else {
          stryCov_9fa48("1913");
          res.status(500).json(stryMutAct_9fa48("1915") ? {} : (stryCov_9fa48("1915"), {
            error: stryMutAct_9fa48("1916") ? "" : (stryCov_9fa48("1916"), "Failed to load the safety review queue")
          }));
          return;
        }
      }
      const eventIds = (stryMutAct_9fa48("1917") ? events && [] : (stryCov_9fa48("1917"), events ?? (stryMutAct_9fa48("1918") ? ["Stryker was here"] : (stryCov_9fa48("1918"), [])))).map(stryMutAct_9fa48("1919") ? () => undefined : (stryCov_9fa48("1919"), event => event.id));
      const {
        data: submissions,
        error: submissionsError
      } = await supabase.from(stryMutAct_9fa48("1920") ? "" : (stryCov_9fa48("1920"), "event_safety_submissions")).select(stryMutAct_9fa48("1921") ? "" : (stryCov_9fa48("1921"), "event_id, equipment_placement, crowd_movement, emergency_access, venue_restrictions, submitted_at")).in(stryMutAct_9fa48("1922") ? "" : (stryCov_9fa48("1922"), "event_id"), (stryMutAct_9fa48("1926") ? eventIds.length <= 0 : stryMutAct_9fa48("1925") ? eventIds.length >= 0 : stryMutAct_9fa48("1924") ? false : stryMutAct_9fa48("1923") ? true : (stryCov_9fa48("1923", "1924", "1925", "1926"), eventIds.length > 0)) ? eventIds : stryMutAct_9fa48("1927") ? [] : (stryCov_9fa48("1927"), [stryMutAct_9fa48("1928") ? +1 : (stryCov_9fa48("1928"), -1)])).order(stryMutAct_9fa48("1929") ? "" : (stryCov_9fa48("1929"), "submitted_at"), stryMutAct_9fa48("1930") ? {} : (stryCov_9fa48("1930"), {
        ascending: stryMutAct_9fa48("1931") ? true : (stryCov_9fa48("1931"), false)
      }));
      if (stryMutAct_9fa48("1933") ? false : stryMutAct_9fa48("1932") ? true : (stryCov_9fa48("1932", "1933"), submissionsError)) {
        if (stryMutAct_9fa48("1934")) {
          {}
        } else {
          stryCov_9fa48("1934");
          res.status(500).json(stryMutAct_9fa48("1936") ? {} : (stryCov_9fa48("1936"), {
            error: stryMutAct_9fa48("1937") ? "" : (stryCov_9fa48("1937"), "Failed to load safety notes")
          }));
          return;
        }
      }

      // Keep only the latest submission per event — resubmission after a
      // reject/changes-requested gets fresh notes and the earlier ones no
      // longer apply (E3-12 AC4).
      const latestByEvent = new Map<number, typeof submissions[number]>();
      for (const submission of stryMutAct_9fa48("1938") ? submissions && [] : (stryCov_9fa48("1938"), submissions ?? (stryMutAct_9fa48("1939") ? ["Stryker was here"] : (stryCov_9fa48("1939"), [])))) {
        if (stryMutAct_9fa48("1940")) {
          {}
        } else {
          stryCov_9fa48("1940");
          if (stryMutAct_9fa48("1943") ? false : stryMutAct_9fa48("1942") ? true : stryMutAct_9fa48("1941") ? latestByEvent.has(submission.event_id) : (stryCov_9fa48("1941", "1942", "1943"), !latestByEvent.has(submission.event_id))) if (stryMutAct_9fa48("1944")) {
            ;
          } else {
            stryCov_9fa48("1944");
            latestByEvent.set(submission.event_id, submission);
          }
        }
      }

      // E3-14: each event's venue bookings and equipment, so the Safety Officer
      // can pick which ones must change (AC1), and — for an event resubmitted
      // after a change request — which of those flags were addressed (AC3).
      // Read with the officer's own token; null when a service couldn't answer,
      // so the rest of the queue still loads.
      const authorization = req.headers.authorization!;
      const extras = await Promise.all((stryMutAct_9fa48("1945") ? events && [] : (stryCov_9fa48("1945"), events ?? (stryMutAct_9fa48("1946") ? ["Stryker was here"] : (stryCov_9fa48("1946"), [])))).map(async event => {
        if (stryMutAct_9fa48("1947")) {
          {}
        } else {
          stryCov_9fa48("1947");
          try {
            if (stryMutAct_9fa48("1948")) {
              {}
            } else {
              stryCov_9fa48("1948");
              const [bookings, equipment, changeRequest] = await Promise.all(stryMutAct_9fa48("1949") ? [] : (stryCov_9fa48("1949"), [fetchEventVenueBookings(event.id, authorization), fetchEventEquipmentRequests(event.id, authorization), loadChangeRequest(supabase, event.id, authorization)]));
              return stryMutAct_9fa48("1950") ? {} : (stryCov_9fa48("1950"), {
                arrangements: (stryMutAct_9fa48("1953") ? bookings.status === "ok" || equipment.status === "ok" : stryMutAct_9fa48("1952") ? false : stryMutAct_9fa48("1951") ? true : (stryCov_9fa48("1951", "1952", "1953"), (stryMutAct_9fa48("1955") ? bookings.status !== "ok" : stryMutAct_9fa48("1954") ? true : (stryCov_9fa48("1954", "1955"), bookings.status === (stryMutAct_9fa48("1956") ? "" : (stryCov_9fa48("1956"), "ok")))) && (stryMutAct_9fa48("1958") ? equipment.status !== "ok" : stryMutAct_9fa48("1957") ? true : (stryCov_9fa48("1957", "1958"), equipment.status === (stryMutAct_9fa48("1959") ? "" : (stryCov_9fa48("1959"), "ok")))))) ? arrangementOptions(bookings.value, equipment.value) : null,
                changeRequest: (stryMutAct_9fa48("1962") ? changeRequest.status !== "ok" : stryMutAct_9fa48("1961") ? false : stryMutAct_9fa48("1960") ? true : (stryCov_9fa48("1960", "1961", "1962"), changeRequest.status === (stryMutAct_9fa48("1963") ? "" : (stryCov_9fa48("1963"), "ok")))) ? changeRequest.value : null
              });
            }
          } catch {
            if (stryMutAct_9fa48("1964")) {
              {}
            } else {
              stryCov_9fa48("1964");
              // One event's extras failing must not take the whole queue down.
              return stryMutAct_9fa48("1965") ? {} : (stryCov_9fa48("1965"), {
                arrangements: null,
                changeRequest: null
              });
            }
          }
        }
      }));
      const result = (stryMutAct_9fa48("1966") ? events && [] : (stryCov_9fa48("1966"), events ?? (stryMutAct_9fa48("1967") ? ["Stryker was here"] : (stryCov_9fa48("1967"), [])))).map((event, index) => {
        if (stryMutAct_9fa48("1968")) {
          {}
        } else {
          stryCov_9fa48("1968");
          const submission = latestByEvent.get(event.id);
          return stryMutAct_9fa48("1969") ? {} : (stryCov_9fa48("1969"), {
            ...event,
            safetyNotes: submission ? stryMutAct_9fa48("1970") ? {} : (stryCov_9fa48("1970"), {
              equipmentPlacement: submission.equipment_placement,
              crowdMovement: submission.crowd_movement,
              emergencyAccess: submission.emergency_access,
              venueRestrictions: submission.venue_restrictions
            }) : null,
            ...extras[index]
          });
        }
      });
      res.json(stryMutAct_9fa48("1972") ? {} : (stryCov_9fa48("1972"), {
        events: result
      }));
    }
  });
}
/**
 * Fetch a single event by id. The service-role client returns any row
 * regardless of ownership, so ownership/role is checked explicitly here;
 * a non-owner (and non-coordinator) request is treated the same as
 * "not found" and the attempt is recorded for audit purposes.
 *
 * E1-8 AC2: the Event Coordinator Lead may open any submitted event (not a
 * draft — a draft hasn't entered the process). Read-only: every write
 * route below rejects the Lead's role.
 */
if (stryMutAct_9fa48("1973")) {
  ;
} else {
  stryCov_9fa48("1973");
  eventsRouter.get(stryMutAct_9fa48("1974") ? "" : (stryCov_9fa48("1974"), "/:id"), async (req: AuthedRequest, res) => {
    if (stryMutAct_9fa48("1975")) {
      {}
    } else {
      stryCov_9fa48("1975");
      const {
        supabase,
        user
      } = req;
      if (stryMutAct_9fa48("1978") ? !supabase && !user : stryMutAct_9fa48("1977") ? false : stryMutAct_9fa48("1976") ? true : (stryCov_9fa48("1976", "1977", "1978"), (stryMutAct_9fa48("1979") ? supabase : (stryCov_9fa48("1979"), !supabase)) || (stryMutAct_9fa48("1980") ? user : (stryCov_9fa48("1980"), !user)))) {
        if (stryMutAct_9fa48("1981")) {
          {}
        } else {
          stryCov_9fa48("1981");
          res.status(401).json(stryMutAct_9fa48("1983") ? {} : (stryCov_9fa48("1983"), {
            error: stryMutAct_9fa48("1984") ? "" : (stryCov_9fa48("1984"), "Unauthenticated")
          }));
          return;
        }
      }
      const eventId = routeParam(req.params.id);
      if (stryMutAct_9fa48("1987") ? false : stryMutAct_9fa48("1986") ? true : stryMutAct_9fa48("1985") ? isPositiveInteger(eventId) : (stryCov_9fa48("1985", "1986", "1987"), !isPositiveInteger(eventId))) {
        if (stryMutAct_9fa48("1988")) {
          {}
        } else {
          stryCov_9fa48("1988");
          await recordAccessDenial(supabase, user.id, eventId, stryMutAct_9fa48("1989") ? "" : (stryCov_9fa48("1989"), "invalid_id_format"));
          res.status(403).json(stryMutAct_9fa48("1991") ? {} : (stryCov_9fa48("1991"), {
            error: stryMutAct_9fa48("1992") ? "" : (stryCov_9fa48("1992"), "Access denied")
          }));
          return;
        }
      }
      const {
        data,
        error
      } = await supabase.from(stryMutAct_9fa48("1993") ? "" : (stryCov_9fa48("1993"), "events")).select(stryMutAct_9fa48("1994") ? `` : (stryCov_9fa48("1994"), `${EVENT_COLUMNS}, organiser_id`)).eq(stryMutAct_9fa48("1995") ? "" : (stryCov_9fa48("1995"), "id"), Number(eventId)).maybeSingle();
      if (stryMutAct_9fa48("1997") ? false : stryMutAct_9fa48("1996") ? true : (stryCov_9fa48("1996", "1997"), error)) {
        if (stryMutAct_9fa48("1998")) {
          {}
        } else {
          stryCov_9fa48("1998");
          res.status(500).json(stryMutAct_9fa48("2000") ? {} : (stryCov_9fa48("2000"), {
            error: stryMutAct_9fa48("2001") ? "" : (stryCov_9fa48("2001"), "Failed to load event")
          }));
          return;
        }
      }
      const isOwner = stryMutAct_9fa48("2004") ? data?.organiser_id !== user.id : stryMutAct_9fa48("2003") ? false : stryMutAct_9fa48("2002") ? true : (stryCov_9fa48("2002", "2003", "2004"), (stryMutAct_9fa48("2005") ? data.organiser_id : (stryCov_9fa48("2005"), data?.organiser_id)) === user.id);
      // Drafts sit outside the process (AGENTS.md §3): only their organiser sees them.
      const isCoordinator = stryMutAct_9fa48("2008") ? user.role === "coordinator" || data?.status !== EVENT_STATUS.Draft : stryMutAct_9fa48("2007") ? false : stryMutAct_9fa48("2006") ? true : (stryCov_9fa48("2006", "2007", "2008"), (stryMutAct_9fa48("2010") ? user.role !== "coordinator" : stryMutAct_9fa48("2009") ? true : (stryCov_9fa48("2009", "2010"), user.role === (stryMutAct_9fa48("2011") ? "" : (stryCov_9fa48("2011"), "coordinator")))) && (stryMutAct_9fa48("2013") ? data?.status === EVENT_STATUS.Draft : stryMutAct_9fa48("2012") ? true : (stryCov_9fa48("2012", "2013"), (stryMutAct_9fa48("2014") ? data.status : (stryCov_9fa48("2014"), data?.status)) !== EVENT_STATUS.Draft)));
      const isLead = stryMutAct_9fa48("2017") ? user.role === COORDINATOR_LEAD_ROLE || data?.status !== EVENT_STATUS.Draft : stryMutAct_9fa48("2016") ? false : stryMutAct_9fa48("2015") ? true : (stryCov_9fa48("2015", "2016", "2017"), (stryMutAct_9fa48("2019") ? user.role !== COORDINATOR_LEAD_ROLE : stryMutAct_9fa48("2018") ? true : (stryCov_9fa48("2018", "2019"), user.role === COORDINATOR_LEAD_ROLE)) && (stryMutAct_9fa48("2021") ? data?.status === EVENT_STATUS.Draft : stryMutAct_9fa48("2020") ? true : (stryCov_9fa48("2020", "2021"), (stryMutAct_9fa48("2022") ? data.status : (stryCov_9fa48("2022"), data?.status)) !== EVENT_STATUS.Draft)));
      // E3-14: read-only, for events the Safety Officer reviews — ones that
      // have been submitted for safety review. venue-service and
      // equipment-service defer to this check, which is how the officer can
      // see the bookings and equipment they may flag.
      const isSafetyOfficer = stryMutAct_9fa48("2025") ? user.role === "safety_officer" && !!data || (await hasSafetySubmission(supabase, data.id)) : stryMutAct_9fa48("2024") ? false : stryMutAct_9fa48("2023") ? true : (stryCov_9fa48("2023", "2024", "2025"), (stryMutAct_9fa48("2027") ? user.role === "safety_officer" || !!data : stryMutAct_9fa48("2026") ? true : (stryCov_9fa48("2026", "2027"), (stryMutAct_9fa48("2029") ? user.role !== "safety_officer" : stryMutAct_9fa48("2028") ? true : (stryCov_9fa48("2028", "2029"), user.role === (stryMutAct_9fa48("2030") ? "" : (stryCov_9fa48("2030"), "safety_officer")))) && (stryMutAct_9fa48("2031") ? !data : (stryCov_9fa48("2031"), !(stryMutAct_9fa48("2032") ? data : (stryCov_9fa48("2032"), !data)))))) && (await hasSafetySubmission(supabase, data.id)));
      if (stryMutAct_9fa48("2035") ? !data && !isOwner && !isCoordinator && !isLead && !isSafetyOfficer : stryMutAct_9fa48("2034") ? false : stryMutAct_9fa48("2033") ? true : (stryCov_9fa48("2033", "2034", "2035"), (stryMutAct_9fa48("2036") ? data : (stryCov_9fa48("2036"), !data)) || (stryMutAct_9fa48("2038") ? !isOwner && !isCoordinator && !isLead || !isSafetyOfficer : stryMutAct_9fa48("2037") ? false : (stryCov_9fa48("2037", "2038"), (stryMutAct_9fa48("2040") ? !isOwner && !isCoordinator || !isLead : stryMutAct_9fa48("2039") ? true : (stryCov_9fa48("2039", "2040"), (stryMutAct_9fa48("2042") ? !isOwner || !isCoordinator : stryMutAct_9fa48("2041") ? true : (stryCov_9fa48("2041", "2042"), (stryMutAct_9fa48("2043") ? isOwner : (stryCov_9fa48("2043"), !isOwner)) && (stryMutAct_9fa48("2044") ? isCoordinator : (stryCov_9fa48("2044"), !isCoordinator)))) && (stryMutAct_9fa48("2045") ? isLead : (stryCov_9fa48("2045"), !isLead)))) && (stryMutAct_9fa48("2046") ? isSafetyOfficer : (stryCov_9fa48("2046"), !isSafetyOfficer)))))) {
        if (stryMutAct_9fa48("2047")) {
          {}
        } else {
          stryCov_9fa48("2047");
          await recordAccessDenial(supabase, user.id, eventId, stryMutAct_9fa48("2048") ? "" : (stryCov_9fa48("2048"), "not_found_or_not_owner"));
          res.status(403).json(stryMutAct_9fa48("2050") ? {} : (stryCov_9fa48("2050"), {
            error: stryMutAct_9fa48("2051") ? "" : (stryCov_9fa48("2051"), "Access denied")
          }));
          return;
        }
      }

      // organiser_id rides along (E2-15): chat-service needs it to know who a
      // coordinator's message should notify, and who to accept history/send
      // requests from. Not a privacy boundary — the organiser's name is
      // already embedded in EVENT_COLUMNS for any coordinator viewing this.
      res.json(stryMutAct_9fa48("2053") ? {} : (stryCov_9fa48("2053"), {
        event: data
      }));
    }
  });
}
/**
 * E2-10: the owning organiser edits event details while clarification is
 * outstanding. The edit itself becomes the reply posted into the
 * clarification thread (AC1) — no separate typed message required — and
 * saving clears the flag back to "Requested" (AC2), putting the request
 * back in the coordinator's normal review queue.
 */
if (stryMutAct_9fa48("2054")) {
  ;
} else {
  stryCov_9fa48("2054");
  eventsRouter.patch(stryMutAct_9fa48("2055") ? "" : (stryCov_9fa48("2055"), "/:id"), async (req: AuthedRequest, res) => {
    if (stryMutAct_9fa48("2056")) {
      {}
    } else {
      stryCov_9fa48("2056");
      const {
        supabase,
        user
      } = req;
      if (stryMutAct_9fa48("2059") ? !supabase && !user : stryMutAct_9fa48("2058") ? false : stryMutAct_9fa48("2057") ? true : (stryCov_9fa48("2057", "2058", "2059"), (stryMutAct_9fa48("2060") ? supabase : (stryCov_9fa48("2060"), !supabase)) || (stryMutAct_9fa48("2061") ? user : (stryCov_9fa48("2061"), !user)))) {
        if (stryMutAct_9fa48("2062")) {
          {}
        } else {
          stryCov_9fa48("2062");
          res.status(401).json(stryMutAct_9fa48("2064") ? {} : (stryCov_9fa48("2064"), {
            error: stryMutAct_9fa48("2065") ? "" : (stryCov_9fa48("2065"), "Unauthenticated")
          }));
          return;
        }
      }
      const eventId = routeParam(req.params.id);
      if (stryMutAct_9fa48("2068") ? false : stryMutAct_9fa48("2067") ? true : stryMutAct_9fa48("2066") ? isPositiveInteger(eventId) : (stryCov_9fa48("2066", "2067", "2068"), !isPositiveInteger(eventId))) {
        if (stryMutAct_9fa48("2069")) {
          {}
        } else {
          stryCov_9fa48("2069");
          res.status(404).json(stryMutAct_9fa48("2071") ? {} : (stryCov_9fa48("2071"), {
            error: stryMutAct_9fa48("2072") ? "" : (stryCov_9fa48("2072"), "Event not found")
          }));
          return;
        }
      }
      const {
        data: existing,
        error: fetchError
      } = await supabase.from(stryMutAct_9fa48("2073") ? "" : (stryCov_9fa48("2073"), "events")).select(stryMutAct_9fa48("2074") ? "" : (stryCov_9fa48("2074"), "id, status, organiser_id, coordinator_id, submitted_details, status_before_clarification")).eq(stryMutAct_9fa48("2075") ? "" : (stryCov_9fa48("2075"), "id"), Number(eventId)).maybeSingle();
      if (stryMutAct_9fa48("2077") ? false : stryMutAct_9fa48("2076") ? true : (stryCov_9fa48("2076", "2077"), fetchError)) {
        if (stryMutAct_9fa48("2078")) {
          {}
        } else {
          stryCov_9fa48("2078");
          res.status(500).json(stryMutAct_9fa48("2080") ? {} : (stryCov_9fa48("2080"), {
            error: stryMutAct_9fa48("2081") ? "" : (stryCov_9fa48("2081"), "Failed to load event")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("2084") ? false : stryMutAct_9fa48("2083") ? true : stryMutAct_9fa48("2082") ? existing : (stryCov_9fa48("2082", "2083", "2084"), !existing)) {
        if (stryMutAct_9fa48("2085")) {
          {}
        } else {
          stryCov_9fa48("2085");
          res.status(404).json(stryMutAct_9fa48("2087") ? {} : (stryCov_9fa48("2087"), {
            error: stryMutAct_9fa48("2088") ? "" : (stryCov_9fa48("2088"), "Event not found")
          }));
          return;
        }
      }

      // E3-7: the assigned coordinator edits event details during Planning —
      // a separate path from the organiser one below, with its own status gate.
      // All fields are editable (team decision: the organiser can already
      // change any field directly in Planning, so restricting the coordinator
      // added no protection, and event history already covers the audit trail).
      const isCoordinatorEditor = stryMutAct_9fa48("2091") ? user.role !== "coordinator" : stryMutAct_9fa48("2090") ? false : stryMutAct_9fa48("2089") ? true : (stryCov_9fa48("2089", "2090", "2091"), user.role === (stryMutAct_9fa48("2092") ? "" : (stryCov_9fa48("2092"), "coordinator")));
      if (stryMutAct_9fa48("2094") ? false : stryMutAct_9fa48("2093") ? true : (stryCov_9fa48("2093", "2094"), isCoordinatorEditor)) {
        if (stryMutAct_9fa48("2095")) {
          {}
        } else {
          stryCov_9fa48("2095");
          if (stryMutAct_9fa48("2098") ? existing.coordinator_id === user.id : stryMutAct_9fa48("2097") ? false : stryMutAct_9fa48("2096") ? true : (stryCov_9fa48("2096", "2097", "2098"), existing.coordinator_id !== user.id)) {
            if (stryMutAct_9fa48("2099")) {
              {}
            } else {
              stryCov_9fa48("2099");
              await recordAccessDenial(supabase, user.id, eventId, stryMutAct_9fa48("2100") ? "" : (stryCov_9fa48("2100"), "not_assigned_coordinator"));
              res.status(403).json(stryMutAct_9fa48("2102") ? {} : (stryCov_9fa48("2102"), {
                error: stryMutAct_9fa48("2103") ? "" : (stryCov_9fa48("2103"), "Access denied")
              }));
              return;
            }
          }
          if (stryMutAct_9fa48("2106") ? existing.status === "Planning" : stryMutAct_9fa48("2105") ? false : stryMutAct_9fa48("2104") ? true : (stryCov_9fa48("2104", "2105", "2106"), existing.status !== (stryMutAct_9fa48("2107") ? "" : (stryCov_9fa48("2107"), "Planning")))) {
            if (stryMutAct_9fa48("2108")) {
              {}
            } else {
              stryCov_9fa48("2108");
              res.status(409).json(stryMutAct_9fa48("2110") ? {} : (stryCov_9fa48("2110"), {
                error: stryMutAct_9fa48("2111") ? "" : (stryCov_9fa48("2111"), "Coordinator edits are only allowed while the event is in Planning.")
              }));
              return;
            }
          }
          const result = validateEventRequest(stryMutAct_9fa48("2112") ? req.body && {} : (stryCov_9fa48("2112"), req.body ?? {}));
          if (stryMutAct_9fa48("2115") ? false : stryMutAct_9fa48("2114") ? true : stryMutAct_9fa48("2113") ? result.valid : (stryCov_9fa48("2113", "2114", "2115"), !result.valid)) {
            if (stryMutAct_9fa48("2116")) {
              {}
            } else {
              stryCov_9fa48("2116");
              res.status(400).json(stryMutAct_9fa48("2118") ? {} : (stryCov_9fa48("2118"), {
                error: stryMutAct_9fa48("2119") ? "" : (stryCov_9fa48("2119"), "Validation failed"),
                fields: result.fields
              }));
              return;
            }
          }
          const oldDetails = (existing.submitted_details ?? {}) as Record<string, unknown>;
          const {
            data,
            error
          } = await supabase.from(stryMutAct_9fa48("2120") ? "" : (stryCov_9fa48("2120"), "events")).update(stryMutAct_9fa48("2121") ? {} : (stryCov_9fa48("2121"), {
            submitted_details: result.value
          })).eq(stryMutAct_9fa48("2122") ? "" : (stryCov_9fa48("2122"), "id"), existing.id).select(EVENT_COLUMNS).single();
          if (stryMutAct_9fa48("2124") ? false : stryMutAct_9fa48("2123") ? true : (stryCov_9fa48("2123", "2124"), error)) {
            if (stryMutAct_9fa48("2125")) {
              {}
            } else {
              stryCov_9fa48("2125");
              res.status(500).json(stryMutAct_9fa48("2127") ? {} : (stryCov_9fa48("2127"), {
                error: stryMutAct_9fa48("2128") ? "" : (stryCov_9fa48("2128"), "Failed to save changes")
              }));
              return;
            }
          }
          await recordEventHistory(supabase, existing.id, diffSubmittedDetailsStructured(oldDetails, result.value!), user.id);
          if (stryMutAct_9fa48("2130") ? false : stryMutAct_9fa48("2129") ? true : (stryCov_9fa48("2129", "2130"), scheduleChanged(oldDetails, result.value as unknown as Record<string, unknown>))) {
            if (stryMutAct_9fa48("2131")) {
              {}
            } else {
              stryCov_9fa48("2131");
              await announceReschedule(supabase, stryMutAct_9fa48("2132") ? {} : (stryCov_9fa48("2132"), {
                id: existing.id,
                actorId: user.id,
                eventName: eventDisplayName(data as unknown as AssignmentEventRow),
                coordinatorId: existing.coordinator_id,
                // the assigned coordinator: checked equal to the caller above
                details: result.value as unknown as Record<string, unknown>
              }));
            }
          }
          if (stryMutAct_9fa48("2134") ? false : stryMutAct_9fa48("2133") ? true : (stryCov_9fa48("2133", "2134"), attendanceChanged(oldDetails, result.value as unknown as Record<string, unknown>))) {
            if (stryMutAct_9fa48("2135")) {
              {}
            } else {
              stryCov_9fa48("2135");
              await announceAttendanceChange(supabase, stryMutAct_9fa48("2136") ? {} : (stryCov_9fa48("2136"), {
                id: existing.id,
                actorId: user.id,
                eventName: eventDisplayName(data as unknown as AssignmentEventRow),
                coordinatorId: existing.coordinator_id,
                // the assigned coordinator: checked equal to the caller above
                details: result.value as unknown as Record<string, unknown>
              }));
            }
          }
          res.json(stryMutAct_9fa48("2138") ? {} : (stryCov_9fa48("2138"), {
            event: data
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("2141") ? existing.organiser_id === user.id : stryMutAct_9fa48("2140") ? false : stryMutAct_9fa48("2139") ? true : (stryCov_9fa48("2139", "2140", "2141"), existing.organiser_id !== user.id)) {
        if (stryMutAct_9fa48("2142")) {
          {}
        } else {
          stryCov_9fa48("2142");
          await recordAccessDenial(supabase, user.id, eventId, stryMutAct_9fa48("2143") ? "" : (stryCov_9fa48("2143"), "not_found_or_not_owner"));
          res.status(403).json(stryMutAct_9fa48("2145") ? {} : (stryCov_9fa48("2145"), {
            error: stryMutAct_9fa48("2146") ? "" : (stryCov_9fa48("2146"), "Access denied")
          }));
          return;
        }
      }

      // E2-7 AC1/AC2: direct edits are allowed while still pending review
      // (Requested/Unassigned), while still in Planning (per AGENTS.md §3 the
      // lifecycle only truly locks down once Confirmed), or, per E2-10, while
      // responding to an outstanding clarification. Anything past that is
      // blocked. E3-9 AC2: once Confirmed, that block points at the change
      // request endpoint (POST /:id/change-requests) rather than telling the
      // organiser to contact their coordinator — that's now a dead end, since
      // the change request flow exists. Safety Review, Completed, Rejected and
      // Cancelled have no edit path at all (Safety Review has no direct-edit
      // or change-request route; the other three are terminal).
      const isClarificationResponse = stryMutAct_9fa48("2149") ? existing.status !== "Clarification Requested" : stryMutAct_9fa48("2148") ? false : stryMutAct_9fa48("2147") ? true : (stryCov_9fa48("2147", "2148", "2149"), existing.status === (stryMutAct_9fa48("2150") ? "" : (stryCov_9fa48("2150"), "Clarification Requested")));
      const isDirectEdit = ORGANISER_DIRECT_EDIT_STATUSES.has(existing.status);
      // E2-4 AC3: editing a draft here means submitting it — same E2-1
      // validation as a fresh request, and the same E2-14 handling as POST /.
      const isDraftSubmit = stryMutAct_9fa48("2153") ? existing.status !== "Draft" : stryMutAct_9fa48("2152") ? false : stryMutAct_9fa48("2151") ? true : (stryCov_9fa48("2151", "2152", "2153"), existing.status === (stryMutAct_9fa48("2154") ? "" : (stryCov_9fa48("2154"), "Draft")));
      if (stryMutAct_9fa48("2157") ? !isClarificationResponse && !isDirectEdit || !isDraftSubmit : stryMutAct_9fa48("2156") ? false : stryMutAct_9fa48("2155") ? true : (stryCov_9fa48("2155", "2156", "2157"), (stryMutAct_9fa48("2159") ? !isClarificationResponse || !isDirectEdit : stryMutAct_9fa48("2158") ? true : (stryCov_9fa48("2158", "2159"), (stryMutAct_9fa48("2160") ? isClarificationResponse : (stryCov_9fa48("2160"), !isClarificationResponse)) && (stryMutAct_9fa48("2161") ? isDirectEdit : (stryCov_9fa48("2161"), !isDirectEdit)))) && (stryMutAct_9fa48("2162") ? isDraftSubmit : (stryCov_9fa48("2162"), !isDraftSubmit)))) {
        if (stryMutAct_9fa48("2163")) {
          {}
        } else {
          stryCov_9fa48("2163");
          res.status(409).json(stryMutAct_9fa48("2165") ? {} : (stryCov_9fa48("2165"), {
            error: (stryMutAct_9fa48("2168") ? existing.status === EVENT_STATUS.Confirmed && existing.status === EVENT_STATUS.NeedsReview : stryMutAct_9fa48("2167") ? false : stryMutAct_9fa48("2166") ? true : (stryCov_9fa48("2166", "2167", "2168"), (stryMutAct_9fa48("2170") ? existing.status !== EVENT_STATUS.Confirmed : stryMutAct_9fa48("2169") ? false : (stryCov_9fa48("2169", "2170"), existing.status === EVENT_STATUS.Confirmed)) || (stryMutAct_9fa48("2172") ? existing.status !== EVENT_STATUS.NeedsReview : stryMutAct_9fa48("2171") ? false : (stryCov_9fa48("2171", "2172"), existing.status === EVENT_STATUS.NeedsReview)))) ? stryMutAct_9fa48("2173") ? "" : (stryCov_9fa48("2173"), "This event is past Planning and can no longer be edited directly. Raise a change request instead.") : stryMutAct_9fa48("2174") ? "" : (stryCov_9fa48("2174"), "This request can no longer be edited or changed at this stage.")
          }));
          return;
        }
      }

      // E2-14: same restriction as POST / — only an organiser's draft reaches
      // the Lead-notification lookup under their own token.
      if (stryMutAct_9fa48("2177") ? isDraftSubmit || user.role !== "organiser" : stryMutAct_9fa48("2176") ? false : stryMutAct_9fa48("2175") ? true : (stryCov_9fa48("2175", "2176", "2177"), isDraftSubmit && (stryMutAct_9fa48("2179") ? user.role === "organiser" : stryMutAct_9fa48("2178") ? true : (stryCov_9fa48("2178", "2179"), user.role !== (stryMutAct_9fa48("2180") ? "" : (stryCov_9fa48("2180"), "organiser")))))) {
        if (stryMutAct_9fa48("2181")) {
          {}
        } else {
          stryCov_9fa48("2181");
          res.status(403).json(stryMutAct_9fa48("2183") ? {} : (stryCov_9fa48("2183"), {
            error: stryMutAct_9fa48("2184") ? "" : (stryCov_9fa48("2184"), "Only organisers can submit event requests")
          }));
          return;
        }
      }
      const result = validateEventRequest(stryMutAct_9fa48("2185") ? req.body && {} : (stryCov_9fa48("2185"), req.body ?? {}));
      if (stryMutAct_9fa48("2188") ? false : stryMutAct_9fa48("2187") ? true : stryMutAct_9fa48("2186") ? result.valid : (stryCov_9fa48("2186", "2187", "2188"), !result.valid)) {
        if (stryMutAct_9fa48("2189")) {
          {}
        } else {
          stryCov_9fa48("2189");
          res.status(400).json(stryMutAct_9fa48("2191") ? {} : (stryCov_9fa48("2191"), {
            error: stryMutAct_9fa48("2192") ? "" : (stryCov_9fa48("2192"), "Validation failed"),
            fields: result.fields
          }));
          return;
        }
      }

      // Clarification responses restore whatever status the event was in
      // before the clarification was requested — "Requested" for the normal
      // pre-approval case, but "Planning" if a coordinator asked a follow-up
      // after already approving. Direct edits (AC1) don't change status at all.
      const updatePayload: Record<string, unknown> = stryMutAct_9fa48("2193") ? {} : (stryCov_9fa48("2193"), {
        submitted_details: result.value
      });
      if (stryMutAct_9fa48("2195") ? false : stryMutAct_9fa48("2194") ? true : (stryCov_9fa48("2194", "2195"), isClarificationResponse)) {
        if (stryMutAct_9fa48("2196")) {
          {}
        } else {
          stryCov_9fa48("2196");
          updatePayload.status = stryMutAct_9fa48("2199") ? existing.status_before_clarification && "Requested" : stryMutAct_9fa48("2198") ? false : stryMutAct_9fa48("2197") ? true : (stryCov_9fa48("2197", "2198", "2199"), existing.status_before_clarification || (stryMutAct_9fa48("2200") ? "" : (stryCov_9fa48("2200"), "Requested")));
          updatePayload.status_before_clarification = null;
        }
      } else if (stryMutAct_9fa48("2202") ? false : stryMutAct_9fa48("2201") ? true : (stryCov_9fa48("2201", "2202"), isDraftSubmit)) {
        if (stryMutAct_9fa48("2203")) {
          {}
        } else {
          stryCov_9fa48("2203");
          updatePayload.status = EVENT_STATUS.Unassigned;
          updatePayload.coordinator_id = null;
        }
      }
      const {
        data,
        error
      } = await supabase.from(stryMutAct_9fa48("2204") ? "" : (stryCov_9fa48("2204"), "events")).update(updatePayload).eq(stryMutAct_9fa48("2205") ? "" : (stryCov_9fa48("2205"), "id"), existing.id).select(EVENT_COLUMNS).single();
      if (stryMutAct_9fa48("2207") ? false : stryMutAct_9fa48("2206") ? true : (stryCov_9fa48("2206", "2207"), error)) {
        if (stryMutAct_9fa48("2208")) {
          {}
        } else {
          stryCov_9fa48("2208");
          res.status(500).json(stryMutAct_9fa48("2210") ? {} : (stryCov_9fa48("2210"), {
            error: stryMutAct_9fa48("2211") ? "" : (stryCov_9fa48("2211"), "Failed to save your response")
          }));
          return;
        }
      }
      const oldDetails = (existing.submitted_details ?? {}) as Record<string, unknown>;
      await recordEventHistory(supabase, existing.id, diffSubmittedDetailsStructured(oldDetails, result.value!), user.id);

      // Equipment and venues can only be booked from Planning on, so an earlier edit has nothing to move or re-check.
      if (stryMutAct_9fa48("2214") ? !isDraftSubmit || !PRE_PLANNING_STATUSES.has(existing.status) : stryMutAct_9fa48("2213") ? false : stryMutAct_9fa48("2212") ? true : (stryCov_9fa48("2212", "2213", "2214"), (stryMutAct_9fa48("2215") ? isDraftSubmit : (stryCov_9fa48("2215"), !isDraftSubmit)) && (stryMutAct_9fa48("2216") ? PRE_PLANNING_STATUSES.has(existing.status) : (stryCov_9fa48("2216"), !PRE_PLANNING_STATUSES.has(existing.status))))) {
        if (stryMutAct_9fa48("2217")) {
          {}
        } else {
          stryCov_9fa48("2217");
          const newDetails = result.value as unknown as Record<string, unknown>;
          const announced = stryMutAct_9fa48("2218") ? {} : (stryCov_9fa48("2218"), {
            id: existing.id,
            actorId: user.id,
            eventName: eventDisplayName(data as unknown as AssignmentEventRow),
            coordinatorId: stryMutAct_9fa48("2219") ? existing.coordinator_id && null : (stryCov_9fa48("2219"), existing.coordinator_id ?? null),
            details: newDetails
          });
          if (stryMutAct_9fa48("2221") ? false : stryMutAct_9fa48("2220") ? true : (stryCov_9fa48("2220", "2221"), scheduleChanged(oldDetails, newDetails))) await announceReschedule(supabase, announced);
          if (stryMutAct_9fa48("2223") ? false : stryMutAct_9fa48("2222") ? true : (stryCov_9fa48("2222", "2223"), attendanceChanged(oldDetails, newDetails))) await announceAttendanceChange(supabase, announced);
        }
      }
      if (stryMutAct_9fa48("2225") ? false : stryMutAct_9fa48("2224") ? true : (stryCov_9fa48("2224", "2225"), isClarificationResponse)) {
        if (stryMutAct_9fa48("2226")) {
          {}
        } else {
          stryCov_9fa48("2226");
          const diff = diffSubmittedDetails(oldDetails, result.value!);
          if (stryMutAct_9fa48("2228") ? false : stryMutAct_9fa48("2227") ? true : (stryCov_9fa48("2227", "2228"), diff)) {
            if (stryMutAct_9fa48("2229")) {
              {}
            } else {
              stryCov_9fa48("2229");
              const {
                data: openQuestion
              } = await supabase.from(stryMutAct_9fa48("2230") ? "" : (stryCov_9fa48("2230"), "event_clarifications")).select(stryMutAct_9fa48("2231") ? "" : (stryCov_9fa48("2231"), "id")).eq(stryMutAct_9fa48("2232") ? "" : (stryCov_9fa48("2232"), "event_id"), existing.id).is(stryMutAct_9fa48("2233") ? "" : (stryCov_9fa48("2233"), "parent_id"), null).eq(stryMutAct_9fa48("2234") ? "" : (stryCov_9fa48("2234"), "resolved"), stryMutAct_9fa48("2235") ? true : (stryCov_9fa48("2235"), false)).order(stryMutAct_9fa48("2236") ? "" : (stryCov_9fa48("2236"), "created_at"), stryMutAct_9fa48("2237") ? {} : (stryCov_9fa48("2237"), {
                ascending: stryMutAct_9fa48("2238") ? true : (stryCov_9fa48("2238"), false)
              })).limit(1).maybeSingle();
              const {
                error: replyError
              } = await supabase.from(stryMutAct_9fa48("2239") ? "" : (stryCov_9fa48("2239"), "event_clarifications")).insert(stryMutAct_9fa48("2240") ? {} : (stryCov_9fa48("2240"), {
                event_id: existing.id,
                parent_id: stryMutAct_9fa48("2241") ? openQuestion?.id && null : (stryCov_9fa48("2241"), (stryMutAct_9fa48("2242") ? openQuestion.id : (stryCov_9fa48("2242"), openQuestion?.id)) ?? null),
                author_id: user.id,
                author_role: stryMutAct_9fa48("2243") ? "" : (stryCov_9fa48("2243"), "organiser"),
                message: diff
              }));
              if (stryMutAct_9fa48("2245") ? false : stryMutAct_9fa48("2244") ? true : (stryCov_9fa48("2244", "2245"), replyError)) {
                if (stryMutAct_9fa48("2246")) {
                  {}
                } else {
                  stryCov_9fa48("2246");
                  console.error(stryMutAct_9fa48("2248") ? "" : (stryCov_9fa48("2248"), "Failed to record clarification response reply"), stryMutAct_9fa48("2249") ? {} : (stryCov_9fa48("2249"), {
                    eventId: existing.id,
                    error: replyError
                  }));
                }
              }
            }
          }

          // #104 row 6: the organiser's response goes to whoever is currently
          // assigned — read fresh from `existing`, not cached from when the
          // clarification was first requested, so a reassignment in between is
          // respected.
          if (stryMutAct_9fa48("2251") ? false : stryMutAct_9fa48("2250") ? true : (stryCov_9fa48("2250", "2251"), existing.coordinator_id)) {
            if (stryMutAct_9fa48("2252")) {
              {}
            } else {
              stryCov_9fa48("2252");
              await getPublisher().publish(stryMutAct_9fa48("2253") ? {} : (stryCov_9fa48("2253"), {
                type: stryMutAct_9fa48("2254") ? "" : (stryCov_9fa48("2254"), "clarification.answered"),
                eventId: data.id,
                actorId: user.id,
                recipients: stryMutAct_9fa48("2255") ? {} : (stryCov_9fa48("2255"), {
                  userIds: stryMutAct_9fa48("2256") ? [] : (stryCov_9fa48("2256"), [existing.coordinator_id]),
                  roles: stryMutAct_9fa48("2257") ? ["Stryker was here"] : (stryCov_9fa48("2257"), [])
                }),
                data: stryMutAct_9fa48("2258") ? {} : (stryCov_9fa48("2258"), {
                  eventName: eventDisplayName(data as unknown as AssignmentEventRow)
                })
              }));
            }
          }
        }
      }
      if (stryMutAct_9fa48("2260") ? false : stryMutAct_9fa48("2259") ? true : (stryCov_9fa48("2259", "2260"), isDraftSubmit)) {
        if (stryMutAct_9fa48("2261")) {
          {}
        } else {
          stryCov_9fa48("2261");
          await notifyCoordinatorLeads(data.id, eventDisplayName(data as unknown as AssignmentEventRow), user.id);
        }
      }
      if (stryMutAct_9fa48("2263") ? false : stryMutAct_9fa48("2262") ? true : (stryCov_9fa48("2262", "2263"), isDirectEdit)) {
        if (stryMutAct_9fa48("2264")) {
          {}
        } else {
          stryCov_9fa48("2264");
          // #104 row 2 / AC4: the assigned coordinator, or every Lead if the
          // event is still Unassigned (no coordinator to address).
          const eventName = eventDisplayName(data as unknown as AssignmentEventRow);
          if (stryMutAct_9fa48("2266") ? false : stryMutAct_9fa48("2265") ? true : (stryCov_9fa48("2265", "2266"), existing.coordinator_id)) {
            if (stryMutAct_9fa48("2267")) {
              {}
            } else {
              stryCov_9fa48("2267");
              await getPublisher().publish(stryMutAct_9fa48("2268") ? {} : (stryCov_9fa48("2268"), {
                type: stryMutAct_9fa48("2269") ? "" : (stryCov_9fa48("2269"), "request.edited"),
                eventId: data.id,
                actorId: user.id,
                recipients: stryMutAct_9fa48("2270") ? {} : (stryCov_9fa48("2270"), {
                  userIds: stryMutAct_9fa48("2271") ? [] : (stryCov_9fa48("2271"), [existing.coordinator_id]),
                  roles: stryMutAct_9fa48("2272") ? ["Stryker was here"] : (stryCov_9fa48("2272"), [])
                }),
                data: stryMutAct_9fa48("2273") ? {} : (stryCov_9fa48("2273"), {
                  eventName
                })
              }));
            }
          } else {
            if (stryMutAct_9fa48("2274")) {
              {}
            } else {
              stryCov_9fa48("2274");
              // No REST lookup — notification-service resolves the Lead ids itself.
              await getPublisher().publish(stryMutAct_9fa48("2275") ? {} : (stryCov_9fa48("2275"), {
                type: stryMutAct_9fa48("2276") ? "" : (stryCov_9fa48("2276"), "request.edited"),
                eventId: data.id,
                actorId: user.id,
                recipients: stryMutAct_9fa48("2277") ? {} : (stryCov_9fa48("2277"), {
                  userIds: stryMutAct_9fa48("2278") ? ["Stryker was here"] : (stryCov_9fa48("2278"), []),
                  roles: stryMutAct_9fa48("2279") ? [] : (stryCov_9fa48("2279"), [stryMutAct_9fa48("2280") ? "" : (stryCov_9fa48("2280"), "coordinator_lead")])
                }),
                data: stryMutAct_9fa48("2281") ? {} : (stryCov_9fa48("2281"), {
                  eventName
                })
              }));
            }
          }
        }
      }
      res.json(stryMutAct_9fa48("2283") ? {} : (stryCov_9fa48("2283"), {
        event: data
      }));
    }
  });
}
/**
 * E3-6 / AGENTS.md §3 transitions table: every active stage the owning
 * Organiser may cancel from — everything except `Draft` (delete it
 * instead) and the three terminal statuses, which are already excluded by
 * this being an allowlist.
 */
const CANCELLABLE_STATUSES = new Set<string>(stryMutAct_9fa48("2284") ? [] : (stryCov_9fa48("2284"), [EVENT_STATUS.Unassigned, EVENT_STATUS.Requested, EVENT_STATUS.ClarificationRequested, EVENT_STATUS.Planning, EVENT_STATUS.SafetyReview, EVENT_STATUS.Confirmed, EVENT_STATUS.NeedsReview]));

/**
 * E3-6: the owning Organiser cancels their own event with a required
 * reason. AC1: automatic — no coordinator approval (the customer's answer
 * to PRD Q2) — the assigned coordinator is just notified with the reason,
 * or every Event Coordinator Lead if the event is still Unassigned (AC1,
 * AGENTS.md §3). AC2-AC5 (releasing venue bookings and equipment,
 * notifying attendees) are each handled in the service that owns that
 * data: this route only flips the status and publishes `event.cancelled`
 * (RabbitMQ.md #14); venue-service, equipment-service and
 * registration-service each consume that same message and publish their
 * own follow-up (RabbitMQ.md section 3.3-3.5, #33/#34/#35). AC6: nothing
 * here deletes anything, so the cancelled event's record and history stay
 * viewable exactly like every other closed event.
 *
 * The update only matches while the event is still in the status just
 * checked, so a concurrent decision (e.g. a Safety Officer rejecting it)
 * between the checks and the write loses the race cleanly with a 409
 * instead of cancelling a status that no longer applies.
 */
if (stryMutAct_9fa48("2285")) {
  ;
} else {
  stryCov_9fa48("2285");
  eventsRouter.post(stryMutAct_9fa48("2286") ? "" : (stryCov_9fa48("2286"), "/:id/cancel"), async (req: AuthedRequest, res) => {
    if (stryMutAct_9fa48("2287")) {
      {}
    } else {
      stryCov_9fa48("2287");
      const {
        supabase,
        user
      } = req;
      if (stryMutAct_9fa48("2290") ? !supabase && !user : stryMutAct_9fa48("2289") ? false : stryMutAct_9fa48("2288") ? true : (stryCov_9fa48("2288", "2289", "2290"), (stryMutAct_9fa48("2291") ? supabase : (stryCov_9fa48("2291"), !supabase)) || (stryMutAct_9fa48("2292") ? user : (stryCov_9fa48("2292"), !user)))) {
        if (stryMutAct_9fa48("2293")) {
          {}
        } else {
          stryCov_9fa48("2293");
          res.status(401).json(stryMutAct_9fa48("2295") ? {} : (stryCov_9fa48("2295"), {
            error: stryMutAct_9fa48("2296") ? "" : (stryCov_9fa48("2296"), "Unauthenticated")
          }));
          return;
        }
      }
      const eventId = routeParam(req.params.id);
      if (stryMutAct_9fa48("2299") ? false : stryMutAct_9fa48("2298") ? true : stryMutAct_9fa48("2297") ? isPositiveInteger(eventId) : (stryCov_9fa48("2297", "2298", "2299"), !isPositiveInteger(eventId))) {
        if (stryMutAct_9fa48("2300")) {
          {}
        } else {
          stryCov_9fa48("2300");
          res.status(404).json(stryMutAct_9fa48("2302") ? {} : (stryCov_9fa48("2302"), {
            error: stryMutAct_9fa48("2303") ? "" : (stryCov_9fa48("2303"), "Event not found")
          }));
          return;
        }
      }
      const {
        data: existing,
        error: fetchError
      } = await supabase.from(stryMutAct_9fa48("2304") ? "" : (stryCov_9fa48("2304"), "events")).select(stryMutAct_9fa48("2305") ? "" : (stryCov_9fa48("2305"), "id, status, organiser_id, coordinator_id")).eq(stryMutAct_9fa48("2306") ? "" : (stryCov_9fa48("2306"), "id"), Number(eventId)).maybeSingle();
      if (stryMutAct_9fa48("2308") ? false : stryMutAct_9fa48("2307") ? true : (stryCov_9fa48("2307", "2308"), fetchError)) {
        if (stryMutAct_9fa48("2309")) {
          {}
        } else {
          stryCov_9fa48("2309");
          res.status(500).json(stryMutAct_9fa48("2311") ? {} : (stryCov_9fa48("2311"), {
            error: stryMutAct_9fa48("2312") ? "" : (stryCov_9fa48("2312"), "Failed to load event")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("2315") ? false : stryMutAct_9fa48("2314") ? true : stryMutAct_9fa48("2313") ? existing : (stryCov_9fa48("2313", "2314", "2315"), !existing)) {
        if (stryMutAct_9fa48("2316")) {
          {}
        } else {
          stryCov_9fa48("2316");
          res.status(404).json(stryMutAct_9fa48("2318") ? {} : (stryCov_9fa48("2318"), {
            error: stryMutAct_9fa48("2319") ? "" : (stryCov_9fa48("2319"), "Event not found")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("2322") ? existing.organiser_id === user.id : stryMutAct_9fa48("2321") ? false : stryMutAct_9fa48("2320") ? true : (stryCov_9fa48("2320", "2321", "2322"), existing.organiser_id !== user.id)) {
        if (stryMutAct_9fa48("2323")) {
          {}
        } else {
          stryCov_9fa48("2323");
          await recordAccessDenial(supabase, user.id, eventId, stryMutAct_9fa48("2324") ? "" : (stryCov_9fa48("2324"), "not_found_or_not_owner"));
          res.status(403).json(stryMutAct_9fa48("2326") ? {} : (stryCov_9fa48("2326"), {
            error: stryMutAct_9fa48("2327") ? "" : (stryCov_9fa48("2327"), "Access denied")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("2330") ? false : stryMutAct_9fa48("2329") ? true : stryMutAct_9fa48("2328") ? CANCELLABLE_STATUSES.has(existing.status) : (stryCov_9fa48("2328", "2329", "2330"), !CANCELLABLE_STATUSES.has(existing.status))) {
        if (stryMutAct_9fa48("2331")) {
          {}
        } else {
          stryCov_9fa48("2331");
          res.status(409).json(stryMutAct_9fa48("2333") ? {} : (stryCov_9fa48("2333"), {
            error: (stryMutAct_9fa48("2336") ? existing.status !== EVENT_STATUS.Draft : stryMutAct_9fa48("2335") ? false : stryMutAct_9fa48("2334") ? true : (stryCov_9fa48("2334", "2335", "2336"), existing.status === EVENT_STATUS.Draft)) ? stryMutAct_9fa48("2337") ? "" : (stryCov_9fa48("2337"), "This is still a draft — delete it instead of cancelling it.") : stryMutAct_9fa48("2338") ? `` : (stryCov_9fa48("2338"), `This event is ${existing.status} and can no longer be cancelled.`)
          }));
          return;
        }
      }
      const reason = (stryMutAct_9fa48("2341") ? typeof req.body?.reason !== "string" : stryMutAct_9fa48("2340") ? false : stryMutAct_9fa48("2339") ? true : (stryCov_9fa48("2339", "2340", "2341"), typeof (stryMutAct_9fa48("2342") ? req.body.reason : (stryCov_9fa48("2342"), req.body?.reason)) === (stryMutAct_9fa48("2343") ? "" : (stryCov_9fa48("2343"), "string")))) ? stryMutAct_9fa48("2344") ? req.body.reason : (stryCov_9fa48("2344"), req.body.reason.trim()) : stryMutAct_9fa48("2345") ? "Stryker was here!" : (stryCov_9fa48("2345"), "");
      if (stryMutAct_9fa48("2348") ? false : stryMutAct_9fa48("2347") ? true : stryMutAct_9fa48("2346") ? reason : (stryCov_9fa48("2346", "2347", "2348"), !reason)) {
        if (stryMutAct_9fa48("2349")) {
          {}
        } else {
          stryCov_9fa48("2349");
          res.status(400).json(stryMutAct_9fa48("2351") ? {} : (stryCov_9fa48("2351"), {
            error: stryMutAct_9fa48("2352") ? "" : (stryCov_9fa48("2352"), "A reason is required to cancel an event")
          }));
          return;
        }
      }
      const {
        data,
        error
      } = await supabase.from(stryMutAct_9fa48("2353") ? "" : (stryCov_9fa48("2353"), "events")).update(stryMutAct_9fa48("2354") ? {} : (stryCov_9fa48("2354"), {
        status: EVENT_STATUS.Cancelled,
        review_outcome: reason,
        decided_at: clock.now().toISOString(),
        decided_by: user.id
      })).eq(stryMutAct_9fa48("2355") ? "" : (stryCov_9fa48("2355"), "id"), existing.id).eq(stryMutAct_9fa48("2356") ? "" : (stryCov_9fa48("2356"), "status"), existing.status).select(EVENT_COLUMNS).maybeSingle();
      if (stryMutAct_9fa48("2358") ? false : stryMutAct_9fa48("2357") ? true : (stryCov_9fa48("2357", "2358"), error)) {
        if (stryMutAct_9fa48("2359")) {
          {}
        } else {
          stryCov_9fa48("2359");
          res.status(500).json(stryMutAct_9fa48("2361") ? {} : (stryCov_9fa48("2361"), {
            error: stryMutAct_9fa48("2362") ? "" : (stryCov_9fa48("2362"), "Failed to cancel this event")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("2365") ? false : stryMutAct_9fa48("2364") ? true : stryMutAct_9fa48("2363") ? data : (stryCov_9fa48("2363", "2364", "2365"), !data)) {
        if (stryMutAct_9fa48("2366")) {
          {}
        } else {
          stryCov_9fa48("2366");
          res.status(409).json(stryMutAct_9fa48("2368") ? {} : (stryCov_9fa48("2368"), {
            error: stryMutAct_9fa48("2369") ? "" : (stryCov_9fa48("2369"), "This event changed while you were cancelling it. Refresh and try again.")
          }));
          return;
        }
      }
      await recordEventHistory(supabase, existing.id, stryMutAct_9fa48("2370") ? [] : (stryCov_9fa48("2370"), [stryMutAct_9fa48("2371") ? {} : (stryCov_9fa48("2371"), {
        field: stryMutAct_9fa48("2372") ? "" : (stryCov_9fa48("2372"), "Status"),
        oldValue: existing.status,
        newValue: EVENT_STATUS.Cancelled
      }), stryMutAct_9fa48("2373") ? {} : (stryCov_9fa48("2373"), {
        field: stryMutAct_9fa48("2374") ? "" : (stryCov_9fa48("2374"), "Cancellation reason"),
        oldValue: null,
        newValue: reason
      })]), user.id);
      const eventName = eventDisplayName(data as unknown as AssignmentEventRow);

      // RabbitMQ.md #14: the organiser's own confirmation, and whoever is
      // notified with the reason — the assigned coordinator, or every Lead if
      // nobody is assigned yet.
      // Other services act on this message (they release the event's bookings,
      // reservations and registrations), so it goes through the outbox and is
      // retried until the broker confirms it.
      const published = await publishDurably(supabase, stryMutAct_9fa48("2375") ? {} : (stryCov_9fa48("2375"), {
        type: stryMutAct_9fa48("2376") ? "" : (stryCov_9fa48("2376"), "event.cancelled"),
        eventId: existing.id,
        actorId: user.id,
        recipients: existing.coordinator_id ? stryMutAct_9fa48("2377") ? {} : (stryCov_9fa48("2377"), {
          userIds: stryMutAct_9fa48("2378") ? [] : (stryCov_9fa48("2378"), [user.id, existing.coordinator_id]),
          roles: stryMutAct_9fa48("2379") ? ["Stryker was here"] : (stryCov_9fa48("2379"), [])
        }) : stryMutAct_9fa48("2380") ? {} : (stryCov_9fa48("2380"), {
          userIds: stryMutAct_9fa48("2381") ? [] : (stryCov_9fa48("2381"), [user.id]),
          roles: stryMutAct_9fa48("2382") ? [] : (stryCov_9fa48("2382"), [stryMutAct_9fa48("2383") ? "" : (stryCov_9fa48("2383"), "coordinator_lead")])
        }),
        data: stryMutAct_9fa48("2384") ? {} : (stryCov_9fa48("2384"), {
          eventName,
          reason
        })
      }));
      res.json(stryMutAct_9fa48("2386") ? {} : (stryCov_9fa48("2386"), {
        event: data,
        notificationsFailed: stryMutAct_9fa48("2387") ? published : (stryCov_9fa48("2387"), !published)
      }));
    }
  });
}
/**
 * E3-9: the only edit path once an event is Confirmed — PATCH /:id above
 * already blocks direct edits past Planning. E3-8: critical fields
 * (schedule, attendance, venue, equipment, accessibility) are held as a
 * `change_requests`/`change_request_fields` row for the assigned
 * coordinator to decide (E3-11, not built here); everything else is
 * written straight to submitted_details.
 *
 * Deciding a held request — approving/rejecting, applying its values,
 * returning the event to Planning — belongs to E3-11 (#36) and has no
 * route yet. Assessing impact (affected bookings/reservations/
 * registrations, capacity conflicts) is E3-10 (#35), also not built here.
 */
if (stryMutAct_9fa48("2388")) {
  ;
} else {
  stryCov_9fa48("2388");
  eventsRouter.post(stryMutAct_9fa48("2389") ? "" : (stryCov_9fa48("2389"), "/:id/change-requests"), async (req: AuthedRequest, res) => {
    if (stryMutAct_9fa48("2390")) {
      {}
    } else {
      stryCov_9fa48("2390");
      const {
        supabase,
        user
      } = req;
      if (stryMutAct_9fa48("2393") ? !supabase && !user : stryMutAct_9fa48("2392") ? false : stryMutAct_9fa48("2391") ? true : (stryCov_9fa48("2391", "2392", "2393"), (stryMutAct_9fa48("2394") ? supabase : (stryCov_9fa48("2394"), !supabase)) || (stryMutAct_9fa48("2395") ? user : (stryCov_9fa48("2395"), !user)))) {
        if (stryMutAct_9fa48("2396")) {
          {}
        } else {
          stryCov_9fa48("2396");
          res.status(401).json(stryMutAct_9fa48("2398") ? {} : (stryCov_9fa48("2398"), {
            error: stryMutAct_9fa48("2399") ? "" : (stryCov_9fa48("2399"), "Unauthenticated")
          }));
          return;
        }
      }
      const eventId = routeParam(req.params.id);
      if (stryMutAct_9fa48("2402") ? false : stryMutAct_9fa48("2401") ? true : stryMutAct_9fa48("2400") ? isPositiveInteger(eventId) : (stryCov_9fa48("2400", "2401", "2402"), !isPositiveInteger(eventId))) {
        if (stryMutAct_9fa48("2403")) {
          {}
        } else {
          stryCov_9fa48("2403");
          res.status(404).json(stryMutAct_9fa48("2405") ? {} : (stryCov_9fa48("2405"), {
            error: stryMutAct_9fa48("2406") ? "" : (stryCov_9fa48("2406"), "Event not found")
          }));
          return;
        }
      }
      const {
        data: existing,
        error: fetchError
      } = await supabase.from(stryMutAct_9fa48("2407") ? "" : (stryCov_9fa48("2407"), "events")).select(stryMutAct_9fa48("2408") ? "" : (stryCov_9fa48("2408"), "id, status, organiser_id, coordinator_id, submitted_details")).eq(stryMutAct_9fa48("2409") ? "" : (stryCov_9fa48("2409"), "id"), Number(eventId)).maybeSingle();
      if (stryMutAct_9fa48("2411") ? false : stryMutAct_9fa48("2410") ? true : (stryCov_9fa48("2410", "2411"), fetchError)) {
        if (stryMutAct_9fa48("2412")) {
          {}
        } else {
          stryCov_9fa48("2412");
          res.status(500).json(stryMutAct_9fa48("2414") ? {} : (stryCov_9fa48("2414"), {
            error: stryMutAct_9fa48("2415") ? "" : (stryCov_9fa48("2415"), "Failed to load event")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("2418") ? false : stryMutAct_9fa48("2417") ? true : stryMutAct_9fa48("2416") ? existing : (stryCov_9fa48("2416", "2417", "2418"), !existing)) {
        if (stryMutAct_9fa48("2419")) {
          {}
        } else {
          stryCov_9fa48("2419");
          res.status(404).json(stryMutAct_9fa48("2421") ? {} : (stryCov_9fa48("2421"), {
            error: stryMutAct_9fa48("2422") ? "" : (stryCov_9fa48("2422"), "Event not found")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("2425") ? existing.organiser_id === user.id : stryMutAct_9fa48("2424") ? false : stryMutAct_9fa48("2423") ? true : (stryCov_9fa48("2423", "2424", "2425"), existing.organiser_id !== user.id)) {
        if (stryMutAct_9fa48("2426")) {
          {}
        } else {
          stryCov_9fa48("2426");
          await recordAccessDenial(supabase, user.id, eventId, stryMutAct_9fa48("2427") ? "" : (stryCov_9fa48("2427"), "not_found_or_not_owner"));
          res.status(403).json(stryMutAct_9fa48("2429") ? {} : (stryCov_9fa48("2429"), {
            error: stryMutAct_9fa48("2430") ? "" : (stryCov_9fa48("2430"), "Access denied")
          }));
          return;
        }
      }

      // E3-9 AC3: Completed/Cancelled block outright. Every other non-Confirmed
      // status (Draft, Unassigned, Requested, Clarification Requested,
      // Planning, Safety Review) already has a direct-edit or other path, so a
      // change request only ever makes sense from Confirmed.
      if (stryMutAct_9fa48("2433") ? existing.status !== EVENT_STATUS.Confirmed || existing.status !== EVENT_STATUS.NeedsReview : stryMutAct_9fa48("2432") ? false : stryMutAct_9fa48("2431") ? true : (stryCov_9fa48("2431", "2432", "2433"), (stryMutAct_9fa48("2435") ? existing.status === EVENT_STATUS.Confirmed : stryMutAct_9fa48("2434") ? true : (stryCov_9fa48("2434", "2435"), existing.status !== EVENT_STATUS.Confirmed)) && (stryMutAct_9fa48("2437") ? existing.status === EVENT_STATUS.NeedsReview : stryMutAct_9fa48("2436") ? true : (stryCov_9fa48("2436", "2437"), existing.status !== EVENT_STATUS.NeedsReview)))) {
        if (stryMutAct_9fa48("2438")) {
          {}
        } else {
          stryCov_9fa48("2438");
          res.status(409).json(stryMutAct_9fa48("2440") ? {} : (stryCov_9fa48("2440"), {
            error: stryMutAct_9fa48("2441") ? "" : (stryCov_9fa48("2441"), "Change requests can only be raised once the event is Confirmed.")
          }));
          return;
        }
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const current = (existing.submitted_details ?? {}) as Partial<ValidatedEventRequest>;

      // Merge with whatever's already open (at most one Pending request per
      // event — enforced by a unique index too, migration 0037) so a second
      // submission updates it instead of piling up a parallel one.
      const {
        data: openRequest,
        error: openRequestError
      } = await supabase.from(stryMutAct_9fa48("2442") ? "" : (stryCov_9fa48("2442"), "change_requests")).select(stryMutAct_9fa48("2443") ? "" : (stryCov_9fa48("2443"), "id")).eq(stryMutAct_9fa48("2444") ? "" : (stryCov_9fa48("2444"), "event_id"), existing.id).eq(stryMutAct_9fa48("2445") ? "" : (stryCov_9fa48("2445"), "status"), CHANGE_REQUEST_STATUS.Pending).maybeSingle();
      if (stryMutAct_9fa48("2447") ? false : stryMutAct_9fa48("2446") ? true : (stryCov_9fa48("2446", "2447"), openRequestError)) {
        if (stryMutAct_9fa48("2448")) {
          {}
        } else {
          stryCov_9fa48("2448");
          res.status(500).json(stryMutAct_9fa48("2450") ? {} : (stryCov_9fa48("2450"), {
            error: stryMutAct_9fa48("2451") ? "" : (stryCov_9fa48("2451"), "Failed to load the event's open change request")
          }));
          return;
        }
      }
      let openFields: {
        id: number;
        field: string;
        old_value: string | null;
        new_value: string;
        is_critical: boolean;
      }[] = stryMutAct_9fa48("2452") ? ["Stryker was here"] : (stryCov_9fa48("2452"), []);
      if (stryMutAct_9fa48("2454") ? false : stryMutAct_9fa48("2453") ? true : (stryCov_9fa48("2453", "2454"), openRequest)) {
        if (stryMutAct_9fa48("2455")) {
          {}
        } else {
          stryCov_9fa48("2455");
          const {
            data,
            error
          } = await supabase.from(stryMutAct_9fa48("2456") ? "" : (stryCov_9fa48("2456"), "change_request_fields")).select(stryMutAct_9fa48("2457") ? "" : (stryCov_9fa48("2457"), "id, field, old_value, new_value, is_critical")).eq(stryMutAct_9fa48("2458") ? "" : (stryCov_9fa48("2458"), "request_id"), openRequest.id);
          if (stryMutAct_9fa48("2460") ? false : stryMutAct_9fa48("2459") ? true : (stryCov_9fa48("2459", "2460"), error)) {
            if (stryMutAct_9fa48("2461")) {
              {}
            } else {
              stryCov_9fa48("2461");
              res.status(500).json(stryMutAct_9fa48("2463") ? {} : (stryCov_9fa48("2463"), {
                error: stryMutAct_9fa48("2464") ? "" : (stryCov_9fa48("2464"), "Failed to load the event's open change request")
              }));
              return;
            }
          }
          // Stryker disable next-line ArrayDeclaration: equivalent - a placeholder row is not critical, so it is filtered out below
          openFields = stryMutAct_9fa48("2465") ? data && [] : (stryCov_9fa48("2465"), data ?? []);
        }
      }
      const heldCritical = stryMutAct_9fa48("2467") ? openFields : (stryCov_9fa48("2467"), openFields.filter(stryMutAct_9fa48("2468") ? () => undefined : (stryCov_9fa48("2468"), field => field.is_critical)));

      // Diff against "what the organiser would see if they reopened the
      // form" — the committed baseline with any already-held values overlaid
      // — so resubmitting an untouched held field is a true no-op, not a
      // spurious re-hold every time.
      const effectiveBaseline = withHeldValues(current, heldCritical.map(stryMutAct_9fa48("2469") ? () => undefined : (stryCov_9fa48("2469"), field => stryMutAct_9fa48("2470") ? {} : (stryCov_9fa48("2470"), {
        field: field.field,
        newValue: field.new_value
      }))));
      const result = validateChangeRequestFields(body, effectiveBaseline);
      if (stryMutAct_9fa48("2473") ? false : stryMutAct_9fa48("2472") ? true : stryMutAct_9fa48("2471") ? result.valid : (stryCov_9fa48("2471", "2472", "2473"), !result.valid)) {
        if (stryMutAct_9fa48("2474")) {
          {}
        } else {
          stryCov_9fa48("2474");
          res.status(400).json(stryMutAct_9fa48("2476") ? {} : (stryCov_9fa48("2476"), {
            error: stryMutAct_9fa48("2477") ? "" : (stryCov_9fa48("2477"), "Validation failed"),
            fields: result.fields
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("2480") ? result.changes.length !== 0 : stryMutAct_9fa48("2479") ? false : stryMutAct_9fa48("2478") ? true : (stryCov_9fa48("2478", "2479", "2480"), result.changes.length === 0)) {
        if (stryMutAct_9fa48("2481")) {
          {}
        } else {
          stryCov_9fa48("2481");
          res.status(400).json(stryMutAct_9fa48("2483") ? {} : (stryCov_9fa48("2483"), {
            error: stryMutAct_9fa48("2484") ? "" : (stryCov_9fa48("2484"), "No field changes were submitted.")
          }));
          return;
        }
      }
      const nonCriticalChanges = stryMutAct_9fa48("2485") ? result.changes : (stryCov_9fa48("2485"), result.changes.filter(stryMutAct_9fa48("2486") ? () => undefined : (stryCov_9fa48("2486"), change => stryMutAct_9fa48("2487") ? change.isCritical : (stryCov_9fa48("2487"), !change.isCritical))));

      // A critical change against the held value is either a revert — the
      // organiser took it back to what's actually committed, so it's un-held
      // — or a genuine overwrite/fresh hold.
      const revertedFields: string[] = stryMutAct_9fa48("2488") ? ["Stryker was here"] : (stryCov_9fa48("2488"), []);
      const upsertedCritical: {
        field: string;
        oldValue: string | null;
        newValue: string;
      }[] = stryMutAct_9fa48("2489") ? ["Stryker was here"] : (stryCov_9fa48("2489"), []);
      for (const change of stryMutAct_9fa48("2490") ? result.changes : (stryCov_9fa48("2490"), result.changes.filter(stryMutAct_9fa48("2491") ? () => undefined : (stryCov_9fa48("2491"), c => c.isCritical)))) {
        if (stryMutAct_9fa48("2492")) {
          {}
        } else {
          stryCov_9fa48("2492");
          const trueBaseline = committedFieldValue(current, change.field);
          // A change to a field that isn't held always differs from its committed value (the diff above is against it),
          // and a submitted value is never empty, so only a held field can come back equal to the committed one.
          if (stryMutAct_9fa48("2495") ? change.newValue !== trueBaseline : stryMutAct_9fa48("2494") ? false : stryMutAct_9fa48("2493") ? true : (stryCov_9fa48("2493", "2494", "2495"), change.newValue === trueBaseline)) {
            if (stryMutAct_9fa48("2496")) {
              {}
            } else {
              stryCov_9fa48("2496");
              if (stryMutAct_9fa48("2497")) {
                ;
              } else {
                stryCov_9fa48("2497");
                revertedFields.push(change.field);
              }
            }
          } else {
            if (stryMutAct_9fa48("2498")) {
              {}
            } else {
              stryCov_9fa48("2498");
              upsertedCritical.push(stryMutAct_9fa48("2500") ? {} : (stryCov_9fa48("2500"), {
                field: change.field,
                oldValue: trueBaseline,
                newValue: change.newValue
              }));
            }
          }
        }
      }

      // Whether any held field is left once the reverted ones are dropped; only read when nothing new is being held.
      const willHoldSomething = stryMutAct_9fa48("2501") ? heldCritical.every(f => !revertedFields.includes(f.field)) : (stryCov_9fa48("2501"), heldCritical.some(stryMutAct_9fa48("2502") ? () => undefined : (stryCov_9fa48("2502"), f => stryMutAct_9fa48("2503") ? revertedFields.includes(f.field) : (stryCov_9fa48("2503"), !revertedFields.includes(f.field)))));

      // Create a row only if nothing's open yet and this submission needs
      // one — a Pending request if it's holding anything, else an already-
      // resolved Approved one for a purely non-critical/pure-revert touch.
      let targetRequestId = stryMutAct_9fa48("2504") ? openRequest?.id && null : (stryCov_9fa48("2504"), (stryMutAct_9fa48("2505") ? openRequest.id : (stryCov_9fa48("2505"), openRequest?.id)) ?? null);
      // With nothing open there is nothing held to revert, so a submission that got this far changes something.
      if (stryMutAct_9fa48("2508") ? false : stryMutAct_9fa48("2507") ? true : stryMutAct_9fa48("2506") ? targetRequestId : (stryCov_9fa48("2506", "2507", "2508"), !targetRequestId)) {
        if (stryMutAct_9fa48("2509")) {
          {}
        } else {
          stryCov_9fa48("2509");
          const isAutoApplied = stryMutAct_9fa48("2512") ? upsertedCritical.length !== 0 : stryMutAct_9fa48("2511") ? false : stryMutAct_9fa48("2510") ? true : (stryCov_9fa48("2510", "2511", "2512"), upsertedCritical.length === 0);
          const {
            data: created,
            error: createError
          } = await supabase.from(stryMutAct_9fa48("2513") ? "" : (stryCov_9fa48("2513"), "change_requests")).insert(stryMutAct_9fa48("2514") ? {} : (stryCov_9fa48("2514"), {
            event_id: existing.id,
            organiser_id: user.id,
            status: isAutoApplied ? CHANGE_REQUEST_STATUS.Approved : CHANGE_REQUEST_STATUS.Pending,
            decided_at: isAutoApplied ? clock.now().toISOString() : null,
            // E3-8 AC3: nothing critical was touched, so there's nothing for a
            // coordinator to review — flagged as automatic (not a coordinator's
            // decision) so both sides can tell it apart from a real approval.
            decision_reason: isAutoApplied ? stryMutAct_9fa48("2515") ? `` : (stryCov_9fa48("2515"), `${AUTO_APPLIED_REASON_PREFIX}${nonCriticalChanges.map(stryMutAct_9fa48("2516") ? () => undefined : (stryCov_9fa48("2516"), c => c.field)).join(stryMutAct_9fa48("2517") ? "" : (stryCov_9fa48("2517"), ", "))}`) : null
          })).select(stryMutAct_9fa48("2518") ? "" : (stryCov_9fa48("2518"), "id")).single();
          if (stryMutAct_9fa48("2521") ? createError && !created : stryMutAct_9fa48("2520") ? false : stryMutAct_9fa48("2519") ? true : (stryCov_9fa48("2519", "2520", "2521"), createError || (stryMutAct_9fa48("2522") ? created : (stryCov_9fa48("2522"), !created)))) {
            if (stryMutAct_9fa48("2523")) {
              {}
            } else {
              stryCov_9fa48("2523");
              res.status(500).json(stryMutAct_9fa48("2525") ? {} : (stryCov_9fa48("2525"), {
                error: stryMutAct_9fa48("2526") ? "" : (stryCov_9fa48("2526"), "Failed to raise change request")
              }));
              return;
            }
          }
          targetRequestId = created.id;
        }
      }
      if (stryMutAct_9fa48("2529") ? revertedFields.length > 0 || targetRequestId : stryMutAct_9fa48("2528") ? false : stryMutAct_9fa48("2527") ? true : (stryCov_9fa48("2527", "2528", "2529"), (stryMutAct_9fa48("2532") ? revertedFields.length <= 0 : stryMutAct_9fa48("2531") ? revertedFields.length >= 0 : stryMutAct_9fa48("2530") ? true : (stryCov_9fa48("2530", "2531", "2532"), revertedFields.length > 0)) && targetRequestId)) {
        if (stryMutAct_9fa48("2533")) {
          {}
        } else {
          stryCov_9fa48("2533");
          const {
            error: deleteError
          } = await supabase.from(stryMutAct_9fa48("2534") ? "" : (stryCov_9fa48("2534"), "change_request_fields")).delete().eq(stryMutAct_9fa48("2535") ? "" : (stryCov_9fa48("2535"), "request_id"), targetRequestId).in(stryMutAct_9fa48("2536") ? "" : (stryCov_9fa48("2536"), "field"), revertedFields);
          if (stryMutAct_9fa48("2538") ? false : stryMutAct_9fa48("2537") ? true : (stryCov_9fa48("2537", "2538"), deleteError)) {
            if (stryMutAct_9fa48("2539")) {
              {}
            } else {
              stryCov_9fa48("2539");
              res.status(500).json(stryMutAct_9fa48("2541") ? {} : (stryCov_9fa48("2541"), {
                error: stryMutAct_9fa48("2542") ? "" : (stryCov_9fa48("2542"), "Failed to raise change request")
              }));
              return;
            }
          }
        }
      }
      const rowsToUpsert = stryMutAct_9fa48("2543") ? [] : (stryCov_9fa48("2543"), [...upsertedCritical.map(stryMutAct_9fa48("2544") ? () => undefined : (stryCov_9fa48("2544"), change => stryMutAct_9fa48("2545") ? {} : (stryCov_9fa48("2545"), {
        ...change,
        isCritical: stryMutAct_9fa48("2546") ? false : (stryCov_9fa48("2546"), true)
      }))), ...nonCriticalChanges.map(stryMutAct_9fa48("2547") ? () => undefined : (stryCov_9fa48("2547"), change => stryMutAct_9fa48("2548") ? {} : (stryCov_9fa48("2548"), {
        field: change.field,
        oldValue: change.oldValue,
        newValue: change.newValue,
        isCritical: stryMutAct_9fa48("2549") ? true : (stryCov_9fa48("2549"), false)
      })))]);
      if (stryMutAct_9fa48("2552") ? rowsToUpsert.length > 0 || targetRequestId : stryMutAct_9fa48("2551") ? false : stryMutAct_9fa48("2550") ? true : (stryCov_9fa48("2550", "2551", "2552"), (stryMutAct_9fa48("2555") ? rowsToUpsert.length <= 0 : stryMutAct_9fa48("2554") ? rowsToUpsert.length >= 0 : stryMutAct_9fa48("2553") ? true : (stryCov_9fa48("2553", "2554", "2555"), rowsToUpsert.length > 0)) && targetRequestId)) {
        if (stryMutAct_9fa48("2556")) {
          {}
        } else {
          stryCov_9fa48("2556");
          const {
            error: upsertError
          } = await supabase.from(stryMutAct_9fa48("2557") ? "" : (stryCov_9fa48("2557"), "change_request_fields")).upsert(rowsToUpsert.map(stryMutAct_9fa48("2558") ? () => undefined : (stryCov_9fa48("2558"), change => stryMutAct_9fa48("2559") ? {} : (stryCov_9fa48("2559"), {
            request_id: targetRequestId,
            field: change.field,
            old_value: change.oldValue,
            new_value: change.newValue,
            is_critical: change.isCritical
          }))), stryMutAct_9fa48("2560") ? {} : (stryCov_9fa48("2560"), {
            onConflict: stryMutAct_9fa48("2561") ? "" : (stryCov_9fa48("2561"), "request_id,field")
          }));
          if (stryMutAct_9fa48("2563") ? false : stryMutAct_9fa48("2562") ? true : (stryCov_9fa48("2562", "2563"), upsertError)) {
            if (stryMutAct_9fa48("2564")) {
              {}
            } else {
              stryCov_9fa48("2564");
              res.status(500).json(stryMutAct_9fa48("2566") ? {} : (stryCov_9fa48("2566"), {
                error: stryMutAct_9fa48("2567") ? "" : (stryCov_9fa48("2567"), "Failed to raise change request")
              }));
              return;
            }
          }
        }
      }

      // Non-critical fields apply immediately (E3-8 AC3) — written straight to
      // submitted_details, same as any other direct edit.
      if (stryMutAct_9fa48("2571") ? nonCriticalChanges.length <= 0 : stryMutAct_9fa48("2570") ? nonCriticalChanges.length >= 0 : stryMutAct_9fa48("2569") ? false : stryMutAct_9fa48("2568") ? true : (stryCov_9fa48("2568", "2569", "2570", "2571"), nonCriticalChanges.length > 0)) {
        if (stryMutAct_9fa48("2572")) {
          {}
        } else {
          stryCov_9fa48("2572");
          const updatedDetails: Record<string, unknown> = stryMutAct_9fa48("2573") ? {} : (stryCov_9fa48("2573"), {
            ...current
          });
          for (const change of nonCriticalChanges) {
            if (stryMutAct_9fa48("2574")) {
              {}
            } else {
              stryCov_9fa48("2574");
              updatedDetails[change.field] = (stryMutAct_9fa48("2577") ? change.field !== "registrationNeeded" : stryMutAct_9fa48("2576") ? false : stryMutAct_9fa48("2575") ? true : (stryCov_9fa48("2575", "2576", "2577"), change.field === (stryMutAct_9fa48("2578") ? "" : (stryCov_9fa48("2578"), "registrationNeeded")))) ? stryMutAct_9fa48("2581") ? body.registrationNeeded === true && body.registrationNeeded === "true" : stryMutAct_9fa48("2580") ? false : stryMutAct_9fa48("2579") ? true : (stryCov_9fa48("2579", "2580", "2581"), (stryMutAct_9fa48("2583") ? body.registrationNeeded !== true : stryMutAct_9fa48("2582") ? false : (stryCov_9fa48("2582", "2583"), body.registrationNeeded === (stryMutAct_9fa48("2584") ? false : (stryCov_9fa48("2584"), true)))) || (stryMutAct_9fa48("2586") ? body.registrationNeeded !== "true" : stryMutAct_9fa48("2585") ? false : (stryCov_9fa48("2585", "2586"), body.registrationNeeded === (stryMutAct_9fa48("2587") ? "" : (stryCov_9fa48("2587"), "true"))))) : stryMutAct_9fa48("2588") ? String(body[change.field]) : (stryCov_9fa48("2588"), String(body[change.field]).trim());
            }
          }
          const {
            error: updateError
          } = await supabase.from(stryMutAct_9fa48("2589") ? "" : (stryCov_9fa48("2589"), "events")).update(stryMutAct_9fa48("2590") ? {} : (stryCov_9fa48("2590"), {
            submitted_details: updatedDetails
          })).eq(stryMutAct_9fa48("2591") ? "" : (stryCov_9fa48("2591"), "id"), existing.id);
          if (stryMutAct_9fa48("2593") ? false : stryMutAct_9fa48("2592") ? true : (stryCov_9fa48("2592", "2593"), updateError)) {
            if (stryMutAct_9fa48("2594")) {
              {}
            } else {
              stryCov_9fa48("2594");
              res.status(500).json(stryMutAct_9fa48("2596") ? {} : (stryCov_9fa48("2596"), {
                error: stryMutAct_9fa48("2597") ? "" : (stryCov_9fa48("2597"), "Failed to apply change request")
              }));
              return;
            }
          }
          await recordEventHistory(supabase, existing.id, nonCriticalChanges.map(stryMutAct_9fa48("2598") ? () => undefined : (stryCov_9fa48("2598"), change => stryMutAct_9fa48("2599") ? {} : (stryCov_9fa48("2599"), {
            field: change.field,
            oldValue: change.oldValue,
            newValue: change.newValue
          }))), user.id);
        }
      }

      // Critical fields are held, not applied (E3-8 AC1) — already recorded
      // above in change_request_fields; just the pending-review event_history
      // entry is left to do here. E3-11 is what later writes decided_by/
      // decided_at/decision_reason and applies these values.
      // Logged as a pending request, not a value change — nothing has been
      // applied yet, so the old value hasn't moved. Covers both a fresh
      // hold and an overwrite of an already-held value — same wording,
      // since either way the committed value is unchanged until decided.
      // (recordEventHistory writes nothing for an empty list.)
      await recordEventHistory(supabase, existing.id, upsertedCritical.map(stryMutAct_9fa48("2600") ? () => undefined : (stryCov_9fa48("2600"), change => stryMutAct_9fa48("2601") ? {} : (stryCov_9fa48("2601"), {
        field: change.field,
        oldValue: change.oldValue,
        newValue: stryMutAct_9fa48("2602") ? `` : (stryCov_9fa48("2602"), `requested: ${change.newValue} (pending coordinator review)`)
      }))), user.id);
      await recordEventHistory(supabase, existing.id, revertedFields.map(field => {
        if (stryMutAct_9fa48("2603")) {
          {}
        } else {
          stryCov_9fa48("2603");
          const discarded = heldCritical.find(stryMutAct_9fa48("2604") ? () => undefined : (stryCov_9fa48("2604"), f => stryMutAct_9fa48("2607") ? f.field !== field : stryMutAct_9fa48("2606") ? false : stryMutAct_9fa48("2605") ? true : (stryCov_9fa48("2605", "2606", "2607"), f.field === field)))!;
          return stryMutAct_9fa48("2608") ? {} : (stryCov_9fa48("2608"), {
            field,
            oldValue: discarded.new_value,
            newValue: stryMutAct_9fa48("2609") ? `` : (stryCov_9fa48("2609"), `reverted to ${committedFieldValue(current, field)} (no longer pending)`)
          });
        }
      }), user.id);
      const eventName = eventDisplayName(existing as unknown as AssignmentEventRow);
      let notificationsFailed = stryMutAct_9fa48("2610") ? true : (stryCov_9fa48("2610"), false);
      let autoResolved = stryMutAct_9fa48("2611") ? true : (stryCov_9fa48("2611"), false);

      // A held critical field puts a Confirmed event into Needs Review until the
      // coordinator decides it (AGENTS.md section 3). The status filter makes it
      // a no-op if the event already moved on; an event already in Needs Review
      // stays there.
      if (stryMutAct_9fa48("2614") ? upsertedCritical.length > 0 || existing.status === EVENT_STATUS.Confirmed : stryMutAct_9fa48("2613") ? false : stryMutAct_9fa48("2612") ? true : (stryCov_9fa48("2612", "2613", "2614"), (stryMutAct_9fa48("2617") ? upsertedCritical.length <= 0 : stryMutAct_9fa48("2616") ? upsertedCritical.length >= 0 : stryMutAct_9fa48("2615") ? true : (stryCov_9fa48("2615", "2616", "2617"), upsertedCritical.length > 0)) && (stryMutAct_9fa48("2619") ? existing.status !== EVENT_STATUS.Confirmed : stryMutAct_9fa48("2618") ? true : (stryCov_9fa48("2618", "2619"), existing.status === EVENT_STATUS.Confirmed)))) {
        if (stryMutAct_9fa48("2620")) {
          {}
        } else {
          stryCov_9fa48("2620");
          const {
            error: reviewError
          } = await supabase.from(stryMutAct_9fa48("2621") ? "" : (stryCov_9fa48("2621"), "events")).update(stryMutAct_9fa48("2622") ? {} : (stryCov_9fa48("2622"), {
            status: EVENT_STATUS.NeedsReview
          })).eq(stryMutAct_9fa48("2623") ? "" : (stryCov_9fa48("2623"), "id"), existing.id).eq(stryMutAct_9fa48("2624") ? "" : (stryCov_9fa48("2624"), "status"), EVENT_STATUS.Confirmed);
          if (stryMutAct_9fa48("2626") ? false : stryMutAct_9fa48("2625") ? true : (stryCov_9fa48("2625", "2626"), reviewError)) {
            if (stryMutAct_9fa48("2627")) {
              {}
            } else {
              stryCov_9fa48("2627");
              res.status(500).json(stryMutAct_9fa48("2629") ? {} : (stryCov_9fa48("2629"), {
                error: stryMutAct_9fa48("2630") ? "" : (stryCov_9fa48("2630"), "Failed to raise change request")
              }));
              return;
            }
          }
          await recordEventHistory(supabase, existing.id, stryMutAct_9fa48("2631") ? [] : (stryCov_9fa48("2631"), [stryMutAct_9fa48("2632") ? {} : (stryCov_9fa48("2632"), {
            field: stryMutAct_9fa48("2633") ? "" : (stryCov_9fa48("2633"), "Status"),
            oldValue: EVENT_STATUS.Confirmed,
            newValue: EVENT_STATUS.NeedsReview
          })]), user.id);
        }
      }
      if (stryMutAct_9fa48("2636") ? targetRequestId && upsertedCritical.length === 0 && !willHoldSomething || revertedFields.length > 0 : stryMutAct_9fa48("2635") ? false : stryMutAct_9fa48("2634") ? true : (stryCov_9fa48("2634", "2635", "2636"), (stryMutAct_9fa48("2638") ? targetRequestId && upsertedCritical.length === 0 || !willHoldSomething : stryMutAct_9fa48("2637") ? true : (stryCov_9fa48("2637", "2638"), (stryMutAct_9fa48("2640") ? targetRequestId || upsertedCritical.length === 0 : stryMutAct_9fa48("2639") ? true : (stryCov_9fa48("2639", "2640"), targetRequestId && (stryMutAct_9fa48("2642") ? upsertedCritical.length !== 0 : stryMutAct_9fa48("2641") ? true : (stryCov_9fa48("2641", "2642"), upsertedCritical.length === 0)))) && (stryMutAct_9fa48("2643") ? willHoldSomething : (stryCov_9fa48("2643"), !willHoldSomething)))) && (stryMutAct_9fa48("2646") ? revertedFields.length <= 0 : stryMutAct_9fa48("2645") ? revertedFields.length >= 0 : stryMutAct_9fa48("2644") ? true : (stryCov_9fa48("2644", "2645", "2646"), revertedFields.length > 0)))) {
        if (stryMutAct_9fa48("2647")) {
          {}
        } else {
          stryCov_9fa48("2647");
          // Every held field just got reverted — nothing left to decide. Close
          // the request out rather than leaving it "Pending" with no fields,
          // and tell both sides it resolved itself rather than staying silent.
          autoResolved = stryMutAct_9fa48("2648") ? false : (stryCov_9fa48("2648"), true);
          // Its own status (migration 0038) — nothing was actually approved,
          // the request just evaporated, so Approved would be the wrong word.
          // decision_reason is still set as the human-readable explanation.
          const {
            error: resolveError
          } = await supabase.from(stryMutAct_9fa48("2649") ? "" : (stryCov_9fa48("2649"), "change_requests")).update(stryMutAct_9fa48("2650") ? {} : (stryCov_9fa48("2650"), {
            status: CHANGE_REQUEST_STATUS.AutoWithdrawn,
            decided_at: clock.now().toISOString(),
            decided_by: null,
            decision_reason: stryMutAct_9fa48("2651") ? `` : (stryCov_9fa48("2651"), `The requested change to ${revertedFields.join(stryMutAct_9fa48("2652") ? "" : (stryCov_9fa48("2652"), ", "))} was reverted before it was reviewed.`)
          })).eq(stryMutAct_9fa48("2653") ? "" : (stryCov_9fa48("2653"), "id"), targetRequestId);
          if (stryMutAct_9fa48("2655") ? false : stryMutAct_9fa48("2654") ? true : (stryCov_9fa48("2654", "2655"), resolveError)) {
            if (stryMutAct_9fa48("2656")) {
              {}
            } else {
              stryCov_9fa48("2656");
              res.status(500).json(stryMutAct_9fa48("2658") ? {} : (stryCov_9fa48("2658"), {
                error: stryMutAct_9fa48("2659") ? "" : (stryCov_9fa48("2659"), "Failed to raise change request")
              }));
              return;
            }
          }
          const recipients = existing.coordinator_id ? stryMutAct_9fa48("2660") ? [] : (stryCov_9fa48("2660"), [user.id, existing.coordinator_id]) : stryMutAct_9fa48("2661") ? [] : (stryCov_9fa48("2661"), [user.id]);
          const published = await getPublisher().publish(stryMutAct_9fa48("2662") ? {} : (stryCov_9fa48("2662"), {
            type: stryMutAct_9fa48("2663") ? "" : (stryCov_9fa48("2663"), "change.withdrawn"),
            eventId: existing.id,
            actorId: user.id,
            recipients: stryMutAct_9fa48("2664") ? {} : (stryCov_9fa48("2664"), {
              userIds: recipients,
              roles: stryMutAct_9fa48("2665") ? ["Stryker was here"] : (stryCov_9fa48("2665"), [])
            }),
            data: stryMutAct_9fa48("2666") ? {} : (stryCov_9fa48("2666"), {
              eventName,
              changeRequestId: targetRequestId,
              fields: revertedFields
            })
          }));
          notificationsFailed = stryMutAct_9fa48("2667") ? published : (stryCov_9fa48("2667"), !published);
        }
      } else if (stryMutAct_9fa48("2669") ? false : stryMutAct_9fa48("2668") ? true : (stryCov_9fa48("2668", "2669"), existing.coordinator_id)) {
        if (stryMutAct_9fa48("2670")) {
          {}
        } else {
          stryCov_9fa48("2670");
          const published = await getPublisher().publish(stryMutAct_9fa48("2671") ? {} : (stryCov_9fa48("2671"), {
            type: stryMutAct_9fa48("2672") ? "" : (stryCov_9fa48("2672"), "change.requested"),
            eventId: existing.id,
            actorId: user.id,
            recipients: stryMutAct_9fa48("2673") ? {} : (stryCov_9fa48("2673"), {
              userIds: stryMutAct_9fa48("2674") ? [] : (stryCov_9fa48("2674"), [existing.coordinator_id]),
              roles: stryMutAct_9fa48("2675") ? ["Stryker was here"] : (stryCov_9fa48("2675"), [])
            }),
            data: stryMutAct_9fa48("2676") ? {} : (stryCov_9fa48("2676"), {
              eventName,
              changeRequestId: targetRequestId,
              fields: result.changes.map(stryMutAct_9fa48("2677") ? () => undefined : (stryCov_9fa48("2677"), change => change.field))
            })
          }));
          notificationsFailed = stryMutAct_9fa48("2678") ? published : (stryCov_9fa48("2678"), !published);
        }
      }
      res.status(201).json(stryMutAct_9fa48("2680") ? {} : (stryCov_9fa48("2680"), {
        changeRequestId: targetRequestId,
        applied: nonCriticalChanges.map(stryMutAct_9fa48("2681") ? () => undefined : (stryCov_9fa48("2681"), change => change.field)),
        held: upsertedCritical.map(stryMutAct_9fa48("2682") ? () => undefined : (stryCov_9fa48("2682"), change => change.field)),
        reverted: revertedFields,
        autoResolved,
        notificationsFailed
      }));
    }
  });
}
/**
 * E3-8 AC2/AC4: what a held critical change would affect — the event's
 * current venue bookings, equipment reservations and registrations, plus
 * whether the requested attendance would exceed a booked venue's capacity.
 * Pure read: nothing here writes anything, matching AC4's "the booking is
 * not released automatically". Not E3-10's own assessment screen (that
 * story still owns its own workflow) — just enough to satisfy E3-8's two
 * ACs for the assigned coordinator reviewing a Pending request.
 */
interface ChangeRequestImpact {
  bookings: {
    id: number;
    status: string;
    venue: {
      id: number;
      name: string;
    } | null;
  }[];
  equipmentReservations: {
    id: number;
    status: string;
    items: ArrangementEquipmentItem[];
  }[];
  registrations: {
    registeredCount: number;
    total: number;
    // E3-10 AC1: "listed", not just counted.
    registrations: {
      registrationId: number;
      userId: string;
      name: string | null;
      status: string;
    }[];
  };
  capacityConflict: {
    bookingId: number;
    venueName: string;
    capacity: number;
    requestedAttendance: number;
  } | null;
  // E3-10 AC2's "availability" half — a held schedule change checked
  // against the booked venue's block-out periods and other bookings.
  // null when nothing to check (no schedule held) or nothing clashed.
  availabilityConflict: {
    bookingId: number;
    unavailabilityConflict: {
      reason: string;
      description: string;
    } | null;
    bookingConflict: {
      bookingId: number;
      status: string;
      window: string;
    } | null;
  } | null;
}

/**
 * What to actually check, from a request's held fields: the requested
 * attendance (for the capacity check) and the proposed schedule (for the
 * availability check) — a partial schedule change (e.g. just endTime)
 * still needs a complete window, so the other two pieces fall back to
 * what's already committed. Shared by the GET route's per-request impact
 * loop and the approve route below, which needs the exact same inputs to
 * decide whether this specific approval actually invalidates a booking.
 */
function deriveImpactInputs(fields: {
  field: string;
  new_value: string;
}[], committedDetails: Record<string, unknown>): {
  requestedAttendance: number | null;
  proposedSchedule: {
    proposedDate: string;
    startTime: string | null;
    endTime: string | null;
  } | null;
} {
  if (stryMutAct_9fa48("2683")) {
    {}
  } else {
    stryCov_9fa48("2683");
    const attendanceField = fields.find(stryMutAct_9fa48("2684") ? () => undefined : (stryCov_9fa48("2684"), field => stryMutAct_9fa48("2687") ? field.field !== "expectedAttendance" : stryMutAct_9fa48("2686") ? false : stryMutAct_9fa48("2685") ? true : (stryCov_9fa48("2685", "2686", "2687"), field.field === (stryMutAct_9fa48("2688") ? "" : (stryCov_9fa48("2688"), "expectedAttendance")))));
    const requestedAttendanceRaw = attendanceField ? Number(attendanceField.new_value) : null;
    const requestedAttendance = Number.isFinite(requestedAttendanceRaw) ? requestedAttendanceRaw : null;
    const heldScheduleField = stryMutAct_9fa48("2689") ? () => undefined : (stryCov_9fa48("2689"), (() => {
      const heldScheduleField = (field: string) => stryMutAct_9fa48("2690") ? fields.find(f => f.field === field).new_value : (stryCov_9fa48("2690"), fields.find(stryMutAct_9fa48("2691") ? () => undefined : (stryCov_9fa48("2691"), f => stryMutAct_9fa48("2694") ? f.field !== field : stryMutAct_9fa48("2693") ? false : stryMutAct_9fa48("2692") ? true : (stryCov_9fa48("2692", "2693", "2694"), f.field === field)))?.new_value);
      return heldScheduleField;
    })());
    const hasScheduleChange = stryMutAct_9fa48("2695") ? ["proposedDate", "startTime", "endTime"].every(field => fields.some(f => f.field === field)) : (stryCov_9fa48("2695"), (stryMutAct_9fa48("2696") ? [] : (stryCov_9fa48("2696"), [stryMutAct_9fa48("2697") ? "" : (stryCov_9fa48("2697"), "proposedDate"), stryMutAct_9fa48("2698") ? "" : (stryCov_9fa48("2698"), "startTime"), stryMutAct_9fa48("2699") ? "" : (stryCov_9fa48("2699"), "endTime")])).some(stryMutAct_9fa48("2700") ? () => undefined : (stryCov_9fa48("2700"), field => stryMutAct_9fa48("2701") ? fields.every(f => f.field === field) : (stryCov_9fa48("2701"), fields.some(stryMutAct_9fa48("2702") ? () => undefined : (stryCov_9fa48("2702"), f => stryMutAct_9fa48("2705") ? f.field !== field : stryMutAct_9fa48("2704") ? false : stryMutAct_9fa48("2703") ? true : (stryCov_9fa48("2703", "2704", "2705"), f.field === field)))))));
    const proposedSchedule = hasScheduleChange ? stryMutAct_9fa48("2706") ? {} : (stryCov_9fa48("2706"), {
      proposedDate: stryMutAct_9fa48("2707") ? heldScheduleField("proposedDate") && committedDetails.proposedDate as string : (stryCov_9fa48("2707"), heldScheduleField(stryMutAct_9fa48("2708") ? "" : (stryCov_9fa48("2708"), "proposedDate")) ?? committedDetails.proposedDate as string),
      startTime: stryMutAct_9fa48("2709") ? (heldScheduleField("startTime") ?? committedDetails.startTime as string | null) && null : (stryCov_9fa48("2709"), (stryMutAct_9fa48("2710") ? heldScheduleField("startTime") && committedDetails.startTime as string | null : (stryCov_9fa48("2710"), heldScheduleField(stryMutAct_9fa48("2711") ? "" : (stryCov_9fa48("2711"), "startTime")) ?? committedDetails.startTime as string | null)) ?? null),
      endTime: stryMutAct_9fa48("2712") ? (heldScheduleField("endTime") ?? committedDetails.endTime as string | null) && null : (stryCov_9fa48("2712"), (stryMutAct_9fa48("2713") ? heldScheduleField("endTime") && committedDetails.endTime as string | null : (stryCov_9fa48("2713"), heldScheduleField(stryMutAct_9fa48("2714") ? "" : (stryCov_9fa48("2714"), "endTime")) ?? committedDetails.endTime as string | null)) ?? null)
    }) : null;
    return stryMutAct_9fa48("2715") ? {} : (stryCov_9fa48("2715"), {
      requestedAttendance,
      proposedSchedule
    });
  }
}
async function loadChangeRequestImpact(eventId: number, requestedAttendance: number | null, proposedSchedule: {
  proposedDate: string;
  startTime: string | null;
  endTime: string | null;
} | null, authorization: string): Promise<ChangeRequestImpact | null> {
  if (stryMutAct_9fa48("2716")) {
    {}
  } else {
    stryCov_9fa48("2716");
    const [bookingsResult, equipmentResult, registrationsResult] = await Promise.all(stryMutAct_9fa48("2717") ? [] : (stryCov_9fa48("2717"), [fetchEventVenueBookings(eventId, authorization), fetchEventEquipmentRequests(eventId, authorization), fetchEventRegistrations(eventId, authorization)]));
    if (stryMutAct_9fa48("2720") ? (bookingsResult.status !== "ok" || equipmentResult.status !== "ok") && registrationsResult.status !== "ok" : stryMutAct_9fa48("2719") ? false : stryMutAct_9fa48("2718") ? true : (stryCov_9fa48("2718", "2719", "2720"), (stryMutAct_9fa48("2722") ? bookingsResult.status !== "ok" && equipmentResult.status !== "ok" : stryMutAct_9fa48("2721") ? false : (stryCov_9fa48("2721", "2722"), (stryMutAct_9fa48("2724") ? bookingsResult.status === "ok" : stryMutAct_9fa48("2723") ? false : (stryCov_9fa48("2723", "2724"), bookingsResult.status !== (stryMutAct_9fa48("2725") ? "" : (stryCov_9fa48("2725"), "ok")))) || (stryMutAct_9fa48("2727") ? equipmentResult.status === "ok" : stryMutAct_9fa48("2726") ? false : (stryCov_9fa48("2726", "2727"), equipmentResult.status !== (stryMutAct_9fa48("2728") ? "" : (stryCov_9fa48("2728"), "ok")))))) || (stryMutAct_9fa48("2730") ? registrationsResult.status === "ok" : stryMutAct_9fa48("2729") ? false : (stryCov_9fa48("2729", "2730"), registrationsResult.status !== (stryMutAct_9fa48("2731") ? "" : (stryCov_9fa48("2731"), "ok")))))) {
      if (stryMutAct_9fa48("2732")) {
        {}
      } else {
        stryCov_9fa48("2732");
        return null;
      }
    }
    const bookings = bookingsResult.value;
    const registrations = registrationsResult.value;

    // E3-8 AC4 / E3-10 AC2: only a booking that's actually locked in the
    // venue is worth checking against — a Withdrawn/Rejected/Expired one
    // doesn't hold anything real, so flagging a conflict against it would
    // name a venue the event no longer has. By the time an event reaches
    // Confirmed its bookings should all be Approved anyway (On Hold/
    // Requested never survive to here), so this is the simplest correct
    // filter without needing hold-expiry data this client doesn't carry.
    const activeBookings = stryMutAct_9fa48("2733") ? bookings : (stryCov_9fa48("2733"), bookings.filter(stryMutAct_9fa48("2734") ? () => undefined : (stryCov_9fa48("2734"), booking => stryMutAct_9fa48("2737") ? booking.status !== "Approved" : stryMutAct_9fa48("2736") ? false : stryMutAct_9fa48("2735") ? true : (stryCov_9fa48("2735", "2736", "2737"), booking.status === (stryMutAct_9fa48("2738") ? "" : (stryCov_9fa48("2738"), "Approved"))))));
    let capacityConflict: ChangeRequestImpact["capacityConflict"] = null;
    // Stryker disable next-line ConditionalExpression: equivalent - without the check `capacity < null` is `capacity < 0`, still false
    if (stryMutAct_9fa48("2741") ? requestedAttendance === null : (stryCov_9fa48("2741"), requestedAttendance !== null)) {
      if (stryMutAct_9fa48("2742")) {
        {}
      } else {
        stryCov_9fa48("2742");
        const overCapacity = activeBookings.find(stryMutAct_9fa48("2743") ? () => undefined : (stryCov_9fa48("2743"), booking => stryMutAct_9fa48("2746") ? typeof booking.venue?.capacity === "number" || booking.venue.capacity < requestedAttendance : stryMutAct_9fa48("2745") ? false : stryMutAct_9fa48("2744") ? true : (stryCov_9fa48("2744", "2745", "2746"), (stryMutAct_9fa48("2748") ? typeof booking.venue?.capacity !== "number" : stryMutAct_9fa48("2747") ? true : (stryCov_9fa48("2747", "2748"), typeof (stryMutAct_9fa48("2749") ? booking.venue.capacity : (stryCov_9fa48("2749"), booking.venue?.capacity)) === (stryMutAct_9fa48("2750") ? "" : (stryCov_9fa48("2750"), "number")))) && (stryMutAct_9fa48("2753") ? booking.venue.capacity >= requestedAttendance : stryMutAct_9fa48("2752") ? booking.venue.capacity <= requestedAttendance : stryMutAct_9fa48("2751") ? true : (stryCov_9fa48("2751", "2752", "2753"), booking.venue.capacity < requestedAttendance)))));
        if (stryMutAct_9fa48("2756") ? overCapacity.venue : stryMutAct_9fa48("2755") ? false : stryMutAct_9fa48("2754") ? true : (stryCov_9fa48("2754", "2755", "2756"), overCapacity?.venue)) {
          if (stryMutAct_9fa48("2757")) {
            {}
          } else {
            stryCov_9fa48("2757");
            capacityConflict = stryMutAct_9fa48("2758") ? {} : (stryCov_9fa48("2758"), {
              bookingId: overCapacity.id,
              venueName: overCapacity.venue.name,
              capacity: overCapacity.venue.capacity as number,
              requestedAttendance
            });
          }
        }
      }
    }

    // Checked against the first active booking with a venue — same
    // simplicity as the capacity check above, and in practice an event's
    // main booking.
    let availabilityConflict: ChangeRequestImpact["availabilityConflict"] = null;
    const bookingToCheck = activeBookings.find(stryMutAct_9fa48("2759") ? () => undefined : (stryCov_9fa48("2759"), booking => booking.venue));
    if (stryMutAct_9fa48("2762") ? proposedSchedule || bookingToCheck : stryMutAct_9fa48("2761") ? false : stryMutAct_9fa48("2760") ? true : (stryCov_9fa48("2760", "2761", "2762"), proposedSchedule && bookingToCheck)) {
      if (stryMutAct_9fa48("2763")) {
        {}
      } else {
        stryCov_9fa48("2763");
        const availabilityResult = await checkBookingAvailability(bookingToCheck.id, proposedSchedule, authorization);
        if (stryMutAct_9fa48("2766") ? availabilityResult.status === "ok" || !availabilityResult.value.available : stryMutAct_9fa48("2765") ? false : stryMutAct_9fa48("2764") ? true : (stryCov_9fa48("2764", "2765", "2766"), (stryMutAct_9fa48("2768") ? availabilityResult.status !== "ok" : stryMutAct_9fa48("2767") ? true : (stryCov_9fa48("2767", "2768"), availabilityResult.status === (stryMutAct_9fa48("2769") ? "" : (stryCov_9fa48("2769"), "ok")))) && (stryMutAct_9fa48("2770") ? availabilityResult.value.available : (stryCov_9fa48("2770"), !availabilityResult.value.available)))) {
          if (stryMutAct_9fa48("2771")) {
            {}
          } else {
            stryCov_9fa48("2771");
            availabilityConflict = stryMutAct_9fa48("2772") ? {} : (stryCov_9fa48("2772"), {
              bookingId: bookingToCheck.id,
              unavailabilityConflict: availabilityResult.value.unavailabilityConflict,
              bookingConflict: availabilityResult.value.bookingConflict
            });
          }
        }
      }
    }
    return stryMutAct_9fa48("2773") ? {} : (stryCov_9fa48("2773"), {
      bookings: bookings.map(stryMutAct_9fa48("2774") ? () => undefined : (stryCov_9fa48("2774"), booking => stryMutAct_9fa48("2775") ? {} : (stryCov_9fa48("2775"), {
        id: booking.id,
        status: booking.status,
        venue: booking.venue ? stryMutAct_9fa48("2776") ? {} : (stryCov_9fa48("2776"), {
          id: booking.venue.id,
          name: booking.venue.name
        }) : null
      }))),
      equipmentReservations: equipmentResult.value.map(stryMutAct_9fa48("2777") ? () => undefined : (stryCov_9fa48("2777"), request => stryMutAct_9fa48("2778") ? {} : (stryCov_9fa48("2778"), {
        id: request.id,
        status: request.status,
        items: request.items
      }))),
      registrations: stryMutAct_9fa48("2779") ? {} : (stryCov_9fa48("2779"), {
        registeredCount: stryMutAct_9fa48("2780") ? registrations.length : (stryCov_9fa48("2780"), registrations.filter(stryMutAct_9fa48("2781") ? () => undefined : (stryCov_9fa48("2781"), r => stryMutAct_9fa48("2784") ? r.status !== "Registered" : stryMutAct_9fa48("2783") ? false : stryMutAct_9fa48("2782") ? true : (stryCov_9fa48("2782", "2783", "2784"), r.status === (stryMutAct_9fa48("2785") ? "" : (stryCov_9fa48("2785"), "Registered"))))).length),
        total: registrations.length,
        registrations: registrations.map(stryMutAct_9fa48("2786") ? () => undefined : (stryCov_9fa48("2786"), r => stryMutAct_9fa48("2787") ? {} : (stryCov_9fa48("2787"), {
          registrationId: r.registrationId,
          userId: r.userId,
          name: r.name,
          status: r.status
        })))
      }),
      capacityConflict,
      availabilityConflict
    });
  }
}

/**
 * E3-9: the organiser's own view of every change request they've raised on
 * this event. E3-8 AC2/AC4: the assigned coordinator gets the same list,
 * plus an `impact` assessment attached to each `Pending` request. Owner or
 * assigned coordinator only, read-only, most recent first.
 */
if (stryMutAct_9fa48("2788")) {
  ;
} else {
  stryCov_9fa48("2788");
  eventsRouter.get(stryMutAct_9fa48("2789") ? "" : (stryCov_9fa48("2789"), "/:id/change-requests"), async (req: AuthedRequest, res) => {
    if (stryMutAct_9fa48("2790")) {
      {}
    } else {
      stryCov_9fa48("2790");
      const {
        supabase,
        user
      } = req;
      if (stryMutAct_9fa48("2793") ? !supabase && !user : stryMutAct_9fa48("2792") ? false : stryMutAct_9fa48("2791") ? true : (stryCov_9fa48("2791", "2792", "2793"), (stryMutAct_9fa48("2794") ? supabase : (stryCov_9fa48("2794"), !supabase)) || (stryMutAct_9fa48("2795") ? user : (stryCov_9fa48("2795"), !user)))) {
        if (stryMutAct_9fa48("2796")) {
          {}
        } else {
          stryCov_9fa48("2796");
          res.status(401).json(stryMutAct_9fa48("2798") ? {} : (stryCov_9fa48("2798"), {
            error: stryMutAct_9fa48("2799") ? "" : (stryCov_9fa48("2799"), "Unauthenticated")
          }));
          return;
        }
      }
      const eventId = routeParam(req.params.id);
      if (stryMutAct_9fa48("2802") ? false : stryMutAct_9fa48("2801") ? true : stryMutAct_9fa48("2800") ? isPositiveInteger(eventId) : (stryCov_9fa48("2800", "2801", "2802"), !isPositiveInteger(eventId))) {
        if (stryMutAct_9fa48("2803")) {
          {}
        } else {
          stryCov_9fa48("2803");
          res.status(404).json(stryMutAct_9fa48("2805") ? {} : (stryCov_9fa48("2805"), {
            error: stryMutAct_9fa48("2806") ? "" : (stryCov_9fa48("2806"), "Event not found")
          }));
          return;
        }
      }
      const {
        data: event,
        error: eventError
      } = await supabase.from(stryMutAct_9fa48("2807") ? "" : (stryCov_9fa48("2807"), "events")).select(stryMutAct_9fa48("2808") ? "" : (stryCov_9fa48("2808"), "id, organiser_id, coordinator_id, submitted_details")).eq(stryMutAct_9fa48("2809") ? "" : (stryCov_9fa48("2809"), "id"), Number(eventId)).maybeSingle();
      if (stryMutAct_9fa48("2811") ? false : stryMutAct_9fa48("2810") ? true : (stryCov_9fa48("2810", "2811"), eventError)) {
        if (stryMutAct_9fa48("2812")) {
          {}
        } else {
          stryCov_9fa48("2812");
          res.status(500).json(stryMutAct_9fa48("2814") ? {} : (stryCov_9fa48("2814"), {
            error: stryMutAct_9fa48("2815") ? "" : (stryCov_9fa48("2815"), "Failed to load event")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("2818") ? false : stryMutAct_9fa48("2817") ? true : stryMutAct_9fa48("2816") ? event : (stryCov_9fa48("2816", "2817", "2818"), !event)) {
        if (stryMutAct_9fa48("2819")) {
          {}
        } else {
          stryCov_9fa48("2819");
          res.status(404).json(stryMutAct_9fa48("2821") ? {} : (stryCov_9fa48("2821"), {
            error: stryMutAct_9fa48("2822") ? "" : (stryCov_9fa48("2822"), "Event not found")
          }));
          return;
        }
      }
      const isOwner = stryMutAct_9fa48("2825") ? event.organiser_id !== user.id : stryMutAct_9fa48("2824") ? false : stryMutAct_9fa48("2823") ? true : (stryCov_9fa48("2823", "2824", "2825"), event.organiser_id === user.id);
      const isAssignedCoordinator = stryMutAct_9fa48("2828") ? user.role === "coordinator" || event.coordinator_id === user.id : stryMutAct_9fa48("2827") ? false : stryMutAct_9fa48("2826") ? true : (stryCov_9fa48("2826", "2827", "2828"), (stryMutAct_9fa48("2830") ? user.role !== "coordinator" : stryMutAct_9fa48("2829") ? true : (stryCov_9fa48("2829", "2830"), user.role === (stryMutAct_9fa48("2831") ? "" : (stryCov_9fa48("2831"), "coordinator")))) && (stryMutAct_9fa48("2833") ? event.coordinator_id !== user.id : stryMutAct_9fa48("2832") ? true : (stryCov_9fa48("2832", "2833"), event.coordinator_id === user.id)));
      if (stryMutAct_9fa48("2836") ? !isOwner || !isAssignedCoordinator : stryMutAct_9fa48("2835") ? false : stryMutAct_9fa48("2834") ? true : (stryCov_9fa48("2834", "2835", "2836"), (stryMutAct_9fa48("2837") ? isOwner : (stryCov_9fa48("2837"), !isOwner)) && (stryMutAct_9fa48("2838") ? isAssignedCoordinator : (stryCov_9fa48("2838"), !isAssignedCoordinator)))) {
        if (stryMutAct_9fa48("2839")) {
          {}
        } else {
          stryCov_9fa48("2839");
          await recordAccessDenial(supabase, user.id, eventId, stryMutAct_9fa48("2840") ? "" : (stryCov_9fa48("2840"), "not_found_or_not_owner"));
          res.status(403).json(stryMutAct_9fa48("2842") ? {} : (stryCov_9fa48("2842"), {
            error: stryMutAct_9fa48("2843") ? "" : (stryCov_9fa48("2843"), "Access denied")
          }));
          return;
        }
      }
      const {
        data: requests,
        error: requestsError
      } = await supabase.from(stryMutAct_9fa48("2844") ? "" : (stryCov_9fa48("2844"), "change_requests")).select(stryMutAct_9fa48("2845") ? "" : (stryCov_9fa48("2845"), "id, status, decided_at, decision_reason, created_at")).eq(stryMutAct_9fa48("2846") ? "" : (stryCov_9fa48("2846"), "event_id"), event.id).order(stryMutAct_9fa48("2847") ? "" : (stryCov_9fa48("2847"), "created_at"), stryMutAct_9fa48("2848") ? {} : (stryCov_9fa48("2848"), {
        ascending: stryMutAct_9fa48("2849") ? true : (stryCov_9fa48("2849"), false)
      }));
      if (stryMutAct_9fa48("2851") ? false : stryMutAct_9fa48("2850") ? true : (stryCov_9fa48("2850", "2851"), requestsError)) {
        if (stryMutAct_9fa48("2852")) {
          {}
        } else {
          stryCov_9fa48("2852");
          res.status(500).json(stryMutAct_9fa48("2854") ? {} : (stryCov_9fa48("2854"), {
            error: stryMutAct_9fa48("2855") ? "" : (stryCov_9fa48("2855"), "Failed to load change requests")
          }));
          return;
        }
      }
      const requestIds = (stryMutAct_9fa48("2856") ? requests && [] : (stryCov_9fa48("2856"), requests ?? (stryMutAct_9fa48("2857") ? ["Stryker was here"] : (stryCov_9fa48("2857"), [])))).map(stryMutAct_9fa48("2858") ? () => undefined : (stryCov_9fa48("2858"), request => request.id));
      const {
        data: fieldRows,
        error: fieldsError
      } = await supabase.from(stryMutAct_9fa48("2859") ? "" : (stryCov_9fa48("2859"), "change_request_fields")).select(stryMutAct_9fa48("2860") ? "" : (stryCov_9fa48("2860"), "request_id, field, old_value, new_value, is_critical, applied_at")).in(stryMutAct_9fa48("2861") ? "" : (stryCov_9fa48("2861"), "request_id"), (stryMutAct_9fa48("2865") ? requestIds.length <= 0 : stryMutAct_9fa48("2864") ? requestIds.length >= 0 : stryMutAct_9fa48("2863") ? false : stryMutAct_9fa48("2862") ? true : (stryCov_9fa48("2862", "2863", "2864", "2865"), requestIds.length > 0)) ? requestIds : stryMutAct_9fa48("2866") ? [] : (stryCov_9fa48("2866"), [stryMutAct_9fa48("2867") ? +1 : (stryCov_9fa48("2867"), -1)]));
      if (stryMutAct_9fa48("2869") ? false : stryMutAct_9fa48("2868") ? true : (stryCov_9fa48("2868", "2869"), fieldsError)) {
        if (stryMutAct_9fa48("2870")) {
          {}
        } else {
          stryCov_9fa48("2870");
          res.status(500).json(stryMutAct_9fa48("2872") ? {} : (stryCov_9fa48("2872"), {
            error: stryMutAct_9fa48("2873") ? "" : (stryCov_9fa48("2873"), "Failed to load change requests")
          }));
          return;
        }
      }
      const fieldsByRequest = new Map<number, typeof fieldRows>();
      // Stryker disable next-line ArrayDeclaration: equivalent - a placeholder row has no request_id, so nothing ever reads its entry
      for (const field of stryMutAct_9fa48("2874") ? fieldRows && [] : (stryCov_9fa48("2874"), fieldRows ?? [])) {
        if (stryMutAct_9fa48("2876")) {
          {}
        } else {
          stryCov_9fa48("2876");
          const list = stryMutAct_9fa48("2877") ? fieldsByRequest.get(field.request_id) && [] : (stryCov_9fa48("2877"), fieldsByRequest.get(field.request_id) ?? (stryMutAct_9fa48("2878") ? ["Stryker was here"] : (stryCov_9fa48("2878"), [])));
          if (stryMutAct_9fa48("2879")) {
            ;
          } else {
            stryCov_9fa48("2879");
            list.push(field);
          }
          if (stryMutAct_9fa48("2880")) {
            ;
          } else {
            stryCov_9fa48("2880");
            fieldsByRequest.set(field.request_id, list);
          }
        }
      }
      const authorization = req.headers.authorization!;
      const committedDetails = (event.submitted_details ?? {}) as Record<string, unknown>;
      const impactByRequest = new Map<number, ChangeRequestImpact | null>();
      // Stryker disable next-line ArrayDeclaration: equivalent - a placeholder has no status, so it is skipped as not Pending
      for (const request of stryMutAct_9fa48("2881") ? requests && [] : (stryCov_9fa48("2881"), requests ?? [])) {
        if (stryMutAct_9fa48("2883")) {
          {}
        } else {
          stryCov_9fa48("2883");
          if (stryMutAct_9fa48("2886") ? request.status === CHANGE_REQUEST_STATUS.Pending : stryMutAct_9fa48("2885") ? false : stryMutAct_9fa48("2884") ? true : (stryCov_9fa48("2884", "2885", "2886"), request.status !== CHANGE_REQUEST_STATUS.Pending)) continue;
          // Only the still-open fields count as "requested" for the impact
          // check — one already applied in an earlier partial decision is
          // already reflected in committedDetails itself.
          // Stryker disable next-line ArrayDeclaration: equivalent - a placeholder has no field name, so it asks for no check
          const fields = stryMutAct_9fa48("2887") ? fieldsByRequest.get(request.id) ?? [] : (stryCov_9fa48("2887"), (stryMutAct_9fa48("2888") ? fieldsByRequest.get(request.id) && [] : (stryCov_9fa48("2888"), fieldsByRequest.get(request.id) ?? [])).filter(stryMutAct_9fa48("2890") ? () => undefined : (stryCov_9fa48("2890"), f => stryMutAct_9fa48("2891") ? f.applied_at : (stryCov_9fa48("2891"), !f.applied_at))));
          const {
            requestedAttendance,
            proposedSchedule
          } = deriveImpactInputs(fields, committedDetails);
          if (stryMutAct_9fa48("2892")) {
            ;
          } else {
            stryCov_9fa48("2892");
            impactByRequest.set(request.id, await loadChangeRequestImpact(event.id, requestedAttendance, proposedSchedule, authorization));
          }
        }
      }
      res.json(stryMutAct_9fa48("2894") ? {} : (stryCov_9fa48("2894"), {
        changeRequests: (stryMutAct_9fa48("2895") ? requests && [] : (stryCov_9fa48("2895"), requests ?? (stryMutAct_9fa48("2896") ? ["Stryker was here"] : (stryCov_9fa48("2896"), [])))).map(stryMutAct_9fa48("2897") ? () => undefined : (stryCov_9fa48("2897"), request => stryMutAct_9fa48("2898") ? {} : (stryCov_9fa48("2898"), {
          id: request.id,
          status: request.status,
          decidedAt: request.decided_at,
          decisionReason: request.decision_reason,
          createdAt: request.created_at,
          fields: (stryMutAct_9fa48("2899") ? fieldsByRequest.get(request.id) && [] : (stryCov_9fa48("2899"), fieldsByRequest.get(request.id) ?? (stryMutAct_9fa48("2900") ? ["Stryker was here"] : (stryCov_9fa48("2900"), [])))).map(stryMutAct_9fa48("2901") ? () => undefined : (stryCov_9fa48("2901"), field => stryMutAct_9fa48("2902") ? {} : (stryCov_9fa48("2902"), {
            field: field.field,
            oldValue: field.old_value,
            newValue: field.new_value,
            isCritical: field.is_critical,
            outcome: fieldOutcome(request.status, field.is_critical, stryMutAct_9fa48("2903") ? !field.applied_at : (stryCov_9fa48("2903"), !(stryMutAct_9fa48("2904") ? field.applied_at : (stryCov_9fa48("2904"), !field.applied_at))))
          }))),
          impact: impactByRequest.has(request.id) ? impactByRequest.get(request.id) : null
        })))
      }));
    }
  });
}
/**
 * E3-11: what happened to one field — a critical field can be applied
 * (stamped `applied_at`, migration 0041) while its request is still
 * Pending, from an earlier partial approval that left other fields open.
 */
function fieldOutcome(requestStatus: string, isCritical: boolean, alreadyApplied: boolean): "pending" | "applied" | "rejected" | "withdrawn" {
  if (stryMutAct_9fa48("2905")) {
    {}
  } else {
    stryCov_9fa48("2905");
    if (stryMutAct_9fa48("2908") ? !isCritical && alreadyApplied : stryMutAct_9fa48("2907") ? false : stryMutAct_9fa48("2906") ? true : (stryCov_9fa48("2906", "2907", "2908"), (stryMutAct_9fa48("2909") ? isCritical : (stryCov_9fa48("2909"), !isCritical)) || alreadyApplied)) return stryMutAct_9fa48("2910") ? "" : (stryCov_9fa48("2910"), "applied");
    if (stryMutAct_9fa48("2913") ? requestStatus !== CHANGE_REQUEST_STATUS.AutoWithdrawn : stryMutAct_9fa48("2912") ? false : stryMutAct_9fa48("2911") ? true : (stryCov_9fa48("2911", "2912", "2913"), requestStatus === CHANGE_REQUEST_STATUS.AutoWithdrawn)) return stryMutAct_9fa48("2914") ? "" : (stryCov_9fa48("2914"), "withdrawn");
    if (stryMutAct_9fa48("2917") ? requestStatus !== CHANGE_REQUEST_STATUS.Rejected : stryMutAct_9fa48("2916") ? false : stryMutAct_9fa48("2915") ? true : (stryCov_9fa48("2915", "2916", "2917"), requestStatus === CHANGE_REQUEST_STATUS.Rejected)) return stryMutAct_9fa48("2918") ? "" : (stryCov_9fa48("2918"), "rejected");
    // Pending, or Approved without the field ever being stamped applied: it
    // has not been confirmed as applied, so don't say it was.
    return stryMutAct_9fa48("2919") ? "" : (stryCov_9fa48("2919"), "pending");
  }
}

/**
 * Loads a Pending change request that belongs to this event, with its
 * fields — shared by approve and reject below. Returns null (after
 * writing the response itself) for every failure case, so callers can
 * just `if (!loaded) return;`.
 */
async function loadPendingChangeRequest(supabase: NonNullable<AuthedRequest["supabase"]>, res: Response, eventId: number, requestId: string): Promise<{
  id: number;
  fields: {
    field: string;
    old_value: string | null;
    new_value: string;
    is_critical: boolean;
  }[];
} | null> {
  if (stryMutAct_9fa48("2920")) {
    {}
  } else {
    stryCov_9fa48("2920");
    if (stryMutAct_9fa48("2923") ? false : stryMutAct_9fa48("2922") ? true : stryMutAct_9fa48("2921") ? isPositiveInteger(requestId) : (stryCov_9fa48("2921", "2922", "2923"), !isPositiveInteger(requestId))) {
      if (stryMutAct_9fa48("2924")) {
        {}
      } else {
        stryCov_9fa48("2924");
        res.status(404).json(stryMutAct_9fa48("2926") ? {} : (stryCov_9fa48("2926"), {
          error: stryMutAct_9fa48("2927") ? "" : (stryCov_9fa48("2927"), "Change request not found")
        }));
        return null;
      }
    }
    const {
      data: changeRequest,
      error: requestError
    } = await supabase.from(stryMutAct_9fa48("2928") ? "" : (stryCov_9fa48("2928"), "change_requests")).select(stryMutAct_9fa48("2929") ? "" : (stryCov_9fa48("2929"), "id, status")).eq(stryMutAct_9fa48("2930") ? "" : (stryCov_9fa48("2930"), "id"), Number(requestId)).eq(stryMutAct_9fa48("2931") ? "" : (stryCov_9fa48("2931"), "event_id"), eventId).maybeSingle();
    if (stryMutAct_9fa48("2933") ? false : stryMutAct_9fa48("2932") ? true : (stryCov_9fa48("2932", "2933"), requestError)) {
      if (stryMutAct_9fa48("2934")) {
        {}
      } else {
        stryCov_9fa48("2934");
        res.status(500).json(stryMutAct_9fa48("2936") ? {} : (stryCov_9fa48("2936"), {
          error: stryMutAct_9fa48("2937") ? "" : (stryCov_9fa48("2937"), "Failed to load the change request")
        }));
        return null;
      }
    }
    if (stryMutAct_9fa48("2940") ? false : stryMutAct_9fa48("2939") ? true : stryMutAct_9fa48("2938") ? changeRequest : (stryCov_9fa48("2938", "2939", "2940"), !changeRequest)) {
      if (stryMutAct_9fa48("2941")) {
        {}
      } else {
        stryCov_9fa48("2941");
        res.status(404).json(stryMutAct_9fa48("2943") ? {} : (stryCov_9fa48("2943"), {
          error: stryMutAct_9fa48("2944") ? "" : (stryCov_9fa48("2944"), "Change request not found")
        }));
        return null;
      }
    }
    if (stryMutAct_9fa48("2947") ? changeRequest.status === CHANGE_REQUEST_STATUS.Pending : stryMutAct_9fa48("2946") ? false : stryMutAct_9fa48("2945") ? true : (stryCov_9fa48("2945", "2946", "2947"), changeRequest.status !== CHANGE_REQUEST_STATUS.Pending)) {
      if (stryMutAct_9fa48("2948")) {
        {}
      } else {
        stryCov_9fa48("2948");
        res.status(409).json(stryMutAct_9fa48("2950") ? {} : (stryCov_9fa48("2950"), {
          error: stryMutAct_9fa48("2951") ? "" : (stryCov_9fa48("2951"), "This change request has already been decided.")
        }));
        return null;
      }
    }

    // Only the fields still open — one already approved in an earlier
    // partial decision (applied_at set, see migration 0041) is resolved and
    // out of scope for a further approve or reject call on this request.
    const {
      data: fieldRows,
      error: fieldsError
    } = await supabase.from(stryMutAct_9fa48("2952") ? "" : (stryCov_9fa48("2952"), "change_request_fields")).select(stryMutAct_9fa48("2953") ? "" : (stryCov_9fa48("2953"), "field, old_value, new_value, is_critical")).eq(stryMutAct_9fa48("2954") ? "" : (stryCov_9fa48("2954"), "request_id"), changeRequest.id).is(stryMutAct_9fa48("2955") ? "" : (stryCov_9fa48("2955"), "applied_at"), null);
    if (stryMutAct_9fa48("2957") ? false : stryMutAct_9fa48("2956") ? true : (stryCov_9fa48("2956", "2957"), fieldsError)) {
      if (stryMutAct_9fa48("2958")) {
        {}
      } else {
        stryCov_9fa48("2958");
        res.status(500).json(stryMutAct_9fa48("2960") ? {} : (stryCov_9fa48("2960"), {
          error: stryMutAct_9fa48("2961") ? "" : (stryCov_9fa48("2961"), "Failed to load the change request")
        }));
        return null;
      }
    }

    // Stryker disable next-line ArrayDeclaration: equivalent - a placeholder row is not critical, so approve sees nothing held either way
    return stryMutAct_9fa48("2962") ? {} : (stryCov_9fa48("2962"), {
      id: changeRequest.id,
      fields: stryMutAct_9fa48("2963") ? fieldRows && [] : (stryCov_9fa48("2963"), fieldRows ?? [])
    });
  }
}

/**
 * Loads the event and checks the caller is its assigned coordinator — the
 * same gate both approve and reject below share. Returns null (after
 * writing the response) on any failure.
 */
async function loadEventForDecision(req: AuthedRequest, res: Response, eventId: string): Promise<{
  id: number;
  status: string;
  safety_approval_stale?: boolean;
  coordinator_id: string | null;
  submitted_details: Record<string, unknown>;
} | null> {
  if (stryMutAct_9fa48("2965")) {
    {}
  } else {
    stryCov_9fa48("2965");
    const {
      supabase,
      user
    } = req;
    if (stryMutAct_9fa48("2968") ? !supabase && !user : stryMutAct_9fa48("2967") ? false : stryMutAct_9fa48("2966") ? true : (stryCov_9fa48("2966", "2967", "2968"), (stryMutAct_9fa48("2969") ? supabase : (stryCov_9fa48("2969"), !supabase)) || (stryMutAct_9fa48("2970") ? user : (stryCov_9fa48("2970"), !user)))) {
      if (stryMutAct_9fa48("2971")) {
        {}
      } else {
        stryCov_9fa48("2971");
        res.status(401).json(stryMutAct_9fa48("2973") ? {} : (stryCov_9fa48("2973"), {
          error: stryMutAct_9fa48("2974") ? "" : (stryCov_9fa48("2974"), "Unauthenticated")
        }));
        return null;
      }
    }
    if (stryMutAct_9fa48("2977") ? false : stryMutAct_9fa48("2976") ? true : stryMutAct_9fa48("2975") ? isPositiveInteger(eventId) : (stryCov_9fa48("2975", "2976", "2977"), !isPositiveInteger(eventId))) {
      if (stryMutAct_9fa48("2978")) {
        {}
      } else {
        stryCov_9fa48("2978");
        res.status(404).json(stryMutAct_9fa48("2980") ? {} : (stryCov_9fa48("2980"), {
          error: stryMutAct_9fa48("2981") ? "" : (stryCov_9fa48("2981"), "Event not found")
        }));
        return null;
      }
    }
    const {
      data: event,
      error: eventError
    } = await supabase.from(stryMutAct_9fa48("2982") ? "" : (stryCov_9fa48("2982"), "events")).select(stryMutAct_9fa48("2983") ? "" : (stryCov_9fa48("2983"), "id, status, safety_approval_stale, coordinator_id, submitted_details")).eq(stryMutAct_9fa48("2984") ? "" : (stryCov_9fa48("2984"), "id"), Number(eventId)).maybeSingle();
    if (stryMutAct_9fa48("2986") ? false : stryMutAct_9fa48("2985") ? true : (stryCov_9fa48("2985", "2986"), eventError)) {
      if (stryMutAct_9fa48("2987")) {
        {}
      } else {
        stryCov_9fa48("2987");
        res.status(500).json(stryMutAct_9fa48("2989") ? {} : (stryCov_9fa48("2989"), {
          error: stryMutAct_9fa48("2990") ? "" : (stryCov_9fa48("2990"), "Failed to load event")
        }));
        return null;
      }
    }
    if (stryMutAct_9fa48("2993") ? false : stryMutAct_9fa48("2992") ? true : stryMutAct_9fa48("2991") ? event : (stryCov_9fa48("2991", "2992", "2993"), !event)) {
      if (stryMutAct_9fa48("2994")) {
        {}
      } else {
        stryCov_9fa48("2994");
        res.status(404).json(stryMutAct_9fa48("2996") ? {} : (stryCov_9fa48("2996"), {
          error: stryMutAct_9fa48("2997") ? "" : (stryCov_9fa48("2997"), "Event not found")
        }));
        return null;
      }
    }
    if (stryMutAct_9fa48("3000") ? user.role !== "coordinator" && event.coordinator_id !== user.id : stryMutAct_9fa48("2999") ? false : stryMutAct_9fa48("2998") ? true : (stryCov_9fa48("2998", "2999", "3000"), (stryMutAct_9fa48("3002") ? user.role === "coordinator" : stryMutAct_9fa48("3001") ? false : (stryCov_9fa48("3001", "3002"), user.role !== (stryMutAct_9fa48("3003") ? "" : (stryCov_9fa48("3003"), "coordinator")))) || (stryMutAct_9fa48("3005") ? event.coordinator_id === user.id : stryMutAct_9fa48("3004") ? false : (stryCov_9fa48("3004", "3005"), event.coordinator_id !== user.id)))) {
      if (stryMutAct_9fa48("3006")) {
        {}
      } else {
        stryCov_9fa48("3006");
        res.status(403).json(stryMutAct_9fa48("3008") ? {} : (stryCov_9fa48("3008"), {
          error: stryMutAct_9fa48("3009") ? "" : (stryCov_9fa48("3009"), "Only the event's assigned coordinator can decide this change request")
        }));
        return null;
      }
    }
    return event as {
      id: number;
      status: string;
      safety_approval_stale?: boolean;
      coordinator_id: string | null;
      submitted_details: Record<string, unknown>;
    };
  }
}

/**
 * E3-11 AC1/AC2/AC3/AC5: the coordinator approves a held change request.
 * Every held field's value is applied, written to event history (AC1),
 * and the event returns to Planning — AGENTS.md §3's re-review rule,
 * broadened (with the team's sign-off) from "only venue/equipment-
 * affecting approvals" to any held critical field, since a safety
 * approval no longer applies once anything held on it changes.
 *
 * AC2/AC3: only a field that actually invalidates something gets flagged
 * — reusing E3-10's own capacity/availability check (deriveImpactInputs +
 * loadChangeRequestImpact) rather than flagging every venue/schedule/
 * attendance approval regardless of whether it's a real problem. Flagging
 * itself is delegated to venue-service/equipment-service (AGENTS.md §1:
 * each service writes only its own tables); this route just calls them.
 * Neither call blocks the approval itself from succeeding (AC5: no
 * separate re-approval needed for the decision to stand) — a flagging
 * failure is reported back, not retried or rolled back into.
 */
if (stryMutAct_9fa48("3010")) {
  ;
} else {
  stryCov_9fa48("3010");
  eventsRouter.post(stryMutAct_9fa48("3011") ? "" : (stryCov_9fa48("3011"), "/:id/change-requests/:requestId/approve"), async (req: AuthedRequest, res) => {
    if (stryMutAct_9fa48("3012")) {
      {}
    } else {
      stryCov_9fa48("3012");
      const eventId = routeParam(req.params.id);
      const event = await loadEventForDecision(req, res, eventId);
      if (stryMutAct_9fa48("3015") ? false : stryMutAct_9fa48("3014") ? true : stryMutAct_9fa48("3013") ? event : (stryCov_9fa48("3013", "3014", "3015"), !event)) return;

      // Approving writes the event's status back (statusAfterApproval), so it must never
      // run on an event that is closed or hasn't entered the process: that would reopen it.
      if (stryMutAct_9fa48("3017") ? false : stryMutAct_9fa48("3016") ? true : (stryCov_9fa48("3016", "3017"), CHANGE_REQUEST_BLOCKED_STATUSES.has(event.status))) {
        if (stryMutAct_9fa48("3018")) {
          {}
        } else {
          stryCov_9fa48("3018");
          res.status(409).json(stryMutAct_9fa48("3020") ? {} : (stryCov_9fa48("3020"), {
            error: stryMutAct_9fa48("3021") ? `` : (stryCov_9fa48("3021"), `A change request can't be approved while the event is ${event.status}.`)
          }));
          return;
        }
      }
      const {
        supabase,
        user
      } = req as Required<Pick<AuthedRequest, "supabase" | "user">>;
      const requestId = routeParam(req.params.requestId);
      const changeRequest = await loadPendingChangeRequest(supabase, res, event.id, requestId);
      if (stryMutAct_9fa48("3024") ? false : stryMutAct_9fa48("3023") ? true : stryMutAct_9fa48("3022") ? changeRequest : (stryCov_9fa48("3022", "3023", "3024"), !changeRequest)) return;
      const allCriticalFields = stryMutAct_9fa48("3025") ? changeRequest.fields : (stryCov_9fa48("3025"), changeRequest.fields.filter(stryMutAct_9fa48("3026") ? () => undefined : (stryCov_9fa48("3026"), f => f.is_critical)));
      const heldFieldNames = allCriticalFields.map(stryMutAct_9fa48("3027") ? () => undefined : (stryCov_9fa48("3027"), f => f.field));

      // E3-11: by default every held field is approved (unchanged behavior).
      // Passing `fields` approves just that subset — the rest are simply left
      // held, not rejected: the coordinator didn't decide on them yet, so the
      // request stays Pending with just those remaining fields, open for a
      // later decision (another partial approve, or an eventual reject of
      // what's left).
      const requestedApproveFields = Array.isArray(stryMutAct_9fa48("3028") ? req.body.fields : (stryCov_9fa48("3028"), req.body?.fields)) ? stryMutAct_9fa48("3029") ? req.body.fields as unknown[] : (stryCov_9fa48("3029"), (req.body.fields as unknown[]).filter(stryMutAct_9fa48("3030") ? () => undefined : (stryCov_9fa48("3030"), (f): f is string => stryMutAct_9fa48("3033") ? typeof f !== "string" : stryMutAct_9fa48("3032") ? false : stryMutAct_9fa48("3031") ? true : (stryCov_9fa48("3031", "3032", "3033"), typeof f === (stryMutAct_9fa48("3034") ? "" : (stryCov_9fa48("3034"), "string")))))) : null;
      let fieldsToApproveNames: string[];
      if (stryMutAct_9fa48("3037") ? requestedApproveFields !== null : stryMutAct_9fa48("3036") ? false : stryMutAct_9fa48("3035") ? true : (stryCov_9fa48("3035", "3036", "3037"), requestedApproveFields === null)) {
        if (stryMutAct_9fa48("3038")) {
          {}
        } else {
          stryCov_9fa48("3038");
          fieldsToApproveNames = heldFieldNames;
        }
      } else {
        if (stryMutAct_9fa48("3039")) {
          {}
        } else {
          stryCov_9fa48("3039");
          const unique = stryMutAct_9fa48("3040") ? [] : (stryCov_9fa48("3040"), [...new Set(requestedApproveFields)]);
          const unknown = stryMutAct_9fa48("3041") ? unique : (stryCov_9fa48("3041"), unique.filter(stryMutAct_9fa48("3042") ? () => undefined : (stryCov_9fa48("3042"), f => stryMutAct_9fa48("3043") ? heldFieldNames.includes(f) : (stryCov_9fa48("3043"), !heldFieldNames.includes(f)))));
          if (stryMutAct_9fa48("3047") ? unknown.length <= 0 : stryMutAct_9fa48("3046") ? unknown.length >= 0 : stryMutAct_9fa48("3045") ? false : stryMutAct_9fa48("3044") ? true : (stryCov_9fa48("3044", "3045", "3046", "3047"), unknown.length > 0)) {
            if (stryMutAct_9fa48("3048")) {
              {}
            } else {
              stryCov_9fa48("3048");
              res.status(400).json(stryMutAct_9fa48("3050") ? {} : (stryCov_9fa48("3050"), {
                error: stryMutAct_9fa48("3051") ? `` : (stryCov_9fa48("3051"), `These fields aren't held on this request: ${unknown.join(stryMutAct_9fa48("3052") ? "" : (stryCov_9fa48("3052"), ", "))}`)
              }));
              return;
            }
          }
          fieldsToApproveNames = unique;
        }
      }
      if (stryMutAct_9fa48("3055") ? fieldsToApproveNames.length !== 0 : stryMutAct_9fa48("3054") ? false : stryMutAct_9fa48("3053") ? true : (stryCov_9fa48("3053", "3054", "3055"), fieldsToApproveNames.length === 0)) {
        if (stryMutAct_9fa48("3056")) {
          {}
        } else {
          stryCov_9fa48("3056");
          res.status(400).json(stryMutAct_9fa48("3058") ? {} : (stryCov_9fa48("3058"), {
            error: stryMutAct_9fa48("3059") ? "" : (stryCov_9fa48("3059"), "Approve at least one field, or use reject to decline the whole request.")
          }));
          return;
        }
      }
      const remainingFieldNames = stryMutAct_9fa48("3060") ? heldFieldNames : (stryCov_9fa48("3060"), heldFieldNames.filter(stryMutAct_9fa48("3061") ? () => undefined : (stryCov_9fa48("3061"), f => stryMutAct_9fa48("3062") ? fieldsToApproveNames.includes(f) : (stryCov_9fa48("3062"), !fieldsToApproveNames.includes(f)))));
      const criticalFields = stryMutAct_9fa48("3063") ? allCriticalFields : (stryCov_9fa48("3063"), allCriticalFields.filter(stryMutAct_9fa48("3064") ? () => undefined : (stryCov_9fa48("3064"), f => fieldsToApproveNames.includes(f.field))));
      const current = event.submitted_details;
      const updatedDetails: Record<string, unknown> = stryMutAct_9fa48("3065") ? {} : (stryCov_9fa48("3065"), {
        ...current
      });
      for (const field of criticalFields) {
        if (stryMutAct_9fa48("3066")) {
          {}
        } else {
          stryCov_9fa48("3066");
          updatedDetails[field.field] = (stryMutAct_9fa48("3069") ? field.field !== "expectedAttendance" : stryMutAct_9fa48("3068") ? false : stryMutAct_9fa48("3067") ? true : (stryCov_9fa48("3067", "3068", "3069"), field.field === (stryMutAct_9fa48("3070") ? "" : (stryCov_9fa48("3070"), "expectedAttendance")))) ? Number(field.new_value) : field.new_value;
        }
      }
      const {
        data: updatedEvent,
        error: updateError
      } = await supabase.from(stryMutAct_9fa48("3071") ? "" : (stryCov_9fa48("3071"), "events")).update(stryMutAct_9fa48("3072") ? {} : (stryCov_9fa48("3072"), {
        submitted_details: updatedDetails,
        status: statusAfterApproval(event.status),
        safety_approval_stale: stryMutAct_9fa48("3073") ? false : (stryCov_9fa48("3073"), true)
      })).eq(stryMutAct_9fa48("3074") ? "" : (stryCov_9fa48("3074"), "id"), event.id).select(stryMutAct_9fa48("3075") ? `` : (stryCov_9fa48("3075"), `${EVENT_COLUMNS}, organiser_id`)).single();
      if (stryMutAct_9fa48("3077") ? false : stryMutAct_9fa48("3076") ? true : (stryCov_9fa48("3076", "3077"), updateError)) {
        if (stryMutAct_9fa48("3078")) {
          {}
        } else {
          stryCov_9fa48("3078");
          res.status(500).json(stryMutAct_9fa48("3080") ? {} : (stryCov_9fa48("3080"), {
            error: stryMutAct_9fa48("3081") ? "" : (stryCov_9fa48("3081"), "Failed to apply the change request")
          }));
          return;
        }
      }

      // Undo the event write if a later step fails, so a field is never left
      // changed on the event but not recorded as applied (or the reverse).
      const rollback = async (): Promise<void> => {
        if (stryMutAct_9fa48("3082")) {
          {}
        } else {
          stryCov_9fa48("3082");
          await supabase.from(stryMutAct_9fa48("3083") ? "" : (stryCov_9fa48("3083"), "events")).update(stryMutAct_9fa48("3084") ? {} : (stryCov_9fa48("3084"), {
            submitted_details: current,
            status: event.status,
            safety_approval_stale: stryMutAct_9fa48("3085") ? event.safety_approval_stale && false : (stryCov_9fa48("3085"), event.safety_approval_stale ?? (stryMutAct_9fa48("3086") ? true : (stryCov_9fa48("3086"), false)))
          })).eq(stryMutAct_9fa48("3087") ? "" : (stryCov_9fa48("3087"), "id"), event.id);
          await supabase.from(stryMutAct_9fa48("3088") ? "" : (stryCov_9fa48("3088"), "change_request_fields")).update(stryMutAct_9fa48("3089") ? {} : (stryCov_9fa48("3089"), {
            applied_at: null
          })).eq(stryMutAct_9fa48("3090") ? "" : (stryCov_9fa48("3090"), "request_id"), changeRequest.id).in(stryMutAct_9fa48("3091") ? "" : (stryCov_9fa48("3091"), "field"), criticalFields.map(stryMutAct_9fa48("3092") ? () => undefined : (stryCov_9fa48("3092"), f => f.field)));
        }
      };

      // A field only counts as applied once the stored event actually holds the
      // approved value: read it back from the row the update returned.
      const stored = ((updatedEvent as {
        submitted_details?: Record<string, unknown>;
      } | null)?.submitted_details ?? {}) as Record<string, unknown>;
      const notStored = stryMutAct_9fa48("3093") ? criticalFields : (stryCov_9fa48("3093"), criticalFields.filter(stryMutAct_9fa48("3094") ? () => undefined : (stryCov_9fa48("3094"), f => stryMutAct_9fa48("3097") ? String(stored[f.field] ?? "") === String(updatedDetails[f.field] ?? "") : stryMutAct_9fa48("3096") ? false : stryMutAct_9fa48("3095") ? true : (stryCov_9fa48("3095", "3096", "3097"), String(stryMutAct_9fa48("3098") ? stored[f.field] && "" : (stryCov_9fa48("3098"), stored[f.field] ?? (stryMutAct_9fa48("3099") ? "Stryker was here!" : (stryCov_9fa48("3099"), "")))) !== String(stryMutAct_9fa48("3100") ? updatedDetails[f.field] && "" : (stryCov_9fa48("3100"), updatedDetails[f.field] ?? (stryMutAct_9fa48("3101") ? "Stryker was here!" : (stryCov_9fa48("3101"), ""))))))));
      if (stryMutAct_9fa48("3105") ? notStored.length <= 0 : stryMutAct_9fa48("3104") ? notStored.length >= 0 : stryMutAct_9fa48("3103") ? false : stryMutAct_9fa48("3102") ? true : (stryCov_9fa48("3102", "3103", "3104", "3105"), notStored.length > 0)) {
        if (stryMutAct_9fa48("3106")) {
          {}
        } else {
          stryCov_9fa48("3106");
          await rollback();
          res.status(500).json(stryMutAct_9fa48("3108") ? {} : (stryCov_9fa48("3108"), {
            error: stryMutAct_9fa48("3109") ? `` : (stryCov_9fa48("3109"), `Couldn't apply the change to ${notStored.map(stryMutAct_9fa48("3110") ? () => undefined : (stryCov_9fa48("3110"), f => f.field)).join(stryMutAct_9fa48("3111") ? "" : (stryCov_9fa48("3111"), ", "))}. Nothing was changed; please try again.`)
          }));
          return;
        }
      }

      // The approved fields are resolved — stamp them applied (migration 0041)
      // so they stop showing as held but the row (and its old/new value) stays
      // for the request's own history, instead of being deleted. Whatever's
      // left unstamped stays open, so the status update below only ever
      // closes the request out when nothing remains.
      // criticalFields is never empty here: an empty selection was refused above.
      const {
        error: applyError
      } = await supabase.from(stryMutAct_9fa48("3112") ? "" : (stryCov_9fa48("3112"), "change_request_fields")).update(stryMutAct_9fa48("3113") ? {} : (stryCov_9fa48("3113"), {
        applied_at: clock.now().toISOString()
      })).eq(stryMutAct_9fa48("3114") ? "" : (stryCov_9fa48("3114"), "request_id"), changeRequest.id).in(stryMutAct_9fa48("3115") ? "" : (stryCov_9fa48("3115"), "field"), criticalFields.map(stryMutAct_9fa48("3116") ? () => undefined : (stryCov_9fa48("3116"), f => f.field)));
      if (stryMutAct_9fa48("3118") ? false : stryMutAct_9fa48("3117") ? true : (stryCov_9fa48("3117", "3118"), applyError)) {
        if (stryMutAct_9fa48("3119")) {
          {}
        } else {
          stryCov_9fa48("3119");
          await rollback();
          res.status(500).json(stryMutAct_9fa48("3121") ? {} : (stryCov_9fa48("3121"), {
            error: stryMutAct_9fa48("3122") ? "" : (stryCov_9fa48("3122"), "Failed to record the decision")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("3125") ? remainingFieldNames.length !== 0 : stryMutAct_9fa48("3124") ? false : stryMutAct_9fa48("3123") ? true : (stryCov_9fa48("3123", "3124", "3125"), remainingFieldNames.length === 0)) {
        if (stryMutAct_9fa48("3126")) {
          {}
        } else {
          stryCov_9fa48("3126");
          const {
            error: decideError
          } = await supabase.from(stryMutAct_9fa48("3127") ? "" : (stryCov_9fa48("3127"), "change_requests")).update(stryMutAct_9fa48("3128") ? {} : (stryCov_9fa48("3128"), {
            status: CHANGE_REQUEST_STATUS.Approved,
            decided_by: user.id,
            decided_at: clock.now().toISOString()
          })).eq(stryMutAct_9fa48("3129") ? "" : (stryCov_9fa48("3129"), "id"), changeRequest.id);
          if (stryMutAct_9fa48("3131") ? false : stryMutAct_9fa48("3130") ? true : (stryCov_9fa48("3130", "3131"), decideError)) {
            if (stryMutAct_9fa48("3132")) {
              {}
            } else {
              stryCov_9fa48("3132");
              await rollback();
              res.status(500).json(stryMutAct_9fa48("3134") ? {} : (stryCov_9fa48("3134"), {
                error: stryMutAct_9fa48("3135") ? "" : (stryCov_9fa48("3135"), "Failed to record the decision")
              }));
              return;
            }
          }
        }
      }
      await recordEventHistory(supabase, event.id, criticalFields.map(stryMutAct_9fa48("3136") ? () => undefined : (stryCov_9fa48("3136"), field => stryMutAct_9fa48("3137") ? {} : (stryCov_9fa48("3137"), {
        field: field.field,
        oldValue: field.old_value,
        newValue: field.new_value
      }))), user.id);
      const authorization = req.headers.authorization!;
      const {
        requestedAttendance,
        proposedSchedule
      } = deriveImpactInputs(criticalFields, current);
      const impact = await loadChangeRequestImpact(event.id, requestedAttendance, proposedSchedule, authorization);
      const bookingIdsToFlag = new Set<number>();
      if (stryMutAct_9fa48("3140") ? impact.capacityConflict : stryMutAct_9fa48("3139") ? false : stryMutAct_9fa48("3138") ? true : (stryCov_9fa48("3138", "3139", "3140"), impact?.capacityConflict)) if (stryMutAct_9fa48("3141")) {
        ;
      } else {
        stryCov_9fa48("3141");
        bookingIdsToFlag.add(impact.capacityConflict.bookingId);
      }
      if (stryMutAct_9fa48("3144") ? impact.availabilityConflict : stryMutAct_9fa48("3143") ? false : stryMutAct_9fa48("3142") ? true : (stryCov_9fa48("3142", "3143", "3144"), impact?.availabilityConflict)) if (stryMutAct_9fa48("3145")) {
        ;
      } else {
        stryCov_9fa48("3145");
        bookingIdsToFlag.add(impact.availabilityConflict.bookingId);
      }
      const bookingsFlagged: {
        bookingId: number;
        staffNotified: boolean;
      }[] = stryMutAct_9fa48("3146") ? ["Stryker was here"] : (stryCov_9fa48("3146"), []);
      const fieldNames = criticalFields.map(stryMutAct_9fa48("3147") ? () => undefined : (stryCov_9fa48("3147"), f => f.field)).join(stryMutAct_9fa48("3148") ? "" : (stryCov_9fa48("3148"), ", "));
      for (const bookingId of bookingIdsToFlag) {
        if (stryMutAct_9fa48("3149")) {
          {}
        } else {
          stryCov_9fa48("3149");
          const result = await flagBookingForRebooking(bookingId, stryMutAct_9fa48("3150") ? `` : (stryCov_9fa48("3150"), `An approved change to ${fieldNames} invalidated this booking.`), authorization);
          if (stryMutAct_9fa48("3153") ? result.status !== "ok" : stryMutAct_9fa48("3152") ? false : stryMutAct_9fa48("3151") ? true : (stryCov_9fa48("3151", "3152", "3153"), result.status === (stryMutAct_9fa48("3154") ? "" : (stryCov_9fa48("3154"), "ok")))) bookingsFlagged.push(stryMutAct_9fa48("3156") ? {} : (stryCov_9fa48("3156"), {
            bookingId,
            staffNotified: result.value.staffNotified
          }));
        }
      }
      let equipmentFlagged = stryMutAct_9fa48("3157") ? true : (stryCov_9fa48("3157"), false);
      if (stryMutAct_9fa48("3160") ? criticalFields.every(f => f.field === "equipment") : stryMutAct_9fa48("3159") ? false : stryMutAct_9fa48("3158") ? true : (stryCov_9fa48("3158", "3159", "3160"), criticalFields.some(stryMutAct_9fa48("3161") ? () => undefined : (stryCov_9fa48("3161"), f => stryMutAct_9fa48("3164") ? f.field !== "equipment" : stryMutAct_9fa48("3163") ? false : stryMutAct_9fa48("3162") ? true : (stryCov_9fa48("3162", "3163", "3164"), f.field === (stryMutAct_9fa48("3165") ? "" : (stryCov_9fa48("3165"), "equipment"))))))) {
        if (stryMutAct_9fa48("3166")) {
          {}
        } else {
          stryCov_9fa48("3166");
          const result = await flagEquipmentForReassessment(event.id, stryMutAct_9fa48("3167") ? `` : (stryCov_9fa48("3167"), `An approved change to equipment requirements may affect the existing reservation.`), authorization);
          equipmentFlagged = stryMutAct_9fa48("3170") ? result.status === "ok" || result.value.flaggedRequestIds.length > 0 : stryMutAct_9fa48("3169") ? false : stryMutAct_9fa48("3168") ? true : (stryCov_9fa48("3168", "3169", "3170"), (stryMutAct_9fa48("3172") ? result.status !== "ok" : stryMutAct_9fa48("3171") ? true : (stryCov_9fa48("3171", "3172"), result.status === (stryMutAct_9fa48("3173") ? "" : (stryCov_9fa48("3173"), "ok")))) && (stryMutAct_9fa48("3176") ? result.value.flaggedRequestIds.length <= 0 : stryMutAct_9fa48("3175") ? result.value.flaggedRequestIds.length >= 0 : stryMutAct_9fa48("3174") ? true : (stryCov_9fa48("3174", "3175", "3176"), result.value.flaggedRequestIds.length > 0)));
        }
      }
      const eventName = eventDisplayName(updatedEvent as unknown as AssignmentEventRow);
      const approvedEvent = stryMutAct_9fa48("3177") ? {} : (stryCov_9fa48("3177"), {
        id: event.id,
        actorId: user.id,
        eventName,
        coordinatorId: event.coordinator_id,
        details: stored
      });
      if (stryMutAct_9fa48("3180") ? criticalFields.every(f => (SCHEDULE_FIELDS as readonly string[]).includes(f.field)) : stryMutAct_9fa48("3179") ? false : stryMutAct_9fa48("3178") ? true : (stryCov_9fa48("3178", "3179", "3180"), criticalFields.some(stryMutAct_9fa48("3181") ? () => undefined : (stryCov_9fa48("3181"), f => (SCHEDULE_FIELDS as readonly string[]).includes(f.field))))) {
        if (stryMutAct_9fa48("3182")) {
          {}
        } else {
          stryCov_9fa48("3182");
          await announceReschedule(supabase, approvedEvent);
        }
      }
      if (stryMutAct_9fa48("3185") ? criticalFields.every(f => f.field === "expectedAttendance") : stryMutAct_9fa48("3184") ? false : stryMutAct_9fa48("3183") ? true : (stryCov_9fa48("3183", "3184", "3185"), criticalFields.some(stryMutAct_9fa48("3186") ? () => undefined : (stryCov_9fa48("3186"), f => stryMutAct_9fa48("3189") ? f.field !== "expectedAttendance" : stryMutAct_9fa48("3188") ? false : stryMutAct_9fa48("3187") ? true : (stryCov_9fa48("3187", "3188", "3189"), f.field === (stryMutAct_9fa48("3190") ? "" : (stryCov_9fa48("3190"), "expectedAttendance"))))))) {
        if (stryMutAct_9fa48("3191")) {
          {}
        } else {
          stryCov_9fa48("3191");
          await announceAttendanceChange(supabase, approvedEvent);
        }
      }
      const published = await getPublisher().publish(stryMutAct_9fa48("3192") ? {} : (stryCov_9fa48("3192"), {
        type: stryMutAct_9fa48("3193") ? "" : (stryCov_9fa48("3193"), "change.decided"),
        eventId: event.id,
        actorId: user.id,
        recipients: stryMutAct_9fa48("3194") ? {} : (stryCov_9fa48("3194"), {
          userIds: stryMutAct_9fa48("3195") ? [(updatedEvent as {
            organiser_id?: string;
          }).organiser_id ?? ""] : (stryCov_9fa48("3195"), (stryMutAct_9fa48("3196") ? [] : (stryCov_9fa48("3196"), [stryMutAct_9fa48("3197") ? (updatedEvent as {
            organiser_id?: string;
          }).organiser_id && "" : (stryCov_9fa48("3197"), (updatedEvent as {
            organiser_id?: string;
          }).organiser_id ?? (stryMutAct_9fa48("3198") ? "Stryker was here!" : (stryCov_9fa48("3198"), "")))])).filter(Boolean)),
          roles: stryMutAct_9fa48("3199") ? ["Stryker was here"] : (stryCov_9fa48("3199"), [])
        }),
        data: (stryMutAct_9fa48("3203") ? remainingFieldNames.length <= 0 : stryMutAct_9fa48("3202") ? remainingFieldNames.length >= 0 : stryMutAct_9fa48("3201") ? false : stryMutAct_9fa48("3200") ? true : (stryCov_9fa48("3200", "3201", "3202", "3203"), remainingFieldNames.length > 0)) ? stryMutAct_9fa48("3204") ? {} : (stryCov_9fa48("3204"), {
          eventName,
          outcome: stryMutAct_9fa48("3205") ? "" : (stryCov_9fa48("3205"), "partially_approved"),
          approvedFields: criticalFields.map(stryMutAct_9fa48("3206") ? () => undefined : (stryCov_9fa48("3206"), f => f.field)),
          remainingFields: remainingFieldNames
        }) : stryMutAct_9fa48("3207") ? {} : (stryCov_9fa48("3207"), {
          eventName,
          outcome: stryMutAct_9fa48("3208") ? "" : (stryCov_9fa48("3208"), "approved")
        })
      }));
      res.json(stryMutAct_9fa48("3210") ? {} : (stryCov_9fa48("3210"), {
        event: updatedEvent,
        approvedFields: criticalFields.map(stryMutAct_9fa48("3211") ? () => undefined : (stryCov_9fa48("3211"), f => f.field)),
        remainingFields: remainingFieldNames,
        bookingsFlagged,
        equipmentFlagged,
        notificationsFailed: stryMutAct_9fa48("3212") ? published : (stryCov_9fa48("3212"), !published)
      }));
    }
  });
}
/**
 * E3-11 AC4: the coordinator rejects a held change request with a
 * required reason. Nothing is applied — the held fields stay recorded on
 * the now-terminal Rejected row as a historical record, event untouched.
 */
if (stryMutAct_9fa48("3213")) {
  ;
} else {
  stryCov_9fa48("3213");
  eventsRouter.post(stryMutAct_9fa48("3214") ? "" : (stryCov_9fa48("3214"), "/:id/change-requests/:requestId/reject"), async (req: AuthedRequest, res) => {
    if (stryMutAct_9fa48("3215")) {
      {}
    } else {
      stryCov_9fa48("3215");
      const eventId = routeParam(req.params.id);
      const event = await loadEventForDecision(req, res, eventId);
      if (stryMutAct_9fa48("3218") ? false : stryMutAct_9fa48("3217") ? true : stryMutAct_9fa48("3216") ? event : (stryCov_9fa48("3216", "3217", "3218"), !event)) return;
      const {
        supabase,
        user
      } = req as Required<Pick<AuthedRequest, "supabase" | "user">>;
      const requestId = routeParam(req.params.requestId);
      const changeRequest = await loadPendingChangeRequest(supabase, res, event.id, requestId);
      if (stryMutAct_9fa48("3221") ? false : stryMutAct_9fa48("3220") ? true : stryMutAct_9fa48("3219") ? changeRequest : (stryCov_9fa48("3219", "3220", "3221"), !changeRequest)) return;
      const reason = (stryMutAct_9fa48("3224") ? typeof req.body?.reason !== "string" : stryMutAct_9fa48("3223") ? false : stryMutAct_9fa48("3222") ? true : (stryCov_9fa48("3222", "3223", "3224"), typeof (stryMutAct_9fa48("3225") ? req.body.reason : (stryCov_9fa48("3225"), req.body?.reason)) === (stryMutAct_9fa48("3226") ? "" : (stryCov_9fa48("3226"), "string")))) ? stryMutAct_9fa48("3227") ? req.body.reason : (stryCov_9fa48("3227"), req.body.reason.trim()) : stryMutAct_9fa48("3228") ? "Stryker was here!" : (stryCov_9fa48("3228"), "");
      if (stryMutAct_9fa48("3231") ? false : stryMutAct_9fa48("3230") ? true : stryMutAct_9fa48("3229") ? reason : (stryCov_9fa48("3229", "3230", "3231"), !reason)) {
        if (stryMutAct_9fa48("3232")) {
          {}
        } else {
          stryCov_9fa48("3232");
          res.status(400).json(stryMutAct_9fa48("3234") ? {} : (stryCov_9fa48("3234"), {
            error: stryMutAct_9fa48("3235") ? "" : (stryCov_9fa48("3235"), "A reason is required")
          }));
          return;
        }
      }
      const {
        data: updated,
        error: decideError
      } = await supabase.from(stryMutAct_9fa48("3236") ? "" : (stryCov_9fa48("3236"), "change_requests")).update(stryMutAct_9fa48("3237") ? {} : (stryCov_9fa48("3237"), {
        status: CHANGE_REQUEST_STATUS.Rejected,
        decision_reason: reason,
        decided_by: user.id,
        decided_at: clock.now().toISOString()
      })).eq(stryMutAct_9fa48("3238") ? "" : (stryCov_9fa48("3238"), "id"), changeRequest.id).select(stryMutAct_9fa48("3239") ? "" : (stryCov_9fa48("3239"), "id, status, decided_at, decision_reason")).single();
      if (stryMutAct_9fa48("3241") ? false : stryMutAct_9fa48("3240") ? true : (stryCov_9fa48("3240", "3241"), decideError)) {
        if (stryMutAct_9fa48("3242")) {
          {}
        } else {
          stryCov_9fa48("3242");
          res.status(500).json(stryMutAct_9fa48("3244") ? {} : (stryCov_9fa48("3244"), {
            error: stryMutAct_9fa48("3245") ? "" : (stryCov_9fa48("3245"), "Failed to record the decision")
          }));
          return;
        }
      }

      // Rejecting the last open request on a Needs Review event whose approved
      // arrangements never changed (safety_approval_stale is still false) settles
      // it: the event returns straight to Confirmed, no new safety review.
      let returnedToConfirmed = stryMutAct_9fa48("3246") ? true : (stryCov_9fa48("3246"), false);
      if (stryMutAct_9fa48("3249") ? event.status !== EVENT_STATUS.NeedsReview : stryMutAct_9fa48("3248") ? false : stryMutAct_9fa48("3247") ? true : (stryCov_9fa48("3247", "3248", "3249"), event.status === EVENT_STATUS.NeedsReview)) {
        if (stryMutAct_9fa48("3250")) {
          {}
        } else {
          stryCov_9fa48("3250");
          const {
            count
          } = await supabase.from(stryMutAct_9fa48("3251") ? "" : (stryCov_9fa48("3251"), "change_requests")).select(stryMutAct_9fa48("3252") ? "" : (stryCov_9fa48("3252"), "id"), stryMutAct_9fa48("3253") ? {} : (stryCov_9fa48("3253"), {
            count: stryMutAct_9fa48("3254") ? "" : (stryCov_9fa48("3254"), "exact"),
            head: stryMutAct_9fa48("3255") ? false : (stryCov_9fa48("3255"), true)
          })).eq(stryMutAct_9fa48("3256") ? "" : (stryCov_9fa48("3256"), "event_id"), event.id).eq(stryMutAct_9fa48("3257") ? "" : (stryCov_9fa48("3257"), "status"), CHANGE_REQUEST_STATUS.Pending);
          if (stryMutAct_9fa48("3260") ? (count ?? 0) !== 0 : stryMutAct_9fa48("3259") ? false : stryMutAct_9fa48("3258") ? true : (stryCov_9fa48("3258", "3259", "3260"), (stryMutAct_9fa48("3261") ? count && 0 : (stryCov_9fa48("3261"), count ?? 0)) === 0)) {
            if (stryMutAct_9fa48("3262")) {
              {}
            } else {
              stryCov_9fa48("3262");
              const {
                data: reverted
              } = await supabase.from(stryMutAct_9fa48("3263") ? "" : (stryCov_9fa48("3263"), "events")).update(stryMutAct_9fa48("3264") ? {} : (stryCov_9fa48("3264"), {
                status: EVENT_STATUS.Confirmed
              })).eq(stryMutAct_9fa48("3265") ? "" : (stryCov_9fa48("3265"), "id"), event.id).eq(stryMutAct_9fa48("3266") ? "" : (stryCov_9fa48("3266"), "status"), EVENT_STATUS.NeedsReview).eq(stryMutAct_9fa48("3267") ? "" : (stryCov_9fa48("3267"), "safety_approval_stale"), stryMutAct_9fa48("3268") ? true : (stryCov_9fa48("3268"), false)).select(stryMutAct_9fa48("3269") ? "" : (stryCov_9fa48("3269"), "id"));
              returnedToConfirmed = stryMutAct_9fa48("3273") ? (reverted ?? []).length <= 0 : stryMutAct_9fa48("3272") ? (reverted ?? []).length >= 0 : stryMutAct_9fa48("3271") ? false : stryMutAct_9fa48("3270") ? true : (stryCov_9fa48("3270", "3271", "3272", "3273"), (stryMutAct_9fa48("3274") ? reverted && [] : (stryCov_9fa48("3274"), reverted ?? (stryMutAct_9fa48("3275") ? ["Stryker was here"] : (stryCov_9fa48("3275"), [])))).length > 0);
              if (stryMutAct_9fa48("3277") ? false : stryMutAct_9fa48("3276") ? true : (stryCov_9fa48("3276", "3277"), returnedToConfirmed)) {
                if (stryMutAct_9fa48("3278")) {
                  {}
                } else {
                  stryCov_9fa48("3278");
                  await recordEventHistory(supabase, event.id, stryMutAct_9fa48("3279") ? [] : (stryCov_9fa48("3279"), [stryMutAct_9fa48("3280") ? {} : (stryCov_9fa48("3280"), {
                    field: stryMutAct_9fa48("3281") ? "" : (stryCov_9fa48("3281"), "Status"),
                    oldValue: EVENT_STATUS.NeedsReview,
                    newValue: EVENT_STATUS.Confirmed
                  })]), user.id);
                }
              }
            }
          }
        }
      }
      const {
        data: eventRow
      } = await supabase.from(stryMutAct_9fa48("3282") ? "" : (stryCov_9fa48("3282"), "events")).select(stryMutAct_9fa48("3283") ? `` : (stryCov_9fa48("3283"), `${EVENT_COLUMNS}, organiser_id`)).eq(stryMutAct_9fa48("3284") ? "" : (stryCov_9fa48("3284"), "id"), event.id).maybeSingle();
      const organiserId = stryMutAct_9fa48("3285") ? (eventRow as {
        organiser_id?: string;
      } | null).organiser_id : (stryCov_9fa48("3285"), (eventRow as {
        organiser_id?: string;
      } | null)?.organiser_id);
      let notificationsFailed = stryMutAct_9fa48("3286") ? true : (stryCov_9fa48("3286"), false);
      if (stryMutAct_9fa48("3288") ? false : stryMutAct_9fa48("3287") ? true : (stryCov_9fa48("3287", "3288"), organiserId)) {
        if (stryMutAct_9fa48("3289")) {
          {}
        } else {
          stryCov_9fa48("3289");
          const eventName = eventDisplayName(eventRow as unknown as AssignmentEventRow);
          const published = await getPublisher().publish(stryMutAct_9fa48("3290") ? {} : (stryCov_9fa48("3290"), {
            type: stryMutAct_9fa48("3291") ? "" : (stryCov_9fa48("3291"), "change.decided"),
            eventId: event.id,
            actorId: user.id,
            recipients: stryMutAct_9fa48("3292") ? {} : (stryCov_9fa48("3292"), {
              userIds: stryMutAct_9fa48("3293") ? [] : (stryCov_9fa48("3293"), [organiserId]),
              roles: stryMutAct_9fa48("3294") ? ["Stryker was here"] : (stryCov_9fa48("3294"), [])
            }),
            data: stryMutAct_9fa48("3295") ? {} : (stryCov_9fa48("3295"), {
              eventName,
              outcome: stryMutAct_9fa48("3296") ? "" : (stryCov_9fa48("3296"), "rejected"),
              reason
            })
          }));
          notificationsFailed = stryMutAct_9fa48("3297") ? published : (stryCov_9fa48("3297"), !published);
        }
      }
      res.json(stryMutAct_9fa48("3299") ? {} : (stryCov_9fa48("3299"), {
        changeRequest: updated,
        returnedToConfirmed,
        notificationsFailed
      }));
    }
  });
}
/**
 * E2-7 AC3: the structured edit history for this event, chronological.
 * Same visibility rule as the clarification thread: owning organiser or
 * any coordinator.
 */
if (stryMutAct_9fa48("3300")) {
  ;
} else {
  stryCov_9fa48("3300");
  eventsRouter.get(stryMutAct_9fa48("3301") ? "" : (stryCov_9fa48("3301"), "/:id/history"), async (req: AuthedRequest, res) => {
    if (stryMutAct_9fa48("3302")) {
      {}
    } else {
      stryCov_9fa48("3302");
      const eventId = routeParam(req.params.id);
      const event = await loadEventForClarification(req, res, eventId);
      if (stryMutAct_9fa48("3305") ? false : stryMutAct_9fa48("3304") ? true : stryMutAct_9fa48("3303") ? event : (stryCov_9fa48("3303", "3304", "3305"), !event)) return;
      const {
        supabase
      } = req as Required<Pick<AuthedRequest, "supabase">>;
      const {
        data,
        error
      } = await supabase.from(stryMutAct_9fa48("3306") ? "" : (stryCov_9fa48("3306"), "event_history")).select(stryMutAct_9fa48("3307") ? "" : (stryCov_9fa48("3307"), "id, field, old_value, new_value, changed_by, changed_by_user:changed_by(name, role), changed_at")).eq(stryMutAct_9fa48("3308") ? "" : (stryCov_9fa48("3308"), "event_id"), event.id).order(stryMutAct_9fa48("3309") ? "" : (stryCov_9fa48("3309"), "changed_at"), stryMutAct_9fa48("3310") ? {} : (stryCov_9fa48("3310"), {
        ascending: stryMutAct_9fa48("3311") ? false : (stryCov_9fa48("3311"), true)
      }));
      if (stryMutAct_9fa48("3313") ? false : stryMutAct_9fa48("3312") ? true : (stryCov_9fa48("3312", "3313"), error)) {
        if (stryMutAct_9fa48("3314")) {
          {}
        } else {
          stryCov_9fa48("3314");
          res.status(500).json(stryMutAct_9fa48("3316") ? {} : (stryCov_9fa48("3316"), {
            error: stryMutAct_9fa48("3317") ? "" : (stryCov_9fa48("3317"), "Failed to load event history")
          }));
          return;
        }
      }
      res.json(stryMutAct_9fa48("3319") ? {} : (stryCov_9fa48("3319"), {
        history: stryMutAct_9fa48("3320") ? data && [] : (stryCov_9fa48("3320"), data ?? (stryMutAct_9fa48("3321") ? ["Stryker was here"] : (stryCov_9fa48("3321"), [])))
      }));
    }
  });
}
/**
 * E3-12/13/14: every Operational Safety Check decision on this event,
 * oldest first — outcome, reason, the Safety Officer and when. Lets the
 * coordinator see why an event came back to Planning without relying on
 * the notification. Same visibility as the edit history.
 */
if (stryMutAct_9fa48("3322")) {
  ;
} else {
  stryCov_9fa48("3322");
  eventsRouter.get(stryMutAct_9fa48("3323") ? "" : (stryCov_9fa48("3323"), "/:id/safety-reviews"), async (req: AuthedRequest, res) => {
    if (stryMutAct_9fa48("3324")) {
      {}
    } else {
      stryCov_9fa48("3324");
      const eventId = routeParam(req.params.id);
      const event = await loadEventForClarification(req, res, eventId);
      if (stryMutAct_9fa48("3327") ? false : stryMutAct_9fa48("3326") ? true : stryMutAct_9fa48("3325") ? event : (stryCov_9fa48("3325", "3326", "3327"), !event)) return;
      const {
        supabase
      } = req as Required<Pick<AuthedRequest, "supabase">>;
      const {
        data,
        error
      } = await supabase.from(stryMutAct_9fa48("3328") ? "" : (stryCov_9fa48("3328"), "event_safety_reviews")).select(stryMutAct_9fa48("3329") ? "" : (stryCov_9fa48("3329"), "id, outcome, reason, submission_id, officer:officer_id(name), created_at")).eq(stryMutAct_9fa48("3330") ? "" : (stryCov_9fa48("3330"), "event_id"), event.id).order(stryMutAct_9fa48("3331") ? "" : (stryCov_9fa48("3331"), "created_at"), stryMutAct_9fa48("3332") ? {} : (stryCov_9fa48("3332"), {
        ascending: stryMutAct_9fa48("3333") ? false : (stryCov_9fa48("3333"), true)
      }));
      if (stryMutAct_9fa48("3335") ? false : stryMutAct_9fa48("3334") ? true : (stryCov_9fa48("3334", "3335"), error)) {
        if (stryMutAct_9fa48("3336")) {
          {}
        } else {
          stryCov_9fa48("3336");
          res.status(500).json(stryMutAct_9fa48("3338") ? {} : (stryCov_9fa48("3338"), {
            error: stryMutAct_9fa48("3339") ? "" : (stryCov_9fa48("3339"), "Failed to load safety reviews")
          }));
          return;
        }
      }
      res.json(stryMutAct_9fa48("3341") ? {} : (stryCov_9fa48("3341"), {
        safetyReviews: stryMutAct_9fa48("3342") ? data && [] : (stryCov_9fa48("3342"), data ?? (stryMutAct_9fa48("3343") ? ["Stryker was here"] : (stryCov_9fa48("3343"), [])))
      }));
    }
  });
}
/**
 * E2-7 AC1 / AGENTS.md §3 edit table: the owning organiser edits directly
 * while the request waits in the unassigned queue, waits on its
 * coordinator's review, or is in Planning.
 */
/** Before Planning nothing is reserved yet, so a reschedule has no equipment to move. */
const PRE_PLANNING_STATUSES = new Set<string>(stryMutAct_9fa48("3344") ? [] : (stryCov_9fa48("3344"), [EVENT_STATUS.Draft, EVENT_STATUS.Unassigned, EVENT_STATUS.Requested]));
const ORGANISER_DIRECT_EDIT_STATUSES = new Set<string>(stryMutAct_9fa48("3345") ? [] : (stryCov_9fa48("3345"), [EVENT_STATUS.Unassigned, EVENT_STATUS.Requested, EVENT_STATUS.Planning]));

/**
 * E2-13: only the Event Coordinator Lead moves an event out of
 * "Unassigned", so "Unassigned" is deliberately absent from every
 * coordinator decision set below — there is no Unassigned → Planning or
 * Unassigned → Rejected (§3). A coordinator reviews once assigned, i.e.
 * from "Requested".
 */
const COORDINATOR_REVIEW_STATUSES = new Set<string>(stryMutAct_9fa48("3346") ? [] : (stryCov_9fa48("3346"), [EVENT_STATUS.Requested]));
const REJECTABLE_STATUSES = new Set<string>(stryMutAct_9fa48("3347") ? [] : (stryCov_9fa48("3347"), [EVENT_STATUS.Requested, EVENT_STATUS.ClarificationRequested]));
interface ReviewEventRow {
  id: number;
  status: string;
  coordinator_id: string | null;
  organiser_id: string | null;
  submitted_details?: Record<string, unknown> | null;
}

/**
 * Shared entry checks for every coordinator decision route (approve/
 * reject/request-clarification): role, id format, existence, the AC5
 * "Rejected is terminal" rule, and ownership — only the event's assigned
 * coordinator may act on it. E2-13 retired E2-6's assign-on-first-action
 * rule: an event with no coordinator is the Lead's to assign, not for any
 * coordinator to claim by acting on it, and E2-12 AC6 relies on the same
 * check to block a previous coordinator after a reassignment. Sends the
 * appropriate error response and returns null if any check fails,
 * otherwise returns the event row for the caller to apply its own
 * status-transition check to.
 */
async function authorizeCoordinatorReview(req: AuthedRequest, res: Response, eventId: string): Promise<ReviewEventRow | null> {
  if (stryMutAct_9fa48("3348")) {
    {}
  } else {
    stryCov_9fa48("3348");
    const {
      supabase,
      user
    } = req;
    if (stryMutAct_9fa48("3351") ? !supabase && !user : stryMutAct_9fa48("3350") ? false : stryMutAct_9fa48("3349") ? true : (stryCov_9fa48("3349", "3350", "3351"), (stryMutAct_9fa48("3352") ? supabase : (stryCov_9fa48("3352"), !supabase)) || (stryMutAct_9fa48("3353") ? user : (stryCov_9fa48("3353"), !user)))) {
      if (stryMutAct_9fa48("3354")) {
        {}
      } else {
        stryCov_9fa48("3354");
        res.status(401).json(stryMutAct_9fa48("3356") ? {} : (stryCov_9fa48("3356"), {
          error: stryMutAct_9fa48("3357") ? "" : (stryCov_9fa48("3357"), "Unauthenticated")
        }));
        return null;
      }
    }
    if (stryMutAct_9fa48("3360") ? user.role === "coordinator" : stryMutAct_9fa48("3359") ? false : stryMutAct_9fa48("3358") ? true : (stryCov_9fa48("3358", "3359", "3360"), user.role !== (stryMutAct_9fa48("3361") ? "" : (stryCov_9fa48("3361"), "coordinator")))) {
      if (stryMutAct_9fa48("3362")) {
        {}
      } else {
        stryCov_9fa48("3362");
        res.status(403).json(stryMutAct_9fa48("3364") ? {} : (stryCov_9fa48("3364"), {
          error: stryMutAct_9fa48("3365") ? "" : (stryCov_9fa48("3365"), "Only coordinators can review event requests")
        }));
        return null;
      }
    }
    if (stryMutAct_9fa48("3368") ? false : stryMutAct_9fa48("3367") ? true : stryMutAct_9fa48("3366") ? isPositiveInteger(eventId) : (stryCov_9fa48("3366", "3367", "3368"), !isPositiveInteger(eventId))) {
      if (stryMutAct_9fa48("3369")) {
        {}
      } else {
        stryCov_9fa48("3369");
        res.status(404).json(stryMutAct_9fa48("3371") ? {} : (stryCov_9fa48("3371"), {
          error: stryMutAct_9fa48("3372") ? "" : (stryCov_9fa48("3372"), "Event not found")
        }));
        return null;
      }
    }
    const {
      data,
      error
    } = await supabase.from(stryMutAct_9fa48("3373") ? "" : (stryCov_9fa48("3373"), "events")).select(stryMutAct_9fa48("3374") ? "" : (stryCov_9fa48("3374"), "id, status, coordinator_id, organiser_id, submitted_details")).eq(stryMutAct_9fa48("3375") ? "" : (stryCov_9fa48("3375"), "id"), Number(eventId)).maybeSingle();
    if (stryMutAct_9fa48("3377") ? false : stryMutAct_9fa48("3376") ? true : (stryCov_9fa48("3376", "3377"), error)) {
      if (stryMutAct_9fa48("3378")) {
        {}
      } else {
        stryCov_9fa48("3378");
        res.status(500).json(stryMutAct_9fa48("3380") ? {} : (stryCov_9fa48("3380"), {
          error: stryMutAct_9fa48("3381") ? "" : (stryCov_9fa48("3381"), "Failed to load event")
        }));
        return null;
      }
    }
    if (stryMutAct_9fa48("3384") ? false : stryMutAct_9fa48("3383") ? true : stryMutAct_9fa48("3382") ? data : (stryCov_9fa48("3382", "3383", "3384"), !data)) {
      if (stryMutAct_9fa48("3385")) {
        {}
      } else {
        stryCov_9fa48("3385");
        res.status(404).json(stryMutAct_9fa48("3387") ? {} : (stryCov_9fa48("3387"), {
          error: stryMutAct_9fa48("3388") ? "" : (stryCov_9fa48("3388"), "Event not found")
        }));
        return null;
      }
    }
    if (stryMutAct_9fa48("3391") ? false : stryMutAct_9fa48("3390") ? true : stryMutAct_9fa48("3389") ? data.coordinator_id : (stryCov_9fa48("3389", "3390", "3391"), !data.coordinator_id)) {
      if (stryMutAct_9fa48("3392")) {
        {}
      } else {
        stryCov_9fa48("3392");
        await recordAccessDenial(supabase, user.id, eventId, stryMutAct_9fa48("3393") ? "" : (stryCov_9fa48("3393"), "coordinator_not_assigned"));
        res.status(403).json(stryMutAct_9fa48("3395") ? {} : (stryCov_9fa48("3395"), {
          error: stryMutAct_9fa48("3396") ? "" : (stryCov_9fa48("3396"), "This request hasn't been assigned to a coordinator yet. The Event Coordinator Lead assigns it.")
        }));
        return null;
      }
    }
    if (stryMutAct_9fa48("3399") ? data.coordinator_id === user.id : stryMutAct_9fa48("3398") ? false : stryMutAct_9fa48("3397") ? true : (stryCov_9fa48("3397", "3398", "3399"), data.coordinator_id !== user.id)) {
      if (stryMutAct_9fa48("3400")) {
        {}
      } else {
        stryCov_9fa48("3400");
        await recordAccessDenial(supabase, user.id, eventId, stryMutAct_9fa48("3401") ? "" : (stryCov_9fa48("3401"), "coordinator_mismatch"));
        res.status(403).json(stryMutAct_9fa48("3403") ? {} : (stryCov_9fa48("3403"), {
          error: stryMutAct_9fa48("3404") ? "" : (stryCov_9fa48("3404"), "This request is assigned to another coordinator")
        }));
        return null;
      }
    }
    if (stryMutAct_9fa48("3407") ? data.status !== "Rejected" : stryMutAct_9fa48("3406") ? false : stryMutAct_9fa48("3405") ? true : (stryCov_9fa48("3405", "3406", "3407"), data.status === (stryMutAct_9fa48("3408") ? "" : (stryCov_9fa48("3408"), "Rejected")))) {
      if (stryMutAct_9fa48("3409")) {
        {}
      } else {
        stryCov_9fa48("3409");
        res.status(409).json(stryMutAct_9fa48("3411") ? {} : (stryCov_9fa48("3411"), {
          error: stryMutAct_9fa48("3412") ? "" : (stryCov_9fa48("3412"), "This request has been rejected and cannot be moved forward")
        }));
        return null;
      }
    }
    return data as ReviewEventRow;
  }
}

/**
 * E1-4.2 AC1 / E2-3: approve — from "Requested", or from "Clarification
 * Requested" once every top-level question raised on this event has been
 * marked resolved (an event already decided is blocked upstream in
 * authorizeCoordinatorReview). Sets status to "Planning".
 */
if (stryMutAct_9fa48("3413")) {
  ;
} else {
  stryCov_9fa48("3413");
  eventsRouter.post(stryMutAct_9fa48("3414") ? "" : (stryCov_9fa48("3414"), "/:id/approve"), async (req: AuthedRequest, res) => {
    if (stryMutAct_9fa48("3415")) {
      {}
    } else {
      stryCov_9fa48("3415");
      const eventId = routeParam(req.params.id);
      const event = await authorizeCoordinatorReview(req, res, eventId);
      if (stryMutAct_9fa48("3418") ? false : stryMutAct_9fa48("3417") ? true : stryMutAct_9fa48("3416") ? event : (stryCov_9fa48("3416", "3417", "3418"), !event)) return;
      if (stryMutAct_9fa48("3421") ? false : stryMutAct_9fa48("3420") ? true : stryMutAct_9fa48("3419") ? COORDINATOR_REVIEW_STATUSES.has(event.status) : (stryCov_9fa48("3419", "3420", "3421"), !COORDINATOR_REVIEW_STATUSES.has(event.status))) {
        if (stryMutAct_9fa48("3422")) {
          {}
        } else {
          stryCov_9fa48("3422");
          if (stryMutAct_9fa48("3425") ? event.status === "Clarification Requested" : stryMutAct_9fa48("3424") ? false : stryMutAct_9fa48("3423") ? true : (stryCov_9fa48("3423", "3424", "3425"), event.status !== (stryMutAct_9fa48("3426") ? "" : (stryCov_9fa48("3426"), "Clarification Requested")))) {
            if (stryMutAct_9fa48("3427")) {
              {}
            } else {
              stryCov_9fa48("3427");
              res.status(409).json(stryMutAct_9fa48("3429") ? {} : (stryCov_9fa48("3429"), {
                error: stryMutAct_9fa48("3430") ? "" : (stryCov_9fa48("3430"), "This request cannot be approved from its current status")
              }));
              return;
            }
          }
          const {
            supabase: clarificationSupabase
          } = req as Required<Pick<AuthedRequest, "supabase">>;
          const {
            data: questions,
            error: questionsError
          } = await clarificationSupabase.from(stryMutAct_9fa48("3431") ? "" : (stryCov_9fa48("3431"), "event_clarifications")).select(stryMutAct_9fa48("3432") ? "" : (stryCov_9fa48("3432"), "id, resolved")).eq(stryMutAct_9fa48("3433") ? "" : (stryCov_9fa48("3433"), "event_id"), event.id).is(stryMutAct_9fa48("3434") ? "" : (stryCov_9fa48("3434"), "parent_id"), null);
          if (stryMutAct_9fa48("3436") ? false : stryMutAct_9fa48("3435") ? true : (stryCov_9fa48("3435", "3436"), questionsError)) {
            if (stryMutAct_9fa48("3437")) {
              {}
            } else {
              stryCov_9fa48("3437");
              res.status(500).json(stryMutAct_9fa48("3439") ? {} : (stryCov_9fa48("3439"), {
                error: stryMutAct_9fa48("3440") ? "" : (stryCov_9fa48("3440"), "Failed to check the clarification thread")
              }));
              return;
            }
          }
          if (stryMutAct_9fa48("3443") ? (questions ?? []).every((q: {
            resolved: boolean;
          }) => !q.resolved) : stryMutAct_9fa48("3442") ? false : stryMutAct_9fa48("3441") ? true : (stryCov_9fa48("3441", "3442", "3443"), (stryMutAct_9fa48("3444") ? questions && [] : (stryCov_9fa48("3444"), questions ?? (stryMutAct_9fa48("3445") ? ["Stryker was here"] : (stryCov_9fa48("3445"), [])))).some(stryMutAct_9fa48("3446") ? () => undefined : (stryCov_9fa48("3446"), (q: {
            resolved: boolean;
          }) => stryMutAct_9fa48("3447") ? q.resolved : (stryCov_9fa48("3447"), !q.resolved))))) {
            if (stryMutAct_9fa48("3448")) {
              {}
            } else {
              stryCov_9fa48("3448");
              res.status(409).json(stryMutAct_9fa48("3450") ? {} : (stryCov_9fa48("3450"), {
                error: stryMutAct_9fa48("3451") ? "" : (stryCov_9fa48("3451"), "This request has an outstanding clarification request and cannot be approved yet")
              }));
              return;
            }
          }
        }
      }
      const {
        supabase,
        user
      } = req as Required<Pick<AuthedRequest, "supabase" | "user">>;
      const {
        data,
        error
      } = await supabase.from(stryMutAct_9fa48("3452") ? "" : (stryCov_9fa48("3452"), "events")).update(stryMutAct_9fa48("3453") ? {} : (stryCov_9fa48("3453"), {
        status: stryMutAct_9fa48("3454") ? "" : (stryCov_9fa48("3454"), "Planning"),
        decided_at: clock.now().toISOString(),
        decided_by: user.id
      })).eq(stryMutAct_9fa48("3455") ? "" : (stryCov_9fa48("3455"), "id"), event.id).select(EVENT_COLUMNS).single();
      if (stryMutAct_9fa48("3457") ? false : stryMutAct_9fa48("3456") ? true : (stryCov_9fa48("3456", "3457"), error)) {
        if (stryMutAct_9fa48("3458")) {
          {}
        } else {
          stryCov_9fa48("3458");
          res.status(500).json(stryMutAct_9fa48("3460") ? {} : (stryCov_9fa48("3460"), {
            error: stryMutAct_9fa48("3461") ? "" : (stryCov_9fa48("3461"), "Failed to approve event request")
          }));
          return;
        }
      }

      // #104 row 7: the organiser is the only recipient of the decision.
      if (stryMutAct_9fa48("3463") ? false : stryMutAct_9fa48("3462") ? true : (stryCov_9fa48("3462", "3463"), event.organiser_id)) {
        if (stryMutAct_9fa48("3464")) {
          {}
        } else {
          stryCov_9fa48("3464");
          await getPublisher().publish(stryMutAct_9fa48("3465") ? {} : (stryCov_9fa48("3465"), {
            type: stryMutAct_9fa48("3466") ? "" : (stryCov_9fa48("3466"), "request.decided"),
            eventId: event.id,
            actorId: user.id,
            recipients: stryMutAct_9fa48("3467") ? {} : (stryCov_9fa48("3467"), {
              userIds: stryMutAct_9fa48("3468") ? [] : (stryCov_9fa48("3468"), [event.organiser_id]),
              roles: stryMutAct_9fa48("3469") ? ["Stryker was here"] : (stryCov_9fa48("3469"), [])
            }),
            data: stryMutAct_9fa48("3470") ? {} : (stryCov_9fa48("3470"), {
              eventName: eventDisplayName(data as unknown as AssignmentEventRow),
              decision: stryMutAct_9fa48("3471") ? "" : (stryCov_9fa48("3471"), "approved")
            })
          }));
        }
      }
      res.json(stryMutAct_9fa48("3473") ? {} : (stryCov_9fa48("3473"), {
        event: data
      }));
    }
  });
}
/**
 * E1-4.2 AC2/AC3/AC5: reject — requires a reason, allowed from "Requested"
 * or "Clarification Requested" (an event already in Planning is out of
 * this story's scope; already-Rejected is blocked upstream in
 * authorizeCoordinatorReview per AC5).
 */
if (stryMutAct_9fa48("3474")) {
  ;
} else {
  stryCov_9fa48("3474");
  eventsRouter.post(stryMutAct_9fa48("3475") ? "" : (stryCov_9fa48("3475"), "/:id/reject"), async (req: AuthedRequest, res) => {
    if (stryMutAct_9fa48("3476")) {
      {}
    } else {
      stryCov_9fa48("3476");
      const eventId = routeParam(req.params.id);
      const event = await authorizeCoordinatorReview(req, res, eventId);
      if (stryMutAct_9fa48("3479") ? false : stryMutAct_9fa48("3478") ? true : stryMutAct_9fa48("3477") ? event : (stryCov_9fa48("3477", "3478", "3479"), !event)) return;
      if (stryMutAct_9fa48("3482") ? false : stryMutAct_9fa48("3481") ? true : stryMutAct_9fa48("3480") ? REJECTABLE_STATUSES.has(event.status) : (stryCov_9fa48("3480", "3481", "3482"), !REJECTABLE_STATUSES.has(event.status))) {
        if (stryMutAct_9fa48("3483")) {
          {}
        } else {
          stryCov_9fa48("3483");
          res.status(409).json(stryMutAct_9fa48("3485") ? {} : (stryCov_9fa48("3485"), {
            error: stryMutAct_9fa48("3486") ? "" : (stryCov_9fa48("3486"), "This request cannot be rejected from its current status")
          }));
          return;
        }
      }
      const reason = (stryMutAct_9fa48("3489") ? typeof req.body?.reason !== "string" : stryMutAct_9fa48("3488") ? false : stryMutAct_9fa48("3487") ? true : (stryCov_9fa48("3487", "3488", "3489"), typeof (stryMutAct_9fa48("3490") ? req.body.reason : (stryCov_9fa48("3490"), req.body?.reason)) === (stryMutAct_9fa48("3491") ? "" : (stryCov_9fa48("3491"), "string")))) ? stryMutAct_9fa48("3492") ? req.body.reason : (stryCov_9fa48("3492"), req.body.reason.trim()) : stryMutAct_9fa48("3493") ? "Stryker was here!" : (stryCov_9fa48("3493"), "");
      if (stryMutAct_9fa48("3496") ? false : stryMutAct_9fa48("3495") ? true : stryMutAct_9fa48("3494") ? reason : (stryCov_9fa48("3494", "3495", "3496"), !reason)) {
        if (stryMutAct_9fa48("3497")) {
          {}
        } else {
          stryCov_9fa48("3497");
          res.status(400).json(stryMutAct_9fa48("3499") ? {} : (stryCov_9fa48("3499"), {
            error: stryMutAct_9fa48("3500") ? "" : (stryCov_9fa48("3500"), "A reason is required to reject a request")
          }));
          return;
        }
      }
      const {
        supabase,
        user
      } = req as Required<Pick<AuthedRequest, "supabase" | "user">>;
      const {
        data,
        error
      } = await supabase.from(stryMutAct_9fa48("3501") ? "" : (stryCov_9fa48("3501"), "events")).update(stryMutAct_9fa48("3502") ? {} : (stryCov_9fa48("3502"), {
        status: stryMutAct_9fa48("3503") ? "" : (stryCov_9fa48("3503"), "Rejected"),
        review_outcome: reason,
        decided_at: clock.now().toISOString(),
        decided_by: user.id
      })).eq(stryMutAct_9fa48("3504") ? "" : (stryCov_9fa48("3504"), "id"), event.id).select(EVENT_COLUMNS).single();
      if (stryMutAct_9fa48("3506") ? false : stryMutAct_9fa48("3505") ? true : (stryCov_9fa48("3505", "3506"), error)) {
        if (stryMutAct_9fa48("3507")) {
          {}
        } else {
          stryCov_9fa48("3507");
          res.status(500).json(stryMutAct_9fa48("3509") ? {} : (stryCov_9fa48("3509"), {
            error: stryMutAct_9fa48("3510") ? "" : (stryCov_9fa48("3510"), "Failed to reject event request")
          }));
          return;
        }
      }

      // #104 row 7: the organiser is the only recipient of the decision.
      if (stryMutAct_9fa48("3512") ? false : stryMutAct_9fa48("3511") ? true : (stryCov_9fa48("3511", "3512"), event.organiser_id)) {
        if (stryMutAct_9fa48("3513")) {
          {}
        } else {
          stryCov_9fa48("3513");
          await getPublisher().publish(stryMutAct_9fa48("3514") ? {} : (stryCov_9fa48("3514"), {
            type: stryMutAct_9fa48("3515") ? "" : (stryCov_9fa48("3515"), "request.decided"),
            eventId: event.id,
            actorId: user.id,
            recipients: stryMutAct_9fa48("3516") ? {} : (stryCov_9fa48("3516"), {
              userIds: stryMutAct_9fa48("3517") ? [] : (stryCov_9fa48("3517"), [event.organiser_id]),
              roles: stryMutAct_9fa48("3518") ? ["Stryker was here"] : (stryCov_9fa48("3518"), [])
            }),
            data: stryMutAct_9fa48("3519") ? {} : (stryCov_9fa48("3519"), {
              eventName: eventDisplayName(data as unknown as AssignmentEventRow),
              decision: stryMutAct_9fa48("3520") ? "" : (stryCov_9fa48("3520"), "rejected"),
              reason
            })
          }));
        }
      }
      res.json(stryMutAct_9fa48("3522") ? {} : (stryCov_9fa48("3522"), {
        event: data
      }));
    }
  });
}
/**
 * E3-5: the assigned coordinator marks an event completed once it has run
 * (Confirmed -> Completed, AGENTS.md §3). AC1: only from Confirmed, which
 * every event reaches through the Safety Officer's approval. AC2: blocked
 * until the event's end time has passed (Singapore time, lib/eventTiming.ts).
 * AC3: nothing is deleted or released — the event's details, history,
 * venue bookings, equipment reservations and registrations all stay as
 * they are, so its full record remains viewable. decided_at/decided_by are
 * left alone (they hold the coordinator's original review decision); who
 * completed it and when goes into the event history instead.
 *
 * The update only matches while the event is still Confirmed and still
 * assigned to the caller, so a concurrent reassignment, cancellation or
 * re-review between the checks and the write makes it a 409 instead.
 */
if (stryMutAct_9fa48("3523")) {
  ;
} else {
  stryCov_9fa48("3523");
  eventsRouter.post(stryMutAct_9fa48("3524") ? "" : (stryCov_9fa48("3524"), "/:id/complete"), async (req: AuthedRequest, res) => {
    if (stryMutAct_9fa48("3525")) {
      {}
    } else {
      stryCov_9fa48("3525");
      const eventId = routeParam(req.params.id);
      const event = await authorizeCoordinatorReview(req, res, eventId);
      if (stryMutAct_9fa48("3528") ? false : stryMutAct_9fa48("3527") ? true : stryMutAct_9fa48("3526") ? event : (stryCov_9fa48("3526", "3527", "3528"), !event)) return;
      if (stryMutAct_9fa48("3531") ? event.status === EVENT_STATUS.Confirmed : stryMutAct_9fa48("3530") ? false : stryMutAct_9fa48("3529") ? true : (stryCov_9fa48("3529", "3530", "3531"), event.status !== EVENT_STATUS.Confirmed)) {
        if (stryMutAct_9fa48("3532")) {
          {}
        } else {
          stryCov_9fa48("3532");
          res.status(409).json(stryMutAct_9fa48("3534") ? {} : (stryCov_9fa48("3534"), {
            error: stryMutAct_9fa48("3535") ? "" : (stryCov_9fa48("3535"), "Only a Confirmed event can be marked completed")
          }));
          return;
        }
      }
      const {
        supabase,
        user
      } = req as Required<Pick<AuthedRequest, "supabase" | "user">>;
      const {
        data: detailsRow,
        error: detailsError
      } = await supabase.from(stryMutAct_9fa48("3536") ? "" : (stryCov_9fa48("3536"), "events")).select(stryMutAct_9fa48("3537") ? "" : (stryCov_9fa48("3537"), "submitted_details")).eq(stryMutAct_9fa48("3538") ? "" : (stryCov_9fa48("3538"), "id"), event.id).single();
      if (stryMutAct_9fa48("3540") ? false : stryMutAct_9fa48("3539") ? true : (stryCov_9fa48("3539", "3540"), detailsError)) {
        if (stryMutAct_9fa48("3541")) {
          {}
        } else {
          stryCov_9fa48("3541");
          res.status(500).json(stryMutAct_9fa48("3543") ? {} : (stryCov_9fa48("3543"), {
            error: stryMutAct_9fa48("3544") ? "" : (stryCov_9fa48("3544"), "Failed to load event")
          }));
          return;
        }
      }
      const details = (detailsRow?.submitted_details ?? {}) as Record<string, unknown>;
      if (stryMutAct_9fa48("3547") ? false : stryMutAct_9fa48("3546") ? true : stryMutAct_9fa48("3545") ? hasEventEnded(details) : (stryCov_9fa48("3545", "3546", "3547"), !hasEventEnded(details))) {
        if (stryMutAct_9fa48("3548")) {
          {}
        } else {
          stryCov_9fa48("3548");
          const endsAt = eventEndsAt(details);
          res.status(409).json(stryMutAct_9fa48("3550") ? {} : (stryCov_9fa48("3550"), {
            error: endsAt ? stryMutAct_9fa48("3551") ? `` : (stryCov_9fa48("3551"), `This event hasn't finished yet. It can be marked completed after it ends (${details.proposedDate} ${stryMutAct_9fa48("3552") ? details.endTime && "end of day" : (stryCov_9fa48("3552"), details.endTime ?? (stryMutAct_9fa48("3553") ? "" : (stryCov_9fa48("3553"), "end of day")))}).`) : stryMutAct_9fa48("3554") ? "" : (stryCov_9fa48("3554"), "This event has no valid date and end time, so it can't be marked completed.")
          }));
          return;
        }
      }
      const {
        data,
        error
      } = await supabase.from(stryMutAct_9fa48("3555") ? "" : (stryCov_9fa48("3555"), "events")).update(stryMutAct_9fa48("3556") ? {} : (stryCov_9fa48("3556"), {
        status: EVENT_STATUS.Completed
      })).eq(stryMutAct_9fa48("3557") ? "" : (stryCov_9fa48("3557"), "id"), event.id).eq(stryMutAct_9fa48("3558") ? "" : (stryCov_9fa48("3558"), "status"), EVENT_STATUS.Confirmed).eq(stryMutAct_9fa48("3559") ? "" : (stryCov_9fa48("3559"), "coordinator_id"), user.id).select(EVENT_COLUMNS).maybeSingle();
      if (stryMutAct_9fa48("3561") ? false : stryMutAct_9fa48("3560") ? true : (stryCov_9fa48("3560", "3561"), error)) {
        if (stryMutAct_9fa48("3562")) {
          {}
        } else {
          stryCov_9fa48("3562");
          res.status(500).json(stryMutAct_9fa48("3564") ? {} : (stryCov_9fa48("3564"), {
            error: stryMutAct_9fa48("3565") ? "" : (stryCov_9fa48("3565"), "Failed to mark the event completed")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("3568") ? false : stryMutAct_9fa48("3567") ? true : stryMutAct_9fa48("3566") ? data : (stryCov_9fa48("3566", "3567", "3568"), !data)) {
        if (stryMutAct_9fa48("3569")) {
          {}
        } else {
          stryCov_9fa48("3569");
          res.status(409).json(stryMutAct_9fa48("3571") ? {} : (stryCov_9fa48("3571"), {
            error: stryMutAct_9fa48("3572") ? "" : (stryCov_9fa48("3572"), "This event is no longer Confirmed or no longer assigned to you")
          }));
          return;
        }
      }
      await recordEventHistory(supabase, event.id, stryMutAct_9fa48("3573") ? [] : (stryCov_9fa48("3573"), [stryMutAct_9fa48("3574") ? {} : (stryCov_9fa48("3574"), {
        field: stryMutAct_9fa48("3575") ? "" : (stryCov_9fa48("3575"), "Status"),
        oldValue: EVENT_STATUS.Confirmed,
        newValue: EVENT_STATUS.Completed
      })]), user.id);
      res.json(stryMutAct_9fa48("3577") ? {} : (stryCov_9fa48("3577"), {
        event: data
      }));
    }
  });
}
/**
 * Registration period (coordinator). Only the assigned coordinator, via
 * authorizeCoordinatorReview. Writes the stored intent (open date, manual
 * open/close); whether registration is open right now is derived on read
 * (lib/registrationPeriod.ts), so nothing here opens or closes anything on a
 * timer. Each change goes into the event history.
 */
async function loadRegistrationRow(supabase: NonNullable<AuthedRequest["supabase"]>, eventId: number): Promise<{
  submitted_details: Record<string, unknown> | null;
  registration_open_date: string | null;
  registration_override: string | null;
} | null> {
  if (stryMutAct_9fa48("3578")) {
    {}
  } else {
    stryCov_9fa48("3578");
    const {
      data
    } = await supabase.from(stryMutAct_9fa48("3579") ? "" : (stryCov_9fa48("3579"), "events")).select(stryMutAct_9fa48("3580") ? "" : (stryCov_9fa48("3580"), "submitted_details, registration_open_date, registration_override")).eq(stryMutAct_9fa48("3581") ? "" : (stryCov_9fa48("3581"), "id"), eventId).maybeSingle();
    return stryMutAct_9fa48("3582") ? data && null : (stryCov_9fa48("3582"), data ?? null);
  }
}
if (stryMutAct_9fa48("3583")) {
  ;
} else {
  stryCov_9fa48("3583");
  eventsRouter.put(stryMutAct_9fa48("3584") ? "" : (stryCov_9fa48("3584"), "/:id/registration"), async (req: AuthedRequest, res) => {
    if (stryMutAct_9fa48("3585")) {
      {}
    } else {
      stryCov_9fa48("3585");
      const eventId = routeParam(req.params.id);
      const event = await authorizeCoordinatorReview(req, res, eventId);
      if (stryMutAct_9fa48("3588") ? false : stryMutAct_9fa48("3587") ? true : stryMutAct_9fa48("3586") ? event : (stryCov_9fa48("3586", "3587", "3588"), !event)) return;
      if (stryMutAct_9fa48("3591") ? false : stryMutAct_9fa48("3590") ? true : stryMutAct_9fa48("3589") ? REGISTRATION_DATE_EDITABLE_STATUSES.includes(event.status) : (stryCov_9fa48("3589", "3590", "3591"), !REGISTRATION_DATE_EDITABLE_STATUSES.includes(event.status))) {
        if (stryMutAct_9fa48("3592")) {
          {}
        } else {
          stryCov_9fa48("3592");
          res.status(409).json(stryMutAct_9fa48("3594") ? {} : (stryCov_9fa48("3594"), {
            error: stryMutAct_9fa48("3595") ? "" : (stryCov_9fa48("3595"), "The registration open date can only be set once the event is in Planning, and before it ends")
          }));
          return;
        }
      }
      const {
        supabase,
        user
      } = req as Required<Pick<AuthedRequest, "supabase" | "user">>;
      const row = await loadRegistrationRow(supabase, event.id);
      if (stryMutAct_9fa48("3598") ? false : stryMutAct_9fa48("3597") ? true : stryMutAct_9fa48("3596") ? row : (stryCov_9fa48("3596", "3597", "3598"), !row)) {
        if (stryMutAct_9fa48("3599")) {
          {}
        } else {
          stryCov_9fa48("3599");
          res.status(500).json(stryMutAct_9fa48("3601") ? {} : (stryCov_9fa48("3601"), {
            error: stryMutAct_9fa48("3602") ? "" : (stryCov_9fa48("3602"), "Failed to load event")
          }));
          return;
        }
      }
      const details = stryMutAct_9fa48("3603") ? row.submitted_details && {} : (stryCov_9fa48("3603"), row.submitted_details ?? {});
      if (stryMutAct_9fa48("3606") ? details.registrationNeeded === true : stryMutAct_9fa48("3605") ? false : stryMutAct_9fa48("3604") ? true : (stryCov_9fa48("3604", "3605", "3606"), details.registrationNeeded !== (stryMutAct_9fa48("3607") ? false : (stryCov_9fa48("3607"), true)))) {
        if (stryMutAct_9fa48("3608")) {
          {}
        } else {
          stryCov_9fa48("3608");
          res.status(409).json(stryMutAct_9fa48("3610") ? {} : (stryCov_9fa48("3610"), {
            error: stryMutAct_9fa48("3611") ? "" : (stryCov_9fa48("3611"), "This event doesn't need registration")
          }));
          return;
        }
      }
      const openDate = (stryMutAct_9fa48("3612") ? req.body && {} : (stryCov_9fa48("3612"), req.body ?? {})).openDate;
      if (stryMutAct_9fa48("3615") ? localDateStart(openDate) !== null : stryMutAct_9fa48("3614") ? false : stryMutAct_9fa48("3613") ? true : (stryCov_9fa48("3613", "3614", "3615"), localDateStart(openDate) === null)) {
        if (stryMutAct_9fa48("3616")) {
          {}
        } else {
          stryCov_9fa48("3616");
          res.status(400).json(stryMutAct_9fa48("3618") ? {} : (stryCov_9fa48("3618"), {
            error: stryMutAct_9fa48("3619") ? "" : (stryCov_9fa48("3619"), "openDate must be a date in YYYY-MM-DD format")
          }));
          return;
        }
      }
      const startsAt = eventStartsAt(details);
      if (stryMutAct_9fa48("3622") ? startsAt === null : stryMutAct_9fa48("3621") ? false : stryMutAct_9fa48("3620") ? true : (stryCov_9fa48("3620", "3621", "3622"), startsAt !== null)) {
        if (stryMutAct_9fa48("3623")) {
          {}
        } else {
          stryCov_9fa48("3623");
          const cutoff = stryMutAct_9fa48("3624") ? startsAt.getTime() + REGISTRATION_CUTOFF_DAYS * 24 * 60 * 60 * 1000 : (stryCov_9fa48("3624"), startsAt.getTime() - (stryMutAct_9fa48("3625") ? REGISTRATION_CUTOFF_DAYS * 24 * 60 * 60 / 1000 : (stryCov_9fa48("3625"), (stryMutAct_9fa48("3626") ? REGISTRATION_CUTOFF_DAYS * 24 * 60 / 60 : (stryCov_9fa48("3626"), (stryMutAct_9fa48("3627") ? REGISTRATION_CUTOFF_DAYS * 24 / 60 : (stryCov_9fa48("3627"), (stryMutAct_9fa48("3628") ? REGISTRATION_CUTOFF_DAYS / 24 : (stryCov_9fa48("3628"), REGISTRATION_CUTOFF_DAYS * 24)) * 60)) * 60)) * 1000)));
          if (stryMutAct_9fa48("3632") ? (localDateStart(openDate) as Date).getTime() < cutoff : stryMutAct_9fa48("3631") ? (localDateStart(openDate) as Date).getTime() > cutoff : stryMutAct_9fa48("3630") ? false : stryMutAct_9fa48("3629") ? true : (stryCov_9fa48("3629", "3630", "3631", "3632"), (localDateStart(openDate) as Date).getTime() >= cutoff)) {
            if (stryMutAct_9fa48("3633")) {
              {}
            } else {
              stryCov_9fa48("3633");
              res.status(400).json(stryMutAct_9fa48("3635") ? {} : (stryCov_9fa48("3635"), {
                error: stryMutAct_9fa48("3636") ? `` : (stryCov_9fa48("3636"), `Registration closes ${REGISTRATION_CUTOFF_DAYS} days before the event, so the open date must be earlier than that`)
              }));
              return;
            }
          }
        }
      }
      const {
        data,
        error
      } = await supabase.from(stryMutAct_9fa48("3637") ? "" : (stryCov_9fa48("3637"), "events")).update(stryMutAct_9fa48("3638") ? {} : (stryCov_9fa48("3638"), {
        registration_open_date: openDate
      })).eq(stryMutAct_9fa48("3639") ? "" : (stryCov_9fa48("3639"), "id"), event.id).eq(stryMutAct_9fa48("3640") ? "" : (stryCov_9fa48("3640"), "coordinator_id"), user.id).in(stryMutAct_9fa48("3641") ? "" : (stryCov_9fa48("3641"), "status"), REGISTRATION_DATE_EDITABLE_STATUSES).select(EVENT_COLUMNS).maybeSingle();
      if (stryMutAct_9fa48("3643") ? false : stryMutAct_9fa48("3642") ? true : (stryCov_9fa48("3642", "3643"), error)) {
        if (stryMutAct_9fa48("3644")) {
          {}
        } else {
          stryCov_9fa48("3644");
          res.status(500).json(stryMutAct_9fa48("3646") ? {} : (stryCov_9fa48("3646"), {
            error: stryMutAct_9fa48("3647") ? "" : (stryCov_9fa48("3647"), "Failed to save the registration open date")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("3650") ? false : stryMutAct_9fa48("3649") ? true : stryMutAct_9fa48("3648") ? data : (stryCov_9fa48("3648", "3649", "3650"), !data)) {
        if (stryMutAct_9fa48("3651")) {
          {}
        } else {
          stryCov_9fa48("3651");
          res.status(409).json(stryMutAct_9fa48("3653") ? {} : (stryCov_9fa48("3653"), {
            error: stryMutAct_9fa48("3654") ? "" : (stryCov_9fa48("3654"), "This event changed or is no longer assigned to you")
          }));
          return;
        }
      }
      await recordEventHistory(supabase, event.id, stryMutAct_9fa48("3655") ? [] : (stryCov_9fa48("3655"), [stryMutAct_9fa48("3656") ? {} : (stryCov_9fa48("3656"), {
        field: stryMutAct_9fa48("3657") ? "" : (stryCov_9fa48("3657"), "Registration open date"),
        oldValue: row.registration_open_date,
        newValue: openDate as string
      })]), user.id);
      res.json(stryMutAct_9fa48("3659") ? {} : (stryCov_9fa48("3659"), {
        event: data
      }));
    }
  });
}
/** open / close / auto: the manual override on registration (Confirmed events only). */
function registrationOverrideRoute(action: string, override: RegistrationOverride) {
  if (stryMutAct_9fa48("3660")) {
    {}
  } else {
    stryCov_9fa48("3660");
    if (stryMutAct_9fa48("3661")) {
      ;
    } else {
      stryCov_9fa48("3661");
      eventsRouter.post(stryMutAct_9fa48("3662") ? `` : (stryCov_9fa48("3662"), `/:id/registration/${action}`), async (req: AuthedRequest, res) => {
        if (stryMutAct_9fa48("3663")) {
          {}
        } else {
          stryCov_9fa48("3663");
          const eventId = routeParam(req.params.id);
          const event = await authorizeCoordinatorReview(req, res, eventId);
          if (stryMutAct_9fa48("3666") ? false : stryMutAct_9fa48("3665") ? true : stryMutAct_9fa48("3664") ? event : (stryCov_9fa48("3664", "3665", "3666"), !event)) return;
          if (stryMutAct_9fa48("3669") ? event.status === EVENT_STATUS.Confirmed : stryMutAct_9fa48("3668") ? false : stryMutAct_9fa48("3667") ? true : (stryCov_9fa48("3667", "3668", "3669"), event.status !== EVENT_STATUS.Confirmed)) {
            if (stryMutAct_9fa48("3670")) {
              {}
            } else {
              stryCov_9fa48("3670");
              res.status(409).json(stryMutAct_9fa48("3672") ? {} : (stryCov_9fa48("3672"), {
                error: stryMutAct_9fa48("3673") ? "" : (stryCov_9fa48("3673"), "Registration can only be opened or closed for a Confirmed event")
              }));
              return;
            }
          }
          const {
            supabase,
            user
          } = req as Required<Pick<AuthedRequest, "supabase" | "user">>;
          const row = await loadRegistrationRow(supabase, event.id);
          if (stryMutAct_9fa48("3676") ? false : stryMutAct_9fa48("3675") ? true : stryMutAct_9fa48("3674") ? row : (stryCov_9fa48("3674", "3675", "3676"), !row)) {
            if (stryMutAct_9fa48("3677")) {
              {}
            } else {
              stryCov_9fa48("3677");
              res.status(500).json(stryMutAct_9fa48("3679") ? {} : (stryCov_9fa48("3679"), {
                error: stryMutAct_9fa48("3680") ? "" : (stryCov_9fa48("3680"), "Failed to load event")
              }));
              return;
            }
          }
          if (stryMutAct_9fa48("3683") ? (row.submitted_details ?? {}).registrationNeeded === true : stryMutAct_9fa48("3682") ? false : stryMutAct_9fa48("3681") ? true : (stryCov_9fa48("3681", "3682", "3683"), (stryMutAct_9fa48("3684") ? row.submitted_details && {} : (stryCov_9fa48("3684"), row.submitted_details ?? {})).registrationNeeded !== (stryMutAct_9fa48("3685") ? false : (stryCov_9fa48("3685"), true)))) {
            if (stryMutAct_9fa48("3686")) {
              {}
            } else {
              stryCov_9fa48("3686");
              res.status(409).json(stryMutAct_9fa48("3688") ? {} : (stryCov_9fa48("3688"), {
                error: stryMutAct_9fa48("3689") ? "" : (stryCov_9fa48("3689"), "This event doesn't need registration")
              }));
              return;
            }
          }
          // The guard above already refused a missing submitted_details.
          const startsAt = eventStartsAt(row.submitted_details!);
          if (stryMutAct_9fa48("3692") ? override === REGISTRATION_OVERRIDE.ForceOpen && startsAt !== null || startsAt.getTime() <= clock.now().getTime() : stryMutAct_9fa48("3691") ? false : stryMutAct_9fa48("3690") ? true : (stryCov_9fa48("3690", "3691", "3692"), (stryMutAct_9fa48("3694") ? override === REGISTRATION_OVERRIDE.ForceOpen || startsAt !== null : stryMutAct_9fa48("3693") ? true : (stryCov_9fa48("3693", "3694"), (stryMutAct_9fa48("3696") ? override !== REGISTRATION_OVERRIDE.ForceOpen : stryMutAct_9fa48("3695") ? true : (stryCov_9fa48("3695", "3696"), override === REGISTRATION_OVERRIDE.ForceOpen)) && (stryMutAct_9fa48("3698") ? startsAt === null : stryMutAct_9fa48("3697") ? true : (stryCov_9fa48("3697", "3698"), startsAt !== null)))) && (stryMutAct_9fa48("3701") ? startsAt.getTime() > clock.now().getTime() : stryMutAct_9fa48("3700") ? startsAt.getTime() < clock.now().getTime() : stryMutAct_9fa48("3699") ? true : (stryCov_9fa48("3699", "3700", "3701"), startsAt.getTime() <= clock.now().getTime())))) {
            if (stryMutAct_9fa48("3702")) {
              {}
            } else {
              stryCov_9fa48("3702");
              res.status(409).json(stryMutAct_9fa48("3704") ? {} : (stryCov_9fa48("3704"), {
                error: stryMutAct_9fa48("3705") ? "" : (stryCov_9fa48("3705"), "This event has already started, so registration can't be opened")
              }));
              return;
            }
          }
          const {
            data,
            error
          } = await supabase.from(stryMutAct_9fa48("3706") ? "" : (stryCov_9fa48("3706"), "events")).update(stryMutAct_9fa48("3707") ? {} : (stryCov_9fa48("3707"), {
            registration_override: override
          })).eq(stryMutAct_9fa48("3708") ? "" : (stryCov_9fa48("3708"), "id"), event.id).eq(stryMutAct_9fa48("3709") ? "" : (stryCov_9fa48("3709"), "status"), EVENT_STATUS.Confirmed).eq(stryMutAct_9fa48("3710") ? "" : (stryCov_9fa48("3710"), "coordinator_id"), user.id).select(EVENT_COLUMNS).maybeSingle();
          if (stryMutAct_9fa48("3712") ? false : stryMutAct_9fa48("3711") ? true : (stryCov_9fa48("3711", "3712"), error)) {
            if (stryMutAct_9fa48("3713")) {
              {}
            } else {
              stryCov_9fa48("3713");
              res.status(500).json(stryMutAct_9fa48("3715") ? {} : (stryCov_9fa48("3715"), {
                error: stryMutAct_9fa48("3716") ? "" : (stryCov_9fa48("3716"), "Failed to update registration")
              }));
              return;
            }
          }
          if (stryMutAct_9fa48("3719") ? false : stryMutAct_9fa48("3718") ? true : stryMutAct_9fa48("3717") ? data : (stryCov_9fa48("3717", "3718", "3719"), !data)) {
            if (stryMutAct_9fa48("3720")) {
              {}
            } else {
              stryCov_9fa48("3720");
              res.status(409).json(stryMutAct_9fa48("3722") ? {} : (stryCov_9fa48("3722"), {
                error: stryMutAct_9fa48("3723") ? "" : (stryCov_9fa48("3723"), "This event is no longer Confirmed or no longer assigned to you")
              }));
              return;
            }
          }
          await recordEventHistory(supabase, event.id, stryMutAct_9fa48("3724") ? [] : (stryCov_9fa48("3724"), [stryMutAct_9fa48("3725") ? {} : (stryCov_9fa48("3725"), {
            field: stryMutAct_9fa48("3726") ? "" : (stryCov_9fa48("3726"), "Registration override"),
            oldValue: stryMutAct_9fa48("3727") ? row.registration_override && REGISTRATION_OVERRIDE.None : (stryCov_9fa48("3727"), row.registration_override ?? REGISTRATION_OVERRIDE.None),
            newValue: override
          })]), user.id);
          res.json(stryMutAct_9fa48("3729") ? {} : (stryCov_9fa48("3729"), {
            event: data
          }));
        }
      });
    }
  }
}
registrationOverrideRoute(stryMutAct_9fa48("3731") ? "" : (stryCov_9fa48("3731"), "open"), REGISTRATION_OVERRIDE.ForceOpen);
registrationOverrideRoute(stryMutAct_9fa48("3733") ? "" : (stryCov_9fa48("3733"), "close"), REGISTRATION_OVERRIDE.ForceClosed);
registrationOverrideRoute(stryMutAct_9fa48("3735") ? "" : (stryCov_9fa48("3735"), "auto"), REGISTRATION_OVERRIDE.None);

/**
 * E3-4: the assigned coordinator submits a Planning event for the Safety
 * Officer's Operational Safety Check (Planning → Safety Review, AGENTS.md §3).
 * Checked in order: the caller is the assigned coordinator (AC7, in
 * authorizeCoordinatorReview), the event is in Planning (AC6), the safety
 * notes are all given (AC5), and the venue and equipment arrangements are
 * settled (AC1–AC4) — read from venue-service and equipment-service. The
 * status change and the notes are then written together by
 * submit_event_for_safety_review (migration 0026). A resubmission after the
 * Safety Officer rejects or requests changes takes the same path, since
 * both return the event to Planning (AC8), and gets a fresh submission row.
 * AC9: every Safety Officer and the Organiser are notified (#105 row 1).
 */
if (stryMutAct_9fa48("3736")) {
  ;
} else {
  stryCov_9fa48("3736");
  eventsRouter.post(stryMutAct_9fa48("3737") ? "" : (stryCov_9fa48("3737"), "/:id/submit-safety-review"), async (req: AuthedRequest, res) => {
    if (stryMutAct_9fa48("3738")) {
      {}
    } else {
      stryCov_9fa48("3738");
      const eventId = routeParam(req.params.id);
      const event = await authorizeCoordinatorReview(req, res, eventId);
      if (stryMutAct_9fa48("3741") ? false : stryMutAct_9fa48("3740") ? true : stryMutAct_9fa48("3739") ? event : (stryCov_9fa48("3739", "3740", "3741"), !event)) return;
      if (stryMutAct_9fa48("3744") ? event.status !== EVENT_STATUS.Planning || event.status !== EVENT_STATUS.NeedsReview : stryMutAct_9fa48("3743") ? false : stryMutAct_9fa48("3742") ? true : (stryCov_9fa48("3742", "3743", "3744"), (stryMutAct_9fa48("3746") ? event.status === EVENT_STATUS.Planning : stryMutAct_9fa48("3745") ? true : (stryCov_9fa48("3745", "3746"), event.status !== EVENT_STATUS.Planning)) && (stryMutAct_9fa48("3748") ? event.status === EVENT_STATUS.NeedsReview : stryMutAct_9fa48("3747") ? true : (stryCov_9fa48("3747", "3748"), event.status !== EVENT_STATUS.NeedsReview)))) {
        if (stryMutAct_9fa48("3749")) {
          {}
        } else {
          stryCov_9fa48("3749");
          res.status(409).json(stryMutAct_9fa48("3751") ? {} : (stryCov_9fa48("3751"), {
            error: stryMutAct_9fa48("3752") ? "" : (stryCov_9fa48("3752"), "Only an event in Planning or Needs Review can be submitted for safety review")
          }));
          return;
        }
      }

      // Needs Review is settled only once every change request is decided.
      if (stryMutAct_9fa48("3755") ? event.status !== EVENT_STATUS.NeedsReview : stryMutAct_9fa48("3754") ? false : stryMutAct_9fa48("3753") ? true : (stryCov_9fa48("3753", "3754", "3755"), event.status === EVENT_STATUS.NeedsReview)) {
        if (stryMutAct_9fa48("3756")) {
          {}
        } else {
          stryCov_9fa48("3756");
          const {
            count
          } = await (req as Required<Pick<AuthedRequest, "supabase">>).supabase.from(stryMutAct_9fa48("3757") ? "" : (stryCov_9fa48("3757"), "change_requests")).select(stryMutAct_9fa48("3758") ? "" : (stryCov_9fa48("3758"), "id"), stryMutAct_9fa48("3759") ? {} : (stryCov_9fa48("3759"), {
            count: stryMutAct_9fa48("3760") ? "" : (stryCov_9fa48("3760"), "exact"),
            head: stryMutAct_9fa48("3761") ? false : (stryCov_9fa48("3761"), true)
          })).eq(stryMutAct_9fa48("3762") ? "" : (stryCov_9fa48("3762"), "event_id"), event.id).eq(stryMutAct_9fa48("3763") ? "" : (stryCov_9fa48("3763"), "status"), CHANGE_REQUEST_STATUS.Pending);
          if (stryMutAct_9fa48("3767") ? (count ?? 0) <= 0 : stryMutAct_9fa48("3766") ? (count ?? 0) >= 0 : stryMutAct_9fa48("3765") ? false : stryMutAct_9fa48("3764") ? true : (stryCov_9fa48("3764", "3765", "3766", "3767"), (stryMutAct_9fa48("3768") ? count && 0 : (stryCov_9fa48("3768"), count ?? 0)) > 0)) {
            if (stryMutAct_9fa48("3769")) {
              {}
            } else {
              stryCov_9fa48("3769");
              res.status(409).json(stryMutAct_9fa48("3771") ? {} : (stryCov_9fa48("3771"), {
                error: stryMutAct_9fa48("3772") ? "" : (stryCov_9fa48("3772"), "Decide the open change request before submitting for safety review")
              }));
              return;
            }
          }
        }
      }
      const parsed = parseSafetyNotes(req.body);
      if (stryMutAct_9fa48("3775") ? false : stryMutAct_9fa48("3774") ? true : stryMutAct_9fa48("3773") ? parsed.valid : (stryCov_9fa48("3773", "3774", "3775"), !parsed.valid)) {
        if (stryMutAct_9fa48("3776")) {
          {}
        } else {
          stryCov_9fa48("3776");
          res.status(400).json(stryMutAct_9fa48("3778") ? {} : (stryCov_9fa48("3778"), {
            error: stryMutAct_9fa48("3779") ? "" : (stryCov_9fa48("3779"), "Safety notes are required"),
            fields: parsed.fields
          }));
          return;
        }
      }
      const authorization = req.headers.authorization!;
      const [bookings, equipment] = await Promise.all(stryMutAct_9fa48("3780") ? [] : (stryCov_9fa48("3780"), [fetchEventVenueBookings(event.id, authorization), fetchEventEquipmentRequests(event.id, authorization)]));
      if (stryMutAct_9fa48("3783") ? bookings.status === "error" && equipment.status === "error" : stryMutAct_9fa48("3782") ? false : stryMutAct_9fa48("3781") ? true : (stryCov_9fa48("3781", "3782", "3783"), (stryMutAct_9fa48("3785") ? bookings.status !== "error" : stryMutAct_9fa48("3784") ? false : (stryCov_9fa48("3784", "3785"), bookings.status === (stryMutAct_9fa48("3786") ? "" : (stryCov_9fa48("3786"), "error")))) || (stryMutAct_9fa48("3788") ? equipment.status !== "error" : stryMutAct_9fa48("3787") ? false : (stryCov_9fa48("3787", "3788"), equipment.status === (stryMutAct_9fa48("3789") ? "" : (stryCov_9fa48("3789"), "error")))))) {
        if (stryMutAct_9fa48("3790")) {
          {}
        } else {
          stryCov_9fa48("3790");
          res.status(502).json(stryMutAct_9fa48("3792") ? {} : (stryCov_9fa48("3792"), {
            error: stryMutAct_9fa48("3793") ? "" : (stryCov_9fa48("3793"), "Couldn't check this event's venue and equipment arrangements. Please try again.")
          }));
          return;
        }
      }
      const equipmentRequirements = stryMutAct_9fa48("3794") ? event.submitted_details.equipment : (stryCov_9fa48("3794"), event.submitted_details?.equipment);
      const outstanding = findOutstandingArrangements(bookings.value, equipment.value, (stryMutAct_9fa48("3797") ? typeof equipmentRequirements !== "string" : stryMutAct_9fa48("3796") ? false : stryMutAct_9fa48("3795") ? true : (stryCov_9fa48("3795", "3796", "3797"), typeof equipmentRequirements === (stryMutAct_9fa48("3798") ? "" : (stryCov_9fa48("3798"), "string")))) ? equipmentRequirements : null);
      if (stryMutAct_9fa48("3800") ? false : stryMutAct_9fa48("3799") ? true : (stryCov_9fa48("3799", "3800"), hasOutstanding(outstanding))) {
        if (stryMutAct_9fa48("3801")) {
          {}
        } else {
          stryCov_9fa48("3801");
          res.status(409).json(stryMutAct_9fa48("3803") ? {} : (stryCov_9fa48("3803"), {
            error: describeOutstanding(outstanding),
            outstanding
          }));
          return;
        }
      }
      const {
        supabase,
        user
      } = req as Required<Pick<AuthedRequest, "supabase" | "user">>;
      const {
        notes
      } = parsed;
      const {
        data: submissionId,
        error: submitError
      } = await supabase.rpc(stryMutAct_9fa48("3804") ? "" : (stryCov_9fa48("3804"), "submit_event_for_safety_review"), stryMutAct_9fa48("3805") ? {} : (stryCov_9fa48("3805"), {
        p_event_id: event.id,
        p_submitted_by: user.id,
        p_equipment_placement: notes.equipmentPlacement,
        p_crowd_movement: notes.crowdMovement,
        p_emergency_access: notes.emergencyAccess,
        p_venue_restrictions: notes.venueRestrictions
      }));
      if (stryMutAct_9fa48("3807") ? false : stryMutAct_9fa48("3806") ? true : (stryCov_9fa48("3806", "3807"), submitError)) {
        if (stryMutAct_9fa48("3808")) {
          {}
        } else {
          stryCov_9fa48("3808");
          res.status(500).json(stryMutAct_9fa48("3810") ? {} : (stryCov_9fa48("3810"), {
            error: stryMutAct_9fa48("3811") ? "" : (stryCov_9fa48("3811"), "Failed to submit the event for safety review")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("3814") ? submissionId !== null : stryMutAct_9fa48("3813") ? false : stryMutAct_9fa48("3812") ? true : (stryCov_9fa48("3812", "3813", "3814"), submissionId === null)) {
        if (stryMutAct_9fa48("3815")) {
          {}
        } else {
          stryCov_9fa48("3815");
          // Moved on, or reassigned, since the checks above.
          res.status(409).json(stryMutAct_9fa48("3817") ? {} : (stryCov_9fa48("3817"), {
            error: stryMutAct_9fa48("3818") ? "" : (stryCov_9fa48("3818"), "This event is no longer in Planning or Needs Review, or no longer assigned to you")
          }));
          return;
        }
      }
      const {
        data,
        error
      } = await supabase.from(stryMutAct_9fa48("3819") ? "" : (stryCov_9fa48("3819"), "events")).select(EVENT_COLUMNS).eq(stryMutAct_9fa48("3820") ? "" : (stryCov_9fa48("3820"), "id"), event.id).single();
      if (stryMutAct_9fa48("3822") ? false : stryMutAct_9fa48("3821") ? true : (stryCov_9fa48("3821", "3822"), error)) {
        if (stryMutAct_9fa48("3823")) {
          {}
        } else {
          stryCov_9fa48("3823");
          res.status(500).json(stryMutAct_9fa48("3825") ? {} : (stryCov_9fa48("3825"), {
            error: stryMutAct_9fa48("3826") ? "" : (stryCov_9fa48("3826"), "Submitted for safety review, but failed to reload the event")
          }));
          return;
        }
      }

      // #105 row 1 (E7-2b): every Safety Officer and the organiser, closing the
      // gap this route's own AC9 comment used to defer to E7.
      if (stryMutAct_9fa48("3828") ? false : stryMutAct_9fa48("3827") ? true : (stryCov_9fa48("3827", "3828"), event.organiser_id)) {
        if (stryMutAct_9fa48("3829")) {
          {}
        } else {
          stryCov_9fa48("3829");
          await getPublisher().publish(stryMutAct_9fa48("3830") ? {} : (stryCov_9fa48("3830"), {
            type: stryMutAct_9fa48("3831") ? "" : (stryCov_9fa48("3831"), "safety.submitted"),
            eventId: event.id,
            actorId: user.id,
            recipients: stryMutAct_9fa48("3832") ? {} : (stryCov_9fa48("3832"), {
              userIds: stryMutAct_9fa48("3833") ? [] : (stryCov_9fa48("3833"), [event.organiser_id]),
              roles: stryMutAct_9fa48("3834") ? [] : (stryCov_9fa48("3834"), [stryMutAct_9fa48("3835") ? "" : (stryCov_9fa48("3835"), "safety_officer")])
            }),
            data: stryMutAct_9fa48("3836") ? {} : (stryCov_9fa48("3836"), {
              eventName: eventDisplayName(data as unknown as AssignmentEventRow)
            })
          }));
        }
      }
      res.json(stryMutAct_9fa48("3838") ? {} : (stryCov_9fa48("3838"), {
        event: data,
        submissionId
      }));
    }
  });
}
interface SafetyReviewEventRow {
  id: number;
  status: string;
  coordinator_id: string | null;
  organiser_id: string | null;
}

/**
 * E3-12/13/14: shared entry checks for the Safety Officer's decision
 * routes. Unlike authorizeCoordinatorReview, there's no per-event
 * assignment to check — any Safety Officer may act on any event in Safety
 * Review (E1-10 AC4/AC5).
 */
async function authorizeSafetyOfficerReview(req: AuthedRequest, res: Response, eventId: string): Promise<SafetyReviewEventRow | null> {
  if (stryMutAct_9fa48("3839")) {
    {}
  } else {
    stryCov_9fa48("3839");
    const {
      supabase,
      user
    } = req;
    if (stryMutAct_9fa48("3842") ? !supabase && !user : stryMutAct_9fa48("3841") ? false : stryMutAct_9fa48("3840") ? true : (stryCov_9fa48("3840", "3841", "3842"), (stryMutAct_9fa48("3843") ? supabase : (stryCov_9fa48("3843"), !supabase)) || (stryMutAct_9fa48("3844") ? user : (stryCov_9fa48("3844"), !user)))) {
      if (stryMutAct_9fa48("3845")) {
        {}
      } else {
        stryCov_9fa48("3845");
        res.status(401).json(stryMutAct_9fa48("3847") ? {} : (stryCov_9fa48("3847"), {
          error: stryMutAct_9fa48("3848") ? "" : (stryCov_9fa48("3848"), "Unauthenticated")
        }));
        return null;
      }
    }
    if (stryMutAct_9fa48("3851") ? user.role === "safety_officer" : stryMutAct_9fa48("3850") ? false : stryMutAct_9fa48("3849") ? true : (stryCov_9fa48("3849", "3850", "3851"), user.role !== (stryMutAct_9fa48("3852") ? "" : (stryCov_9fa48("3852"), "safety_officer")))) {
      if (stryMutAct_9fa48("3853")) {
        {}
      } else {
        stryCov_9fa48("3853");
        res.status(403).json(stryMutAct_9fa48("3855") ? {} : (stryCov_9fa48("3855"), {
          error: stryMutAct_9fa48("3856") ? "" : (stryCov_9fa48("3856"), "Only the Safety Officer can decide an Operational Safety Check")
        }));
        return null;
      }
    }
    if (stryMutAct_9fa48("3859") ? false : stryMutAct_9fa48("3858") ? true : stryMutAct_9fa48("3857") ? isPositiveInteger(eventId) : (stryCov_9fa48("3857", "3858", "3859"), !isPositiveInteger(eventId))) {
      if (stryMutAct_9fa48("3860")) {
        {}
      } else {
        stryCov_9fa48("3860");
        res.status(404).json(stryMutAct_9fa48("3862") ? {} : (stryCov_9fa48("3862"), {
          error: stryMutAct_9fa48("3863") ? "" : (stryCov_9fa48("3863"), "Event not found")
        }));
        return null;
      }
    }
    const {
      data,
      error
    } = await supabase.from(stryMutAct_9fa48("3864") ? "" : (stryCov_9fa48("3864"), "events")).select(stryMutAct_9fa48("3865") ? "" : (stryCov_9fa48("3865"), "id, status, coordinator_id, organiser_id")).eq(stryMutAct_9fa48("3866") ? "" : (stryCov_9fa48("3866"), "id"), Number(eventId)).maybeSingle();
    if (stryMutAct_9fa48("3868") ? false : stryMutAct_9fa48("3867") ? true : (stryCov_9fa48("3867", "3868"), error)) {
      if (stryMutAct_9fa48("3869")) {
        {}
      } else {
        stryCov_9fa48("3869");
        res.status(500).json(stryMutAct_9fa48("3871") ? {} : (stryCov_9fa48("3871"), {
          error: stryMutAct_9fa48("3872") ? "" : (stryCov_9fa48("3872"), "Failed to load event")
        }));
        return null;
      }
    }
    if (stryMutAct_9fa48("3875") ? false : stryMutAct_9fa48("3874") ? true : stryMutAct_9fa48("3873") ? data : (stryCov_9fa48("3873", "3874", "3875"), !data)) {
      if (stryMutAct_9fa48("3876")) {
        {}
      } else {
        stryCov_9fa48("3876");
        res.status(404).json(stryMutAct_9fa48("3878") ? {} : (stryCov_9fa48("3878"), {
          error: stryMutAct_9fa48("3879") ? "" : (stryCov_9fa48("3879"), "Event not found")
        }));
        return null;
      }
    }
    return data as SafetyReviewEventRow;
  }
}

/**
 * E3-12: the Safety Officer approves the Operational Safety Check (Safety
 * Review -> Confirmed, AGENTS.md §3). The decision and status change land
 * together in approve_event_safety_review (migration 0028), which also
 * links the decision to the submission it answers. The assigned
 * coordinator and Organiser are notified (AC1); a failure to notify never
 * blocks the already-committed decision.
 */
if (stryMutAct_9fa48("3880")) {
  ;
} else {
  stryCov_9fa48("3880");
  eventsRouter.post(stryMutAct_9fa48("3881") ? "" : (stryCov_9fa48("3881"), "/:id/safety-review/approve"), async (req: AuthedRequest, res) => {
    if (stryMutAct_9fa48("3882")) {
      {}
    } else {
      stryCov_9fa48("3882");
      const eventId = routeParam(req.params.id);
      const event = await authorizeSafetyOfficerReview(req, res, eventId);
      if (stryMutAct_9fa48("3885") ? false : stryMutAct_9fa48("3884") ? true : stryMutAct_9fa48("3883") ? event : (stryCov_9fa48("3883", "3884", "3885"), !event)) return;
      if (stryMutAct_9fa48("3888") ? event.status === EVENT_STATUS.SafetyReview : stryMutAct_9fa48("3887") ? false : stryMutAct_9fa48("3886") ? true : (stryCov_9fa48("3886", "3887", "3888"), event.status !== EVENT_STATUS.SafetyReview)) {
        if (stryMutAct_9fa48("3889")) {
          {}
        } else {
          stryCov_9fa48("3889");
          res.status(409).json(stryMutAct_9fa48("3891") ? {} : (stryCov_9fa48("3891"), {
            error: stryMutAct_9fa48("3892") ? "" : (stryCov_9fa48("3892"), "Only an event in Safety Review can be approved")
          }));
          return;
        }
      }
      const reason = (stryMutAct_9fa48("3895") ? typeof req.body?.reason === "string" || req.body.reason.trim() : stryMutAct_9fa48("3894") ? false : stryMutAct_9fa48("3893") ? true : (stryCov_9fa48("3893", "3894", "3895"), (stryMutAct_9fa48("3897") ? typeof req.body?.reason !== "string" : stryMutAct_9fa48("3896") ? true : (stryCov_9fa48("3896", "3897"), typeof (stryMutAct_9fa48("3898") ? req.body.reason : (stryCov_9fa48("3898"), req.body?.reason)) === (stryMutAct_9fa48("3899") ? "" : (stryCov_9fa48("3899"), "string")))) && (stryMutAct_9fa48("3900") ? req.body.reason : (stryCov_9fa48("3900"), req.body.reason.trim())))) ? stryMutAct_9fa48("3901") ? req.body.reason : (stryCov_9fa48("3901"), req.body.reason.trim()) : null;
      const {
        supabase,
        user
      } = req as Required<Pick<AuthedRequest, "supabase" | "user">>;
      const {
        data: reviewId,
        error: approveError
      } = await supabase.rpc(stryMutAct_9fa48("3902") ? "" : (stryCov_9fa48("3902"), "approve_event_safety_review"), stryMutAct_9fa48("3903") ? {} : (stryCov_9fa48("3903"), {
        p_event_id: event.id,
        p_officer_id: user.id,
        p_reason: reason
      }));
      if (stryMutAct_9fa48("3905") ? false : stryMutAct_9fa48("3904") ? true : (stryCov_9fa48("3904", "3905"), approveError)) {
        if (stryMutAct_9fa48("3906")) {
          {}
        } else {
          stryCov_9fa48("3906");
          res.status(500).json(stryMutAct_9fa48("3908") ? {} : (stryCov_9fa48("3908"), {
            error: stryMutAct_9fa48("3909") ? "" : (stryCov_9fa48("3909"), "Failed to approve the safety review")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("3912") ? reviewId !== null : stryMutAct_9fa48("3911") ? false : stryMutAct_9fa48("3910") ? true : (stryCov_9fa48("3910", "3911", "3912"), reviewId === null)) {
        if (stryMutAct_9fa48("3913")) {
          {}
        } else {
          stryCov_9fa48("3913");
          res.status(409).json(stryMutAct_9fa48("3915") ? {} : (stryCov_9fa48("3915"), {
            error: stryMutAct_9fa48("3916") ? "" : (stryCov_9fa48("3916"), "This event is no longer in Safety Review")
          }));
          return;
        }
      }
      const {
        data,
        error
      } = await supabase.from(stryMutAct_9fa48("3917") ? "" : (stryCov_9fa48("3917"), "events")).select(EVENT_COLUMNS).eq(stryMutAct_9fa48("3918") ? "" : (stryCov_9fa48("3918"), "id"), event.id).single();
      if (stryMutAct_9fa48("3920") ? false : stryMutAct_9fa48("3919") ? true : (stryCov_9fa48("3919", "3920"), error)) {
        if (stryMutAct_9fa48("3921")) {
          {}
        } else {
          stryCov_9fa48("3921");
          res.status(500).json(stryMutAct_9fa48("3923") ? {} : (stryCov_9fa48("3923"), {
            error: stryMutAct_9fa48("3924") ? "" : (stryCov_9fa48("3924"), "Approved, but failed to reload the event")
          }));
          return;
        }
      }
      const recipients = stryMutAct_9fa48("3925") ? [event.coordinator_id, event.organiser_id] : (stryCov_9fa48("3925"), (stryMutAct_9fa48("3926") ? [] : (stryCov_9fa48("3926"), [event.coordinator_id, event.organiser_id])).filter(stryMutAct_9fa48("3927") ? () => undefined : (stryCov_9fa48("3927"), (id): id is string => stryMutAct_9fa48("3930") ? typeof id !== "string" : stryMutAct_9fa48("3929") ? false : stryMutAct_9fa48("3928") ? true : (stryCov_9fa48("3928", "3929", "3930"), typeof id === (stryMutAct_9fa48("3931") ? "" : (stryCov_9fa48("3931"), "string"))))));
      const eventName = ((data.submitted_details ?? {}) as Record<string, unknown>).name;

      // Migrated to RabbitMQ (ARD section 1.1, RabbitMQ.md #9 "safety.decided").
      await getPublisher().publish(stryMutAct_9fa48("3932") ? {} : (stryCov_9fa48("3932"), {
        type: stryMutAct_9fa48("3933") ? "" : (stryCov_9fa48("3933"), "safety.decided"),
        eventId: event.id,
        actorId: user.id,
        recipients: stryMutAct_9fa48("3934") ? {} : (stryCov_9fa48("3934"), {
          userIds: recipients,
          roles: stryMutAct_9fa48("3935") ? ["Stryker was here"] : (stryCov_9fa48("3935"), [])
        }),
        data: stryMutAct_9fa48("3936") ? {} : (stryCov_9fa48("3936"), {
          outcome: stryMutAct_9fa48("3937") ? "" : (stryCov_9fa48("3937"), "approved"),
          eventName: (stryMutAct_9fa48("3940") ? typeof eventName !== "string" : stryMutAct_9fa48("3939") ? false : stryMutAct_9fa48("3938") ? true : (stryCov_9fa48("3938", "3939", "3940"), typeof eventName === (stryMutAct_9fa48("3941") ? "" : (stryCov_9fa48("3941"), "string")))) ? eventName : null
        })
      }));
      res.json(stryMutAct_9fa48("3943") ? {} : (stryCov_9fa48("3943"), {
        event: data,
        reviewId
      }));
    }
  });
}
/**
 * E3-13: the Safety Officer rejects the Operational Safety Check (Safety
 * Review -> Planning, AGENTS.md §3). A reason is required (AC2). The
 * decision and status change land together in reject_event_safety_review
 * (migration 0029); the event's venue bookings and equipment reservations
 * are left as they are, for the coordinator to rework. Only the assigned
 * coordinator is notified, with the reason (AC1); a failure to notify
 * never blocks the already-committed decision.
 */
if (stryMutAct_9fa48("3944")) {
  ;
} else {
  stryCov_9fa48("3944");
  eventsRouter.post(stryMutAct_9fa48("3945") ? "" : (stryCov_9fa48("3945"), "/:id/safety-review/reject"), async (req: AuthedRequest, res) => {
    if (stryMutAct_9fa48("3946")) {
      {}
    } else {
      stryCov_9fa48("3946");
      const eventId = routeParam(req.params.id);
      const event = await authorizeSafetyOfficerReview(req, res, eventId);
      if (stryMutAct_9fa48("3949") ? false : stryMutAct_9fa48("3948") ? true : stryMutAct_9fa48("3947") ? event : (stryCov_9fa48("3947", "3948", "3949"), !event)) return;
      if (stryMutAct_9fa48("3952") ? event.status === EVENT_STATUS.SafetyReview : stryMutAct_9fa48("3951") ? false : stryMutAct_9fa48("3950") ? true : (stryCov_9fa48("3950", "3951", "3952"), event.status !== EVENT_STATUS.SafetyReview)) {
        if (stryMutAct_9fa48("3953")) {
          {}
        } else {
          stryCov_9fa48("3953");
          res.status(409).json(stryMutAct_9fa48("3955") ? {} : (stryCov_9fa48("3955"), {
            error: stryMutAct_9fa48("3956") ? "" : (stryCov_9fa48("3956"), "Only an event in Safety Review can be rejected")
          }));
          return;
        }
      }
      const reason = (stryMutAct_9fa48("3959") ? typeof req.body?.reason !== "string" : stryMutAct_9fa48("3958") ? false : stryMutAct_9fa48("3957") ? true : (stryCov_9fa48("3957", "3958", "3959"), typeof (stryMutAct_9fa48("3960") ? req.body.reason : (stryCov_9fa48("3960"), req.body?.reason)) === (stryMutAct_9fa48("3961") ? "" : (stryCov_9fa48("3961"), "string")))) ? stryMutAct_9fa48("3962") ? req.body.reason : (stryCov_9fa48("3962"), req.body.reason.trim()) : stryMutAct_9fa48("3963") ? "Stryker was here!" : (stryCov_9fa48("3963"), "");
      if (stryMutAct_9fa48("3966") ? false : stryMutAct_9fa48("3965") ? true : stryMutAct_9fa48("3964") ? reason : (stryCov_9fa48("3964", "3965", "3966"), !reason)) {
        if (stryMutAct_9fa48("3967")) {
          {}
        } else {
          stryCov_9fa48("3967");
          res.status(400).json(stryMutAct_9fa48("3969") ? {} : (stryCov_9fa48("3969"), {
            error: stryMutAct_9fa48("3970") ? "" : (stryCov_9fa48("3970"), "A reason is required to reject a safety review")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("3974") ? reason.length <= MAX_SAFETY_DECISION_REASON_LENGTH : stryMutAct_9fa48("3973") ? reason.length >= MAX_SAFETY_DECISION_REASON_LENGTH : stryMutAct_9fa48("3972") ? false : stryMutAct_9fa48("3971") ? true : (stryCov_9fa48("3971", "3972", "3973", "3974"), reason.length > MAX_SAFETY_DECISION_REASON_LENGTH)) {
        if (stryMutAct_9fa48("3975")) {
          {}
        } else {
          stryCov_9fa48("3975");
          res.status(400).json(stryMutAct_9fa48("3977") ? {} : (stryCov_9fa48("3977"), {
            error: stryMutAct_9fa48("3978") ? `` : (stryCov_9fa48("3978"), `Keep the reason under ${MAX_SAFETY_DECISION_REASON_LENGTH} characters`)
          }));
          return;
        }
      }
      const {
        supabase,
        user
      } = req as Required<Pick<AuthedRequest, "supabase" | "user">>;
      const {
        data: reviewId,
        error: rejectError
      } = await supabase.rpc(stryMutAct_9fa48("3979") ? "" : (stryCov_9fa48("3979"), "reject_event_safety_review"), stryMutAct_9fa48("3980") ? {} : (stryCov_9fa48("3980"), {
        p_event_id: event.id,
        p_officer_id: user.id,
        p_reason: reason
      }));
      if (stryMutAct_9fa48("3982") ? false : stryMutAct_9fa48("3981") ? true : (stryCov_9fa48("3981", "3982"), rejectError)) {
        if (stryMutAct_9fa48("3983")) {
          {}
        } else {
          stryCov_9fa48("3983");
          res.status(500).json(stryMutAct_9fa48("3985") ? {} : (stryCov_9fa48("3985"), {
            error: stryMutAct_9fa48("3986") ? "" : (stryCov_9fa48("3986"), "Failed to reject the safety review")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("3989") ? reviewId !== null : stryMutAct_9fa48("3988") ? false : stryMutAct_9fa48("3987") ? true : (stryCov_9fa48("3987", "3988", "3989"), reviewId === null)) {
        if (stryMutAct_9fa48("3990")) {
          {}
        } else {
          stryCov_9fa48("3990");
          res.status(409).json(stryMutAct_9fa48("3992") ? {} : (stryCov_9fa48("3992"), {
            error: stryMutAct_9fa48("3993") ? "" : (stryCov_9fa48("3993"), "This event is no longer in Safety Review")
          }));
          return;
        }
      }
      const {
        data,
        error
      } = await supabase.from(stryMutAct_9fa48("3994") ? "" : (stryCov_9fa48("3994"), "events")).select(EVENT_COLUMNS).eq(stryMutAct_9fa48("3995") ? "" : (stryCov_9fa48("3995"), "id"), event.id).single();
      if (stryMutAct_9fa48("3997") ? false : stryMutAct_9fa48("3996") ? true : (stryCov_9fa48("3996", "3997"), error)) {
        if (stryMutAct_9fa48("3998")) {
          {}
        } else {
          stryCov_9fa48("3998");
          res.status(500).json(stryMutAct_9fa48("4000") ? {} : (stryCov_9fa48("4000"), {
            error: stryMutAct_9fa48("4001") ? "" : (stryCov_9fa48("4001"), "Rejected, but failed to reload the event")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("4003") ? false : stryMutAct_9fa48("4002") ? true : (stryCov_9fa48("4002", "4003"), event.coordinator_id)) {
        if (stryMutAct_9fa48("4004")) {
          {}
        } else {
          stryCov_9fa48("4004");
          const eventName = ((data.submitted_details ?? {}) as Record<string, unknown>).name;
          // Migrated to RabbitMQ (ARD section 1.1, RabbitMQ.md #9 "safety.decided"),
          // same type the approve route already publishes.
          await getPublisher().publish(stryMutAct_9fa48("4005") ? {} : (stryCov_9fa48("4005"), {
            type: stryMutAct_9fa48("4006") ? "" : (stryCov_9fa48("4006"), "safety.decided"),
            eventId: event.id,
            actorId: user.id,
            recipients: stryMutAct_9fa48("4007") ? {} : (stryCov_9fa48("4007"), {
              userIds: stryMutAct_9fa48("4008") ? [] : (stryCov_9fa48("4008"), [event.coordinator_id]),
              roles: stryMutAct_9fa48("4009") ? ["Stryker was here"] : (stryCov_9fa48("4009"), [])
            }),
            data: stryMutAct_9fa48("4010") ? {} : (stryCov_9fa48("4010"), {
              outcome: stryMutAct_9fa48("4011") ? "" : (stryCov_9fa48("4011"), "rejected"),
              reason,
              eventName: (stryMutAct_9fa48("4014") ? typeof eventName !== "string" : stryMutAct_9fa48("4013") ? false : stryMutAct_9fa48("4012") ? true : (stryCov_9fa48("4012", "4013", "4014"), typeof eventName === (stryMutAct_9fa48("4015") ? "" : (stryCov_9fa48("4015"), "string")))) ? eventName : null
            })
          }));
        }
      }
      res.json(stryMutAct_9fa48("4017") ? {} : (stryCov_9fa48("4017"), {
        event: data,
        reviewId
      }));
    }
  });
}
/**
 * E3-14: the Safety Officer requests specific changes, short of rejecting
 * (Safety Review -> Planning, AGENTS.md §3). At least one venue booking or
 * equipment reservation must be picked, each with what must change about it,
 * plus an optional general note (AC1, AC2). The picked arrangements are read from the services that own
 * them — so only this event's live ones can be flagged — and snapshotted,
 * so each flag can clear once its arrangement changes (AC3). The status
 * change, decision and flags land together in request_event_safety_changes
 * (migration 0035). Only the assigned coordinator is notified (AC1); a
 * failure to notify never blocks the already-committed decision.
 */
if (stryMutAct_9fa48("4018")) {
  ;
} else {
  stryCov_9fa48("4018");
  eventsRouter.post(stryMutAct_9fa48("4019") ? "" : (stryCov_9fa48("4019"), "/:id/safety-review/request-changes"), async (req: AuthedRequest, res) => {
    if (stryMutAct_9fa48("4020")) {
      {}
    } else {
      stryCov_9fa48("4020");
      const eventId = routeParam(req.params.id);
      const event = await authorizeSafetyOfficerReview(req, res, eventId);
      if (stryMutAct_9fa48("4023") ? false : stryMutAct_9fa48("4022") ? true : stryMutAct_9fa48("4021") ? event : (stryCov_9fa48("4021", "4022", "4023"), !event)) return;
      if (stryMutAct_9fa48("4026") ? event.status === EVENT_STATUS.SafetyReview : stryMutAct_9fa48("4025") ? false : stryMutAct_9fa48("4024") ? true : (stryCov_9fa48("4024", "4025", "4026"), event.status !== EVENT_STATUS.SafetyReview)) {
        if (stryMutAct_9fa48("4027")) {
          {}
        } else {
          stryCov_9fa48("4027");
          res.status(409).json(stryMutAct_9fa48("4029") ? {} : (stryCov_9fa48("4029"), {
            error: stryMutAct_9fa48("4030") ? "" : (stryCov_9fa48("4030"), "Changes can only be requested for an event in Safety Review")
          }));
          return;
        }
      }
      const parsed = parseChangeRequest(req.body);
      if (stryMutAct_9fa48("4033") ? false : stryMutAct_9fa48("4032") ? true : stryMutAct_9fa48("4031") ? parsed.valid : (stryCov_9fa48("4031", "4032", "4033"), !parsed.valid)) {
        if (stryMutAct_9fa48("4034")) {
          {}
        } else {
          stryCov_9fa48("4034");
          res.status(400).json(stryMutAct_9fa48("4036") ? {} : (stryCov_9fa48("4036"), {
            error: stryMutAct_9fa48("4037") ? "" : (stryCov_9fa48("4037"), "Pick what must change and say what for each"),
            fields: parsed.fields
          }));
          return;
        }
      }
      const authorization = req.headers.authorization!;
      const [bookings, equipment] = await Promise.all(stryMutAct_9fa48("4038") ? [] : (stryCov_9fa48("4038"), [fetchEventVenueBookings(event.id, authorization), fetchEventEquipmentRequests(event.id, authorization)]));
      if (stryMutAct_9fa48("4041") ? bookings.status === "error" && equipment.status === "error" : stryMutAct_9fa48("4040") ? false : stryMutAct_9fa48("4039") ? true : (stryCov_9fa48("4039", "4040", "4041"), (stryMutAct_9fa48("4043") ? bookings.status !== "error" : stryMutAct_9fa48("4042") ? false : (stryCov_9fa48("4042", "4043"), bookings.status === (stryMutAct_9fa48("4044") ? "" : (stryCov_9fa48("4044"), "error")))) || (stryMutAct_9fa48("4046") ? equipment.status !== "error" : stryMutAct_9fa48("4045") ? false : (stryCov_9fa48("4045", "4046"), equipment.status === (stryMutAct_9fa48("4047") ? "" : (stryCov_9fa48("4047"), "error")))))) {
        if (stryMutAct_9fa48("4048")) {
          {}
        } else {
          stryCov_9fa48("4048");
          res.status(502).json(stryMutAct_9fa48("4050") ? {} : (stryCov_9fa48("4050"), {
            error: stryMutAct_9fa48("4051") ? "" : (stryCov_9fa48("4051"), "Couldn't load this event's venue bookings and equipment. Try again.")
          }));
          return;
        }
      }
      const resolved = resolveFlags(parsed.request.arrangements, bookings.value, equipment.value);
      if (stryMutAct_9fa48("4054") ? false : stryMutAct_9fa48("4053") ? true : stryMutAct_9fa48("4052") ? resolved.ok : (stryCov_9fa48("4052", "4053", "4054"), !resolved.ok)) {
        if (stryMutAct_9fa48("4055")) {
          {}
        } else {
          stryCov_9fa48("4055");
          res.status(400).json(stryMutAct_9fa48("4057") ? {} : (stryCov_9fa48("4057"), {
            error: stryMutAct_9fa48("4058") ? "" : (stryCov_9fa48("4058"), "Some of the selected arrangements aren't this event's current venue bookings or equipment"),
            fields: stryMutAct_9fa48("4059") ? {} : (stryCov_9fa48("4059"), {
              arrangements: stryMutAct_9fa48("4060") ? "" : (stryCov_9fa48("4060"), "Pick from this event's current venue bookings and equipment.")
            }),
            unknown: resolved.unknown
          }));
          return;
        }
      }
      const {
        supabase,
        user
      } = req as Required<Pick<AuthedRequest, "supabase" | "user">>;
      const reason = combinedReason(resolved.flags, parsed.request.generalNote);
      const {
        data: reviewId,
        error: requestError
      } = await supabase.rpc(stryMutAct_9fa48("4061") ? "" : (stryCov_9fa48("4061"), "request_event_safety_changes"), stryMutAct_9fa48("4062") ? {} : (stryCov_9fa48("4062"), {
        p_event_id: event.id,
        p_officer_id: user.id,
        p_reason: reason,
        p_general_note: parsed.request.generalNote,
        p_flags: resolved.flags
      }));
      if (stryMutAct_9fa48("4064") ? false : stryMutAct_9fa48("4063") ? true : (stryCov_9fa48("4063", "4064"), requestError)) {
        if (stryMutAct_9fa48("4065")) {
          {}
        } else {
          stryCov_9fa48("4065");
          res.status(500).json(stryMutAct_9fa48("4067") ? {} : (stryCov_9fa48("4067"), {
            error: stryMutAct_9fa48("4068") ? "" : (stryCov_9fa48("4068"), "Failed to request changes")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("4071") ? reviewId !== null : stryMutAct_9fa48("4070") ? false : stryMutAct_9fa48("4069") ? true : (stryCov_9fa48("4069", "4070", "4071"), reviewId === null)) {
        if (stryMutAct_9fa48("4072")) {
          {}
        } else {
          stryCov_9fa48("4072");
          res.status(409).json(stryMutAct_9fa48("4074") ? {} : (stryCov_9fa48("4074"), {
            error: stryMutAct_9fa48("4075") ? "" : (stryCov_9fa48("4075"), "This event is no longer in Safety Review")
          }));
          return;
        }
      }
      const {
        data,
        error
      } = await supabase.from(stryMutAct_9fa48("4076") ? "" : (stryCov_9fa48("4076"), "events")).select(EVENT_COLUMNS).eq(stryMutAct_9fa48("4077") ? "" : (stryCov_9fa48("4077"), "id"), event.id).single();
      if (stryMutAct_9fa48("4079") ? false : stryMutAct_9fa48("4078") ? true : (stryCov_9fa48("4078", "4079"), error)) {
        if (stryMutAct_9fa48("4080")) {
          {}
        } else {
          stryCov_9fa48("4080");
          res.status(500).json(stryMutAct_9fa48("4082") ? {} : (stryCov_9fa48("4082"), {
            error: stryMutAct_9fa48("4083") ? "" : (stryCov_9fa48("4083"), "Changes requested, but failed to reload the event")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("4085") ? false : stryMutAct_9fa48("4084") ? true : (stryCov_9fa48("4084", "4085"), event.coordinator_id)) {
        if (stryMutAct_9fa48("4086")) {
          {}
        } else {
          stryCov_9fa48("4086");
          const eventName = ((data.submitted_details ?? {}) as Record<string, unknown>).name;
          // Migrated to RabbitMQ (ARD section 1.1, RabbitMQ.md #9 "safety.decided"),
          // same type the approve/reject routes already publish.
          await getPublisher().publish(stryMutAct_9fa48("4087") ? {} : (stryCov_9fa48("4087"), {
            type: stryMutAct_9fa48("4088") ? "" : (stryCov_9fa48("4088"), "safety.decided"),
            eventId: event.id,
            actorId: user.id,
            recipients: stryMutAct_9fa48("4089") ? {} : (stryCov_9fa48("4089"), {
              userIds: stryMutAct_9fa48("4090") ? [] : (stryCov_9fa48("4090"), [event.coordinator_id]),
              roles: stryMutAct_9fa48("4091") ? ["Stryker was here"] : (stryCov_9fa48("4091"), [])
            }),
            data: stryMutAct_9fa48("4092") ? {} : (stryCov_9fa48("4092"), {
              outcome: stryMutAct_9fa48("4093") ? "" : (stryCov_9fa48("4093"), "changes_requested"),
              reason,
              eventName: (stryMutAct_9fa48("4096") ? typeof eventName !== "string" : stryMutAct_9fa48("4095") ? false : stryMutAct_9fa48("4094") ? true : (stryCov_9fa48("4094", "4095", "4096"), typeof eventName === (stryMutAct_9fa48("4097") ? "" : (stryCov_9fa48("4097"), "string")))) ? eventName : null
            })
          }));
        }
      }
      res.json(stryMutAct_9fa48("4099") ? {} : (stryCov_9fa48("4099"), {
        event: data,
        reviewId
      }));
    }
  });
}
/** Whether the event has ever been submitted for safety review (E3-4). */
async function hasSafetySubmission(supabase: NonNullable<AuthedRequest["supabase"]>, eventId: number): Promise<boolean> {
  if (stryMutAct_9fa48("4100")) {
    {}
  } else {
    stryCov_9fa48("4100");
    const {
      data
    } = await supabase.from(stryMutAct_9fa48("4101") ? "" : (stryCov_9fa48("4101"), "event_safety_submissions")).select(stryMutAct_9fa48("4102") ? "" : (stryCov_9fa48("4102"), "id")).eq(stryMutAct_9fa48("4103") ? "" : (stryCov_9fa48("4103"), "event_id"), eventId).limit(1).maybeSingle();
    return stryMutAct_9fa48("4106") ? data === null : stryMutAct_9fa48("4105") ? false : stryMutAct_9fa48("4104") ? true : (stryCov_9fa48("4104", "4105", "4106"), data !== null);
  }
}
interface SafetyChangeRequestView {
  reviewId: number;
  officerName: string | null;
  requestedAt: string;
  /** Every note combined, as recorded on the decision. */
  reason: string;
  generalNote: string | null;
  flags: {
    type: string;
    id: number;
    label: string;
    note: string;
    clearedAt: string | null;
  }[];
  /** false when the arrangements couldn't be read, so changes weren't checked this time. */
  arrangementsChecked: boolean;
}

/**
 * E3-14 AC3: the event's open change request — only while the latest
 * safety decision is "Changes Requested" (a later approval or rejection
 * supersedes it). Each flag is compared with its arrangement's current
 * state, read with the caller's token from the owning service; a flag
 * whose arrangement changed is cleared for good. If the arrangements
 * can't be read, the flags are returned as stored.
 */
async function loadChangeRequest(supabase: NonNullable<AuthedRequest["supabase"]>, eventId: number, authorization: string): Promise<{
  status: "ok";
  value: SafetyChangeRequestView | null;
} | {
  status: "error";
}> {
  if (stryMutAct_9fa48("4107")) {
    {}
  } else {
    stryCov_9fa48("4107");
    const {
      data: latest,
      error: latestError
    } = await supabase.from(stryMutAct_9fa48("4108") ? "" : (stryCov_9fa48("4108"), "event_safety_reviews")).select(stryMutAct_9fa48("4109") ? "" : (stryCov_9fa48("4109"), "id, outcome, reason, general_note, created_at, officer:officer_id(name)")).eq(stryMutAct_9fa48("4110") ? "" : (stryCov_9fa48("4110"), "event_id"), eventId).order(stryMutAct_9fa48("4111") ? "" : (stryCov_9fa48("4111"), "created_at"), stryMutAct_9fa48("4112") ? {} : (stryCov_9fa48("4112"), {
      ascending: stryMutAct_9fa48("4113") ? true : (stryCov_9fa48("4113"), false)
    })).limit(1).maybeSingle();
    if (stryMutAct_9fa48("4115") ? false : stryMutAct_9fa48("4114") ? true : (stryCov_9fa48("4114", "4115"), latestError)) return stryMutAct_9fa48("4116") ? {} : (stryCov_9fa48("4116"), {
      status: stryMutAct_9fa48("4117") ? "" : (stryCov_9fa48("4117"), "error")
    });
    if (stryMutAct_9fa48("4120") ? !latest && latest.outcome !== "Changes Requested" : stryMutAct_9fa48("4119") ? false : stryMutAct_9fa48("4118") ? true : (stryCov_9fa48("4118", "4119", "4120"), (stryMutAct_9fa48("4121") ? latest : (stryCov_9fa48("4121"), !latest)) || (stryMutAct_9fa48("4123") ? latest.outcome === "Changes Requested" : stryMutAct_9fa48("4122") ? false : (stryCov_9fa48("4122", "4123"), latest.outcome !== (stryMutAct_9fa48("4124") ? "" : (stryCov_9fa48("4124"), "Changes Requested")))))) return stryMutAct_9fa48("4125") ? {} : (stryCov_9fa48("4125"), {
      status: stryMutAct_9fa48("4126") ? "" : (stryCov_9fa48("4126"), "ok"),
      value: null
    });
    const {
      data: flagRows,
      error: flagsError
    } = await supabase.from(stryMutAct_9fa48("4127") ? "" : (stryCov_9fa48("4127"), "event_safety_review_flags")).select(stryMutAct_9fa48("4128") ? "" : (stryCov_9fa48("4128"), "id, arrangement_type, arrangement_id, label, note, snapshot, cleared_at")).eq(stryMutAct_9fa48("4129") ? "" : (stryCov_9fa48("4129"), "review_id"), latest.id).order(stryMutAct_9fa48("4130") ? "" : (stryCov_9fa48("4130"), "id"));
    if (stryMutAct_9fa48("4132") ? false : stryMutAct_9fa48("4131") ? true : (stryCov_9fa48("4131", "4132"), flagsError)) return stryMutAct_9fa48("4133") ? {} : (stryCov_9fa48("4133"), {
      status: stryMutAct_9fa48("4134") ? "" : (stryCov_9fa48("4134"), "error")
    });
    const flags = (flagRows ?? []) as (StoredFlag & {
      id: number;
      label: string;
      note: string;
      cleared_at: string | null;
    })[];
    const [bookings, equipment] = await Promise.all(stryMutAct_9fa48("4135") ? [] : (stryCov_9fa48("4135"), [fetchEventVenueBookings(eventId, authorization), fetchEventEquipmentRequests(eventId, authorization)]));
    const arrangementsChecked = stryMutAct_9fa48("4138") ? bookings.status === "ok" || equipment.status === "ok" : stryMutAct_9fa48("4137") ? false : stryMutAct_9fa48("4136") ? true : (stryCov_9fa48("4136", "4137", "4138"), (stryMutAct_9fa48("4140") ? bookings.status !== "ok" : stryMutAct_9fa48("4139") ? true : (stryCov_9fa48("4139", "4140"), bookings.status === (stryMutAct_9fa48("4141") ? "" : (stryCov_9fa48("4141"), "ok")))) && (stryMutAct_9fa48("4143") ? equipment.status !== "ok" : stryMutAct_9fa48("4142") ? true : (stryCov_9fa48("4142", "4143"), equipment.status === (stryMutAct_9fa48("4144") ? "" : (stryCov_9fa48("4144"), "ok")))));
    if (stryMutAct_9fa48("4147") ? bookings.status === "ok" || equipment.status === "ok" : stryMutAct_9fa48("4146") ? false : stryMutAct_9fa48("4145") ? true : (stryCov_9fa48("4145", "4146", "4147"), (stryMutAct_9fa48("4149") ? bookings.status !== "ok" : stryMutAct_9fa48("4148") ? true : (stryCov_9fa48("4148", "4149"), bookings.status === (stryMutAct_9fa48("4150") ? "" : (stryCov_9fa48("4150"), "ok")))) && (stryMutAct_9fa48("4152") ? equipment.status !== "ok" : stryMutAct_9fa48("4151") ? true : (stryCov_9fa48("4151", "4152"), equipment.status === (stryMutAct_9fa48("4153") ? "" : (stryCov_9fa48("4153"), "ok")))))) {
      if (stryMutAct_9fa48("4154")) {
        {}
      } else {
        stryCov_9fa48("4154");
        const states = currentArrangements(bookings.value, equipment.value);
        const changed = stryMutAct_9fa48("4155") ? flags : (stryCov_9fa48("4155"), flags.filter(stryMutAct_9fa48("4156") ? () => undefined : (stryCov_9fa48("4156"), flag => stryMutAct_9fa48("4159") ? !flag.cleared_at || hasChanged(flag, states) : stryMutAct_9fa48("4158") ? false : stryMutAct_9fa48("4157") ? true : (stryCov_9fa48("4157", "4158", "4159"), (stryMutAct_9fa48("4160") ? flag.cleared_at : (stryCov_9fa48("4160"), !flag.cleared_at)) && hasChanged(flag, states)))));
        if (stryMutAct_9fa48("4164") ? changed.length <= 0 : stryMutAct_9fa48("4163") ? changed.length >= 0 : stryMutAct_9fa48("4162") ? false : stryMutAct_9fa48("4161") ? true : (stryCov_9fa48("4161", "4162", "4163", "4164"), changed.length > 0)) {
          if (stryMutAct_9fa48("4165")) {
            {}
          } else {
            stryCov_9fa48("4165");
            const clearedAt = clock.now().toISOString();
            const {
              error: clearError
            } = await supabase.from(stryMutAct_9fa48("4166") ? "" : (stryCov_9fa48("4166"), "event_safety_review_flags")).update(stryMutAct_9fa48("4167") ? {} : (stryCov_9fa48("4167"), {
              cleared_at: clearedAt
            })).in(stryMutAct_9fa48("4168") ? "" : (stryCov_9fa48("4168"), "id"), changed.map(stryMutAct_9fa48("4169") ? () => undefined : (stryCov_9fa48("4169"), flag => flag.id))).is(stryMutAct_9fa48("4170") ? "" : (stryCov_9fa48("4170"), "cleared_at"), null);
            // A failed write only means the flags show as open until the next look.
            if (stryMutAct_9fa48("4173") ? false : stryMutAct_9fa48("4172") ? true : stryMutAct_9fa48("4171") ? clearError : (stryCov_9fa48("4171", "4172", "4173"), !clearError)) for (const flag of changed) flag.cleared_at = clearedAt;
          }
        }
      }
    }
    const officer = latest.officer as {
      name?: string;
    } | {
      name?: string;
    }[] | null;
    return stryMutAct_9fa48("4174") ? {} : (stryCov_9fa48("4174"), {
      status: stryMutAct_9fa48("4175") ? "" : (stryCov_9fa48("4175"), "ok"),
      value: stryMutAct_9fa48("4176") ? {} : (stryCov_9fa48("4176"), {
        reviewId: latest.id,
        officerName: stryMutAct_9fa48("4177") ? (Array.isArray(officer) ? officer[0]?.name : officer?.name) && null : (stryCov_9fa48("4177"), (Array.isArray(officer) ? stryMutAct_9fa48("4178") ? officer[0].name : (stryCov_9fa48("4178"), officer[0]?.name) : stryMutAct_9fa48("4179") ? officer.name : (stryCov_9fa48("4179"), officer?.name)) ?? null),
        requestedAt: latest.created_at,
        reason: stryMutAct_9fa48("4180") ? latest.reason && "" : (stryCov_9fa48("4180"), latest.reason ?? (stryMutAct_9fa48("4181") ? "Stryker was here!" : (stryCov_9fa48("4181"), ""))),
        generalNote: stryMutAct_9fa48("4182") ? latest.general_note && null : (stryCov_9fa48("4182"), latest.general_note ?? null),
        flags: flags.map(stryMutAct_9fa48("4183") ? () => undefined : (stryCov_9fa48("4183"), flag => stryMutAct_9fa48("4184") ? {} : (stryCov_9fa48("4184"), {
          type: flag.arrangement_type,
          id: Number(flag.arrangement_id),
          label: flag.label,
          note: flag.note,
          clearedAt: flag.cleared_at
        }))),
        arrangementsChecked
      })
    });
  }
}

/**
 * E3-14 AC3: the coordinator sees the flagged arrangements and the Safety
 * Officer's notes when they open the event; the Safety Officer and the
 * Coordinator Lead may read it too. `changeRequest` is null when there's
 * no open change request.
 */
if (stryMutAct_9fa48("4185")) {
  ;
} else {
  stryCov_9fa48("4185");
  eventsRouter.get(stryMutAct_9fa48("4186") ? "" : (stryCov_9fa48("4186"), "/:id/safety-changes"), async (req: AuthedRequest, res) => {
    if (stryMutAct_9fa48("4187")) {
      {}
    } else {
      stryCov_9fa48("4187");
      const {
        supabase,
        user
      } = req;
      if (stryMutAct_9fa48("4190") ? !supabase && !user : stryMutAct_9fa48("4189") ? false : stryMutAct_9fa48("4188") ? true : (stryCov_9fa48("4188", "4189", "4190"), (stryMutAct_9fa48("4191") ? supabase : (stryCov_9fa48("4191"), !supabase)) || (stryMutAct_9fa48("4192") ? user : (stryCov_9fa48("4192"), !user)))) {
        if (stryMutAct_9fa48("4193")) {
          {}
        } else {
          stryCov_9fa48("4193");
          res.status(401).json(stryMutAct_9fa48("4195") ? {} : (stryCov_9fa48("4195"), {
            error: stryMutAct_9fa48("4196") ? "" : (stryCov_9fa48("4196"), "Unauthenticated")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("4199") ? false : stryMutAct_9fa48("4198") ? true : stryMutAct_9fa48("4197") ? ["coordinator", COORDINATOR_LEAD_ROLE, "safety_officer"].includes(user.role) : (stryCov_9fa48("4197", "4198", "4199"), !(stryMutAct_9fa48("4200") ? [] : (stryCov_9fa48("4200"), [stryMutAct_9fa48("4201") ? "" : (stryCov_9fa48("4201"), "coordinator"), COORDINATOR_LEAD_ROLE, stryMutAct_9fa48("4202") ? "" : (stryCov_9fa48("4202"), "safety_officer")])).includes(user.role))) {
        if (stryMutAct_9fa48("4203")) {
          {}
        } else {
          stryCov_9fa48("4203");
          res.status(403).json(stryMutAct_9fa48("4205") ? {} : (stryCov_9fa48("4205"), {
            error: stryMutAct_9fa48("4206") ? "" : (stryCov_9fa48("4206"), "Access denied")
          }));
          return;
        }
      }
      const eventId = routeParam(req.params.id);
      if (stryMutAct_9fa48("4209") ? false : stryMutAct_9fa48("4208") ? true : stryMutAct_9fa48("4207") ? isPositiveInteger(eventId) : (stryCov_9fa48("4207", "4208", "4209"), !isPositiveInteger(eventId))) {
        if (stryMutAct_9fa48("4210")) {
          {}
        } else {
          stryCov_9fa48("4210");
          res.status(404).json(stryMutAct_9fa48("4212") ? {} : (stryCov_9fa48("4212"), {
            error: stryMutAct_9fa48("4213") ? "" : (stryCov_9fa48("4213"), "Event not found")
          }));
          return;
        }
      }
      const {
        data: event,
        error
      } = await supabase.from(stryMutAct_9fa48("4214") ? "" : (stryCov_9fa48("4214"), "events")).select(stryMutAct_9fa48("4215") ? "" : (stryCov_9fa48("4215"), "id")).eq(stryMutAct_9fa48("4216") ? "" : (stryCov_9fa48("4216"), "id"), Number(eventId)).maybeSingle();
      if (stryMutAct_9fa48("4218") ? false : stryMutAct_9fa48("4217") ? true : (stryCov_9fa48("4217", "4218"), error)) {
        if (stryMutAct_9fa48("4219")) {
          {}
        } else {
          stryCov_9fa48("4219");
          res.status(500).json(stryMutAct_9fa48("4221") ? {} : (stryCov_9fa48("4221"), {
            error: stryMutAct_9fa48("4222") ? "" : (stryCov_9fa48("4222"), "Failed to load event")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("4225") ? false : stryMutAct_9fa48("4224") ? true : stryMutAct_9fa48("4223") ? event : (stryCov_9fa48("4223", "4224", "4225"), !event)) {
        if (stryMutAct_9fa48("4226")) {
          {}
        } else {
          stryCov_9fa48("4226");
          res.status(404).json(stryMutAct_9fa48("4228") ? {} : (stryCov_9fa48("4228"), {
            error: stryMutAct_9fa48("4229") ? "" : (stryCov_9fa48("4229"), "Event not found")
          }));
          return;
        }
      }
      const result = await loadChangeRequest(supabase, event.id, req.headers.authorization!);
      if (stryMutAct_9fa48("4232") ? result.status !== "error" : stryMutAct_9fa48("4231") ? false : stryMutAct_9fa48("4230") ? true : (stryCov_9fa48("4230", "4231", "4232"), result.status === (stryMutAct_9fa48("4233") ? "" : (stryCov_9fa48("4233"), "error")))) {
        if (stryMutAct_9fa48("4234")) {
          {}
        } else {
          stryCov_9fa48("4234");
          res.status(500).json(stryMutAct_9fa48("4236") ? {} : (stryCov_9fa48("4236"), {
            error: stryMutAct_9fa48("4237") ? "" : (stryCov_9fa48("4237"), "Failed to load the requested safety changes")
          }));
          return;
        }
      }
      res.json(stryMutAct_9fa48("4239") ? {} : (stryCov_9fa48("4239"), {
        changeRequest: result.value
      }));
    }
  });
}
/**
 * Statuses a coordinator can request clarification from: "Requested",
 * plus "Planning" — a coordinator may realise they need more information
 * after already approving an event. Either way the event's current status
 * is captured into status_before_clarification so the organiser's
 * response (PATCH /:id) knows whether to restore it to "Requested" or back
 * to "Planning".
 */
const CLARIFICATION_REQUESTABLE_STATUSES = new Set<string>(stryMutAct_9fa48("4240") ? [] : (stryCov_9fa48("4240"), [...COORDINATOR_REVIEW_STATUSES, EVENT_STATUS.Planning]));

/**
 * Request clarification/amendment from the Organiser — from a
 * pending-review status, or from "Planning" for a post-approval follow-up
 * question. Resolving an outstanding request (Organiser amends and
 * resubmits) is not built yet; until it is, this is a one-way transition
 * that leaves approval blocked (AC1's "no outstanding clarification").
 */
if (stryMutAct_9fa48("4241")) {
  ;
} else {
  stryCov_9fa48("4241");
  eventsRouter.post(stryMutAct_9fa48("4242") ? "" : (stryCov_9fa48("4242"), "/:id/request-clarification"), async (req: AuthedRequest, res) => {
    if (stryMutAct_9fa48("4243")) {
      {}
    } else {
      stryCov_9fa48("4243");
      const eventId = routeParam(req.params.id);
      const event = await authorizeCoordinatorReview(req, res, eventId);
      if (stryMutAct_9fa48("4246") ? false : stryMutAct_9fa48("4245") ? true : stryMutAct_9fa48("4244") ? event : (stryCov_9fa48("4244", "4245", "4246"), !event)) return;
      if (stryMutAct_9fa48("4249") ? false : stryMutAct_9fa48("4248") ? true : stryMutAct_9fa48("4247") ? CLARIFICATION_REQUESTABLE_STATUSES.has(event.status) : (stryCov_9fa48("4247", "4248", "4249"), !CLARIFICATION_REQUESTABLE_STATUSES.has(event.status))) {
        if (stryMutAct_9fa48("4250")) {
          {}
        } else {
          stryCov_9fa48("4250");
          res.status(409).json(stryMutAct_9fa48("4252") ? {} : (stryCov_9fa48("4252"), {
            error: stryMutAct_9fa48("4253") ? "" : (stryCov_9fa48("4253"), "Clarification can only be requested while this request is pending review")
          }));
          return;
        }
      }
      const message = (stryMutAct_9fa48("4256") ? typeof req.body?.message !== "string" : stryMutAct_9fa48("4255") ? false : stryMutAct_9fa48("4254") ? true : (stryCov_9fa48("4254", "4255", "4256"), typeof (stryMutAct_9fa48("4257") ? req.body.message : (stryCov_9fa48("4257"), req.body?.message)) === (stryMutAct_9fa48("4258") ? "" : (stryCov_9fa48("4258"), "string")))) ? stryMutAct_9fa48("4259") ? req.body.message : (stryCov_9fa48("4259"), req.body.message.trim()) : stryMutAct_9fa48("4260") ? "Stryker was here!" : (stryCov_9fa48("4260"), "");
      if (stryMutAct_9fa48("4263") ? false : stryMutAct_9fa48("4262") ? true : stryMutAct_9fa48("4261") ? message : (stryCov_9fa48("4261", "4262", "4263"), !message)) {
        if (stryMutAct_9fa48("4264")) {
          {}
        } else {
          stryCov_9fa48("4264");
          res.status(400).json(stryMutAct_9fa48("4266") ? {} : (stryCov_9fa48("4266"), {
            error: stryMutAct_9fa48("4267") ? "" : (stryCov_9fa48("4267"), "A message is required to request clarification")
          }));
          return;
        }
      }
      const {
        supabase,
        user
      } = req as Required<Pick<AuthedRequest, "supabase" | "user">>;
      const {
        data,
        error
      } = await supabase.from(stryMutAct_9fa48("4268") ? "" : (stryCov_9fa48("4268"), "events")).update(stryMutAct_9fa48("4269") ? {} : (stryCov_9fa48("4269"), {
        status: stryMutAct_9fa48("4270") ? "" : (stryCov_9fa48("4270"), "Clarification Requested"),
        status_before_clarification: event.status,
        review_outcome: message,
        decided_at: clock.now().toISOString(),
        decided_by: user.id
      })).eq(stryMutAct_9fa48("4271") ? "" : (stryCov_9fa48("4271"), "id"), event.id).select(EVENT_COLUMNS).single();
      if (stryMutAct_9fa48("4273") ? false : stryMutAct_9fa48("4272") ? true : (stryCov_9fa48("4272", "4273"), error)) {
        if (stryMutAct_9fa48("4274")) {
          {}
        } else {
          stryCov_9fa48("4274");
          res.status(500).json(stryMutAct_9fa48("4276") ? {} : (stryCov_9fa48("4276"), {
            error: stryMutAct_9fa48("4277") ? "" : (stryCov_9fa48("4277"), "Failed to request clarification")
          }));
          return;
        }
      }

      // Seeds the thread the clarification popup renders (AC3) with this
      // first question. Best-effort: the status transition above is the part
      // that actually gates approval, so a failure here is logged, not fatal.
      const {
        error: threadError
      } = await supabase.from(stryMutAct_9fa48("4278") ? "" : (stryCov_9fa48("4278"), "event_clarifications")).insert(stryMutAct_9fa48("4279") ? {} : (stryCov_9fa48("4279"), {
        event_id: event.id,
        author_id: user.id,
        author_role: stryMutAct_9fa48("4280") ? "" : (stryCov_9fa48("4280"), "coordinator"),
        message
      }));
      if (stryMutAct_9fa48("4282") ? false : stryMutAct_9fa48("4281") ? true : (stryCov_9fa48("4281", "4282"), threadError)) {
        if (stryMutAct_9fa48("4283")) {
          {}
        } else {
          stryCov_9fa48("4283");
          console.error(stryMutAct_9fa48("4285") ? "" : (stryCov_9fa48("4285"), "Failed to record clarification thread entry"), stryMutAct_9fa48("4286") ? {} : (stryCov_9fa48("4286"), {
            eventId: event.id,
            error: threadError
          }));
        }
      }

      // #104 row 5: the organiser is the only recipient — there's always one,
      // since only an organiser can submit a request in the first place.
      if (stryMutAct_9fa48("4288") ? false : stryMutAct_9fa48("4287") ? true : (stryCov_9fa48("4287", "4288"), event.organiser_id)) {
        if (stryMutAct_9fa48("4289")) {
          {}
        } else {
          stryCov_9fa48("4289");
          await getPublisher().publish(stryMutAct_9fa48("4290") ? {} : (stryCov_9fa48("4290"), {
            type: stryMutAct_9fa48("4291") ? "" : (stryCov_9fa48("4291"), "clarification.requested"),
            eventId: event.id,
            actorId: user.id,
            recipients: stryMutAct_9fa48("4292") ? {} : (stryCov_9fa48("4292"), {
              userIds: stryMutAct_9fa48("4293") ? [] : (stryCov_9fa48("4293"), [event.organiser_id]),
              roles: stryMutAct_9fa48("4294") ? ["Stryker was here"] : (stryCov_9fa48("4294"), [])
            }),
            data: stryMutAct_9fa48("4295") ? {} : (stryCov_9fa48("4295"), {
              eventName: eventDisplayName(data as unknown as AssignmentEventRow),
              message
            })
          }));
        }
      }
      res.json(stryMutAct_9fa48("4297") ? {} : (stryCov_9fa48("4297"), {
        event: data
      }));
    }
  });
}
interface ClarificationRow {
  id: number;
  parent_id: number | null;
  author_id: string;
  author_role: string;
  message: string;
  resolved: boolean;
  created_at: string;
}
const CLARIFICATION_COLUMNS = stryMutAct_9fa48("4298") ? "" : (stryCov_9fa48("4298"), "id, parent_id, author_id, author_role, message, resolved, created_at");

/**
 * Shared visibility check for the clarification thread and history routes:
 * same rule as GET /:id (owning organiser, any coordinator, or the Event
 * Coordinator Lead for a submitted event — E2-12 AC2 has the Lead read a
 * reassignment back from the history), but returns the fields those routes
 * need (organiser_id/coordinator_id/status) rather than the full event
 * payload. Write routes apply their own, narrower check on top.
 */
async function loadEventForClarification(req: AuthedRequest, res: Response, eventId: string): Promise<{
  id: number;
  status: string;
  organiser_id: string;
  coordinator_id: string | null;
} | null> {
  if (stryMutAct_9fa48("4299")) {
    {}
  } else {
    stryCov_9fa48("4299");
    const {
      supabase,
      user
    } = req;
    if (stryMutAct_9fa48("4302") ? !supabase && !user : stryMutAct_9fa48("4301") ? false : stryMutAct_9fa48("4300") ? true : (stryCov_9fa48("4300", "4301", "4302"), (stryMutAct_9fa48("4303") ? supabase : (stryCov_9fa48("4303"), !supabase)) || (stryMutAct_9fa48("4304") ? user : (stryCov_9fa48("4304"), !user)))) {
      if (stryMutAct_9fa48("4305")) {
        {}
      } else {
        stryCov_9fa48("4305");
        res.status(401).json(stryMutAct_9fa48("4307") ? {} : (stryCov_9fa48("4307"), {
          error: stryMutAct_9fa48("4308") ? "" : (stryCov_9fa48("4308"), "Unauthenticated")
        }));
        return null;
      }
    }
    if (stryMutAct_9fa48("4311") ? false : stryMutAct_9fa48("4310") ? true : stryMutAct_9fa48("4309") ? isPositiveInteger(eventId) : (stryCov_9fa48("4309", "4310", "4311"), !isPositiveInteger(eventId))) {
      if (stryMutAct_9fa48("4312")) {
        {}
      } else {
        stryCov_9fa48("4312");
        res.status(404).json(stryMutAct_9fa48("4314") ? {} : (stryCov_9fa48("4314"), {
          error: stryMutAct_9fa48("4315") ? "" : (stryCov_9fa48("4315"), "Event not found")
        }));
        return null;
      }
    }
    const {
      data,
      error
    } = await supabase.from(stryMutAct_9fa48("4316") ? "" : (stryCov_9fa48("4316"), "events")).select(stryMutAct_9fa48("4317") ? "" : (stryCov_9fa48("4317"), "id, status, organiser_id, coordinator_id")).eq(stryMutAct_9fa48("4318") ? "" : (stryCov_9fa48("4318"), "id"), Number(eventId)).maybeSingle();
    if (stryMutAct_9fa48("4320") ? false : stryMutAct_9fa48("4319") ? true : (stryCov_9fa48("4319", "4320"), error)) {
      if (stryMutAct_9fa48("4321")) {
        {}
      } else {
        stryCov_9fa48("4321");
        res.status(500).json(stryMutAct_9fa48("4323") ? {} : (stryCov_9fa48("4323"), {
          error: stryMutAct_9fa48("4324") ? "" : (stryCov_9fa48("4324"), "Failed to load event")
        }));
        return null;
      }
    }
    const isOwner = stryMutAct_9fa48("4327") ? data?.organiser_id !== user.id : stryMutAct_9fa48("4326") ? false : stryMutAct_9fa48("4325") ? true : (stryCov_9fa48("4325", "4326", "4327"), (stryMutAct_9fa48("4328") ? data.organiser_id : (stryCov_9fa48("4328"), data?.organiser_id)) === user.id);
    // Drafts sit outside the process (AGENTS.md §3): only their organiser sees them.
    const isCoordinator = stryMutAct_9fa48("4331") ? user.role === "coordinator" || data?.status !== EVENT_STATUS.Draft : stryMutAct_9fa48("4330") ? false : stryMutAct_9fa48("4329") ? true : (stryCov_9fa48("4329", "4330", "4331"), (stryMutAct_9fa48("4333") ? user.role !== "coordinator" : stryMutAct_9fa48("4332") ? true : (stryCov_9fa48("4332", "4333"), user.role === (stryMutAct_9fa48("4334") ? "" : (stryCov_9fa48("4334"), "coordinator")))) && (stryMutAct_9fa48("4336") ? data?.status === EVENT_STATUS.Draft : stryMutAct_9fa48("4335") ? true : (stryCov_9fa48("4335", "4336"), (stryMutAct_9fa48("4337") ? data.status : (stryCov_9fa48("4337"), data?.status)) !== EVENT_STATUS.Draft)));
    const isLead = stryMutAct_9fa48("4340") ? user.role === COORDINATOR_LEAD_ROLE || data?.status !== EVENT_STATUS.Draft : stryMutAct_9fa48("4339") ? false : stryMutAct_9fa48("4338") ? true : (stryCov_9fa48("4338", "4339", "4340"), (stryMutAct_9fa48("4342") ? user.role !== COORDINATOR_LEAD_ROLE : stryMutAct_9fa48("4341") ? true : (stryCov_9fa48("4341", "4342"), user.role === COORDINATOR_LEAD_ROLE)) && (stryMutAct_9fa48("4344") ? data?.status === EVENT_STATUS.Draft : stryMutAct_9fa48("4343") ? true : (stryCov_9fa48("4343", "4344"), (stryMutAct_9fa48("4345") ? data.status : (stryCov_9fa48("4345"), data?.status)) !== EVENT_STATUS.Draft)));
    if (stryMutAct_9fa48("4348") ? !data && !isOwner && !isCoordinator && !isLead : stryMutAct_9fa48("4347") ? false : stryMutAct_9fa48("4346") ? true : (stryCov_9fa48("4346", "4347", "4348"), (stryMutAct_9fa48("4349") ? data : (stryCov_9fa48("4349"), !data)) || (stryMutAct_9fa48("4351") ? !isOwner && !isCoordinator || !isLead : stryMutAct_9fa48("4350") ? false : (stryCov_9fa48("4350", "4351"), (stryMutAct_9fa48("4353") ? !isOwner || !isCoordinator : stryMutAct_9fa48("4352") ? true : (stryCov_9fa48("4352", "4353"), (stryMutAct_9fa48("4354") ? isOwner : (stryCov_9fa48("4354"), !isOwner)) && (stryMutAct_9fa48("4355") ? isCoordinator : (stryCov_9fa48("4355"), !isCoordinator)))) && (stryMutAct_9fa48("4356") ? isLead : (stryCov_9fa48("4356"), !isLead)))))) {
      if (stryMutAct_9fa48("4357")) {
        {}
      } else {
        stryCov_9fa48("4357");
        await recordAccessDenial(supabase, user.id, eventId, stryMutAct_9fa48("4358") ? "" : (stryCov_9fa48("4358"), "not_found_or_not_owner"));
        res.status(403).json(stryMutAct_9fa48("4360") ? {} : (stryCov_9fa48("4360"), {
          error: stryMutAct_9fa48("4361") ? "" : (stryCov_9fa48("4361"), "Access denied")
        }));
        return null;
      }
    }
    return data;
  }
}

/** AC3: the full exchange, chronological, for anyone with access to the event. */
if (stryMutAct_9fa48("4362")) {
  ;
} else {
  stryCov_9fa48("4362");
  eventsRouter.get(stryMutAct_9fa48("4363") ? "" : (stryCov_9fa48("4363"), "/:id/clarifications"), async (req: AuthedRequest, res) => {
    if (stryMutAct_9fa48("4364")) {
      {}
    } else {
      stryCov_9fa48("4364");
      const eventId = routeParam(req.params.id);
      const event = await loadEventForClarification(req, res, eventId);
      if (stryMutAct_9fa48("4367") ? false : stryMutAct_9fa48("4366") ? true : stryMutAct_9fa48("4365") ? event : (stryCov_9fa48("4365", "4366", "4367"), !event)) return;
      const {
        supabase
      } = req as Required<Pick<AuthedRequest, "supabase">>;
      const {
        data,
        error
      } = await supabase.from(stryMutAct_9fa48("4368") ? "" : (stryCov_9fa48("4368"), "event_clarifications")).select(CLARIFICATION_COLUMNS).eq(stryMutAct_9fa48("4369") ? "" : (stryCov_9fa48("4369"), "event_id"), event.id).order(stryMutAct_9fa48("4370") ? "" : (stryCov_9fa48("4370"), "created_at"), stryMutAct_9fa48("4371") ? {} : (stryCov_9fa48("4371"), {
        ascending: stryMutAct_9fa48("4372") ? false : (stryCov_9fa48("4372"), true)
      }));
      if (stryMutAct_9fa48("4374") ? false : stryMutAct_9fa48("4373") ? true : (stryCov_9fa48("4373", "4374"), error)) {
        if (stryMutAct_9fa48("4375")) {
          {}
        } else {
          stryCov_9fa48("4375");
          res.status(500).json(stryMutAct_9fa48("4377") ? {} : (stryCov_9fa48("4377"), {
            error: stryMutAct_9fa48("4378") ? "" : (stryCov_9fa48("4378"), "Failed to load clarifications")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("4379")) {
        ;
      } else {
        stryCov_9fa48("4379");
        res.json(stryMutAct_9fa48("4380") ? {} : (stryCov_9fa48("4380"), {
          clarifications: (data ?? []) as ClarificationRow[]
        }));
      }
    }
  });
}
/**
 * Coordinator asks a follow-up question. The main "Request Clarification/
 * Amendment" action (POST /:id/request-clarification) makes the *first*
 * ask and flips the status; once outstanding, that button disables (AC2),
 * so this — the popup's "+" — is how the assigned coordinator keeps
 * asking without a way to re-open a request that's already flagged.
 */
if (stryMutAct_9fa48("4381")) {
  ;
} else {
  stryCov_9fa48("4381");
  eventsRouter.post(stryMutAct_9fa48("4382") ? "" : (stryCov_9fa48("4382"), "/:id/clarifications"), async (req: AuthedRequest, res) => {
    if (stryMutAct_9fa48("4383")) {
      {}
    } else {
      stryCov_9fa48("4383");
      const eventId = routeParam(req.params.id);
      const event = await authorizeCoordinatorReview(req, res, eventId);
      if (stryMutAct_9fa48("4386") ? false : stryMutAct_9fa48("4385") ? true : stryMutAct_9fa48("4384") ? event : (stryCov_9fa48("4384", "4385", "4386"), !event)) return;
      if (stryMutAct_9fa48("4389") ? event.status === "Clarification Requested" : stryMutAct_9fa48("4388") ? false : stryMutAct_9fa48("4387") ? true : (stryCov_9fa48("4387", "4388", "4389"), event.status !== (stryMutAct_9fa48("4390") ? "" : (stryCov_9fa48("4390"), "Clarification Requested")))) {
        if (stryMutAct_9fa48("4391")) {
          {}
        } else {
          stryCov_9fa48("4391");
          res.status(409).json(stryMutAct_9fa48("4393") ? {} : (stryCov_9fa48("4393"), {
            error: stryMutAct_9fa48("4394") ? "" : (stryCov_9fa48("4394"), "Additional questions can only be added while clarification is outstanding")
          }));
          return;
        }
      }
      const message = (stryMutAct_9fa48("4397") ? typeof req.body?.message !== "string" : stryMutAct_9fa48("4396") ? false : stryMutAct_9fa48("4395") ? true : (stryCov_9fa48("4395", "4396", "4397"), typeof (stryMutAct_9fa48("4398") ? req.body.message : (stryCov_9fa48("4398"), req.body?.message)) === (stryMutAct_9fa48("4399") ? "" : (stryCov_9fa48("4399"), "string")))) ? stryMutAct_9fa48("4400") ? req.body.message : (stryCov_9fa48("4400"), req.body.message.trim()) : stryMutAct_9fa48("4401") ? "Stryker was here!" : (stryCov_9fa48("4401"), "");
      if (stryMutAct_9fa48("4404") ? false : stryMutAct_9fa48("4403") ? true : stryMutAct_9fa48("4402") ? message : (stryCov_9fa48("4402", "4403", "4404"), !message)) {
        if (stryMutAct_9fa48("4405")) {
          {}
        } else {
          stryCov_9fa48("4405");
          res.status(400).json(stryMutAct_9fa48("4407") ? {} : (stryCov_9fa48("4407"), {
            error: stryMutAct_9fa48("4408") ? "" : (stryCov_9fa48("4408"), "A question is required")
          }));
          return;
        }
      }
      const {
        supabase,
        user
      } = req as Required<Pick<AuthedRequest, "supabase" | "user">>;
      const {
        data,
        error
      } = await supabase.from(stryMutAct_9fa48("4409") ? "" : (stryCov_9fa48("4409"), "event_clarifications")).insert(stryMutAct_9fa48("4410") ? {} : (stryCov_9fa48("4410"), {
        event_id: event.id,
        author_id: user.id,
        author_role: stryMutAct_9fa48("4411") ? "" : (stryCov_9fa48("4411"), "coordinator"),
        message
      })).select(CLARIFICATION_COLUMNS).single();
      if (stryMutAct_9fa48("4413") ? false : stryMutAct_9fa48("4412") ? true : (stryCov_9fa48("4412", "4413"), error)) {
        if (stryMutAct_9fa48("4414")) {
          {}
        } else {
          stryCov_9fa48("4414");
          res.status(500).json(stryMutAct_9fa48("4416") ? {} : (stryCov_9fa48("4416"), {
            error: stryMutAct_9fa48("4417") ? "" : (stryCov_9fa48("4417"), "Failed to add question")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("4418")) {
        ;
      } else {
        stryCov_9fa48("4418");
        res.status(201).json(stryMutAct_9fa48("4419") ? {} : (stryCov_9fa48("4419"), {
          clarification: data as ClarificationRow
        }));
      }
    }
  });
}
/** Either party replies within a question's thread. */
if (stryMutAct_9fa48("4420")) {
  ;
} else {
  stryCov_9fa48("4420");
  eventsRouter.post(stryMutAct_9fa48("4421") ? "" : (stryCov_9fa48("4421"), "/:id/clarifications/:questionId/replies"), async (req: AuthedRequest, res) => {
    if (stryMutAct_9fa48("4422")) {
      {}
    } else {
      stryCov_9fa48("4422");
      const eventId = routeParam(req.params.id);
      const event = await loadEventForClarification(req, res, eventId);
      if (stryMutAct_9fa48("4425") ? false : stryMutAct_9fa48("4424") ? true : stryMutAct_9fa48("4423") ? event : (stryCov_9fa48("4423", "4424", "4425"), !event)) return;
      const {
        user,
        supabase
      } = req as Required<Pick<AuthedRequest, "supabase" | "user">>;
      const isOwner = stryMutAct_9fa48("4428") ? event.organiser_id !== user.id : stryMutAct_9fa48("4427") ? false : stryMutAct_9fa48("4426") ? true : (stryCov_9fa48("4426", "4427", "4428"), event.organiser_id === user.id);
      const isAssignedCoordinator = stryMutAct_9fa48("4431") ? user.role === "coordinator" || event.coordinator_id === user.id : stryMutAct_9fa48("4430") ? false : stryMutAct_9fa48("4429") ? true : (stryCov_9fa48("4429", "4430", "4431"), (stryMutAct_9fa48("4433") ? user.role !== "coordinator" : stryMutAct_9fa48("4432") ? true : (stryCov_9fa48("4432", "4433"), user.role === (stryMutAct_9fa48("4434") ? "" : (stryCov_9fa48("4434"), "coordinator")))) && (stryMutAct_9fa48("4436") ? event.coordinator_id !== user.id : stryMutAct_9fa48("4435") ? true : (stryCov_9fa48("4435", "4436"), event.coordinator_id === user.id)));
      if (stryMutAct_9fa48("4439") ? !isOwner || !isAssignedCoordinator : stryMutAct_9fa48("4438") ? false : stryMutAct_9fa48("4437") ? true : (stryCov_9fa48("4437", "4438", "4439"), (stryMutAct_9fa48("4440") ? isOwner : (stryCov_9fa48("4440"), !isOwner)) && (stryMutAct_9fa48("4441") ? isAssignedCoordinator : (stryCov_9fa48("4441"), !isAssignedCoordinator)))) {
        if (stryMutAct_9fa48("4442")) {
          {}
        } else {
          stryCov_9fa48("4442");
          res.status(403).json(stryMutAct_9fa48("4444") ? {} : (stryCov_9fa48("4444"), {
            error: stryMutAct_9fa48("4445") ? "" : (stryCov_9fa48("4445"), "Access denied")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("4448") ? event.status === "Clarification Requested" : stryMutAct_9fa48("4447") ? false : stryMutAct_9fa48("4446") ? true : (stryCov_9fa48("4446", "4447", "4448"), event.status !== (stryMutAct_9fa48("4449") ? "" : (stryCov_9fa48("4449"), "Clarification Requested")))) {
        if (stryMutAct_9fa48("4450")) {
          {}
        } else {
          stryCov_9fa48("4450");
          res.status(409).json(stryMutAct_9fa48("4452") ? {} : (stryCov_9fa48("4452"), {
            error: stryMutAct_9fa48("4453") ? "" : (stryCov_9fa48("4453"), "This clarification is no longer open for replies")
          }));
          return;
        }
      }
      const questionId = routeParam(req.params.questionId);
      if (stryMutAct_9fa48("4456") ? false : stryMutAct_9fa48("4455") ? true : stryMutAct_9fa48("4454") ? isPositiveInteger(questionId) : (stryCov_9fa48("4454", "4455", "4456"), !isPositiveInteger(questionId))) {
        if (stryMutAct_9fa48("4457")) {
          {}
        } else {
          stryCov_9fa48("4457");
          res.status(404).json(stryMutAct_9fa48("4459") ? {} : (stryCov_9fa48("4459"), {
            error: stryMutAct_9fa48("4460") ? "" : (stryCov_9fa48("4460"), "Question not found")
          }));
          return;
        }
      }
      const {
        data: question,
        error: questionError
      } = await supabase.from(stryMutAct_9fa48("4461") ? "" : (stryCov_9fa48("4461"), "event_clarifications")).select(stryMutAct_9fa48("4462") ? "" : (stryCov_9fa48("4462"), "id, event_id, parent_id, resolved")).eq(stryMutAct_9fa48("4463") ? "" : (stryCov_9fa48("4463"), "id"), Number(questionId)).maybeSingle();
      if (stryMutAct_9fa48("4465") ? false : stryMutAct_9fa48("4464") ? true : (stryCov_9fa48("4464", "4465"), questionError)) {
        if (stryMutAct_9fa48("4466")) {
          {}
        } else {
          stryCov_9fa48("4466");
          res.status(500).json(stryMutAct_9fa48("4468") ? {} : (stryCov_9fa48("4468"), {
            error: stryMutAct_9fa48("4469") ? "" : (stryCov_9fa48("4469"), "Failed to load question")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("4472") ? (!question || question.event_id !== event.id) && question.parent_id !== null : stryMutAct_9fa48("4471") ? false : stryMutAct_9fa48("4470") ? true : (stryCov_9fa48("4470", "4471", "4472"), (stryMutAct_9fa48("4474") ? !question && question.event_id !== event.id : stryMutAct_9fa48("4473") ? false : (stryCov_9fa48("4473", "4474"), (stryMutAct_9fa48("4475") ? question : (stryCov_9fa48("4475"), !question)) || (stryMutAct_9fa48("4477") ? question.event_id === event.id : stryMutAct_9fa48("4476") ? false : (stryCov_9fa48("4476", "4477"), question.event_id !== event.id)))) || (stryMutAct_9fa48("4479") ? question.parent_id === null : stryMutAct_9fa48("4478") ? false : (stryCov_9fa48("4478", "4479"), question.parent_id !== null)))) {
        if (stryMutAct_9fa48("4480")) {
          {}
        } else {
          stryCov_9fa48("4480");
          res.status(404).json(stryMutAct_9fa48("4482") ? {} : (stryCov_9fa48("4482"), {
            error: stryMutAct_9fa48("4483") ? "" : (stryCov_9fa48("4483"), "Question not found")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("4485") ? false : stryMutAct_9fa48("4484") ? true : (stryCov_9fa48("4484", "4485"), question.resolved)) {
        if (stryMutAct_9fa48("4486")) {
          {}
        } else {
          stryCov_9fa48("4486");
          res.status(409).json(stryMutAct_9fa48("4488") ? {} : (stryCov_9fa48("4488"), {
            error: stryMutAct_9fa48("4489") ? "" : (stryCov_9fa48("4489"), "This question has been resolved and is no longer open for replies")
          }));
          return;
        }
      }
      const message = (stryMutAct_9fa48("4492") ? typeof req.body?.message !== "string" : stryMutAct_9fa48("4491") ? false : stryMutAct_9fa48("4490") ? true : (stryCov_9fa48("4490", "4491", "4492"), typeof (stryMutAct_9fa48("4493") ? req.body.message : (stryCov_9fa48("4493"), req.body?.message)) === (stryMutAct_9fa48("4494") ? "" : (stryCov_9fa48("4494"), "string")))) ? stryMutAct_9fa48("4495") ? req.body.message : (stryCov_9fa48("4495"), req.body.message.trim()) : stryMutAct_9fa48("4496") ? "Stryker was here!" : (stryCov_9fa48("4496"), "");
      if (stryMutAct_9fa48("4499") ? false : stryMutAct_9fa48("4498") ? true : stryMutAct_9fa48("4497") ? message : (stryCov_9fa48("4497", "4498", "4499"), !message)) {
        if (stryMutAct_9fa48("4500")) {
          {}
        } else {
          stryCov_9fa48("4500");
          res.status(400).json(stryMutAct_9fa48("4502") ? {} : (stryCov_9fa48("4502"), {
            error: stryMutAct_9fa48("4503") ? "" : (stryCov_9fa48("4503"), "A reply is required")
          }));
          return;
        }
      }
      const authorRole = (stryMutAct_9fa48("4506") ? user.role !== "coordinator" : stryMutAct_9fa48("4505") ? false : stryMutAct_9fa48("4504") ? true : (stryCov_9fa48("4504", "4505", "4506"), user.role === (stryMutAct_9fa48("4507") ? "" : (stryCov_9fa48("4507"), "coordinator")))) ? stryMutAct_9fa48("4508") ? "" : (stryCov_9fa48("4508"), "coordinator") : stryMutAct_9fa48("4509") ? "" : (stryCov_9fa48("4509"), "organiser");
      const {
        data,
        error
      } = await supabase.from(stryMutAct_9fa48("4510") ? "" : (stryCov_9fa48("4510"), "event_clarifications")).insert(stryMutAct_9fa48("4511") ? {} : (stryCov_9fa48("4511"), {
        event_id: event.id,
        parent_id: question.id,
        author_id: user.id,
        author_role: authorRole,
        message
      })).select(CLARIFICATION_COLUMNS).single();
      if (stryMutAct_9fa48("4513") ? false : stryMutAct_9fa48("4512") ? true : (stryCov_9fa48("4512", "4513"), error)) {
        if (stryMutAct_9fa48("4514")) {
          {}
        } else {
          stryCov_9fa48("4514");
          res.status(500).json(stryMutAct_9fa48("4516") ? {} : (stryCov_9fa48("4516"), {
            error: stryMutAct_9fa48("4517") ? "" : (stryCov_9fa48("4517"), "Failed to add reply")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("4518")) {
        ;
      } else {
        stryCov_9fa48("4518");
        res.status(201).json(stryMutAct_9fa48("4519") ? {} : (stryCov_9fa48("4519"), {
          clarification: data as ClarificationRow
        }));
      }
    }
  });
}
/**
 * Coordinator marks a top-level question resolved — once every question
 * on the event is resolved, /approve unblocks (see its status check).
 */
if (stryMutAct_9fa48("4520")) {
  ;
} else {
  stryCov_9fa48("4520");
  eventsRouter.post(stryMutAct_9fa48("4521") ? "" : (stryCov_9fa48("4521"), "/:id/clarifications/:questionId/resolve"), async (req: AuthedRequest, res) => {
    if (stryMutAct_9fa48("4522")) {
      {}
    } else {
      stryCov_9fa48("4522");
      const eventId = routeParam(req.params.id);
      const event = await authorizeCoordinatorReview(req, res, eventId);
      if (stryMutAct_9fa48("4525") ? false : stryMutAct_9fa48("4524") ? true : stryMutAct_9fa48("4523") ? event : (stryCov_9fa48("4523", "4524", "4525"), !event)) return;
      if (stryMutAct_9fa48("4528") ? event.status === "Clarification Requested" : stryMutAct_9fa48("4527") ? false : stryMutAct_9fa48("4526") ? true : (stryCov_9fa48("4526", "4527", "4528"), event.status !== (stryMutAct_9fa48("4529") ? "" : (stryCov_9fa48("4529"), "Clarification Requested")))) {
        if (stryMutAct_9fa48("4530")) {
          {}
        } else {
          stryCov_9fa48("4530");
          res.status(409).json(stryMutAct_9fa48("4532") ? {} : (stryCov_9fa48("4532"), {
            error: stryMutAct_9fa48("4533") ? "" : (stryCov_9fa48("4533"), "Questions can only be resolved while clarification is outstanding")
          }));
          return;
        }
      }
      const questionId = routeParam(req.params.questionId);
      if (stryMutAct_9fa48("4536") ? false : stryMutAct_9fa48("4535") ? true : stryMutAct_9fa48("4534") ? isPositiveInteger(questionId) : (stryCov_9fa48("4534", "4535", "4536"), !isPositiveInteger(questionId))) {
        if (stryMutAct_9fa48("4537")) {
          {}
        } else {
          stryCov_9fa48("4537");
          res.status(404).json(stryMutAct_9fa48("4539") ? {} : (stryCov_9fa48("4539"), {
            error: stryMutAct_9fa48("4540") ? "" : (stryCov_9fa48("4540"), "Question not found")
          }));
          return;
        }
      }
      const {
        supabase
      } = req as Required<Pick<AuthedRequest, "supabase">>;
      const {
        data: question,
        error: questionError
      } = await supabase.from(stryMutAct_9fa48("4541") ? "" : (stryCov_9fa48("4541"), "event_clarifications")).select(stryMutAct_9fa48("4542") ? "" : (stryCov_9fa48("4542"), "id, event_id, parent_id")).eq(stryMutAct_9fa48("4543") ? "" : (stryCov_9fa48("4543"), "id"), Number(questionId)).maybeSingle();
      if (stryMutAct_9fa48("4545") ? false : stryMutAct_9fa48("4544") ? true : (stryCov_9fa48("4544", "4545"), questionError)) {
        if (stryMutAct_9fa48("4546")) {
          {}
        } else {
          stryCov_9fa48("4546");
          res.status(500).json(stryMutAct_9fa48("4548") ? {} : (stryCov_9fa48("4548"), {
            error: stryMutAct_9fa48("4549") ? "" : (stryCov_9fa48("4549"), "Failed to load question")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("4552") ? (!question || question.event_id !== event.id) && question.parent_id !== null : stryMutAct_9fa48("4551") ? false : stryMutAct_9fa48("4550") ? true : (stryCov_9fa48("4550", "4551", "4552"), (stryMutAct_9fa48("4554") ? !question && question.event_id !== event.id : stryMutAct_9fa48("4553") ? false : (stryCov_9fa48("4553", "4554"), (stryMutAct_9fa48("4555") ? question : (stryCov_9fa48("4555"), !question)) || (stryMutAct_9fa48("4557") ? question.event_id === event.id : stryMutAct_9fa48("4556") ? false : (stryCov_9fa48("4556", "4557"), question.event_id !== event.id)))) || (stryMutAct_9fa48("4559") ? question.parent_id === null : stryMutAct_9fa48("4558") ? false : (stryCov_9fa48("4558", "4559"), question.parent_id !== null)))) {
        if (stryMutAct_9fa48("4560")) {
          {}
        } else {
          stryCov_9fa48("4560");
          res.status(404).json(stryMutAct_9fa48("4562") ? {} : (stryCov_9fa48("4562"), {
            error: stryMutAct_9fa48("4563") ? "" : (stryCov_9fa48("4563"), "Question not found")
          }));
          return;
        }
      }
      const {
        data,
        error
      } = await supabase.from(stryMutAct_9fa48("4564") ? "" : (stryCov_9fa48("4564"), "event_clarifications")).update(stryMutAct_9fa48("4565") ? {} : (stryCov_9fa48("4565"), {
        resolved: stryMutAct_9fa48("4566") ? false : (stryCov_9fa48("4566"), true)
      })).eq(stryMutAct_9fa48("4567") ? "" : (stryCov_9fa48("4567"), "id"), question.id).select(CLARIFICATION_COLUMNS).single();
      if (stryMutAct_9fa48("4569") ? false : stryMutAct_9fa48("4568") ? true : (stryCov_9fa48("4568", "4569"), error)) {
        if (stryMutAct_9fa48("4570")) {
          {}
        } else {
          stryCov_9fa48("4570");
          res.status(500).json(stryMutAct_9fa48("4572") ? {} : (stryCov_9fa48("4572"), {
            error: stryMutAct_9fa48("4573") ? "" : (stryCov_9fa48("4573"), "Failed to resolve question")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("4574")) {
        ;
      } else {
        stryCov_9fa48("4574");
        res.json(stryMutAct_9fa48("4575") ? {} : (stryCov_9fa48("4575"), {
          clarification: data as ClarificationRow
        }));
      }
    }
  });
}
interface AssignmentEventRow {
  id: number;
  status: string;
  organiser_id: string;
  coordinator_id: string | null;
  coordinator: {
    name: string;
  } | null;
  submitted_details: Record<string, unknown> | null;
}

/**
 * Shared entry checks for assign (E2-13) and reassign (E2-12): Lead role
 * (AC "including directly via the API"), id format, existence, a
 * coordinatorId in the body, and that it names an active coordinator.
 * Status rules differ between the two and are left to the caller. Sends
 * the error response and returns null if any check fails.
 */
async function authorizeLeadAssignment(req: AuthedRequest, res: Response, eventId: string): Promise<{
  event: AssignmentEventRow;
  coordinator: {
    id: string;
    name: string;
  };
} | null> {
  if (stryMutAct_9fa48("4576")) {
    {}
  } else {
    stryCov_9fa48("4576");
    const {
      supabase,
      user
    } = req;
    if (stryMutAct_9fa48("4579") ? !supabase && !user : stryMutAct_9fa48("4578") ? false : stryMutAct_9fa48("4577") ? true : (stryCov_9fa48("4577", "4578", "4579"), (stryMutAct_9fa48("4580") ? supabase : (stryCov_9fa48("4580"), !supabase)) || (stryMutAct_9fa48("4581") ? user : (stryCov_9fa48("4581"), !user)))) {
      if (stryMutAct_9fa48("4582")) {
        {}
      } else {
        stryCov_9fa48("4582");
        res.status(401).json(stryMutAct_9fa48("4584") ? {} : (stryCov_9fa48("4584"), {
          error: stryMutAct_9fa48("4585") ? "" : (stryCov_9fa48("4585"), "Unauthenticated")
        }));
        return null;
      }
    }
    if (stryMutAct_9fa48("4588") ? user.role === COORDINATOR_LEAD_ROLE : stryMutAct_9fa48("4587") ? false : stryMutAct_9fa48("4586") ? true : (stryCov_9fa48("4586", "4587", "4588"), user.role !== COORDINATOR_LEAD_ROLE)) {
      if (stryMutAct_9fa48("4589")) {
        {}
      } else {
        stryCov_9fa48("4589");
        await recordAccessDenial(supabase, user.id, eventId, stryMutAct_9fa48("4590") ? "" : (stryCov_9fa48("4590"), "assignment_role_not_allowed"));
        res.status(403).json(stryMutAct_9fa48("4592") ? {} : (stryCov_9fa48("4592"), {
          error: stryMutAct_9fa48("4593") ? "" : (stryCov_9fa48("4593"), "Only the Event Coordinator Lead can assign or reassign coordinators")
        }));
        return null;
      }
    }
    if (stryMutAct_9fa48("4596") ? false : stryMutAct_9fa48("4595") ? true : stryMutAct_9fa48("4594") ? isPositiveInteger(eventId) : (stryCov_9fa48("4594", "4595", "4596"), !isPositiveInteger(eventId))) {
      if (stryMutAct_9fa48("4597")) {
        {}
      } else {
        stryCov_9fa48("4597");
        res.status(404).json(stryMutAct_9fa48("4599") ? {} : (stryCov_9fa48("4599"), {
          error: stryMutAct_9fa48("4600") ? "" : (stryCov_9fa48("4600"), "Event not found")
        }));
        return null;
      }
    }
    const coordinatorId = (stryMutAct_9fa48("4603") ? typeof req.body?.coordinatorId !== "string" : stryMutAct_9fa48("4602") ? false : stryMutAct_9fa48("4601") ? true : (stryCov_9fa48("4601", "4602", "4603"), typeof (stryMutAct_9fa48("4604") ? req.body.coordinatorId : (stryCov_9fa48("4604"), req.body?.coordinatorId)) === (stryMutAct_9fa48("4605") ? "" : (stryCov_9fa48("4605"), "string")))) ? stryMutAct_9fa48("4606") ? req.body.coordinatorId : (stryCov_9fa48("4606"), req.body.coordinatorId.trim()) : stryMutAct_9fa48("4607") ? "Stryker was here!" : (stryCov_9fa48("4607"), "");
    if (stryMutAct_9fa48("4610") ? false : stryMutAct_9fa48("4609") ? true : stryMutAct_9fa48("4608") ? coordinatorId : (stryCov_9fa48("4608", "4609", "4610"), !coordinatorId)) {
      if (stryMutAct_9fa48("4611")) {
        {}
      } else {
        stryCov_9fa48("4611");
        res.status(400).json(stryMutAct_9fa48("4613") ? {} : (stryCov_9fa48("4613"), {
          error: stryMutAct_9fa48("4614") ? "" : (stryCov_9fa48("4614"), "Choose a coordinator")
        }));
        return null;
      }
    }
    const {
      data,
      error
    } = await supabase.from(stryMutAct_9fa48("4615") ? "" : (stryCov_9fa48("4615"), "events")).select(stryMutAct_9fa48("4616") ? "" : (stryCov_9fa48("4616"), "id, status, organiser_id, coordinator_id, coordinator:coordinator_id(name), submitted_details")).eq(stryMutAct_9fa48("4617") ? "" : (stryCov_9fa48("4617"), "id"), Number(eventId)).maybeSingle();
    if (stryMutAct_9fa48("4619") ? false : stryMutAct_9fa48("4618") ? true : (stryCov_9fa48("4618", "4619"), error)) {
      if (stryMutAct_9fa48("4620")) {
        {}
      } else {
        stryCov_9fa48("4620");
        res.status(500).json(stryMutAct_9fa48("4622") ? {} : (stryCov_9fa48("4622"), {
          error: stryMutAct_9fa48("4623") ? "" : (stryCov_9fa48("4623"), "Failed to load event")
        }));
        return null;
      }
    }
    if (stryMutAct_9fa48("4626") ? !data && data.status === EVENT_STATUS.Draft : stryMutAct_9fa48("4625") ? false : stryMutAct_9fa48("4624") ? true : (stryCov_9fa48("4624", "4625", "4626"), (stryMutAct_9fa48("4627") ? data : (stryCov_9fa48("4627"), !data)) || (stryMutAct_9fa48("4629") ? data.status !== EVENT_STATUS.Draft : stryMutAct_9fa48("4628") ? false : (stryCov_9fa48("4628", "4629"), data.status === EVENT_STATUS.Draft)))) {
      if (stryMutAct_9fa48("4630")) {
        {}
      } else {
        stryCov_9fa48("4630");
        res.status(404).json(stryMutAct_9fa48("4632") ? {} : (stryCov_9fa48("4632"), {
          error: stryMutAct_9fa48("4633") ? "" : (stryCov_9fa48("4633"), "Event not found")
        }));
        return null;
      }
    }
    const coordinators = await fetchCoordinators(req.headers.authorization!);
    if (stryMutAct_9fa48("4636") ? coordinators.status !== "error" : stryMutAct_9fa48("4635") ? false : stryMutAct_9fa48("4634") ? true : (stryCov_9fa48("4634", "4635", "4636"), coordinators.status === (stryMutAct_9fa48("4637") ? "" : (stryCov_9fa48("4637"), "error")))) {
      if (stryMutAct_9fa48("4638")) {
        {}
      } else {
        stryCov_9fa48("4638");
        res.status(502).json(stryMutAct_9fa48("4640") ? {} : (stryCov_9fa48("4640"), {
          error: stryMutAct_9fa48("4641") ? "" : (stryCov_9fa48("4641"), "Failed to load the list of coordinators")
        }));
        return null;
      }
    }
    const coordinator = coordinators.coordinators.find(stryMutAct_9fa48("4642") ? () => undefined : (stryCov_9fa48("4642"), c => stryMutAct_9fa48("4645") ? c.id !== coordinatorId : stryMutAct_9fa48("4644") ? false : stryMutAct_9fa48("4643") ? true : (stryCov_9fa48("4643", "4644", "4645"), c.id === coordinatorId)));
    if (stryMutAct_9fa48("4648") ? false : stryMutAct_9fa48("4647") ? true : stryMutAct_9fa48("4646") ? coordinator : (stryCov_9fa48("4646", "4647", "4648"), !coordinator)) {
      if (stryMutAct_9fa48("4649")) {
        {}
      } else {
        stryCov_9fa48("4649");
        res.status(400).json(stryMutAct_9fa48("4651") ? {} : (stryCov_9fa48("4651"), {
          error: stryMutAct_9fa48("4652") ? "" : (stryCov_9fa48("4652"), "That user is not an active Event Coordinator")
        }));
        return null;
      }
    }
    return stryMutAct_9fa48("4653") ? {} : (stryCov_9fa48("4653"), {
      event: data as unknown as AssignmentEventRow,
      coordinator
    });
  }
}
function eventDisplayName(event: AssignmentEventRow): string {
  if (stryMutAct_9fa48("4654")) {
    {}
  } else {
    stryCov_9fa48("4654");
    const name = stryMutAct_9fa48("4655") ? event.submitted_details.name : (stryCov_9fa48("4655"), event.submitted_details?.name);
    return (stryMutAct_9fa48("4658") ? typeof name === "string" || name.trim() : stryMutAct_9fa48("4657") ? false : stryMutAct_9fa48("4656") ? true : (stryCov_9fa48("4656", "4657", "4658"), (stryMutAct_9fa48("4660") ? typeof name !== "string" : stryMutAct_9fa48("4659") ? true : (stryCov_9fa48("4659", "4660"), typeof name === (stryMutAct_9fa48("4661") ? "" : (stryCov_9fa48("4661"), "string")))) && (stryMutAct_9fa48("4662") ? name : (stryCov_9fa48("4662"), name.trim())))) ? stryMutAct_9fa48("4663") ? name : (stryCov_9fa48("4663"), name.trim()) : stryMutAct_9fa48("4664") ? `` : (stryCov_9fa48("4664"), `Event #${event.id}`);
  }
}

/**
 * E2-13: the Event Coordinator Lead assigns a request from the unassigned
 * queue. AC1: the coordinator becomes the event's single point of contact
 * and the status moves Unassigned → Requested (§3); both the coordinator
 * and the Organiser are notified. AC2: an event that already has a
 * coordinator is blocked — that is a reassignment (E2-12). AC3: with no
 * active coordinator there is nobody valid to name, so the request stays
 * Unassigned. AC4: Lead only.
 *
 * The update only matches while the event is still Unassigned with no
 * coordinator, so if two Leads assign the same request at once exactly one
 * wins and the other gets a 409 — an event never ends up with two.
 *
 * Notifications are best-effort and sent after the write lands, so a slow
 * or failing notification-service never undoes an assignment.
 */
if (stryMutAct_9fa48("4665")) {
  ;
} else {
  stryCov_9fa48("4665");
  eventsRouter.post(stryMutAct_9fa48("4666") ? "" : (stryCov_9fa48("4666"), "/:id/assign"), async (req: AuthedRequest, res) => {
    if (stryMutAct_9fa48("4667")) {
      {}
    } else {
      stryCov_9fa48("4667");
      const eventId = routeParam(req.params.id);
      const authorized = await authorizeLeadAssignment(req, res, eventId);
      if (stryMutAct_9fa48("4670") ? false : stryMutAct_9fa48("4669") ? true : stryMutAct_9fa48("4668") ? authorized : (stryCov_9fa48("4668", "4669", "4670"), !authorized)) return;
      const {
        event,
        coordinator
      } = authorized;
      if (stryMutAct_9fa48("4672") ? false : stryMutAct_9fa48("4671") ? true : (stryCov_9fa48("4671", "4672"), event.coordinator_id)) {
        if (stryMutAct_9fa48("4673")) {
          {}
        } else {
          stryCov_9fa48("4673");
          res.status(409).json(stryMutAct_9fa48("4675") ? {} : (stryCov_9fa48("4675"), {
            error: stryMutAct_9fa48("4676") ? "" : (stryCov_9fa48("4676"), "This event already has a coordinator. An event has at most one — use reassignment instead.")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("4679") ? event.status === EVENT_STATUS.Unassigned : stryMutAct_9fa48("4678") ? false : stryMutAct_9fa48("4677") ? true : (stryCov_9fa48("4677", "4678", "4679"), event.status !== EVENT_STATUS.Unassigned)) {
        if (stryMutAct_9fa48("4680")) {
          {}
        } else {
          stryCov_9fa48("4680");
          res.status(409).json(stryMutAct_9fa48("4682") ? {} : (stryCov_9fa48("4682"), {
            error: stryMutAct_9fa48("4683") ? "" : (stryCov_9fa48("4683"), "Only a request in the unassigned queue can be assigned")
          }));
          return;
        }
      }
      const {
        supabase,
        user
      } = req as Required<Pick<AuthedRequest, "supabase" | "user">>;
      const {
        data,
        error
      } = await supabase.from(stryMutAct_9fa48("4684") ? "" : (stryCov_9fa48("4684"), "events")).update(stryMutAct_9fa48("4685") ? {} : (stryCov_9fa48("4685"), {
        status: EVENT_STATUS.Requested,
        coordinator_id: coordinator.id
      })).eq(stryMutAct_9fa48("4686") ? "" : (stryCov_9fa48("4686"), "id"), event.id).eq(stryMutAct_9fa48("4687") ? "" : (stryCov_9fa48("4687"), "status"), EVENT_STATUS.Unassigned).is(stryMutAct_9fa48("4688") ? "" : (stryCov_9fa48("4688"), "coordinator_id"), null).select(EVENT_COLUMNS).maybeSingle();
      if (stryMutAct_9fa48("4690") ? false : stryMutAct_9fa48("4689") ? true : (stryCov_9fa48("4689", "4690"), error)) {
        if (stryMutAct_9fa48("4691")) {
          {}
        } else {
          stryCov_9fa48("4691");
          res.status(500).json(stryMutAct_9fa48("4693") ? {} : (stryCov_9fa48("4693"), {
            error: stryMutAct_9fa48("4694") ? "" : (stryCov_9fa48("4694"), "Failed to assign the coordinator")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("4697") ? false : stryMutAct_9fa48("4696") ? true : stryMutAct_9fa48("4695") ? data : (stryCov_9fa48("4695", "4696", "4697"), !data)) {
        if (stryMutAct_9fa48("4698")) {
          {}
        } else {
          stryCov_9fa48("4698");
          res.status(409).json(stryMutAct_9fa48("4700") ? {} : (stryCov_9fa48("4700"), {
            error: stryMutAct_9fa48("4701") ? "" : (stryCov_9fa48("4701"), "This request was assigned by someone else just now. Refresh to see who.")
          }));
          return;
        }
      }
      await recordEventHistory(supabase, event.id, stryMutAct_9fa48("4702") ? [] : (stryCov_9fa48("4702"), [stryMutAct_9fa48("4703") ? {} : (stryCov_9fa48("4703"), {
        field: stryMutAct_9fa48("4704") ? "" : (stryCov_9fa48("4704"), "Coordinator"),
        oldValue: null,
        newValue: coordinator.name
      }), stryMutAct_9fa48("4705") ? {} : (stryCov_9fa48("4705"), {
        field: stryMutAct_9fa48("4706") ? "" : (stryCov_9fa48("4706"), "Status"),
        oldValue: EVENT_STATUS.Unassigned,
        newValue: EVENT_STATUS.Requested
      })]), user.id);
      const eventName = eventDisplayName(event);

      // Migrated to RabbitMQ (ARD section 1.1): notification-service's
      // existing consumer renders this into the coordinator's and organiser's
      // notifications (notification-service/src/lib/messageTemplates.ts).
      const published = await getPublisher().publish(stryMutAct_9fa48("4707") ? {} : (stryCov_9fa48("4707"), {
        type: stryMutAct_9fa48("4708") ? "" : (stryCov_9fa48("4708"), "coordinator.assigned"),
        eventId: event.id,
        actorId: user.id,
        recipients: stryMutAct_9fa48("4709") ? {} : (stryCov_9fa48("4709"), {
          userIds: stryMutAct_9fa48("4710") ? [] : (stryCov_9fa48("4710"), [coordinator.id, event.organiser_id]),
          roles: stryMutAct_9fa48("4711") ? ["Stryker was here"] : (stryCov_9fa48("4711"), [])
        }),
        data: stryMutAct_9fa48("4712") ? {} : (stryCov_9fa48("4712"), {
          eventName,
          coordinatorId: coordinator.id,
          coordinatorName: coordinator.name,
          organiserId: event.organiser_id
        })
      }));
      res.json(stryMutAct_9fa48("4714") ? {} : (stryCov_9fa48("4714"), {
        event: data,
        notificationsFailed: stryMutAct_9fa48("4715") ? published : (stryCov_9fa48("4715"), !published)
      }));
    }
  });
}
/**
 * E2-12: the Event Coordinator Lead hands an assigned event to a different
 * active coordinator. AC1: the new coordinator becomes the only one and the
 * previous assignment ends; the status does not change (§3 lists this as
 * Requested → Requested, and it applies in any open status). AC2: recorded
 * in the event history — previous coordinator, new coordinator, when, and
 * by whom (changed_by). AC3: blocked once the event is Rejected, Cancelled
 * or Completed. AC4: an event without a coordinator is assigned (E2-13),
 * not reassigned. AC5: Lead only. AC6 needs nothing here: every
 * coordinator action checks events.coordinator_id live, so the previous
 * coordinator is blocked and the new one can act the moment this commits.
 * AC7: the Organiser and both coordinators are notified.
 *
 * The update only matches while the previous coordinator is still the
 * assigned one, so two simultaneous reassignments can't both apply.
 */
if (stryMutAct_9fa48("4716")) {
  ;
} else {
  stryCov_9fa48("4716");
  eventsRouter.post(stryMutAct_9fa48("4717") ? "" : (stryCov_9fa48("4717"), "/:id/reassign"), async (req: AuthedRequest, res) => {
    if (stryMutAct_9fa48("4718")) {
      {}
    } else {
      stryCov_9fa48("4718");
      const eventId = routeParam(req.params.id);
      const authorized = await authorizeLeadAssignment(req, res, eventId);
      if (stryMutAct_9fa48("4721") ? false : stryMutAct_9fa48("4720") ? true : stryMutAct_9fa48("4719") ? authorized : (stryCov_9fa48("4719", "4720", "4721"), !authorized)) return;
      const {
        event,
        coordinator
      } = authorized;
      if (stryMutAct_9fa48("4723") ? false : stryMutAct_9fa48("4722") ? true : (stryCov_9fa48("4722", "4723"), CLOSED_EVENT_STATUSES.has(event.status))) {
        if (stryMutAct_9fa48("4724")) {
          {}
        } else {
          stryCov_9fa48("4724");
          res.status(409).json(stryMutAct_9fa48("4726") ? {} : (stryCov_9fa48("4726"), {
            error: stryMutAct_9fa48("4727") ? `` : (stryCov_9fa48("4727"), `This event is ${event.status}. Closed events cannot be reassigned.`)
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("4730") ? false : stryMutAct_9fa48("4729") ? true : stryMutAct_9fa48("4728") ? event.coordinator_id : (stryCov_9fa48("4728", "4729", "4730"), !event.coordinator_id)) {
        if (stryMutAct_9fa48("4731")) {
          {}
        } else {
          stryCov_9fa48("4731");
          res.status(409).json(stryMutAct_9fa48("4733") ? {} : (stryCov_9fa48("4733"), {
            error: stryMutAct_9fa48("4734") ? "" : (stryCov_9fa48("4734"), "This event has no coordinator yet. Assign one from the unassigned queue instead.")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("4737") ? event.coordinator_id !== coordinator.id : stryMutAct_9fa48("4736") ? false : stryMutAct_9fa48("4735") ? true : (stryCov_9fa48("4735", "4736", "4737"), event.coordinator_id === coordinator.id)) {
        if (stryMutAct_9fa48("4738")) {
          {}
        } else {
          stryCov_9fa48("4738");
          res.status(400).json(stryMutAct_9fa48("4740") ? {} : (stryCov_9fa48("4740"), {
            error: stryMutAct_9fa48("4741") ? "" : (stryCov_9fa48("4741"), "Choose a different coordinator from the one already assigned")
          }));
          return;
        }
      }
      const previousCoordinatorId = event.coordinator_id;
      const previousCoordinatorName = stryMutAct_9fa48("4742") ? event.coordinator?.name && previousCoordinatorId : (stryCov_9fa48("4742"), (stryMutAct_9fa48("4743") ? event.coordinator.name : (stryCov_9fa48("4743"), event.coordinator?.name)) ?? previousCoordinatorId);
      const {
        supabase,
        user
      } = req as Required<Pick<AuthedRequest, "supabase" | "user">>;
      const {
        data,
        error
      } = await supabase.from(stryMutAct_9fa48("4744") ? "" : (stryCov_9fa48("4744"), "events")).update(stryMutAct_9fa48("4745") ? {} : (stryCov_9fa48("4745"), {
        coordinator_id: coordinator.id
      })).eq(stryMutAct_9fa48("4746") ? "" : (stryCov_9fa48("4746"), "id"), event.id).eq(stryMutAct_9fa48("4747") ? "" : (stryCov_9fa48("4747"), "coordinator_id"), previousCoordinatorId).eq(stryMutAct_9fa48("4748") ? "" : (stryCov_9fa48("4748"), "status"), event.status).select(EVENT_COLUMNS).maybeSingle();
      if (stryMutAct_9fa48("4750") ? false : stryMutAct_9fa48("4749") ? true : (stryCov_9fa48("4749", "4750"), error)) {
        if (stryMutAct_9fa48("4751")) {
          {}
        } else {
          stryCov_9fa48("4751");
          res.status(500).json(stryMutAct_9fa48("4753") ? {} : (stryCov_9fa48("4753"), {
            error: stryMutAct_9fa48("4754") ? "" : (stryCov_9fa48("4754"), "Failed to reassign the coordinator")
          }));
          return;
        }
      }
      if (stryMutAct_9fa48("4757") ? false : stryMutAct_9fa48("4756") ? true : stryMutAct_9fa48("4755") ? data : (stryCov_9fa48("4755", "4756", "4757"), !data)) {
        if (stryMutAct_9fa48("4758")) {
          {}
        } else {
          stryCov_9fa48("4758");
          res.status(409).json(stryMutAct_9fa48("4760") ? {} : (stryCov_9fa48("4760"), {
            error: stryMutAct_9fa48("4761") ? "" : (stryCov_9fa48("4761"), "This event changed while you were reassigning it. Refresh and try again.")
          }));
          return;
        }
      }
      await recordEventHistory(supabase, event.id, stryMutAct_9fa48("4762") ? [] : (stryCov_9fa48("4762"), [stryMutAct_9fa48("4763") ? {} : (stryCov_9fa48("4763"), {
        field: stryMutAct_9fa48("4764") ? "" : (stryCov_9fa48("4764"), "Coordinator"),
        oldValue: previousCoordinatorName,
        newValue: coordinator.name
      })]), user.id);
      const eventName = eventDisplayName(event);

      // Migrated to RabbitMQ (ARD section 1.1, RabbitMQ.md #4 "coordinator.reassigned").
      const published = await getPublisher().publish(stryMutAct_9fa48("4765") ? {} : (stryCov_9fa48("4765"), {
        type: stryMutAct_9fa48("4766") ? "" : (stryCov_9fa48("4766"), "coordinator.reassigned"),
        eventId: event.id,
        actorId: user.id,
        recipients: stryMutAct_9fa48("4767") ? {} : (stryCov_9fa48("4767"), {
          userIds: stryMutAct_9fa48("4768") ? [] : (stryCov_9fa48("4768"), [event.organiser_id, previousCoordinatorId, coordinator.id]),
          roles: stryMutAct_9fa48("4769") ? ["Stryker was here"] : (stryCov_9fa48("4769"), [])
        }),
        data: stryMutAct_9fa48("4770") ? {} : (stryCov_9fa48("4770"), {
          eventName,
          organiserId: event.organiser_id,
          newCoordinatorId: coordinator.id,
          newCoordinatorName: coordinator.name,
          previousCoordinatorId,
          previousCoordinatorName
        })
      }));
      res.json(stryMutAct_9fa48("4772") ? {} : (stryCov_9fa48("4772"), {
        event: data,
        notificationsFailed: stryMutAct_9fa48("4773") ? published : (stryCov_9fa48("4773"), !published)
      }));
    }
  });
}
/**
 * Where an event goes when its coordinator approves a held change: a
 * Confirmed or Needs Review event stays in Needs Review to be re-arranged
 * and re-checked; a Safety Review event returns to Planning (AGENTS.md
 * section 3); Planning stays in Planning.
 */
const CHANGE_REQUEST_BLOCKED_STATUSES: ReadonlySet<string> = new Set(stryMutAct_9fa48("4774") ? [] : (stryCov_9fa48("4774"), [EVENT_STATUS.Draft, EVENT_STATUS.Unassigned, ...CLOSED_EVENT_STATUSES]));
function statusAfterApproval(current: string): string {
  if (stryMutAct_9fa48("4775")) {
    {}
  } else {
    stryCov_9fa48("4775");
    if (stryMutAct_9fa48("4778") ? current === EVENT_STATUS.Confirmed && current === EVENT_STATUS.NeedsReview : stryMutAct_9fa48("4777") ? false : stryMutAct_9fa48("4776") ? true : (stryCov_9fa48("4776", "4777", "4778"), (stryMutAct_9fa48("4780") ? current !== EVENT_STATUS.Confirmed : stryMutAct_9fa48("4779") ? false : (stryCov_9fa48("4779", "4780"), current === EVENT_STATUS.Confirmed)) || (stryMutAct_9fa48("4782") ? current !== EVENT_STATUS.NeedsReview : stryMutAct_9fa48("4781") ? false : (stryCov_9fa48("4781", "4782"), current === EVENT_STATUS.NeedsReview)))) return EVENT_STATUS.NeedsReview;
    return EVENT_STATUS.Planning;
  }
}

/**
 * venue-service / equipment-service: an arrangement the event relied on is
 * gone (a booking became Replacement Required, a reserved unit became
 * unusable). Internal callers only. Confirmed -> Needs Review; Safety
 * Review -> Planning; an event already in Needs Review just has its safety
 * approval marked stale. Any other status needs nothing: Planning is being
 * arranged anyway and the rest are closed or not yet approved. Idempotent,
 * so a repeat call after the event has moved is a harmless no-op.
 */
async function arrangementsChangedHandler(req: AuthedRequest, res: Response): Promise<void> {
  if (stryMutAct_9fa48("4783")) {
    {}
  } else {
    stryCov_9fa48("4783");
    // Loaded on use: this is the one route with no end-user request to carry a client.
    const {
      supabaseAdmin: supabase
    } = await import("../lib/supabaseAdmin.js");
    const eventId = routeParam(req.params.id);
    if (stryMutAct_9fa48("4786") ? false : stryMutAct_9fa48("4785") ? true : stryMutAct_9fa48("4784") ? isPositiveInteger(eventId) : (stryCov_9fa48("4784", "4785", "4786"), !isPositiveInteger(eventId))) {
      if (stryMutAct_9fa48("4787")) {
        {}
      } else {
        stryCov_9fa48("4787");
        res.status(404).json(stryMutAct_9fa48("4789") ? {} : (stryCov_9fa48("4789"), {
          error: stryMutAct_9fa48("4790") ? "" : (stryCov_9fa48("4790"), "Event not found")
        }));
        return;
      }
    }
    const reason = (stryMutAct_9fa48("4793") ? typeof req.body?.reason !== "string" : stryMutAct_9fa48("4792") ? false : stryMutAct_9fa48("4791") ? true : (stryCov_9fa48("4791", "4792", "4793"), typeof (stryMutAct_9fa48("4794") ? req.body.reason : (stryCov_9fa48("4794"), req.body?.reason)) === (stryMutAct_9fa48("4795") ? "" : (stryCov_9fa48("4795"), "string")))) ? stryMutAct_9fa48("4796") ? req.body.reason : (stryCov_9fa48("4796"), req.body.reason.trim()) : stryMutAct_9fa48("4797") ? "Stryker was here!" : (stryCov_9fa48("4797"), "");
    if (stryMutAct_9fa48("4800") ? false : stryMutAct_9fa48("4799") ? true : stryMutAct_9fa48("4798") ? reason : (stryCov_9fa48("4798", "4799", "4800"), !reason)) {
      if (stryMutAct_9fa48("4801")) {
        {}
      } else {
        stryCov_9fa48("4801");
        res.status(400).json(stryMutAct_9fa48("4803") ? {} : (stryCov_9fa48("4803"), {
          error: stryMutAct_9fa48("4804") ? "" : (stryCov_9fa48("4804"), "A reason is required")
        }));
        return;
      }
    }
    const {
      data: event,
      error
    } = await supabase.from(stryMutAct_9fa48("4805") ? "" : (stryCov_9fa48("4805"), "events")).select(stryMutAct_9fa48("4806") ? `` : (stryCov_9fa48("4806"), `${EVENT_COLUMNS}, organiser_id`)).eq(stryMutAct_9fa48("4807") ? "" : (stryCov_9fa48("4807"), "id"), Number(eventId)).maybeSingle();
    if (stryMutAct_9fa48("4809") ? false : stryMutAct_9fa48("4808") ? true : (stryCov_9fa48("4808", "4809"), error)) {
      if (stryMutAct_9fa48("4810")) {
        {}
      } else {
        stryCov_9fa48("4810");
        res.status(500).json(stryMutAct_9fa48("4812") ? {} : (stryCov_9fa48("4812"), {
          error: stryMutAct_9fa48("4813") ? "" : (stryCov_9fa48("4813"), "Failed to load event")
        }));
        return;
      }
    }
    if (stryMutAct_9fa48("4816") ? false : stryMutAct_9fa48("4815") ? true : stryMutAct_9fa48("4814") ? event : (stryCov_9fa48("4814", "4815", "4816"), !event)) {
      if (stryMutAct_9fa48("4817")) {
        {}
      } else {
        stryCov_9fa48("4817");
        res.status(404).json(stryMutAct_9fa48("4819") ? {} : (stryCov_9fa48("4819"), {
          error: stryMutAct_9fa48("4820") ? "" : (stryCov_9fa48("4820"), "Event not found")
        }));
        return;
      }
    }
    const row = event as unknown as AssignmentEventRow & {
      status: string;
      coordinator_id: string | null;
      organiser_id: string | null;
    };
    const from = row.status;
    let to: string | null = null;
    if (stryMutAct_9fa48("4823") ? from !== EVENT_STATUS.Confirmed : stryMutAct_9fa48("4822") ? false : stryMutAct_9fa48("4821") ? true : (stryCov_9fa48("4821", "4822", "4823"), from === EVENT_STATUS.Confirmed)) to = EVENT_STATUS.NeedsReview;else if (stryMutAct_9fa48("4826") ? from !== EVENT_STATUS.SafetyReview : stryMutAct_9fa48("4825") ? false : stryMutAct_9fa48("4824") ? true : (stryCov_9fa48("4824", "4825", "4826"), from === EVENT_STATUS.SafetyReview)) to = EVENT_STATUS.Planning;else if (stryMutAct_9fa48("4829") ? from !== EVENT_STATUS.NeedsReview : stryMutAct_9fa48("4828") ? false : stryMutAct_9fa48("4827") ? true : (stryCov_9fa48("4827", "4828", "4829"), from === EVENT_STATUS.NeedsReview)) to = EVENT_STATUS.NeedsReview;
    if (stryMutAct_9fa48("4832") ? to !== null : stryMutAct_9fa48("4831") ? false : stryMutAct_9fa48("4830") ? true : (stryCov_9fa48("4830", "4831", "4832"), to === null)) {
      if (stryMutAct_9fa48("4833")) {
        {}
      } else {
        stryCov_9fa48("4833");
        res.json(stryMutAct_9fa48("4835") ? {} : (stryCov_9fa48("4835"), {
          changed: stryMutAct_9fa48("4836") ? true : (stryCov_9fa48("4836"), false),
          status: from
        }));
        return;
      }
    }
    const {
      data: updated,
      error: updateError
    } = await supabase.from(stryMutAct_9fa48("4837") ? "" : (stryCov_9fa48("4837"), "events")).update(stryMutAct_9fa48("4838") ? {} : (stryCov_9fa48("4838"), {
      status: to,
      safety_approval_stale: stryMutAct_9fa48("4839") ? false : (stryCov_9fa48("4839"), true)
    })).eq(stryMutAct_9fa48("4840") ? "" : (stryCov_9fa48("4840"), "id"), row.id).eq(stryMutAct_9fa48("4841") ? "" : (stryCov_9fa48("4841"), "status"), from).select(stryMutAct_9fa48("4842") ? "" : (stryCov_9fa48("4842"), "id"));
    if (stryMutAct_9fa48("4844") ? false : stryMutAct_9fa48("4843") ? true : (stryCov_9fa48("4843", "4844"), updateError)) {
      if (stryMutAct_9fa48("4845")) {
        {}
      } else {
        stryCov_9fa48("4845");
        res.status(500).json(stryMutAct_9fa48("4847") ? {} : (stryCov_9fa48("4847"), {
          error: stryMutAct_9fa48("4848") ? "" : (stryCov_9fa48("4848"), "Failed to update the event")
        }));
        return;
      }
    }
    if (stryMutAct_9fa48("4851") ? (updated ?? []).length !== 0 : stryMutAct_9fa48("4850") ? false : stryMutAct_9fa48("4849") ? true : (stryCov_9fa48("4849", "4850", "4851"), (stryMutAct_9fa48("4852") ? updated && [] : (stryCov_9fa48("4852"), updated ?? (stryMutAct_9fa48("4853") ? ["Stryker was here"] : (stryCov_9fa48("4853"), [])))).length === 0)) {
      if (stryMutAct_9fa48("4854")) {
        {}
      } else {
        stryCov_9fa48("4854");
        res.status(409).json(stryMutAct_9fa48("4856") ? {} : (stryCov_9fa48("4856"), {
          error: stryMutAct_9fa48("4857") ? "" : (stryCov_9fa48("4857"), "The event changed status; try again")
        }));
        return;
      }
    }
    if (stryMutAct_9fa48("4860") ? to !== from : stryMutAct_9fa48("4859") ? false : stryMutAct_9fa48("4858") ? true : (stryCov_9fa48("4858", "4859", "4860"), to === from)) {
      if (stryMutAct_9fa48("4861")) {
        {}
      } else {
        stryCov_9fa48("4861");
        res.json(stryMutAct_9fa48("4863") ? {} : (stryCov_9fa48("4863"), {
          changed: stryMutAct_9fa48("4864") ? true : (stryCov_9fa48("4864"), false),
          status: to
        }));
        return;
      }
    }
    const eventName = eventDisplayName(row);
    const userIds = stryMutAct_9fa48("4865") ? [row.coordinator_id, row.organiser_id] : (stryCov_9fa48("4865"), (stryMutAct_9fa48("4866") ? [] : (stryCov_9fa48("4866"), [row.coordinator_id, row.organiser_id])).filter(stryMutAct_9fa48("4867") ? () => undefined : (stryCov_9fa48("4867"), (id): id is string => Boolean(id))));
    const fromSafety = stryMutAct_9fa48("4870") ? from !== EVENT_STATUS.SafetyReview : stryMutAct_9fa48("4869") ? false : stryMutAct_9fa48("4868") ? true : (stryCov_9fa48("4868", "4869", "4870"), from === EVENT_STATUS.SafetyReview);
    const published = await getPublisher().publish(stryMutAct_9fa48("4871") ? {} : (stryCov_9fa48("4871"), {
      type: fromSafety ? stryMutAct_9fa48("4872") ? "" : (stryCov_9fa48("4872"), "event.returned_to_planning") : stryMutAct_9fa48("4873") ? "" : (stryCov_9fa48("4873"), "event.needs_review"),
      eventId: row.id,
      actorId: null,
      recipients: stryMutAct_9fa48("4874") ? {} : (stryCov_9fa48("4874"), {
        userIds,
        roles: fromSafety ? stryMutAct_9fa48("4875") ? [] : (stryCov_9fa48("4875"), [stryMutAct_9fa48("4876") ? "" : (stryCov_9fa48("4876"), "safety_officer")]) : stryMutAct_9fa48("4877") ? ["Stryker was here"] : (stryCov_9fa48("4877"), [])
      }),
      data: stryMutAct_9fa48("4878") ? {} : (stryCov_9fa48("4878"), {
        eventName,
        reason
      })
    }));
    res.json(stryMutAct_9fa48("4880") ? {} : (stryCov_9fa48("4880"), {
      changed: stryMutAct_9fa48("4881") ? false : (stryCov_9fa48("4881"), true),
      status: to,
      notificationsFailed: stryMutAct_9fa48("4882") ? published : (stryCov_9fa48("4882"), !published)
    }));
  }
}