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
import type { ArrangementBooking, ArrangementEquipmentRequest } from "./arrangementsClient.js";
import { MAX_SAFETY_DECISION_REASON_LENGTH } from "./safetyReview.js";

/**
 * E3-14: the Safety Officer requests changes to specific arrangements of an
 * event in Safety Review, short of rejecting it. The rules are pure, so the
 * routes only fetch and write.
 *
 * An arrangement is either a venue booking (venue-service) or one item of
 * an equipment request (equipment-service). Each flag keeps a snapshot of
 * the arrangement as it was when flagged; the flag clears once the
 * arrangement no longer matches it (AC3). What "changed" means:
 *
 * - venue booking: its status moved on (released, withdrawn, replaced…).
 *   A booking's venue and event can't be edited, so changing it means
 *   releasing it and booking another.
 * - equipment item: its type, quantity or reserved quantity changed, or it
 *   was removed.
 */

export type ArrangementType = "venue_booking" | "equipment_item";

/** An arrangement the Safety Officer can flag. */
export interface ArrangementOption {
  type: ArrangementType;
  id: number;
  label: string;
  /** e.g. "Approved", or "2 of 2 reserved". */
  detail: string;
}
type Snapshot = Record<string, string | number>;

/** Bookings that no longer hold or ask for a venue have nothing to re-review. */
const ENDED_BOOKING_STATUSES = new Set(stryMutAct_9fa48("783") ? [] : (stryCov_9fa48("783"), [stryMutAct_9fa48("784") ? "" : (stryCov_9fa48("784"), "Rejected"), stryMutAct_9fa48("785") ? "" : (stryCov_9fa48("785"), "Withdrawn"), stryMutAct_9fa48("786") ? "" : (stryCov_9fa48("786"), "Expired")]));
function key(type: ArrangementType, id: number): string {
  if (stryMutAct_9fa48("787")) {
    {}
  } else {
    stryCov_9fa48("787");
    return stryMutAct_9fa48("788") ? `` : (stryCov_9fa48("788"), `${type}:${id}`);
  }
}

/** The current state of every arrangement, keyed by type and id. */
export function currentArrangements(bookings: ArrangementBooking[], equipmentRequests: ArrangementEquipmentRequest[]): Map<string, {
  option: ArrangementOption;
  snapshot: Snapshot;
  flaggable: boolean;
}> {
  if (stryMutAct_9fa48("789")) {
    {}
  } else {
    stryCov_9fa48("789");
    const states = new Map<string, {
      option: ArrangementOption;
      snapshot: Snapshot;
      flaggable: boolean;
    }>();
    for (const booking of bookings) {
      if (stryMutAct_9fa48("790")) {
        {}
      } else {
        stryCov_9fa48("790");
        states.set(key(stryMutAct_9fa48("792") ? "" : (stryCov_9fa48("792"), "venue_booking"), booking.id), stryMutAct_9fa48("793") ? {} : (stryCov_9fa48("793"), {
          option: stryMutAct_9fa48("794") ? {} : (stryCov_9fa48("794"), {
            type: stryMutAct_9fa48("795") ? "" : (stryCov_9fa48("795"), "venue_booking"),
            id: booking.id,
            label: stryMutAct_9fa48("796") ? booking.venue?.name && `Venue booking #${booking.id}` : (stryCov_9fa48("796"), (stryMutAct_9fa48("797") ? booking.venue.name : (stryCov_9fa48("797"), booking.venue?.name)) ?? (stryMutAct_9fa48("798") ? `` : (stryCov_9fa48("798"), `Venue booking #${booking.id}`))),
            detail: booking.status
          }),
          snapshot: stryMutAct_9fa48("799") ? {} : (stryCov_9fa48("799"), {
            status: booking.status
          }),
          flaggable: stryMutAct_9fa48("800") ? ENDED_BOOKING_STATUSES.has(booking.status) : (stryCov_9fa48("800"), !ENDED_BOOKING_STATUSES.has(booking.status))
        }));
      }
    }
    for (const request of equipmentRequests) {
      if (stryMutAct_9fa48("801")) {
        {}
      } else {
        stryCov_9fa48("801");
        for (const item of request.items) {
          if (stryMutAct_9fa48("802")) {
            {}
          } else {
            stryCov_9fa48("802");
            states.set(key(stryMutAct_9fa48("804") ? "" : (stryCov_9fa48("804"), "equipment_item"), item.id), stryMutAct_9fa48("805") ? {} : (stryCov_9fa48("805"), {
              option: stryMutAct_9fa48("806") ? {} : (stryCov_9fa48("806"), {
                type: stryMutAct_9fa48("807") ? "" : (stryCov_9fa48("807"), "equipment_item"),
                id: item.id,
                label: stryMutAct_9fa48("808") ? `` : (stryCov_9fa48("808"), `${item.equipmentType} × ${item.quantity}`),
                detail: stryMutAct_9fa48("809") ? `` : (stryCov_9fa48("809"), `${item.quantityFulfilled} of ${item.quantity} reserved`)
              }),
              snapshot: stryMutAct_9fa48("810") ? {} : (stryCov_9fa48("810"), {
                equipmentType: item.equipmentType,
                quantity: item.quantity,
                quantityFulfilled: item.quantityFulfilled
              }),
              flaggable: stryMutAct_9fa48("811") ? false : (stryCov_9fa48("811"), true)
            }));
          }
        }
      }
    }
    return states;
  }
}

