import { describe, expect, it } from "vitest";
import { createPlatform, presets } from "./index.js";

describe("createPlatform", () => {
  it("resolves a SaaS preset with secure defaults", () => {
    const platform = createPlatform({
      preset: presets.saas(),
      database: { adapter: "memory" },
    });
    expect(platform.config.authorization.defaultDeny).toBe(true);
    expect(platform.config.auth.mfa).toBe(true);
    expect(platform.config.modules.billing).toBe(true);
  });

  it("initializes and shuts down gracefully", async () => {
    const platform = createPlatform({ database: { adapter: "memory" } });
    await platform.initialize();
    expect(platform.isInitialized).toBe(true);
    const health = await platform.database.healthCheck();
    expect(health.ok).toBe(true);
    await platform.shutdown();
    expect(platform.isInitialized).toBe(false);
  });

  it("runs custom modules during initialize", async () => {
    const order: string[] = [];
    const platform = createPlatform({ database: { adapter: "memory" } });
    platform
      .extend({
        name: "first",
        initialize: () => {
          order.push("first");
        },
      })
      .extend({
        name: "second",
        initialize: () => {
          order.push("second");
        },
      });
    await platform.initialize();
    expect(order).toEqual(["first", "second"]);
    await platform.shutdown();
  });

  it("rejects duplicate module names", () => {
    const platform = createPlatform({ database: { adapter: "memory" } });
    platform.extend({ name: "dup", initialize: () => undefined });
    expect(() => platform.extend({ name: "dup", initialize: () => undefined })).toThrow(
      /already registered/,
    );
  });

  it("rejects unavailable database adapters loudly", () => {
    expect(() => createPlatform({ database: { adapter: "postgres" } })).toThrow(/not installed/);
  });

  it("enforces tenant isolation through platform services", async () => {
    const platform = createPlatform({ database: { adapter: "memory" } });
    await platform.initialize();
    const tenantId = platform.tenants.create({
      id: "t1",
      name: "Acme",
      slug: "acme",
      strategy: "shared-schema",
      domains: [],
    }).id;
    await platform.database.insert("users", [{ name: "Ada" }], { tenantId });
    const rows = await platform.database.find("users", { tenantId: "t-other" });
    expect(rows).toHaveLength(0);
    await platform.shutdown();
  });
});
