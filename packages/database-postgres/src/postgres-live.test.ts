/**
 * Live-Postgres integration tests — run against a real database.
 *
 *   POSTGRES_TEST_URL=postgres://postgres:testpass@localhost:5433/allinone_test pnpm --filter @allinone/database-postgres test
 *
 * Default URL targets the local Docker test container:
 *   docker run -d --name allinone-pg-test -e POSTGRES_PASSWORD=testpass \
 *     -e POSTGRES_DB=allinone_test -p 5433:5432 --rm postgres:17
 *
 * Skipped entirely when no server is reachable (unit tests still run).
 */
import { afterAll, describe, expect, it } from "vitest";
import { createPostgresAdapter, type PostgresAdapter } from "./index.js";

const URL =
  process.env["POSTGRES_TEST_URL"] ??
  process.env["DATABASE_URL"] ??
  "postgres://postgres:testpass@localhost:5433/allinone_test";

/** Tables for this run — dropped first so re-runs never hit duplicate keys. */
const RUN = `r${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const t = (name: string): string => `${name}_${RUN}`;

describe("postgres live integration", () => {
  let adapter: PostgresAdapter | undefined;

  async function live(): Promise<PostgresAdapter | null> {
    const candidate = createPostgresAdapter({ connectionString: URL });
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
    if (adapter) {
      const tables = [
        "live_items",
        "live_tx",
        "live_nested",
        "live_migrated",
        "live_authors",
        "live_books",
        "live_rls",
      ]
        .map(t)
        .join('", "');
      await adapter.query(`DROP TABLE IF EXISTS "${tables}" CASCADE`).catch(() => undefined);
      await adapter.disconnect().catch(() => undefined);
    }
  });

  it("CRUD round-trip on real Postgres", async () => {
    const db = await live();
    if (!db) return;
    const table = t("live_items");
    await db.createTable(table);
    await db.insert(table, [{ id: "a", name: "Ada", score: 3 }]);
    const found = await db.find(table, {
      filters: [{ field: "name", operator: "eq", value: "Ada" }],
    });
    expect(found).toHaveLength(1);
    await db.remove(table, "a");
    expect(await db.find(table, {})).toHaveLength(0);
  });

  it("rolls back failed transactions", async () => {
    const db = await live();
    if (!db) return;
    const table = t("live_tx");
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

  it("nested savepoints isolate inner failures", async () => {
    const db = await live();
    if (!db) return;
    const table = t("live_nested");
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

  it("migrations apply transactionally + idempotently", async () => {
    const db = await live();
    if (!db) return;
    const table = t("live_migrated");
    const migration = {
      id: `live_001_${RUN}`,
      async up(tx: PostgresAdapter): Promise<void> {
        await tx.createTable(table);
      },
    };
    await db.migrate([migration]);
    await db.migrate([migration]);
    await db.insert(table, [{ id: "x" }]);
    expect(await db.find(table, {})).toHaveLength(1);
  });

  it("joins + JSONB containment via query()", async () => {
    const db = await live();
    if (!db) return;
    const authors = t("live_authors");
    const books = t("live_books");
    await db.createTable(authors);
    await db.createTable(books);
    await db.insert(authors, [{ id: "a1", name: "Ada" }]);
    await db.insert(books, [{ id: "b1", authorid: "a1", title: "Engines" }]);
    const join = await db.query<{ book: string; author: string }>(
      `SELECT b."data" ->> 'title' AS book, a."data" ->> 'name' AS author ` +
        `FROM "${books}" b JOIN "${authors}" a ` +
        `ON b."data" ->> 'authorid' = a."id"`,
    );
    expect(join.rows[0]).toMatchObject({ book: "Engines", author: "Ada" });
    const jsonb = await db.query<{ id: string }>(
      `SELECT "id" FROM "${books}" WHERE "data" @> $1::jsonb`,
      ['{"title":"Engines"}'],
    );
    expect(jsonb.rows).toHaveLength(1);
  });

  it("RLS helper installs tenant policies", async () => {
    const db = await live();
    if (!db) return;
    const table = t("live_rls");
    await db.createTable(table);
    await db.enableTenantRowLevelSecurity(table);
    await db.withTenantSetting("t1", async () => {
      await db.insert(table, [{ id: "r1" }], { tenantId: "t1" });
    });
    expect(await db.find(table, { tenantId: "t1" })).toHaveLength(1);
  });
});
