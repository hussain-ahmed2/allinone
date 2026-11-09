/**
 * SQLite adapter for @allinone/database.
 *
 * Storage model: one table per collection with
 *   (id TEXT PK, tenant_id TEXT, data TEXT-JSON, created_at,
 *    updated_at, version, deleted_at)
 * Document-flexible data (JSON text) with relational tenant isolation,
 * soft delete, and optimistic locking.
 *
 * Driver: Node's built-in `node:sqlite` (Node >= 22.5) — zero native
 * dependencies. `:memory:` is supported for tests and short-lived apps;
 * file paths persist across restarts.
 *
 * Safety: values are always bound with `?` placeholders; table/field
 * identifiers are whitelisted (see ./sql.ts).
 */
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  type AdapterContext,
  type DatabaseAdapter,
  type QueryOptions,
  type Row,
} from "@allinone/database";
import {
  assertIdentifier,
  buildCreateTableQuery,
  buildInsertQuery,
  buildOptimisticUpdateQuery,
  buildSelectQuery,
  buildSoftDeleteQuery,
  buildUpdateQuery,
} from "./sql.js";

export interface SqliteAdapterOptions {
  /** File path, ":memory:", or omitted for a temporary file. */
  path?: string;
  /** Same as `path` (convenience alias). */
  filename?: string;
  /** Enable WAL mode (better concurrency for file databases). Default false. */
  wal?: boolean;
}

type SqliteRow = Record<string, string | number | null>;

export const sqliteCapabilities = {
  transactions: true,
  nestedTransactions: true,
  foreignKeys: true,
  joins: true,
  jsonQueries: true,
  fullTextSearch: true,
  schemaMigrations: true,
  optimisticLocking: true,
  rowLevelSecurity: false,
  softDeletes: true,
} as const;

function parseData(data: string): Record<string, unknown> {
  return JSON.parse(data) as Record<string, unknown>;
}

function toRow(record: SqliteRow): Row {
  return {
    ...parseData(String(record["data"])),
    id: String(record["id"]),
    ...(record["tenant_id"] ? { tenantId: String(record["tenant_id"]) } : {}),
    _createdAt: String(record["created_at"]),
    _updatedAt: String(record["updated_at"]),
    _version: Number(record["version"]),
  };
}

function toInsertId(row: Row): string {
  const id = row["id"];
  return typeof id === "string" && id.length > 0 ? id : `sqlite_${randomUUID().slice(0, 12)}`;
}

const MIGRATIONS_TABLE = "allinone_migrations";

export function createSqliteAdapter(options: SqliteAdapterOptions = {}): SqliteAdapter {
  const db = new DatabaseSync(options.filename ?? options.path ?? ":memory:");
  if (options.wal === true) {
    db.exec("PRAGMA journal_mode = WAL;");
  }
  return new SqliteAdapter(db);
}

export class SqliteAdapter implements DatabaseAdapter {
  readonly name = "sqlite";
  readonly capabilities = { ...sqliteCapabilities };
  readonly #db: DatabaseSync;
  #txDepth = 0;
  #savepointSeq = 0;
  #connected = false;

  constructor(db: DatabaseSync) {
    this.#db = db;
  }

  async connect(): Promise<void> {
    this.#db.exec("PRAGMA foreign_keys = ON;");
    this.query("SELECT 1 AS ok");
    this.#connected = true;
  }

  async disconnect(): Promise<void> {
    this.#db.close();
    this.#connected = false;
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
    const started = performance.now();
    this.query("SELECT 1");
    return { ok: this.#connected, latencyMs: Math.round(performance.now() - started) };
  }

  /**
   * Parameterized raw SQL escape hatch — joins, FTS search, admin DDL.
   * Always pass values via `params`; never interpolate.
   */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  query<T extends SqliteRow = SqliteRow>(text: string, params: unknown[] = []): { rows: T[] } {
    const rows = this.#db.prepare(text).all(...(params as never[])) as unknown as T[];
    return { rows };
  }

  async createTable(collection: string): Promise<void> {
    assertIdentifier(collection);
    const q = buildCreateTableQuery(collection);
    this.#db.exec(q.text);
  }

  async insert(collection: string, rows: readonly Row[], ctx?: AdapterContext): Promise<Row[]> {
    if (rows.length === 0) return [];
    const tenantId = ctx?.tenantId;
    const insertRows = rows.map((row) => ({
      id: toInsertId(row),
      tenantId,
      data: JSON.stringify(row),
    }));
    const q = buildInsertQuery(collection, insertRows);
    this.#db.prepare(q.text).run(...(q.params as never[]));
    const ids = insertRows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(", ");
    const found = this.query(
      `SELECT \`id\`, \`tenant_id\`, \`data\`, \`created_at\`, \`updated_at\`, \`version\` ` +
        `FROM \`${assertIdentifier(collection)}\` WHERE \`id\` IN (${placeholders})`,
      ids,
    ).rows;
    const byId = new Map(found.map((r) => [String(r["id"]), r]));
    return insertRows
      .map((r) => byId.get(r.id))
      .filter((r): r is SqliteRow => r !== undefined)
      .map(toRow);
  }

  async find(collection: string, options?: QueryOptions, ctx?: AdapterContext): Promise<Row[]> {
    const tenantId = options?.tenantId ?? ctx?.tenantId;
    const q = buildSelectQuery(collection, options, tenantId);
    return this.query(q.text, q.params).rows.map(toRow);
  }

  /**
   * Read one non-deleted row (tenant-scoped when `tenantId` is set).
   * Used for read-modify-write updates.
   */
  #getRecord(collection: string, id: string, tenantId: string | undefined): SqliteRow | null {
    const table = `\`${assertIdentifier(collection)}\``;
    const params: unknown[] = [id];
    let text =
      `SELECT \`id\`, \`tenant_id\`, \`data\`, \`created_at\`, \`updated_at\`, \`version\` ` +
      `FROM ${table} WHERE \`id\` = ? AND \`deleted_at\` IS NULL`;
    if (tenantId !== undefined) {
      params.push(tenantId);
      text += " AND `tenant_id` = ?";
    }
    return this.query(text, params).rows[0] ?? null;
  }