/** AC1: what the Safety Officer may pick from — the event's live venue bookings and its equipment items. */
export function arrangementOptions(bookings: ArrangementBooking[], equipmentRequests: ArrangementEquipmentRequest[]): ArrangementOption[] {
  if (stryMutAct_9fa48("812")) {
    {}
  } else {
    stryCov_9fa48("812");
    return stryMutAct_9fa48("813") ? [...currentArrangements(bookings, equipmentRequests).values()].map(s => s.option) : (stryCov_9fa48("813"), (stryMutAct_9fa48("814") ? [] : (stryCov_9fa48("814"), [...currentArrangements(bookings, equipmentRequests).values()])).filter(stryMutAct_9fa48("815") ? () => undefined : (stryCov_9fa48("815"), s => s.flaggable)).map(stryMutAct_9fa48("816") ? () => undefined : (stryCov_9fa48("816"), s => s.option)));
  }
}

/** What must change about one arrangement — or, in general, about the event — is capped like a reason. */
export const MAX_SAFETY_CHANGE_NOTE_LENGTH = MAX_SAFETY_DECISION_REASON_LENGTH;
export interface ChangeRequest {
  /** Each picked arrangement with what must change about it. */
  arrangements: {
    type: ArrangementType;
    id: number;
    note: string;
  }[];
  /** Anything not about one arrangement; optional. */
  generalNote: string | null;
}
export type ParsedChangeRequest = {
  valid: true;
  request: ChangeRequest;
} | {
  valid: false;
  fields: Record<string, string>;
};

/**
 * AC1/AC2: `{ arrangements: [{ type, id, note }], generalNote? }`. At least
 * one arrangement is required, and each picked one needs a note saying what
 * must change about it; the general note is optional. Every problem is
 * reported at once: `arrangements` for the list itself, and
 * `note:<type>:<id>` for a picked arrangement's missing or over-long note.
 */
