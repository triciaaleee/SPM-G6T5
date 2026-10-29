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
import { supabaseAdmin } from "../lib/supabaseAdmin.js";
import { EVENT_STATUS } from "../lib/eventStatus.js";
import { isPositiveInteger } from "../lib/validation.js";
import { ATTENDEE_INFO_FIELDS, attendeeAccessibility, attendeeOrganiserName, registrationInfo } from "./events.js";
import { clock } from "../lib/clock.js";

/**
 * Guests browsing the public landing pages: the events attendees can already
 * see (Confirmed, registration opened — the same `listed` rule as
 * GET /open-for-registration), with no login. Registering still needs an
 * attendee account; this only lets someone look first.
 *
 * Same whitelist as the attendee routes, minus capacity: a place count would
 * need registration-service's registered count, which is not public.
 */
export const publicEventsRouter = Router();
const EVENT_COLUMNS = stryMutAct_9fa48("4883") ? "" : (stryCov_9fa48("4883"), "id, status, submitted_details, registration_open_date, registration_override, organiser:organiser_id(name)");
interface PublicEventRow {
  id: number;
  status: string;
  submitted_details: Record<string, unknown> | null;
  registration_open_date: unknown;
  registration_override: unknown;
  organiser: unknown;
}

/** The listed event as guests see it, or null when it isn't listed. */
function toPublicEvent(row: PublicEventRow, now: Date) {
  if (stryMutAct_9fa48("4884")) {
    {}
  } else {
    stryCov_9fa48("4884");
    const details = (row.submitted_details ?? {}) as Record<string, unknown>;
    const registration = registrationInfo(row, details, now);
    if (stryMutAct_9fa48("4887") ? false : stryMutAct_9fa48("4886") ? true : stryMutAct_9fa48("4885") ? registration.listed : (stryCov_9fa48("4885", "4886", "4887"), !registration.listed)) return null;
    const event: Record<string, unknown> = stryMutAct_9fa48("4888") ? {} : (stryCov_9fa48("4888"), {
      id: row.id,
      registrationState: registration.registrationState,
      open: registration.open,
      accessibility: attendeeAccessibility(details.accessibility),
      organiserName: attendeeOrganiserName(row.organiser)
    });
    for (const field of ATTENDEE_INFO_FIELDS) event[field] = stryMutAct_9fa48("4889") ? details[field] && null : (stryCov_9fa48("4889"), details[field] ?? null);
    return event;
  }
}

// Stryker disable next-line StringLiteral: equivalent - the router treats the path "" exactly like "/"
if (stryMutAct_9fa48("4890")) {
  ;
} else {
  stryCov_9fa48("4890");
  publicEventsRouter.get("/", async (_req, res) => {
    if (stryMutAct_9fa48("4892")) {
      {}
    } else {
      stryCov_9fa48("4892");
      const {
        data,
        error
      } = await supabaseAdmin.from(stryMutAct_9fa48("4893") ? "" : (stryCov_9fa48("4893"), "events")).select(EVENT_COLUMNS).eq(stryMutAct_9fa48("4894") ? "" : (stryCov_9fa48("4894"), "status"), EVENT_STATUS.Confirmed);
      if (stryMutAct_9fa48("4896") ? false : stryMutAct_9fa48("4895") ? true : (stryCov_9fa48("4895", "4896"), error)) {
        if (stryMutAct_9fa48("4897")) {
          {}
        } else {
          stryCov_9fa48("4897");
          res.status(500).json(stryMutAct_9fa48("4899") ? {} : (stryCov_9fa48("4899"), {
            error: stryMutAct_9fa48("4900") ? "" : (stryCov_9fa48("4900"), "Failed to load events")
          }));
          return;
        }
      }
      const now = clock.now();
      const events = ((data ?? []) as PublicEventRow[]).flatMap(stryMutAct_9fa48("4901") ? () => undefined : (stryCov_9fa48("4901"), row => stryMutAct_9fa48("4902") ? toPublicEvent(row, now) && [] : (stryCov_9fa48("4902"), toPublicEvent(row, now) ?? (stryMutAct_9fa48("4903") ? ["Stryker was here"] : (stryCov_9fa48("4903"), [])))));
      res.json(stryMutAct_9fa48("4905") ? {} : (stryCov_9fa48("4905"), {
        events
      }));
    }
  });
}
/** One listed event. Anything else — unlisted, not Confirmed, missing — is a plain 404. */
if (stryMutAct_9fa48("4906")) {
  ;
} else {
  stryCov_9fa48("4906");
  publicEventsRouter.get(stryMutAct_9fa48("4907") ? "" : (stryCov_9fa48("4907"), "/:id"), async (req, res) => {
    if (stryMutAct_9fa48("4908")) {
      {}
    } else {
      stryCov_9fa48("4908");
      if (stryMutAct_9fa48("4911") ? false : stryMutAct_9fa48("4910") ? true : stryMutAct_9fa48("4909") ? isPositiveInteger(req.params.id) : (stryCov_9fa48("4909", "4910", "4911"), !isPositiveInteger(req.params.id))) {
        if (stryMutAct_9fa48("4912")) {
          {}
        } else {
          stryCov_9fa48("4912");
          res.status(400).json(stryMutAct_9fa48("4914") ? {} : (stryCov_9fa48("4914"), {
            error: stryMutAct_9fa48("4915") ? "" : (stryCov_9fa48("4915"), "Invalid event id")
          }));
          return;
        }
      }
      const {
        data,
        error
      } = await supabaseAdmin.from(stryMutAct_9fa48("4916") ? "" : (stryCov_9fa48("4916"), "events")).select(EVENT_COLUMNS).eq(stryMutAct_9fa48("4917") ? "" : (stryCov_9fa48("4917"), "id"), Number(req.params.id)).eq(stryMutAct_9fa48("4918") ? "" : (stryCov_9fa48("4918"), "status"), EVENT_STATUS.Confirmed).maybeSingle();
      if (stryMutAct_9fa48("4920") ? false : stryMutAct_9fa48("4919") ? true : (stryCov_9fa48("4919", "4920"), error)) {
        if (stryMutAct_9fa48("4921")) {
          {}
        } else {
          stryCov_9fa48("4921");
          res.status(500).json(stryMutAct_9fa48("4923") ? {} : (stryCov_9fa48("4923"), {
            error: stryMutAct_9fa48("4924") ? "" : (stryCov_9fa48("4924"), "Failed to load the event")
          }));
          return;
        }
      }
      const event = data ? toPublicEvent(data as PublicEventRow, clock.now()) : null;
      if (stryMutAct_9fa48("4927") ? false : stryMutAct_9fa48("4926") ? true : stryMutAct_9fa48("4925") ? event : (stryCov_9fa48("4925", "4926", "4927"), !event)) {
        if (stryMutAct_9fa48("4928")) {
          {}
        } else {
          stryCov_9fa48("4928");
          res.status(404).json(stryMutAct_9fa48("4930") ? {} : (stryCov_9fa48("4930"), {
            error: stryMutAct_9fa48("4931") ? "" : (stryCov_9fa48("4931"), "Event not found")
          }));
          return;
        }
      }
      res.json(stryMutAct_9fa48("4933") ? {} : (stryCov_9fa48("4933"), {
        event
      }));
    }
  });
}