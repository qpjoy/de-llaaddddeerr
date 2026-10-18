// Callback delivery (V2-5, plan §10). The transaction that ends a client job
// writes its delivery row (client-settlement.mjs); this loop sends it after
// commit, outside any transaction, signed with the client's callback secret:
//
//   X-MX-Delivery-Id: <uuid>        receivers dedupe on this
//   X-MX-Event:       job.finished
//   X-MX-Timestamp:   <unix seconds>
//   X-MX-Signature:   v1=<hex HMAC-SHA256(secret, "<timestamp>.<deliveryId>.<body>")>
//
// Any 2xx settles it. Otherwise it is retried with exponential backoff
// (10 s doubling, at most 1 h, ±10 % jitter) and marked dead after 12 tries;
// an administrator can retry a dead delivery. A target outside the client's
// allowed origins is never contacted. Redirects are not followed.
import { createHmac, timingSafeEqual } from "node:crypto";
import { callbackOrigin } from "./clients.mjs";

export const MAX_ATTEMPTS = 12;
export const BASE_DELAY_MS = 10000;
export const MAX_DELAY_MS = 3600000;
export const SIGNATURE_TOLERANCE_S = 300;
// Delivered and dead deliveries are kept this long for the admin view.
export const OUTBOX_RETENTION_MS = 14 * 86400000;

export const backoffMs = (attempts, random = Math.random) =>
  Math.round(
    Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempts - 1)) *
      (0.9 + 0.2 * random()),
  );
export const signature = (secret, timestamp, deliveryId, body) =>
  `v1=${createHmac("sha256", secret).update(`${timestamp}.${deliveryId}.${body}`).digest("hex")}`;
/** Receiver side (reference for Hub): true when the delivery is authentic
 * and fresh. Dedupe on the delivery id separately. */
export function verifySignature(secret, headers, body, nowMs = Date.now()) {
  const get = (name) => headers[name] ?? headers[name.toLowerCase()];
  const timestamp = Number(get("X-MX-Timestamp")),
    id = get("X-MX-Delivery-Id"),
    given = get("X-MX-Signature");
  if (!Number.isInteger(timestamp) || !id || typeof given !== "string")
    return false;
  if (Math.abs(nowMs / 1000 - timestamp) > SIGNATURE_TOLERANCE_S) return false;
  const expected = signature(secret, timestamp, id, body);
  return (
    expected.length === given.length &&
    timingSafeEqual(Buffer.from(expected), Buffer.from(given))
  );
}

export class OutboxDeliverer {
  constructor(
    store,
    {
      fetch = globalThis.fetch,
      intervalMs = 1000,
      timeoutMs = 10000,
      batch = 20,
      lockMs = 30000,
      random = Math.random,
      pruneEveryMs = 600000,
    } = {},
  ) {
    Object.assign(this, {
      store,
      fetch,
      intervalMs,
      timeoutMs,
      batch,
      lockMs,
      random,
      pruneEveryMs,
    });
    this.prunedAt = 0;
    this.stats = { delivered: 0, failed: 0, dead: 0 };
    this.running = null;
  }
  async deliver({ delivery, client }) {
    const started = Date.now();
    const attempts = delivery.attempts + 1;
    let outcome;
    if (
      !client ||
      client.status !== "active" ||
      !client.callbackHosts?.includes(callbackOrigin(delivery.url))
    )
      outcome = {
        ok: false,
        final: true,
        error: "回调地址不在调用方允许的来源内或调用方已停用",
      };
    else
      try {
        const body = JSON.stringify(delivery.payload);
        const timestamp = Math.floor(Date.now() / 1000);
        const res = await this.fetch(delivery.url, {
          method: "POST",
          redirect: "manual",
          signal: AbortSignal.timeout(this.timeoutMs),
          headers: {
            "Content-Type": "application/json",
            "User-Agent": "mx-device-outbox/1",
            "X-MX-Delivery-Id": delivery.id,
            "X-MX-Event": delivery.event,
            "X-MX-Timestamp": String(timestamp),
            "X-MX-Signature": signature(
              client.callbackSecret,
              timestamp,
              delivery.id,
              body,
            ),
          },
          body,
        });
        await res.arrayBuffer().catch(() => {});
        outcome =
          res.status >= 200 && res.status < 300
            ? { ok: true, httpStatus: res.status }
            : {
                ok: false,
                httpStatus: res.status,
                error: `HTTP ${res.status}`,
              };
      } catch (error) {
        outcome = {
          ok: false,
          error: error?.name === "TimeoutError" ? "接收方超时" : "连接失败",
        };
      }
    const dead = !outcome.ok && (outcome.final || attempts >= MAX_ATTEMPTS);
    const last = {
      at: Date.now(),
      ms: Date.now() - started,
      httpStatus: outcome.httpStatus ?? null,
      error: outcome.error ?? null,
    };
    await this.store.settleDelivery(delivery.id, {
      status: outcome.ok ? "delivered" : dead ? "dead" : "pending",
      attempts,
      nextAt:
        outcome.ok || dead ? 0 : Date.now() + backoffMs(attempts, this.random),
      last,
    });
    this.stats[outcome.ok ? "delivered" : dead ? "dead" : "failed"]++;
    return outcome;
  }
  /** One pass: claim due deliveries and send them concurrently. */
  async tick() {
    if (Date.now() - this.prunedAt >= this.pruneEveryMs) {
      this.prunedAt = Date.now();
      // A failed cleanup is retried at the next period; delivery goes on.
      await Promise.resolve()
        .then(() =>
          this.store.pruneOutbox?.({ retentionMs: OUTBOX_RETENTION_MS }),
        )
        .catch(() => {});
    }
    const due = await this.store.claimDeliveries({
      limit: this.batch,
      lockMs: this.lockMs,
    });
    await Promise.all(due.map((d) => this.deliver(d).catch(() => {})));
    return due.length;
  }
  start() {
    this.stopped = false;
    const loop = async () => {
      while (!this.stopped) {
        let sent = 0;
        try {
          sent = await this.tick();
        } catch {
          // Store unavailable: try again next interval.
        }
        if (!sent || this.stopped)
          await new Promise((r) => {
            this.wake = r;
            this.timer = setTimeout(r, this.intervalMs);
            this.timer.unref?.();
          });
      }
    };
    this.running = loop();
    return this;
  }
  /** A job just finished in this process: look now. */
  poke() {
    clearTimeout(this.timer);
    this.wake?.();
  }
  async stop() {
    this.stopped = true;
    this.poke();
    await this.running;
  }
}
