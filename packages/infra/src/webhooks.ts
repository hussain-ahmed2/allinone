/**
 * Webhook delivery worker — signed dispatch, retries, dead-letter log.
 *
 * Each delivery attempt POSTs `{"event","payload","id","createdAt"}` to the
 * endpoint URL with `x-webhook-*` headers (event, timestamp, signature,
 * delivery-id). Failures (non-2xx or network errors) schedule the next
 * attempt with exponential backoff; after `maxAttempts`, the delivery is
 * dead-lettered and stays in the log for inspection/replay.
 */
import { randomBytes } from "node:crypto";
import { retryBackoffSeconds, signWebhook } from "./infra.js";

export interface WebhookSubscription {
  id: string;
  tenantId: string;
  url: string;
  secret: string;
  events: readonly string[];
}

export interface WebhookEventInput {
  event: string;
  payload: Record<string, unknown>;
}

export interface DeliveryRecord {
  id: string;
  eventId: string;
  endpointId: string;
  tenantId: string;
  event: string;
  payload: Record<string, unknown>;
  status: "queued" | "delivering" | "delivered" | "dead";
  attempts: number;
  nextAttemptAt: number;
  lastStatus?: number;
  lastError?: string;
  createdAt: string;
}

type FetchFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  status: number;
}>;

function defaultFetch(): FetchFn {
  return async (url, init) => {
    const res = await fetch(url, init);
    return { status: res.status };
  };
}

export class WebhookDispatcher {
  readonly #subscriptions: WebhookSubscription[] = [];
  readonly #deliveries = new Map<string, DeliveryRecord>();
  readonly #fetch: FetchFn;
  readonly #maxAttempts: number;
  readonly #baseDelaySeconds: number;

  constructor(options?: { fetchImpl?: FetchFn; maxAttempts?: number; baseDelaySeconds?: number }) {
    this.#fetch = options?.fetchImpl ?? defaultFetch();
    this.#maxAttempts = options?.maxAttempts ?? 5;
    this.#baseDelaySeconds = options?.baseDelaySeconds ?? 30;
  }

  /** Subscribe an endpoint (tenant-scoped; secret kept server-side). */
  subscribe(subscription: WebhookSubscription): void {
    if (!subscription.url.startsWith("https://") && !subscription.url.startsWith("http://")) {
      throw new Error("[allinone/infra] Webhook URL must be http(s)");
    }
    if (this.#subscriptions.some((s) => s.id === subscription.id)) {
      throw new Error(`[allinone/infra] Duplicate subscription: ${subscription.id}`);
    }
    this.#subscriptions.push(subscription);
  }

  /** Enqueue an event for every matching tenant subscription. */
  dispatch(tenantId: string, input: WebhookEventInput): DeliveryRecord[] {
    const eventId = `evt_${randomBytes(9).toString("base64url")}`;
    const created: DeliveryRecord[] = [];
    for (const subscription of this.#subscriptions) {
      if (subscription.tenantId !== tenantId) continue;
      if (!subscription.events.includes(input.event)) continue;
      const delivery: DeliveryRecord = {
        id: `dly_${randomBytes(9).toString("base64url")}`,
        eventId,
        endpointId: subscription.id,
        tenantId,
        event: input.event,
        payload: input.payload,
        status: "queued",
        attempts: 0,
        nextAttemptAt: Date.now(),
        createdAt: new Date().toISOString(),
      };
      this.#deliveries.set(delivery.id, delivery);
      created.push(delivery);
    }
    return created;
  }

  /**
   * Attempt every due delivery once (in order). Returns the attempted
   * delivery ids. Call on a timer (e.g. every 30s) from your framework.
   */
  async processDue(now = Date.now()): Promise<string[]> {
    const attempted: string[] = [];
    for (const delivery of this.#deliveries.values()) {
      if (delivery.status !== "queued" || delivery.nextAttemptAt > now) continue;
      attempted.push(delivery.id);
      await this.#attempt(delivery);
    }
    return attempted;
  }

  async #attempt(delivery: DeliveryRecord): Promise<void> {
    const subscription = this.#subscriptions.find((s) => s.id === delivery.endpointId);
    if (!subscription) {
      delivery.status = "dead";
      delivery.lastError = "Subscription removed";
      return;
    }
    delivery.attempts += 1;
    delivery.status = "delivering";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify({
      id: delivery.eventId,
      event: delivery.event,
      payload: delivery.payload,
      createdAt: delivery.createdAt,
    });
    const signature = signWebhook(subscription.secret, body, timestamp);
    try {
      const res = await this.#fetch(subscription.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-webhook-id": delivery.id,
          "x-webhook-event": delivery.event,
          "x-webhook-timestamp": timestamp,
          "x-webhook-signature": signature,
        },
        body,
      });
      delivery.lastStatus = res.status;
      if (res.status >= 200 && res.status < 300) {
        delivery.status = "delivered";
        return;
      }
      delivery.lastError = `HTTP ${String(res.status)}`;
    } catch (error) {
      delivery.lastError = error instanceof Error ? error.message : String(error);
    }
    if (delivery.attempts >= this.#maxAttempts) {
      delivery.status = "dead";
    } else {
      const backoff = Math.max(this.#baseDelaySeconds, retryBackoffSeconds(delivery.attempts));
      delivery.status = "queued";
      delivery.nextAttemptAt = Date.now() + backoff * 1000;
    }
  }

  /** Dead-letter + delivery log for one tenant. */
  deadLetters(tenantId: string): DeliveryRecord[] {
    return [...this.#deliveries.values()].filter(
      (d) => d.tenantId === tenantId && d.status === "dead",
    );
  }

  deliveriesByEndpoint(endpointId: string): DeliveryRecord[] {
    return [...this.#deliveries.values()].filter((d) => d.endpointId === endpointId);
  }
}

export function createWebhookDispatcher(
  options?: ConstructorParameters<typeof WebhookDispatcher>[0],
): WebhookDispatcher {
  return new WebhookDispatcher(options);
}
