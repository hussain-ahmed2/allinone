import { describe, expect, it } from "vitest";
import { createHeaderResolver, TenantContext, tenantCacheKey, TenantRegistry } from "./index.js";

describe("TenantContext", () => {
  it("is explicit and async-safe", async () => {
    const ctx = new TenantContext();
    await ctx.runWithTenant("t1", async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(ctx.getCurrent()).toBe("t1");
    });
    expect(ctx.getCurrent()).toBeNull();
  });

  it("throws when tenant-scoped work runs without context", () => {
    const ctx = new TenantContext();
    expect(() => ctx.require()).toThrow(/No active tenant/);
  });

  it("prevents cross-tenant cache leakage via key namespacing", () => {
    expect(tenantCacheKey("a", "k")).not.toBe(tenantCacheKey("b", "k"));
  });
});

describe("TenantRegistry + safe header resolver", () => {
  it("rejects header tenant ids without membership", async () => {
    const registry = new TenantRegistry();
    registry.create({
      id: "t1",
      name: "Acme",
      slug: "acme",
      strategy: "shared-schema",
      domains: [],
    });
    const resolve = createHeaderResolver(registry, () => false);
    await expect(resolve({ headerTenantId: "t1", userId: "u1" })).resolves.toBeNull();
  });

  it("accepts header tenant ids with validated membership", async () => {
    const registry = new TenantRegistry();
    registry.create({
      id: "t1",
      name: "Acme",
      slug: "acme",
      strategy: "shared-schema",
      domains: [],
    });
    const resolve = createHeaderResolver(registry, () => true);
    await expect(resolve({ headerTenantId: "t1", userId: "u1" })).resolves.toBe("t1");
  });

  it("suspends and archives tenants", () => {
    const registry = new TenantRegistry();
    registry.create({ id: "t1", name: "A", slug: "a", strategy: "shared-schema", domains: [] });
    expect(registry.suspend("t1").status).toBe("suspended");
    expect(registry.archive("t1").status).toBe("archived");
  });
});
