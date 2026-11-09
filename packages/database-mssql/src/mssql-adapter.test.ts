/**
 * Live MSSQL tests — run against a real SQL Server (CI service or Docker).
 *
 *   MSSQL_TEST_URL=mssql://sa:TestPass1!@localhost:1433/allinone_test pnpm --filter @allinone/database-mssql test
 *
 * Skipped entirely when no server is reachable (unit tests still run).
 */
import { afterAll, describe, expect, it } from "vitest";
import {
  assertCapability,
  runAdapterConformance,
  UnsupportedCapabilityError,
  type DatabaseAdapter,
} from "@allinone/database";
import { createMssqlAdapter, type MssqlAdapter } from "./index.js";

const URL = process.env["MSSQL_TEST_URL"] ?? "mssql://sa:TestPass1!@localhost:1433/allinone_test";

/** Tables for this run — dropped first so re-runs never hit duplicate keys. */
const RUN = `r${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const t = (name: string): string => `${name}_${RUN}`;

describe("mssql adapter (live SQL Server)", () => {
  let adapter: MssqlAdapter | undefined;

  async function live(): Promise<MssqlAdapter | null> {
    const candidate = createMssqlAdapter({ connectionString: URL });
    try {
      const health = await candidate.healthCheck().catch(() => ({ ok: false, latencyMs: 0 }));
      if (!health.ok) {
        await candidate.disconnect().catch(() => undefined);
        return null;
      }
      adapter = candidate;
      return candidate;
    } catch {
      await candidate.disconnect().catch(() => undefined);
      return null;
    }
  }

  afterAll(async () => {
    await adapter?.disconnect().catch(() => undefined);
  });

  it("declares full relational capabilities", async () => {
    const db = await live();
    if (!db) return;
    expect(db.capabilities.transactions).toBe(true);
    expect(db.capabilities.nestedTransactions).toBe(true);
    expect(db.capabilities.jsonQueries).toBe(true);
    expect(db.capabilities.optimisticLocking).toBe(true);
    expect(db.capabilities.rowLevelSecurity).toBe(true);
    expect(db.name).toBe("mssql");
  });

  it("passes the shared adapter conformance suite", async () => {
    const db = await live();
    if (!db) return;
    await db.createTable(t("conformance_items"));
    await runAdapterConformance(db);
  });

  it("inserts, finds, filters, and sorts", async () => {
    const db = await live();
    if (!db) return;
    const table = t("users");
    await db.createTable(table);
    await db.insert(table, [
      { id: "u1", name: "Ada", score: 3 },
      { id: "u2", name: "Bo", score: 1 },
      { id: "u3", name: "Cy", score: 2 },
    ]);
    const filtered = await db.find(table, {
      filters: [{ field: "score", operator: "gt", value: 1 }],
      sort: [{ field: "score", direction: "desc" }],
    });
    expect(filtered.map((r) => r["id"])).toEqual(["u1", "u3"]);
  });

  it("supports contains / in / isNull filters", async () => {
    const db = await live();
    if (!db) return;
    const table = t("posts");
    await db.createTable(table);
    await db.insert(table, [
      { id: "p1", title: "Hello World" },
      { id: "p2", title: "Goodbye" },
      { id: "p3" },
    ]);
    const contains = await db.find(table, {
      filters: [{ field: "title", operator: "contains", value: "World" }],
    });
    expect(contains.map((r) => r["id"])).toEqual(["p1"]);
    const inFilter = await db.find(table, {
      filters: [{ field: "title", operator: "in", value: ["Hello World", "Nope"] }],
    });
    expect(inFilter).toHaveLength(1);
    const nulls = await db.find(table, {
      filters: [{ field: "title", operator: "isNull" }],
    });
    expect(nulls.map((r) => r["id"])).toEqual(["p3"]);
  });

  it("enforces tenant isolation at query time", async () => {
    const db = await live();
    if (!db) return;
    const table = t("items");
    await db.createTable(table);
    await db.insert(table, [{ id: "a", v: 1 }], { tenantId: "t1" });
    await db.insert(table, [{ id: "b", v: 2 }], { tenantId: "t2" });
    const own = await db.find(table, { tenantId: "t1" });
    expect(own.map((r) => r["id"])).toEqual(["a"]);
    const other = await db.find(table, { tenantId: "t3" });
    expect(other).toHaveLength(0);
    await expect(db.update(table, "a", { v: 9 }, { tenantId: "t2" })).resolves.toBeNull();
    await expect(db.remove(table, "a", { tenantId: "t2" })).resolves.toBe(false);
  });

  it("soft-deletes and hard-deletes", async () => {
    const db = await live();
    if (!db) return;
    const table = t("items");
    await db.createTable(table);
    await db.insert(table, [{ id: "a" }]);
    await expect(db.remove(table, "a")).resolves.toBe(true);
    await expect(db.find(table, {})).resolves.toHaveLength(0);
    await expect(db.remove(table, "a")).resolves.toBe(false);
    await db.insert(table, [{ id: "b" }]);
    await expect(db.hardRemove(table, "b")).resolves.toBe(true);
    await expect(db.find(table, {})).resolves.toHaveLength(0);
  });

  it("optimistic locking detects lost updates", async () => {
    const db = await live();
    if (!db) return;
    const table = t("docs");
    await db.createTable(table);
    const [created] = await db.insert(table, [{ id: "d1", text: "v1" }]);
    const version = created?._version as number;
    const first = await db.updateOptimistic(table, "d1", { text: "v2" }, version);
    expect(first?.["text"]).toBe("v2");
    const stale = await db.updateOptimistic(table, "d1", { text: "v3" }, version);
    expect(stale).toBeNull();
  });

  it("commits and rolls back transactions", async () => {
    const db = await live();
    if (!db) return;
    const table = t("tx_items");
    await db.createTable(table);
    await db.transaction(async (tx) => {
      await tx.insert(table, [{ id: "a" }]);
    });
    expect(await db.find(table, {})).toHaveLength(1);
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(table, [{ id: "b" }]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await db.find(table, {})).map((r) => r["id"])).toEqual(["a"]);
  });

  it("nested transactions use savepoints", async () => {
    const db = await live();
    if (!db) return;
    const table = t("nested_items");
    await db.createTable(table);
    await db.transaction(async (tx) => {
      await tx.insert(table, [{ id: "outer" }]);
      await expect(
        tx.transaction(async (inner) => {
          await inner.insert(table, [{ id: "inner" }]);
          throw new Error("inner fail");
        }),
      ).rejects.toThrow("inner fail");
    });
    const rows = await db.find(table, { sort: [{ field: "id", direction: "asc" }] });
    expect(rows.map((r) => r["id"])).toEqual(["outer"]);
  });

  it("runs migrations idempotently", async () => {
    const db = await live();
    if (!db) return;
    const table = t("migrated");
    const migration = {
      id: `m001_${RUN}`,
      async up(tx: MssqlAdapter): Promise<void> {
        await tx.createTable(table);
      },
    };
    await db.migrate([migration]);
    await db.migrate([migration]);
    await db.insert(table, [{ id: "x" }]);
    expect(await db.find(table, {})).toHaveLength(1);
  });

  it("treats SQL-injection values as data, not SQL", async () => {
    const db = await live();
    if (!db) return;
    const table = t("users");
    await db.createTable(table);
    await db.insert(table, [{ id: "u1", name: "Ada" }]);
    const evil = "x' OR '1'='1";
    const found = await db.find(table, {
      filters: [{ field: "name", operator: "eq", value: evil }],
    });
    expect(found).toHaveLength(0);
    const all = await db.find(table, {});
    expect(all).toHaveLength(1);
    expect(all[0]?.["name"]).toBe("Ada");
  });

  it("rejects unsafe table names", async () => {
    const db = await live();
    if (!db) return;
    await expect(db.createTable('users"; DROP TABLE users; --')).rejects.toThrow(
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
      assertCapability(fake, "optimisticLocking");
    }).toThrow(UnsupportedCapabilityError);
  });
});