export function parseChangeRequest(body: unknown): ParsedChangeRequest {
  if (stryMutAct_9fa48("817")) {
    {}
  } else {
    stryCov_9fa48("817");
    const raw = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const fields: Record<string, string> = {};
    const arrangements: ChangeRequest["arrangements"] = stryMutAct_9fa48("818") ? ["Stryker was here"] : (stryCov_9fa48("818"), []);
    const seen = new Set<string>();
    const list = Array.isArray(raw.arrangements) ? raw.arrangements : stryMutAct_9fa48("819") ? ["Stryker was here"] : (stryCov_9fa48("819"), []);
    for (const entry of list) {
      if (stryMutAct_9fa48("820")) {
        {}
      } else {
        stryCov_9fa48("820");
        const item = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
        const type = item.type;
        const id = item.id;
        if (stryMutAct_9fa48("823") ? (type !== "venue_booking" && type !== "equipment_item" || !Number.isInteger(id)) && id as number < 1 : stryMutAct_9fa48("822") ? false : stryMutAct_9fa48("821") ? true : (stryCov_9fa48("821", "822", "823"), (stryMutAct_9fa48("825") ? type !== "venue_booking" && type !== "equipment_item" && !Number.isInteger(id) : stryMutAct_9fa48("824") ? false : (stryCov_9fa48("824", "825"), (stryMutAct_9fa48("827") ? type !== "venue_booking" || type !== "equipment_item" : stryMutAct_9fa48("826") ? false : (stryCov_9fa48("826", "827"), (stryMutAct_9fa48("829") ? type === "venue_booking" : stryMutAct_9fa48("828") ? true : (stryCov_9fa48("828", "829"), type !== (stryMutAct_9fa48("830") ? "" : (stryCov_9fa48("830"), "venue_booking")))) && (stryMutAct_9fa48("832") ? type === "equipment_item" : stryMutAct_9fa48("831") ? true : (stryCov_9fa48("831", "832"), type !== (stryMutAct_9fa48("833") ? "" : (stryCov_9fa48("833"), "equipment_item")))))) || (stryMutAct_9fa48("834") ? Number.isInteger(id) : (stryCov_9fa48("834"), !Number.isInteger(id))))) || (stryMutAct_9fa48("837") ? id as number >= 1 : stryMutAct_9fa48("836") ? id as number <= 1 : stryMutAct_9fa48("835") ? false : (stryCov_9fa48("835", "836", "837"), id as number < 1)))) {
          if (stryMutAct_9fa48("838")) {
            {}
          } else {
            stryCov_9fa48("838");
            fields.arrangements = stryMutAct_9fa48("839") ? "" : (stryCov_9fa48("839"), "Each arrangement needs a type (venue_booking or equipment_item) and an id.");
            continue;
          }
        }
        const itemKey = key(type, id as number);
        if (stryMutAct_9fa48("841") ? false : stryMutAct_9fa48("840") ? true : (stryCov_9fa48("840", "841"), seen.has(itemKey))) continue;
        if (stryMutAct_9fa48("842")) {
          ;
        } else {
          stryCov_9fa48("842");
          seen.add(itemKey);
        }
        const note = (stryMutAct_9fa48("845") ? typeof item.note !== "string" : stryMutAct_9fa48("844") ? false : stryMutAct_9fa48("843") ? true : (stryCov_9fa48("843", "844", "845"), typeof item.note === (stryMutAct_9fa48("846") ? "" : (stryCov_9fa48("846"), "string")))) ? stryMutAct_9fa48("847") ? item.note : (stryCov_9fa48("847"), item.note.trim()) : stryMutAct_9fa48("848") ? "Stryker was here!" : (stryCov_9fa48("848"), "");
        if (stryMutAct_9fa48("851") ? false : stryMutAct_9fa48("850") ? true : stryMutAct_9fa48("849") ? note : (stryCov_9fa48("849", "850", "851"), !note)) fields[stryMutAct_9fa48("852") ? `` : (stryCov_9fa48("852"), `note:${itemKey}`)] = stryMutAct_9fa48("853") ? "" : (stryCov_9fa48("853"), "Say what must change here.");else if (stryMutAct_9fa48("857") ? note.length <= MAX_SAFETY_CHANGE_NOTE_LENGTH : stryMutAct_9fa48("856") ? note.length >= MAX_SAFETY_CHANGE_NOTE_LENGTH : stryMutAct_9fa48("855") ? false : stryMutAct_9fa48("854") ? true : (stryCov_9fa48("854", "855", "856", "857"), note.length > MAX_SAFETY_CHANGE_NOTE_LENGTH)) {
          if (stryMutAct_9fa48("858")) {
            {}
          } else {
            stryCov_9fa48("858");
            fields[stryMutAct_9fa48("859") ? `` : (stryCov_9fa48("859"), `note:${itemKey}`)] = stryMutAct_9fa48("860") ? `` : (stryCov_9fa48("860"), `Keep this under ${MAX_SAFETY_CHANGE_NOTE_LENGTH} characters.`);
          }
        }
        if (stryMutAct_9fa48("861")) {
          ;
        } else {
          stryCov_9fa48("861");
          arrangements.push(stryMutAct_9fa48("862") ? {} : (stryCov_9fa48("862"), {
            type,
            id: id as number,
            note
          }));
        }
      }
    }
    if (stryMutAct_9fa48("865") ? !fields.arrangements || arrangements.length === 0 : stryMutAct_9fa48("864") ? false : stryMutAct_9fa48("863") ? true : (stryCov_9fa48("863", "864", "865"), (stryMutAct_9fa48("866") ? fields.arrangements : (stryCov_9fa48("866"), !fields.arrangements)) && (stryMutAct_9fa48("868") ? arrangements.length !== 0 : stryMutAct_9fa48("867") ? true : (stryCov_9fa48("867", "868"), arrangements.length === 0)))) {
      if (stryMutAct_9fa48("869")) {
        {}
      } else {
        stryCov_9fa48("869");
        fields.arrangements = stryMutAct_9fa48("870") ? "" : (stryCov_9fa48("870"), "Select at least one venue booking or equipment reservation that must change.");
      }
    }
    const general = (stryMutAct_9fa48("873") ? typeof raw.generalNote !== "string" : stryMutAct_9fa48("872") ? false : stryMutAct_9fa48("871") ? true : (stryCov_9fa48("871", "872", "873"), typeof raw.generalNote === (stryMutAct_9fa48("874") ? "" : (stryCov_9fa48("874"), "string")))) ? stryMutAct_9fa48("875") ? raw.generalNote : (stryCov_9fa48("875"), raw.generalNote.trim()) : stryMutAct_9fa48("876") ? "Stryker was here!" : (stryCov_9fa48("876"), "");
    if (stryMutAct_9fa48("880") ? general.length <= MAX_SAFETY_CHANGE_NOTE_LENGTH : stryMutAct_9fa48("879") ? general.length >= MAX_SAFETY_CHANGE_NOTE_LENGTH : stryMutAct_9fa48("878") ? false : stryMutAct_9fa48("877") ? true : (stryCov_9fa48("877", "878", "879", "880"), general.length > MAX_SAFETY_CHANGE_NOTE_LENGTH)) {
      if (stryMutAct_9fa48("881")) {
        {}
      } else {
        stryCov_9fa48("881");
        fields.generalNote = stryMutAct_9fa48("882") ? `` : (stryCov_9fa48("882"), `Keep this under ${MAX_SAFETY_CHANGE_NOTE_LENGTH} characters.`);
      }
    }
    return (stryMutAct_9fa48("886") ? Object.keys(fields).length <= 0 : stryMutAct_9fa48("885") ? Object.keys(fields).length >= 0 : stryMutAct_9fa48("884") ? false : stryMutAct_9fa48("883") ? true : (stryCov_9fa48("883", "884", "885", "886"), Object.keys(fields).length > 0)) ? stryMutAct_9fa48("887") ? {} : (stryCov_9fa48("887"), {
      valid: stryMutAct_9fa48("888") ? true : (stryCov_9fa48("888"), false),
      fields
    }) : stryMutAct_9fa48("889") ? {} : (stryCov_9fa48("889"), {
      valid: stryMutAct_9fa48("890") ? false : (stryCov_9fa48("890"), true),
      request: stryMutAct_9fa48("891") ? {} : (stryCov_9fa48("891"), {
        arrangements,
        generalNote: stryMutAct_9fa48("894") ? general && null : stryMutAct_9fa48("893") ? false : stryMutAct_9fa48("892") ? true : (stryCov_9fa48("892", "893", "894"), general || null)
      })
    });
  }
}