  async update(
    collection: string,
    id: string,
    patch: Row,
    ctx?: AdapterContext,
  ): Promise<Row | null> {
    const tenantId = ctx?.tenantId;
    const existing = this.#getRecord(collection, id, tenantId);
    if (!existing) return null;
    const merged: Row = { ...parseData(String(existing["data"])), ...patch };
    const q = buildUpdateQuery(collection, id, JSON.stringify(merged), tenantId);
    this.#db.prepare(q.text).run(...(q.params as never[]));
    const fresh = this.#getRecord(collection, id, tenantId);
    return fresh ? toRow(fresh) : null;
  }

  /**
   * Optimistic-locking update — returns null (no error) when the
   * expected version no longer matches (lost update detected).
   */
  async updateOptimistic(
    collection: string,
    id: string,
    patch: Row,
    expectedVersion: number,
    ctx?: AdapterContext,
  ): Promise<Row | null> {
    const tenantId = ctx?.tenantId;
    const existing = this.#getRecord(collection, id, tenantId);
    if (!existing) return null;
    const merged: Row = { ...parseData(String(existing["data"])), ...patch };
    const q = buildOptimisticUpdateQuery(
      collection,
      id,
      JSON.stringify(merged),
      expectedVersion,
      tenantId,
    );
    const result = this.#db.prepare(q.text).run(...(q.params as never[]));
    if (Number(result.changes) === 0) return null;
    const fresh = this.#getRecord(collection, id, tenantId);
    return fresh ? toRow(fresh) : null;
  }

  async remove(collection: string, id: string, ctx?: AdapterContext): Promise<boolean> {
    const tenantId = ctx?.tenantId;
    const q = buildSoftDeleteQuery(collection, id, tenantId);
    const result = this.#db.prepare(q.text).run(...(q.params as never[]));
    return Number(result.changes) > 0;
  }

  /**
   * Hard-delete escape hatch — for GDPR-style erasure where soft delete
   * is not acceptable. Soft-delete remains the default (`remove()`).
   */
  async hardRemove(collection: string, id: string, ctx?: AdapterContext): Promise<boolean> {
    const table = `\`${assertIdentifier(collection)}\``;
    const params: unknown[] = [id];
    let text = `DELETE FROM ${table} WHERE \`id\` = ?`;
    if (ctx?.tenantId !== undefined) {
      params.push(ctx.tenantId);
      text += " AND `tenant_id` = ?";
    }
    const result = this.#db.prepare(text).run(...(params as never[]));
    return Number(result.changes) > 0;
  }

  async transaction<T>(fn: (tx: DatabaseAdapter) => Promise<T>): Promise<T> {
    if (this.#txDepth > 0) {
      this.#savepointSeq += 1;
      const sp = "sp_" + String(this.#savepointSeq);
      this.#db.exec(`SAVEPOINT "${sp}"`);
      this.#txDepth += 1;
      try {
        const result = await fn(this);
        this.#db.exec(`RELEASE "${sp}"`);
        return result;
      } catch (error) {
        this.#db.exec(`ROLLBACK TO "${sp}"`);
        this.#db.exec(`RELEASE "${sp}"`);
        throw error;
      } finally {
        this.#txDepth -= 1;
      }
    }
    this.#db.exec("BEGIN");
    this.#txDepth = 1;
    try {
      const result = await fn(this);
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    } finally {
      this.#txDepth = 0;
    }
  }

  /**
   * Run pending migrations (each in its own transaction) and record them
   * in `allinone_migrations`. Safe to re-run — already-applied ids skip.
   */
  async migrate(migrations: readonly Migration[] = []): Promise<void> {
    this.#db.exec(
      `CREATE TABLE IF NOT EXISTS \`${MIGRATIONS_TABLE}\` (` +
        "`id` TEXT NOT NULL," +
        "`applied_at` TEXT NOT NULL DEFAULT (datetime('now'))," +
        "PRIMARY KEY (`id`))",
    );
    const rows = this.query<{ id: string }>(`SELECT \`id\` FROM \`${MIGRATIONS_TABLE}\``).rows;
    const applied = new Set(rows.map((r) => r.id));
    for (const migration of migrations) {
      if (applied.has(migration.id)) continue;
      await this.transaction(async (tx) => {
        if (!(tx instanceof SqliteAdapter)) throw new Error("unreachable");
        await migration.up(tx);
        tx.query(`INSERT INTO \`${MIGRATIONS_TABLE}\` (\`id\`) VALUES (?)`, [migration.id]);
      });
    }
  }

  isConnected(): boolean {
    return this.#connected;
  }
}

export interface Migration {
  id: string;
  description?: string;
  up(tx: SqliteAdapter): Promise<void>;
}
