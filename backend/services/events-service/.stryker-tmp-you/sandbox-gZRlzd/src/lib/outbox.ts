// @ts-nocheck
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
import type { supabaseAdmin } from "./supabaseAdmin.js";
import { getPublisher, type OutboundMessage } from "./rabbitPublisher.js";
import { clock } from "./clock.js";
type Supabase = typeof supabaseAdmin;

/**
 * Reliable publishing for a message another service must act on (today
 * `event.cancelled`; migration 0045). The message is stored in
 * `event_outbox` right after the DB write it announces, then published.
 * If the broker is down or the service stops first, `flushOutbox` (run on
 * a timer by index.ts) keeps retrying until the broker confirms it. A
 * notification-only message doesn't need this; it publishes directly.
 *
 * Delivery is at-least-once: a retry reuses the stored `message_id`, so a
 * consumer can skip a repeat. The store is not in the same transaction as
 * the write it announces, so a crash between the two can still lose the
 * message; it is a much smaller window than a broker outage.
 */

interface OutboxRow {
  id: number;
  message_id: string;
  type: string;
  event_id: number | null;
  actor_id: string | null;
  recipients: {
    userIds: string[];
    roles: string[];
  };
  data: Record<string, unknown>;
  occurred_at: string;
}
const OUTBOX_COLUMNS = stryMutAct_9fa48("497") ? "" : (stryCov_9fa48("497"), "id, message_id, type, event_id, actor_id, recipients, data, occurred_at");
const FLUSH_BATCH = 50;
function toMessage(row: OutboxRow): OutboundMessage {
  if (stryMutAct_9fa48("498")) {
    {}
  } else {
    stryCov_9fa48("498");
    return stryMutAct_9fa48("499") ? {} : (stryCov_9fa48("499"), {
      messageId: row.message_id,
      occurredAt: row.occurred_at,
      type: row.type,
      eventId: row.event_id,
      actorId: row.actor_id,
      recipients: row.recipients,
      data: row.data
    });
  }
}
async function markPublished(supabase: Supabase, id: number): Promise<void> {
  if (stryMutAct_9fa48("500")) {
    {}
  } else {
    stryCov_9fa48("500");
    const {
      error
    } = await supabase.from(stryMutAct_9fa48("501") ? "" : (stryCov_9fa48("501"), "event_outbox")).update(stryMutAct_9fa48("502") ? {} : (stryCov_9fa48("502"), {
      published_at: clock.now().toISOString()
    })).eq(stryMutAct_9fa48("503") ? "" : (stryCov_9fa48("503"), "id"), id);
    // Left unmarked, the relay will publish it again; a consumer skips the repeat.
    if (stryMutAct_9fa48("505") ? false : stryMutAct_9fa48("504") ? true : (stryCov_9fa48("504", "505"), error)) console.error(stryMutAct_9fa48("507") ? `` : (stryCov_9fa48("507"), `events-service: could not mark outbox row ${id} published`), error);
  }
}
async function markFailed(supabase: Supabase, row: OutboxRow, attempts: number): Promise<void> {
  if (stryMutAct_9fa48("508")) {
    {}
  } else {
    stryCov_9fa48("508");
    const {
      error
    } = await supabase.from(stryMutAct_9fa48("509") ? "" : (stryCov_9fa48("509"), "event_outbox")).update(stryMutAct_9fa48("510") ? {} : (stryCov_9fa48("510"), {
      attempts,
      last_error: stryMutAct_9fa48("511") ? "" : (stryCov_9fa48("511"), "broker did not confirm the message")
    })).eq(stryMutAct_9fa48("512") ? "" : (stryCov_9fa48("512"), "id"), row.id);
    if (stryMutAct_9fa48("514") ? false : stryMutAct_9fa48("513") ? true : (stryCov_9fa48("513", "514"), error)) console.error(stryMutAct_9fa48("516") ? `` : (stryCov_9fa48("516"), `events-service: could not record the failed attempt on outbox row ${row.id}`), error);
  }
}

/**
 * Stores `msg`, then tries to publish it once. Resolves true when the
 * message is safe: published, or stored for the relay to retry. Resolves
 * false only when it could neither be stored nor published directly.
 */
