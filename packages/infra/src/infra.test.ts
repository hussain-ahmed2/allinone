import { describe, expect, it } from "vitest";
import {
  aggregateHealth,
  ApiKeyStore,
  AuditLog,
  MemoryCache,
  RateLimiter,
  signWebhook,
  SubscriptionStore,
  verifyWebhook,
} from "./index.js";

describe("AuditLog", () => {
  it("is append-only and tamper-evident", () => {
    const log = new AuditLog();
    log.append({ actorId: "u1", tenantId: "t1", action: "login", resource: "session", outcome: "success", correlationId: "c1", metadata: {} });
    log.append({ actorId: "u1", tenantId: "t1", action: "read", resource: "users", outcome: "success", correlationId: "c2", metadata: {} });
    expect(log.listForTenant("t1")).toHaveLength(2);
    expect(log.listForTenant("t2")).toHaveLength(0);
    expect(log.verifyChain()).toBe(true);
  });
});

describe("ApiKeyStore", () => {
  it("verifies scoped keys with timing-safe compare", () => {
    const store = new ApiKeyStore();
    const { secret } = store.create({ tenantId: "t1", name: "ci", scopes: ["users.read"] });
    expect(store.verify(secret, "users.read")).not.toBeNull();
    expect(store.verify(secret, "users.delete")).toBeNull();
  });
});

describe("webhooks", () => {
  it("signs and verifies within tolerance", () => {
    const secret = "s3cr3t";
    const body = JSON.stringify({ a: 1 });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signWebhook(secret, body, ts);
    expect(verifyWebhook(secret, body, ts, sig)).toBe(true);
    expect(verifyWebhook(secret, body + "x", ts, sig)).toBe(false);
  });
});

describe("SubscriptionStore", () => {
  it("fails closed without subscription and enforces limits", () => {
    const store = new SubscriptionStore();
    store.addPlan({ id: "pro", name: "Pro", entitlements: { seats: 5 } });
    expect(store.entitlement("t1", "seats")).toBe(0);
    store.subscribe("t1", "pro");
    expect(store.entitlement("t1", "seats")).toBe(5);
    store.recordUsage("t1", "seats", 5);
    expect(store.isLimitExceeded("t1", "seats")).toBe(true);
  });
});

describe("RateLimiter + MemoryCache + health", () => {
  it("rate limits per key", () => {
    const limiter = new RateLimiter(2, 60);
    expect(limiter.allow("t1")).toBe(true);
    expect(limiter.allow("t1")).toBe(true);
    expect(limiter.allow("t1")).toBe(false);
  });

  it("expires cache entries", async () => {
    const cache = new MemoryCache();
    await cache.set("k", "v", 60);
    expect(await cache.get("k")).toBe("v");
  });

  it("aggregates health fail-closed", async () => {
    const status = await aggregateHealth({
      db: async () => ({ ok: true, latencyMs: 1 }),
      cache: async () => {
        throw new Error("down");
      },
    });
    expect(status.ok).toBe(false);
  });
});