/** A flag to store: the arrangement, its label, what must change and its state when flagged. */
export interface NewFlag {
  type: ArrangementType;
  id: number;
  label: string;
  note: string;
  snapshot: Snapshot;
}

/** Turns the selection into flags, or names the ones that aren't this event's (live) arrangements. */
export function resolveFlags(selected: ChangeRequest["arrangements"], bookings: ArrangementBooking[], equipmentRequests: ArrangementEquipmentRequest[]): {
  ok: true;
  flags: NewFlag[];
} | {
  ok: false;
  unknown: ChangeRequest["arrangements"];
} {
  if (stryMutAct_9fa48("895")) {
    {}
  } else {
    stryCov_9fa48("895");
    const states = currentArrangements(bookings, equipmentRequests);
    const flags: NewFlag[] = stryMutAct_9fa48("896") ? ["Stryker was here"] : (stryCov_9fa48("896"), []);
    const unknown: ChangeRequest["arrangements"] = stryMutAct_9fa48("897") ? ["Stryker was here"] : (stryCov_9fa48("897"), []);
    for (const choice of selected) {
      if (stryMutAct_9fa48("898")) {
        {}
      } else {
        stryCov_9fa48("898");
        const state = states.get(key(choice.type, choice.id));
        if (stryMutAct_9fa48("901") ? !state && !state.flaggable : stryMutAct_9fa48("900") ? false : stryMutAct_9fa48("899") ? true : (stryCov_9fa48("899", "900", "901"), (stryMutAct_9fa48("902") ? state : (stryCov_9fa48("902"), !state)) || (stryMutAct_9fa48("903") ? state.flaggable : (stryCov_9fa48("903"), !state.flaggable)))) {
          if (stryMutAct_9fa48("904")) {
            ;
          } else {
            stryCov_9fa48("904");
            unknown.push(choice);
          }
        } else flags.push(stryMutAct_9fa48("906") ? {} : (stryCov_9fa48("906"), {
          type: choice.type,
          id: choice.id,
          label: state.option.label,
          note: choice.note,
          snapshot: state.snapshot
        }));
      }
    }
    return (stryMutAct_9fa48("910") ? unknown.length <= 0 : stryMutAct_9fa48("909") ? unknown.length >= 0 : stryMutAct_9fa48("908") ? false : stryMutAct_9fa48("907") ? true : (stryCov_9fa48("907", "908", "909", "910"), unknown.length > 0)) ? stryMutAct_9fa48("911") ? {} : (stryCov_9fa48("911"), {
      ok: stryMutAct_9fa48("912") ? true : (stryCov_9fa48("912"), false),
      unknown
    }) : stryMutAct_9fa48("913") ? {} : (stryCov_9fa48("913"), {
      ok: stryMutAct_9fa48("914") ? false : (stryCov_9fa48("914"), true),
      flags
    });
  }
}

