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
import amqp from "amqplib";
import { randomUUID } from "node:crypto";
import { clock } from "./clock.js";

/**
 * The envelope every publisher on `connectsphere.events` uses
 * (c4_diagrams/RabbitMQ.md section 2).
 */
export interface OutboundMessage {
  /** Set by the outbox so a retry reuses the same id and consumers can skip a repeat; otherwise generated. */
  messageId?: string;
  /** Likewise kept stable across retries. */
  occurredAt?: string;
  type: string;
  eventId: number | null;
  actorId: string | null;
  recipients: {
    userIds: string[];
    roles: string[];
  };
  data: Record<string, unknown>;
}
export interface EventPublisher {
  /** Resolves true once the broker has confirmed the message, false on failure — never rejects (M6: best effort, logged). */
  publish(msg: OutboundMessage): Promise<boolean>;
}
const EXCHANGE = stryMutAct_9fa48("562") ? "" : (stryCov_9fa48("562"), "connectsphere.events");
type Connection = Awaited<ReturnType<typeof amqp.connect>>;
type Channel = Awaited<ReturnType<Connection["createConfirmChannel"]>>;

/**
 * Lazily connects on the first publish and reuses the channel after that.
 * M3: callers publish only after their own DB write has committed. M6: a
 * failed publish is logged and swallowed — best effort, which suits a
 * notification. A message another service must act on goes through
 * `lib/outbox.ts` instead, which retries until this resolves true.
 */
function createRealPublisher(url: string): EventPublisher {
  if (stryMutAct_9fa48("563")) {
    {}
  } else {
    stryCov_9fa48("563");
    let channelPromise: Promise<Channel> | undefined;
    async function getChannel(): Promise<Channel> {
      if (stryMutAct_9fa48("564")) {
        {}
      } else {
        stryCov_9fa48("564");
        if (stryMutAct_9fa48("567") ? false : stryMutAct_9fa48("566") ? true : stryMutAct_9fa48("565") ? channelPromise : (stryCov_9fa48("565", "566", "567"), !channelPromise)) {
          if (stryMutAct_9fa48("568")) {
            {}
          } else {
            stryCov_9fa48("568");
            channelPromise = (async () => {
              if (stryMutAct_9fa48("569")) {
                {}
              } else {
                stryCov_9fa48("569");
                const connection = await amqp.connect(url);
                const channel = await connection.createConfirmChannel();
                await channel.assertExchange(EXCHANGE, stryMutAct_9fa48("570") ? "" : (stryCov_9fa48("570"), "topic"), stryMutAct_9fa48("571") ? {} : (stryCov_9fa48("571"), {
                  durable: stryMutAct_9fa48("572") ? false : (stryCov_9fa48("572"), true)
                }));
                return channel;
              }
            })();
          }
        }
        return channelPromise;
      }
    }
    return stryMutAct_9fa48("573") ? {} : (stryCov_9fa48("573"), {
      async publish(msg: OutboundMessage): Promise<boolean> {
        if (stryMutAct_9fa48("574")) {
          {}
        } else {
          stryCov_9fa48("574");
          try {
            if (stryMutAct_9fa48("575")) {
              {}
            } else {
              stryCov_9fa48("575");
              const channel = await getChannel();
              const envelope = stryMutAct_9fa48("576") ? {} : (stryCov_9fa48("576"), {
                messageId: stryMutAct_9fa48("577") ? msg.messageId && randomUUID() : (stryCov_9fa48("577"), msg.messageId ?? randomUUID()),
                type: msg.type,
                occurredAt: stryMutAct_9fa48("578") ? msg.occurredAt && clock.now().toISOString() : (stryCov_9fa48("578"), msg.occurredAt ?? clock.now().toISOString()),
                publisher: stryMutAct_9fa48("579") ? "" : (stryCov_9fa48("579"), "events-service"),
                actorId: msg.actorId,
                eventId: msg.eventId,
                recipients: msg.recipients,
                data: msg.data
              });
              // A confirm channel: the callback fires once the broker has the message,
              // so `true` below means it was accepted, not just handed to the client.
              await new Promise<void>((resolve, reject) => {
                if (stryMutAct_9fa48("580")) {
                  {}
                } else {
                  stryCov_9fa48("580");
                  channel.publish(EXCHANGE, msg.type, Buffer.from(JSON.stringify(envelope)), stryMutAct_9fa48("582") ? {} : (stryCov_9fa48("582"), {
                    persistent: stryMutAct_9fa48("583") ? false : (stryCov_9fa48("583"), true)
                  }), stryMutAct_9fa48("584") ? () => undefined : (stryCov_9fa48("584"), err => err ? reject(err) : resolve()));
                }
              });
              console.log(stryMutAct_9fa48("586") ? `` : (stryCov_9fa48("586"), `events-service: published "${msg.type}" to RabbitMQ (messageId=${envelope.messageId})`));
              return stryMutAct_9fa48("587") ? false : (stryCov_9fa48("587"), true);
            }
          } catch (err) {
            if (stryMutAct_9fa48("588")) {
              {}
            } else {
              stryCov_9fa48("588");
              console.error(stryMutAct_9fa48("590") ? `` : (stryCov_9fa48("590"), `events-service: failed to publish "${msg.type}"`), err);
              channelPromise = undefined; // retry a fresh connection next time
              return stryMutAct_9fa48("591") ? true : (stryCov_9fa48("591"), false);
            }
          }
        }
      }
    });
  }
}

/** No-op if RABBITMQ_URL isn't set, so local dev without Docker isn't blocked. */
const idlePublisher: EventPublisher = stryMutAct_9fa48("592") ? {} : (stryCov_9fa48("592"), {
  async publish() {
    if (stryMutAct_9fa48("593")) {
      {}
    } else {
      stryCov_9fa48("593");
      return stryMutAct_9fa48("594") ? false : (stryCov_9fa48("594"), true);
    }
  }
});
let publisher: EventPublisher | undefined;
export function getPublisher(): EventPublisher {
  if (stryMutAct_9fa48("595")) {
    {}
  } else {
    stryCov_9fa48("595");
    if (stryMutAct_9fa48("598") ? false : stryMutAct_9fa48("597") ? true : stryMutAct_9fa48("596") ? publisher : (stryCov_9fa48("596", "597", "598"), !publisher)) {
      if (stryMutAct_9fa48("599")) {
        {}
      } else {
        stryCov_9fa48("599");
        const url = process.env.RABBITMQ_URL;
        publisher = url ? createRealPublisher(url) : idlePublisher;
      }
    }
    return publisher;
  }
}

/** Test-only: lets tests swap in a fake without touching real amqplib (M12). */
export function setPublisherForTest(fake: EventPublisher | undefined): void {
  if (stryMutAct_9fa48("600")) {
    {}
  } else {
    stryCov_9fa48("600");
    publisher = fake;
  }
}