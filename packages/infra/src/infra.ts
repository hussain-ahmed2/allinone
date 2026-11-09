/**
 * @allinone/infra — optional application infrastructure.
 *
 * Every module here is OPT-IN via module flags. Nothing in this package
 * is imported by platform core, so optional features add zero base runtime
 * cost. Each section declares its provider interface so users can swap
 * implementations (SMTP, S3, Redis, Stripe, ...) without framework lock-in.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/* ------------------------------------------------------------------ */
/* Audit — append-only, tenant-scoped                                   */
/* ------------------------------------------------------------------ */

export interface AuditEvent {
  id: string;
  actorId: string;
  tenantId: string;
  organizationId?: string;
  action: string;
  resource: string;
  outcome: "success" | "failure";
  correlationId: string;
  ip?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/**
 * Append-only audit log. There is intentionally NO update/delete API —
 * retention + export policies handle lifecycle; tampering is detectable
 * via hash chaining (`prevHash`).
 */
export class AuditLog {
  readonly #events: (AuditEvent & { hash: string; prevHash: string })[] = [];

  append(input: Omit<AuditEvent, "id" | "createdAt">): AuditEvent {
    const last = this.#events[this.#events.length - 1];
    const prevHash = last ? last.hash : "genesis";
    const event: AuditEvent = {
      ...input,
      id: `aud_${randomBytes(9).toString("base64url")}`,
      createdAt: new Date().toISOString(),
    };
    const hash = createHash("sha256")
      .update(prevHash + JSON.stringify(event))
      .digest("hex");
    this.#events.push({ ...event, hash, prevHash });
    return event;
  }

  /** Tenant-scoped read — cross-tenant queries are impossible via this API. */
  listForTenant(tenantId: string): AuditEvent[] {
    return this.#events
      .filter((e) => e.tenantId === tenantId)
      .map(({ hash: _h, prevHash: _p, ...e }) => e);
  }

  /** Verify the hash chain — tamper detection. */
  verifyChain(): boolean {
    let prev = "genesis";
    for (const e of this.#events) {
      if (e.prevHash !== prev) return false;
      const { hash, prevHash: _p, ...body } = e;
      const expected = createHash("sha256")
        .update(prev + JSON.stringify(body))
        .digest("hex");
      if (expected !== hash) return false;
      prev = hash;
    }
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* API keys — hashed storage, scoped permissions                        */
/* ------------------------------------------------------------------ */

export interface ApiKeyRecord {
  id: string;
  tenantId: string;
  name: string;
  keyHash: string;
  scopes: readonly string[];
  expiresAt?: string;
  revoked: boolean;
  createdAt: string;
}

export class ApiKeyStore {
  readonly #keys = new Map<string, ApiKeyRecord>();

  create(input: {
    tenantId: string;
    name: string;
    scopes: readonly string[];
    expiresInSeconds?: number;
  }): {
    record: ApiKeyRecord;
    secret: string;
  } {
    const secret = `sk_live_${randomBytes(24).toString("base64url")}`;
    const record: ApiKeyRecord = {
      id: `key_${randomBytes(9).toString("base64url")}`,
      tenantId: input.tenantId,
      name: input.name,
      keyHash: createHash("sha256").update(secret).digest("hex"),
      scopes: input.scopes,
      ...(input.expiresInSeconds
        ? { expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000).toISOString() }
        : {}),
      revoked: false,
      createdAt: new Date().toISOString(),
    };
    this.#keys.set(record.id, record);
    return { record, secret };
  }

  /** Timing-safe verification. Returns record only when valid + scoped. */
  verify(secret: string, requiredScope: string): ApiKeyRecord | null {
    const hash = createHash("sha256").update(secret).digest("hex");
    for (const record of this.#keys.values()) {
      if (record.revoked) continue;
      if (record.expiresAt && Date.now() > new Date(record.expiresAt).getTime()) continue;
      const stored = Buffer.from(record.keyHash, "hex");
      const candidate = Buffer.from(hash, "hex");
      if (stored.length !== candidate.length) continue;
      if (!timingSafeEqual(stored, candidate)) continue;
      const hasScope = record.scopes.some(
        (s) =>
          s === "*" ||
          s === requiredScope ||
          (s.endsWith(".*") && requiredScope.startsWith(s.slice(0, -1))),
      );
      return hasScope ? record : null;
    }
    return null;
  }

  revoke(id: string): boolean {
    const record = this.#keys.get(id);
    if (!record) return false;
    record.revoked = true;
    return true;
  }
}

/* ------------------------------------------------------------------ */
/* Webhooks — signed delivery, retries with backoff                     */
/* ------------------------------------------------------------------ */

export interface WebhookEndpoint {
  id: string;
  tenantId: string;
  url: string;
  secret: string;
  events: readonly string[];
}

export function signWebhook(secret: string, body: string, timestamp: string): string {
  return createHmac(secret, `${timestamp}.${body}`);
}

function createHmac(secret: string, payload: string): string {
  return createHash("sha256").update(`${secret}.${payload}`).digest("hex");
}

export function verifyWebhook(
  secret: string,
  body: string,
  timestamp: string,
  signature: string,
  maxAgeSeconds = 300,
): boolean {
  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > maxAgeSeconds) return false;
  const expected = signWebhook(secret, body, timestamp);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Exponential backoff schedule (seconds) for webhook retries. */
export function retryBackoffSeconds(attempt: number): number {
  return Math.min(2 ** attempt, 3600);
}

/* ------------------------------------------------------------------ */
/* Notifications / storage / cache — provider interfaces                */
/* ------------------------------------------------------------------ */

export interface NotificationMessage {
  to: string;
  subject: string;
  body: string;
  tenantId: string;
}

export interface NotificationProvider {
  readonly name: string;
  send(message: NotificationMessage): Promise<void>;
}

export interface StorageProvider {
  readonly name: string;
  put(key: string, data: Buffer, contentType: string): Promise<{ url: string }>;
  getSignedUrl(key: string, expiresInSeconds: number): Promise<string>;
}

export interface CacheProvider {
  readonly name: string;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
}

/** In-memory cache with TTL + tenant-safe keys (caller namespaces by tenant). */
export class MemoryCache implements CacheProvider {
  readonly name = "memory";
  readonly #entries = new Map<string, { value: string; expiresAt: number }>();