export async function publishDurably(supabase: Supabase, msg: OutboundMessage): Promise<boolean> {
  if (stryMutAct_9fa48("517")) {
    {}
  } else {
    stryCov_9fa48("517");
    const {
      data,
      error
    } = await supabase.from(stryMutAct_9fa48("518") ? "" : (stryCov_9fa48("518"), "event_outbox")).insert(stryMutAct_9fa48("519") ? {} : (stryCov_9fa48("519"), {
      type: msg.type,
      event_id: msg.eventId,
      actor_id: msg.actorId,
      recipients: msg.recipients,
      data: msg.data
    })).select(OUTBOX_COLUMNS).single();
    if (stryMutAct_9fa48("522") ? error && !data : stryMutAct_9fa48("521") ? false : stryMutAct_9fa48("520") ? true : (stryCov_9fa48("520", "521", "522"), error || (stryMutAct_9fa48("523") ? data : (stryCov_9fa48("523"), !data)))) {
      if (stryMutAct_9fa48("524")) {
        {}
      } else {
        stryCov_9fa48("524");
        console.error(stryMutAct_9fa48("526") ? `` : (stryCov_9fa48("526"), `events-service: could not store "${msg.type}" in the outbox, publishing it directly`), error);
        return getPublisher().publish(msg);
      }
    }
    const row = data as unknown as OutboxRow;
    if (stryMutAct_9fa48("528") ? false : stryMutAct_9fa48("527") ? true : (stryCov_9fa48("527", "528"), await getPublisher().publish(toMessage(row)))) {
      if (stryMutAct_9fa48("529")) {
        {}
      } else {
        stryCov_9fa48("529");
        await markPublished(supabase, row.id);
      }
    }
    return stryMutAct_9fa48("530") ? false : (stryCov_9fa48("530"), true);
  }
}

/**
 * Publishes what is still waiting, oldest first. Stops at the first
 * failure: the broker is likely down, and later messages should not
 * overtake an earlier one. Resolves how many it published.
 */
export async function flushOutbox(supabase: Supabase): Promise<number> {
  if (stryMutAct_9fa48("531")) {
    {}
  } else {
    stryCov_9fa48("531");
    const {
      data,
      error
    } = await supabase.from(stryMutAct_9fa48("532") ? "" : (stryCov_9fa48("532"), "event_outbox")).select(stryMutAct_9fa48("533") ? `` : (stryCov_9fa48("533"), `${OUTBOX_COLUMNS}, attempts`)).is(stryMutAct_9fa48("534") ? "" : (stryCov_9fa48("534"), "published_at"), null).order(stryMutAct_9fa48("535") ? "" : (stryCov_9fa48("535"), "id"), stryMutAct_9fa48("536") ? {} : (stryCov_9fa48("536"), {
      ascending: stryMutAct_9fa48("537") ? false : (stryCov_9fa48("537"), true)
    })).limit(FLUSH_BATCH);
    if (stryMutAct_9fa48("539") ? false : stryMutAct_9fa48("538") ? true : (stryCov_9fa48("538", "539"), error)) {
      if (stryMutAct_9fa48("540")) {
        {}
      } else {
        stryCov_9fa48("540");
        console.error(stryMutAct_9fa48("542") ? "" : (stryCov_9fa48("542"), "events-service: could not read the outbox"), error);
        return 0;
      }
    }
    let published = 0;
    for (const row of (data ?? []) as unknown as (OutboxRow & {
      attempts: number;
    })[]) {
      if (stryMutAct_9fa48("543")) {
        {}
      } else {
        stryCov_9fa48("543");
        if (stryMutAct_9fa48("546") ? false : stryMutAct_9fa48("545") ? true : stryMutAct_9fa48("544") ? await getPublisher().publish(toMessage(row)) : (stryCov_9fa48("544", "545", "546"), !(await getPublisher().publish(toMessage(row))))) {
          if (stryMutAct_9fa48("547")) {
            {}
          } else {
            stryCov_9fa48("547");
            await markFailed(supabase, row, stryMutAct_9fa48("548") ? row.attempts - 1 : (stryCov_9fa48("548"), row.attempts + 1));
            break;
          }
        }
        await markPublished(supabase, row.id);
        stryMutAct_9fa48("549") ? published -= 1 : (stryCov_9fa48("549"), published += 1);
      }
    }
    return published;
  }
}

/** Runs `flushOutbox` on a timer; a failed run is logged and the next one tries again. */
export function startOutboxRelay(supabase: Supabase, intervalMs = 10_000): () => void {
  if (stryMutAct_9fa48("550")) {
    {}
  } else {
    stryCov_9fa48("550");
    const timer = setInterval(() => {
      if (stryMutAct_9fa48("551")) {
        {}
      } else {
        stryCov_9fa48("551");
        flushOutbox(supabase).catch(stryMutAct_9fa48("553") ? () => undefined : (stryCov_9fa48("553"), err => console.error(stryMutAct_9fa48("554") ? "" : (stryCov_9fa48("554"), "events-service: outbox relay failed"), err)));
      }
    }, intervalMs);
    return stryMutAct_9fa48("555") ? () => undefined : (stryCov_9fa48("555"), () => clearInterval(timer));
  }
}