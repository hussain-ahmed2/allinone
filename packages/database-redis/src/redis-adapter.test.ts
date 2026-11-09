/**
 * Live Redis tests — run against a real server.
 *
 *   REDIS_TEST_URL=redis://127.0.0.1:6380 pnpm --filter @allinone/database-redis test
 *
 * Default URL targets the local Docker container on 6380:
 *   docker run -d --name allinone-redis-test -p 6380:6379 --rm redis:7
 */
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import {
  assertCapability,
  runAdapterConformance,
  UnsupportedCapabilityError,
  type DatabaseAdapter,
} from "@allinone/database";
import { createRedisAdapter, type RedisAdapter } from "./index.js";

const URL = process.env["REDIS_TEST_URL"] ?? "redis://127.0.0.1:6380";

/** Fresh namespace per test — zero shared state (shared NS leaks across tests). */
function createTestAdapter(): RedisAdapter {
  const ns = `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  return createRedisAdapter({ url: URL, namespace: ns });
}

describe("redis adapter (live redis:7)", () => {
  let adapter: RedisAdapter;

  beforeEach(async () => {
    adapter = createTestAdapter();
    await adapter.connect();
  });

  afterEach(async () => {
    await adapter.disconnect().catch(() => undefined);
  });

  it("declares honest KV capabilities", () => {
    expect(adapter.capabilities.transactions).toBe(false);
    expect(adapter.capabilities.nestedTransactions).toBe(false);
    expect(adapter.capabilities.joins).toBe(false);
    expect(adapter.capabilities.optimisticLocking).toBe(true);
    expect(adapter.capabilities.softDeletes).toBe(true);
    expect(adapter.name).toBe("redis");
  });

  it("rejects transactions loudly (never simulated)", async () => {
    await expect(adapter.transaction(async () => undefined)).rejects.toThrow(
      UnsupportedCapabilityError,
    );
    expect(() => {
      assertCapability(adapter, "transactions");
    }).toThrow(UnsupportedCapabilityError);
  });

  it("passes the shared adapter conformance suite", async () => {
    await runAdapterConformance(adapter);
  });

  it("inserts, finds, filters, and sorts", async () => {
    await adapter.createTable("users");
    await adapter.insert("users", [
      { id: "u1", name: "Ada", score: 3 },
      { id: "u2", name: "Bo", score: 1 },
      { id: "u3", name: "Cy", score: 2 },
    ]);
    const filtered = await adapter.find("users", {
      filters: [{ field: "score", operator: "gt", value: 1 }],
      sort: [{ field: "score", direction: "desc" }],
    });
    expect(filtered.map((r) => r["id"])).toEqual(["u1", "u3"]);
  });

  it("supports contains / in / isNull filters", async () => {
    await adapter.createTable("posts");
    await adapter.insert("posts", [
      { id: "p1", title: "Hello World" },
      { id: "p2", title: "Goodbye" },
      { id: "p3" },
    ]);
    const contains = await adapter.find("posts", {
      filters: [{ field: "title", operator: "contains", value: "World" }],
    });
    expect(contains.map((r) => r["id"])).toEqual(["p1"]);
    const inFilter = await adapter.find("posts", {
      filters: [{ field: "title", operator: "in", value: ["Hello World", "Nope"] }],
    });
    expect(inFilter).toHaveLength(1);
    const nulls = await adapter.find("posts", {
      filters: [{ field: "title", operator: "isNull" }],
    });
    expect(nulls.map((r) => r["id"])).toEqual(["p3"]);
  });

  it("enforces tenant isolation at query time", async () => {
    await adapter.createTable("items");
    await adapter.insert("items", [{ id: "a", v: 1 }], { tenantId: "t1" });
    await adapter.insert("items", [{ id: "b", v: 2 }], { tenantId: "t2" });
    const own = await adapter.find("items", { tenantId: "t1" });
    expect(own.map((r) => r["id"])).toEqual(["a"]);
    const other = await adapter.find("items", { tenantId: "t3" });
    expect(other).toHaveLength(0);
    await expect(adapter.update("items", "a", { v: 9 }, { tenantId: "t2" })).resolves.toBeNull();
    await expect(adapter.remove("items", "a", { tenantId: "t2" })).resolves.toBe(false);
  });

  it("soft-deletes and hard-deletes", async () => {
    await adapter.createTable("items");
    await adapter.insert("items", [{ id: "a" }]);
    await expect(adapter.remove("items", "a")).resolves.toBe(true);
    await expect(adapter.find("items", {})).resolves.toHaveLength(0);
    await expect(adapter.remove("items", "a")).resolves.toBe(false);
    await adapter.insert("items", [{ id: "b" }]);
    await expect(adapter.hardRemove("items", "b")).resolves.toBe(true);
    await expect(adapter.find("items", {})).resolves.toHaveLength(0);
  });

  it("optimistic locking detects lost updates (Lua CAS)", async () => {
    await adapter.createTable("docs");
    const [created] = await adapter.insert("docs", [{ id: "d1", text: "v1" }]);
    const version = created?._version as number;
    const first = await adapter.updateOptimistic("docs", "d1", { text: "v2" }, version);
    expect(first?.["text"]).toBe("v2");
    const stale = await adapter.updateOptimistic("docs", "d1", { text: "v3" }, version);
    expect(stale).toBeNull();
  });

  it("rejects NoSQL-injection filter values end to end", async () => {
    await adapter.createTable("users");
    await adapter.insert("users", [{ id: "u1", name: "Ada" }]);
    await expect(
      adapter.find("users", {
        filters: [{ field: "name", operator: "eq", value: { $gt: "" } }],
      }),
    ).rejects.toThrow(/requires a primitive/);
    expect(await adapter.find("users", {})).toHaveLength(1);
  });

  it("works as an infra CacheProvider", async () => {
    const cache = adapter.asCacheProvider();
    await cache.set("k1", "v1", 30);
    expect(await cache.get("k1")).toBe("v1");
    await cache.set("k1", "v2", 30);
    expect(await cache.get("k1")).toBe("v2");
    await cache.delete("k1");
    expect(await cache.get("k1")).toBeNull();
  });
});

describe("capability errors", () => {
  it("assertCapability honestly rejects unsupported adapters", () => {
    const fake = {
      name: "fake",
      capabilities: {
        transactions: false,
        nestedTransactions: false,
        foreignKeys: false,
        joins: false,
        jsonQueries: false,
        fullTextSearch: false,
        schemaMigrations: false,
        optimisticLocking: false,
        rowLevelSecurity: false,
        softDeletes: false,
      },
    } as DatabaseAdapter;
    expect(() => {
      assertCapability(fake, "schemaMigrations");
    }).toThrow(UnsupportedCapabilityError);
  });
});