  async get(key: string): Promise<string | null> {
    const entry = this.#entries.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.#entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.#entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  async delete(key: string): Promise<void> {
    this.#entries.delete(key);
  }
}

/* ------------------------------------------------------------------ */
/* Subscriptions — plan entitlements + metered usage                    */
/* ------------------------------------------------------------------ */

export interface Plan {
  id: string;
  name: string;
  /** Feature key → included quantity (use Infinity for unlimited). */
  entitlements: Record<string, number>;
}

export class SubscriptionStore {
  readonly #plans = new Map<string, Plan>();
  readonly #subscriptions = new Map<string, { planId: string; status: string }>();
  readonly #usage = new Map<string, number>();

  addPlan(plan: Plan): void {
    this.#plans.set(plan.id, plan);
  }

  subscribe(tenantId: string, planId: string): void {
    if (!this.#plans.has(planId)) throw new Error(`[allinone/infra] Unknown plan: ${planId}`);
    this.#subscriptions.set(tenantId, { planId, status: "active" });
  }

  /** Fail-closed: tenants without a subscription have zero entitlements. */
  entitlement(tenantId: string, feature: string): number {
    const sub = this.#subscriptions.get(tenantId);
    if (!sub) return 0;
    const plan = this.#plans.get(sub.planId);
    return plan?.entitlements[feature] ?? 0;
  }

  recordUsage(tenantId: string, feature: string, amount: number): void {
    const key = `${tenantId}:${feature}`;
    this.#usage.set(key, (this.#usage.get(key) ?? 0) + amount);
  }

  usage(tenantId: string, feature: string): number {
    return this.#usage.get(`${tenantId}:${feature}`) ?? 0;
  }

  /** True when usage is at/over the plan limit for the feature. */
  isLimitExceeded(tenantId: string, feature: string): boolean {
    const limit = this.entitlement(tenantId, feature);
    if (!Number.isFinite(limit)) return false;
    return this.usage(tenantId, feature) >= limit;
  }
}

/* ------------------------------------------------------------------ */
/* Rate limiting — sliding window, per-tenant                           */
/* ------------------------------------------------------------------ */

export class RateLimiter {
  readonly #hits = new Map<string, number[]>();

  constructor(
    private readonly maxRequests: number,
    private readonly windowSeconds: number,
  ) {}

  /** Returns true when the request is allowed. */
  allow(key: string): boolean {
    const now = Date.now();
    const windowStart = now - this.windowSeconds * 1000;
    const hits = (this.#hits.get(key) ?? []).filter((t) => t > windowStart);
    hits.push(now);
    this.#hits.set(key, hits);
    return hits.length <= this.maxRequests;
  }
}

/* ------------------------------------------------------------------ */
/* Observability — structured logging + health                          */
/* ------------------------------------------------------------------ */

export interface LogContext {
  requestId?: string;
  tenantId?: string;
  userId?: string;
}

export function createLogger(
  sink: (line: string) => void = (line: string) => {
    // eslint-disable-next-line no-console -- default sink is stdout for CLI use
    console.log(line);
  },
) {
  return {
    info(message: string, fields: Record<string, unknown> = {}, ctx: LogContext = {}): void {
      sink(
        JSON.stringify({
          level: "info",
          message,
          timestamp: new Date().toISOString(),
          ...ctx,
          ...fields,
        }),
      );
    },
    warn(message: string, fields: Record<string, unknown> = {}, ctx: LogContext = {}): void {
      sink(
        JSON.stringify({
          level: "warn",
          message,
          timestamp: new Date().toISOString(),
          ...ctx,
          ...fields,
        }),
      );
    },
    error(message: string, fields: Record<string, unknown> = {}, ctx: LogContext = {}): void {
      sink(
        JSON.stringify({
          level: "error",
          message,
          timestamp: new Date().toISOString(),
          ...ctx,
          ...fields,
        }),
      );
    },
  };
}

export interface HealthStatus {
  ok: boolean;
  checks: Record<string, { ok: boolean; latencyMs: number }>;
}

/** Aggregate health across subsystems (database, cache, ...). */
export async function aggregateHealth(
  checks: Record<string, () => Promise<{ ok: boolean; latencyMs: number }>>,
): Promise<HealthStatus> {
  const results: Record<string, { ok: boolean; latencyMs: number }> = {};
  let ok = true;
  for (const [name, fn] of Object.entries(checks)) {
    try {
      const result = await fn();
      results[name] = result;
      ok = ok && result.ok;
    } catch {
      results[name] = { ok: false, latencyMs: 0 };
      ok = false;
    }
  }
  return { ok, checks: results };
}