/**
 * The decision's reason (event_safety_reviews.reason, required there): every
 * note, labelled, then the general note — e.g. "Seminar Room 3-01: exits
 * blocked; PA system × 2: move away from the exit. General: update the
 * crowd plan." Decision history and notifications read it as one text.
 */
export function combinedReason(flags: Pick<NewFlag, "label" | "note">[], generalNote: string | null): string {
  if (stryMutAct_9fa48("915")) {
    {}
  } else {
    stryCov_9fa48("915");
    // Trailing punctuation goes, so joining never gives "exit.; " or "exit.. General".
    const items = flags.map(stryMutAct_9fa48("916") ? () => undefined : (stryCov_9fa48("916"), flag => stryMutAct_9fa48("917") ? `` : (stryCov_9fa48("917"), `${flag.label}: ${flag.note.replace(stryMutAct_9fa48("921") ? /[.;\S]+$/ : stryMutAct_9fa48("920") ? /[^.;\s]+$/ : stryMutAct_9fa48("919") ? /[.;\s]$/ : stryMutAct_9fa48("918") ? /[.;\s]+/ : (stryCov_9fa48("918", "919", "920", "921"), /[.;\s]+$/), stryMutAct_9fa48("922") ? "Stryker was here!" : (stryCov_9fa48("922"), ""))}`))).join(stryMutAct_9fa48("923") ? "" : (stryCov_9fa48("923"), "; "));
    return generalNote ? stryMutAct_9fa48("924") ? `` : (stryCov_9fa48("924"), `${items}. General: ${generalNote}`) : items;
  }
}

/** A stored flag, as far as clearing is concerned. */
export interface StoredFlag {
  arrangement_type: ArrangementType;
  arrangement_id: number;
  snapshot: Snapshot;
}

/** AC3: the arrangement no longer looks as it did when flagged (or is gone). */
export function hasChanged(flag: StoredFlag, states: ReturnType<typeof currentArrangements>): boolean {
  if (stryMutAct_9fa48("925")) {
    {}
  } else {
    stryCov_9fa48("925");
    const state = states.get(key(flag.arrangement_type, Number(flag.arrangement_id)));
    if (stryMutAct_9fa48("928") ? false : stryMutAct_9fa48("927") ? true : stryMutAct_9fa48("926") ? state : (stryCov_9fa48("926", "927", "928"), !state)) return stryMutAct_9fa48("929") ? false : (stryCov_9fa48("929"), true);
    const before = stryMutAct_9fa48("930") ? flag.snapshot && {} : (stryCov_9fa48("930"), flag.snapshot ?? {});
    const keys = new Set(stryMutAct_9fa48("931") ? [] : (stryCov_9fa48("931"), [...Object.keys(before), ...Object.keys(state.snapshot)]));
    return stryMutAct_9fa48("932") ? [...keys].every(k => before[k] !== state.snapshot[k]) : (stryCov_9fa48("932"), (stryMutAct_9fa48("933") ? [] : (stryCov_9fa48("933"), [...keys])).some(stryMutAct_9fa48("934") ? () => undefined : (stryCov_9fa48("934"), k => stryMutAct_9fa48("937") ? before[k] === state.snapshot[k] : stryMutAct_9fa48("936") ? false : stryMutAct_9fa48("935") ? true : (stryCov_9fa48("935", "936", "937"), before[k] !== state.snapshot[k]))));
  }
}