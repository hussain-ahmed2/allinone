import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertCapability,
  runAdapterConformance,
  UnsupportedCapabilityError,
  type DatabaseAdapter,
} from "@allinone/database";
import { createMongoAdapter, type MongoAdapter } from "./index.js";

const URL = process.env["MONGO_TEST_URL"] ?? "mongodb://127.0.0.1:27017";

/** Fresh database per test — no shared state, no duplicate-key flakes. */
function createTestAdapter(): MongoAdapter {
  const dbName = `allinone_mongo_test_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  return createMongoAdapter({ connectionString: URL, dbName });
}

describe("mongo adapter (local mongod)", () => {
  let adapter: MongoAdapter;

  beforeEach(async () => {
    adapter = createTestAdapter();
    await adapter.connect();
  });

  afterEach(async () => {
    await adapter.disconnect().catch(() => undefined);
  });

  it("declares honest document capabilities", () => {
    expect(adapter.capabilities.transactions).toBe(false);
    expect(adapter.capabilities.nestedTransactions).toBe(false);
    expect(adapter.capabilities.foreignKeys).toBe(false);
    expect(adapter.capabilities.joins).toBe(false);
    expect(adapter.capabilities.rowLevelSecurity).toBe(false);
    expect(adapter.capabilities.optimisticLocking).toBe(true);
    expect(adapter.capabilities.softDeletes).toBe(true);
    expect(adapter.name).toBe("mongodb");
  });

  it("passes the shared adapter conformance suite", async () => {
    await runAdapterConformance(adapter);
  });

  it("rejects transactions loudly (standalone has no replica set)", async () => {
    await expect(adapter.transaction(async () => undefined)).rejects.toThrow(
      UnsupportedCapabilityError,
    );
    expect(() => {
      assertCapability(adapter, "transactions");
    }).toThrow(UnsupportedCapabilityError);
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

  it("optimistic locking detects lost updates", async () => {
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
    // Rejected queries never executed — data intact.
    expect(await adapter.find("users", {})).toHaveLength(1);
  });

  it("runs data migrations idempotently", async () => {
    const migrations = [
      {
        id: "001_init",
        async up(db: MongoAdapter): Promise<void> {
          await db.createTable("things");
        },
      },
    ];
    await adapter.migrate(migrations);
    await adapter.migrate(migrations);
    await adapter.insert("things", [{ id: "t1" }]);
    expect(await adapter.find("things", {})).toHaveLength(1);
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
      assertCapability(fake, "joins");
    }).toThrow(UnsupportedCapabilityError);
  });
});
