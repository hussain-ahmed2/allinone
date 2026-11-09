import { beforeEach, afterEach, describe, expect, it } from "vitest";
import {
  assertCapability,
  runAdapterConformance,
  UnsupportedCapabilityError,
  type DatabaseAdapter,
} from "@allinone/database";
import { createSqliteAdapter, type SqliteAdapter } from "./index.js";

/** Fresh in-memory database per test — zero infrastructure needed. */
function createTestAdapter(): SqliteAdapter {
  return createSqliteAdapter({ path: ":memory:" });
}

describe("sqlite adapter (:memory:)", () => {
  let adapter: SqliteAdapter;

  beforeEach(async () => {
    adapter = createTestAdapter();
    await adapter.connect();
  });

  afterEach(async () => {
    await adapter.disconnect().catch(() => undefined);
  });

  it("declares full relational capabilities", () => {
    expect(adapter.capabilities.transactions).toBe(true);
    expect(adapter.capabilities.nestedTransactions).toBe(true);
    expect(adapter.capabilities.jsonQueries).toBe(true);
    expect(adapter.capabilities.optimisticLocking).toBe(true);
    expect(adapter.capabilities.rowLevelSecurity).toBe(false);
    expect(adapter.name).toBe("sqlite");
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

  it("optimistic locking detects lost updates", async () => {
    await adapter.createTable("docs");
    const [created] = await adapter.insert("docs", [{ id: "d1", text: "v1" }]);
    const version = created?._version as number;
    const first = await adapter.updateOptimistic("docs", "d1", { text: "v2" }, version);
    expect(first?.["text"]).toBe("v2");
    const stale = await adapter.updateOptimistic("docs", "d1", { text: "v3" }, version);
    expect(stale).toBeNull();
  });

  it("commits and rolls back transactions", async () => {
    await adapter.createTable("items");
    await adapter.transaction(async (tx) => {
      await tx.insert("items", [{ id: "a" }]);
    });
    expect(await adapter.find("items", {})).toHaveLength(1);
    await expect(
      adapter.transaction(async (tx) => {
        await tx.insert("items", [{ id: "b" }]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await adapter.find("items", {})).map((r) => r["id"])).toEqual(["a"]);
  });

  it("nested transactions use savepoints", async () => {
    await adapter.createTable("items");
    await adapter.transaction(async (tx) => {
      await tx.insert("items", [{ id: "outer" }]);
      await expect(
        tx.transaction(async (inner) => {
          await inner.insert("items", [{ id: "inner" }]);
          throw new Error("inner fail");
        }),
      ).rejects.toThrow("inner fail");
    });
    const rows = await adapter.find("items", { sort: [{ field: "id", direction: "asc" }] });
    expect(rows.map((r) => r["id"])).toEqual(["outer"]);
  });

  it("runs migrations idempotently", async () => {
    const migrations = [
      {
        id: "001_init",
        async up(tx: SqliteAdapter): Promise<void> {
          await tx.createTable("things");
        },
      },
    ];
    await adapter.migrate(migrations);
    await adapter.migrate(migrations);
    await adapter.insert("things", [{ id: "t1" }]);
    expect(await adapter.find("things", {})).toHaveLength(1);
  });

  it("treats SQL-injection values as data, not SQL", async () => {
    await adapter.createTable("users");
    await adapter.insert("users", [{ id: "u1", name: "Ada" }]);
    const evil = "x' OR '1'='1";
    const found = await adapter.find("users", {
      filters: [{ field: "name", operator: "eq", value: evil }],
    });
    expect(found).toHaveLength(0);
    const all = await adapter.find("users", {});
    expect(all).toHaveLength(1);
    expect(all[0]?.["name"]).toBe("Ada");
  });

  it("rejects unsafe table names", async () => {
    await expect(adapter.createTable('users"; DROP TABLE users; --')).rejects.toThrow(
      /Invalid table identifier/,
    );
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
