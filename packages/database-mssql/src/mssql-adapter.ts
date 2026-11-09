/**
 * Microsoft SQL Server adapter for @allinone/database.
 *
 * Storage model: one table per collection with
 *   (id NVARCHAR PK, tenant_id NVARCHAR, data NVARCHAR(MAX) JSON,
 *    created_at DATETIME2, updated_at, version, deleted_at)
 * Document-flexible data (JSON text) with relational tenant isolation,
 * soft delete, and optimistic locking.
 *
 * Safety: values are always bound via node-mssql's parameterized
 * `request.input(...)` (@p0, @p1, ...); table/field identifiers are
 * whitelisted (see ./sql.ts).
 */
import { randomUUID } from "node:crypto";
import mssql from "mssql";
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
  type BuiltQuery,
} from "./sql.js";

export interface MssqlAdapterOptions {
  /** Connection string: `mssql://user:pass@host:1433/db`. */
  connectionString?: string;
  server?: string;
  user?: string;
  password?: string;
  database?: string;
  port?: number;
  encrypt?: boolean;
  pool?: boolean;
  poolMax?: number;
}

export interface MssqlRowRecord {
  id: string;
  tenant_id: string | null;
  data: string | Record<string, unknown>;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
}

export const mssqlCapabilities = {
  transactions: true,
  nestedTransactions: true,
  foreignKeys: true,
  joins: true,
  jsonQueries: true,
  fullTextSearch: true,
  schemaMigrations: true,
  optimisticLocking: true,
  rowLevelSecurity: true,
  softDeletes: true,
} as const;

function parseData(data: string | Record<string, unknown>): Record<string, unknown> {
  return typeof data === "string" ? (JSON.parse(data) as Record<string, unknown>) : data;
}

function toRow(record: MssqlRowRecord): Row {
  return {
    ...parseData(record.data),
    id: record.id,
    ...(record.tenant_id ? { tenantId: record.tenant_id } : {}),
    _createdAt: new Date(record.created_at).toISOString(),
    _updatedAt: new Date(record.updated_at).toISOString(),
    _version: record.version,
  };
}

function toInsertId(row: Row): string {
  const id = row["id"];
  return typeof id === "string" && id.length > 0 ? id : `mssql_${randomUUID().slice(0, 12)}`;
}

const MIGRATIONS_TABLE = "allinone_migrations";

/** Parse `mssql://user:pass@host[:port]/db` into plain config fields. */
function parseConnectionString(url: string): {
  server: string;
  user: string;
  password: string;
  database: string;
  port?: number;
} {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(
      `[allinone/database-mssql] Invalid connection string (use mssql://user:pass@host:1433/db)`,
    );
  }
  const database = parsed.pathname.replace(/^\//, "");
  return {
    server: parsed.hostname,
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database,
    ...(parsed.port ? { port: Number(parsed.port) } : {}),
  };
}

export function createMssqlAdapter(options: MssqlAdapterOptions = {}): MssqlAdapter {
  const fromUrl = options.connectionString ? parseConnectionString(options.connectionString) : null;
  const config: mssql.config = {
    server: options.server ?? fromUrl?.server ?? "127.0.0.1",
    user: options.user ?? fromUrl?.user ?? "sa",
    password: options.password ?? fromUrl?.password ?? "",
    database: options.database ?? fromUrl?.database ?? "allinone",
    ...(options.port !== undefined || fromUrl?.port !== undefined
      ? { port: options.port ?? fromUrl?.port }
      : {}),
    options: { encrypt: options.encrypt ?? true },
    ...(options.poolMax !== undefined ? { pool: { max: options.poolMax } } : {}),
  };
  return new MssqlAdapter(config);
}

export class MssqlAdapter implements DatabaseAdapter {
  readonly name = "mssql";
  readonly capabilities = { ...mssqlCapabilities };
  readonly #config: mssql.config;
  #pool: mssql.ConnectionPool | undefined;
  #transaction: mssql.Transaction | undefined;
  #txDepth = 0;
  #savepointSeq = 0;
  #connected = false;

  constructor(config: mssql.config) {
    this.#config = config;
  }

  private async pool(): Promise<mssql.ConnectionPool> {
    if (!this.#pool) {
      const pool = new mssql.ConnectionPool(this.#config);
      await pool.connect();
      this.#pool = pool;
    }
    return this.#pool;
  }

  /** Fresh request bound to the tx (if any) or the pool. */
  private request(pool: mssql.ConnectionPool): mssql.Request {
    return this.#transaction ? new mssql.Request(this.#transaction) : new mssql.Request(pool);
  }

  /** Active request — bound parameters applied from the BuiltQuery bag. */
  private async runQuery<T = Record<string, unknown>>(query: BuiltQuery): Promise<T[]> {
    const pool = await this.pool();
    const request = this.request(pool);
    for (const [name, value] of Object.entries(query.params)) {
      request.input(name, value);
    }
    const result = await request.query(query.text);
    return result.recordset.map((row: Record<string, unknown>) => row as T);
  }

  async connect(): Promise<void> {
    await this.pool();
    await this.query("SELECT 1 AS ok");
    this.#connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.#pool) await this.#pool.close();
    this.#pool = undefined;
    this.#connected = false;
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
    const started = performance.now();
    await this.query("SELECT 1");
    return { ok: true, latencyMs: Math.round(performance.now() - started) };
  }

  /**
   * Parameterized raw SQL escape hatch — joins, FULLTEXT search, admin DDL.
   * Always bind values via @parameters; never interpolate.
   */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  async query<T = Record<string, unknown>>(
    text: string,
    params: Record<string, unknown> = {},
  ): Promise<{ rows: T[] }> {
    const rows = await this.runQuery<T>({ text, params });
    return { rows };
  }

  async createTable(collection: string): Promise<void> {
    assertIdentifier(collection);
    const q = buildCreateTableQuery(collection);
    await this.query(q.text);
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
    await this.runQuery(q);
    const ids = insertRows.map((r) => r.id);
    const bagPlaceholders = ids.map((_, i) => `@i${String(i)}`).join(", ");
    const found = await this.runQuery<MssqlRowRecord>({
      text:
        `SELECT [id], [tenant_id], [data], [created_at], [updated_at], [version] ` +
        `FROM [${assertIdentifier(collection)}] WHERE [id] IN (${bagPlaceholders})`,
      params: Object.fromEntries(ids.map((id, i) => [`i${String(i)}`, id])),
    });
    const byId = new Map(found.map((r) => [r.id, r]));
    return insertRows
      .map((r) => byId.get(r.id))
      .filter((r): r is MssqlRowRecord => r !== undefined)
      .map(toRow);
  }

  async find(collection: string, options?: QueryOptions, ctx?: AdapterContext): Promise<Row[]> {
    const tenantId = options?.tenantId ?? ctx?.tenantId;
    const q = buildSelectQuery(collection, options, tenantId);
    const rows = await this.runQuery<MssqlRowRecord>(q);
    return rows.map(toRow);
  }

  /**
   * Read one non-deleted row (tenant-scoped when `tenantId` is set).
   * Used for read-modify-write updates.
   */
  async #getRecord(
    collection: string,
    id: string,
    tenantId: string | undefined,
  ): Promise<MssqlRowRecord | null> {
    const table = `[${assertIdentifier(collection)}]`;
    let text =
      `SELECT [id], [tenant_id], [data], [created_at], [updated_at], [version] ` +
      `FROM ${table} WHERE [id] = @id AND [deleted_at] IS NULL`;
    const params: Record<string, unknown> = { id };
    if (tenantId !== undefined) {
      params["tenantId"] = tenantId;
      text += " AND [tenant_id] = @tenantId";
    }
    const rows = await this.runQuery<MssqlRowRecord>({ text, params });
    return rows[0] ?? null;
  }

  async update(
    collection: string,
    id: string,
    patch: Row,
    ctx?: AdapterContext,
  ): Promise<Row | null> {
    const tenantId = ctx?.tenantId;
    const existing = await this.#getRecord(collection, id, tenantId);
    if (!existing) return null;
    const merged: Row = { ...parseData(existing.data), ...patch };
    const q = buildUpdateQuery(collection, id, JSON.stringify(merged), tenantId);
    await this.runQuery(q);
    const fresh = await this.#getRecord(collection, id, tenantId);
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
    const existing = await this.#getRecord(collection, id, tenantId);
    if (!existing) return null;
    const merged: Row = { ...parseData(existing.data), ...patch };
    const q = buildOptimisticUpdateQuery(
      collection,
      id,
      JSON.stringify(merged),
      expectedVersion,
      tenantId,
    );
    const pool = await this.pool();
    const request = this.request(pool);
    for (const [name, value] of Object.entries(q.params)) request.input(name, value);
    const result = await request.query(q.text);
    if ((result.rowsAffected[0] ?? 0) === 0) return null;
    const fresh = await this.#getRecord(collection, id, tenantId);
    return fresh ? toRow(fresh) : null;
  }

  async remove(collection: string, id: string, ctx?: AdapterContext): Promise<boolean> {
    const tenantId = ctx?.tenantId;
    const q = buildSoftDeleteQuery(collection, id, tenantId);
    const pool = await this.pool();
    const request = this.request(pool);
    for (const [name, value] of Object.entries(q.params)) request.input(name, value);
    const result = await request.query(q.text);
    return (result.rowsAffected[0] ?? 0) > 0;
  }

  /**
   * Hard-delete escape hatch — for GDPR-style erasure where soft delete
   * is not acceptable. Soft-delete remains the default (`remove()`).
   */
  async hardRemove(collection: string, id: string, ctx?: AdapterContext): Promise<boolean> {
    const table = `[${assertIdentifier(collection)}]`;
    let text = `DELETE FROM ${table} WHERE [id] = @id`;
    const params: Record<string, unknown> = { id };
    if (ctx?.tenantId !== undefined) {
      params["tenantId"] = ctx.tenantId;
      text += " AND [tenant_id] = @tenantId";
    }
    const pool = await this.pool();
    const request = this.request(pool);
    for (const [name, value] of Object.entries(params)) request.input(name, value);
    const result = await request.query(text);
    return (result.rowsAffected[0] ?? 0) > 0;
  }

  async transaction<T>(fn: (tx: DatabaseAdapter) => Promise<T>): Promise<T> {
    if (this.#txDepth > 0) {
      this.#savepointSeq += 1;
      const sp = "sp_" + String(this.#savepointSeq);
      await this.query(`SAVE TRANSACTION [${sp}]`);
      this.#txDepth += 1;
      try {
        const result = await fn(this);
        await this.query(`RELEASE SAVEPOINT [${sp}]`);
        return result;
      } catch (error) {
        await this.query(`ROLLBACK TRANSACTION [${sp}]`);
        await this.query(`RELEASE SAVEPOINT [${sp}]`);
        throw error;
      } finally {
        this.#txDepth -= 1;
      }
    }

    if (this.#transaction)
      throw new Error("[allinone/database-mssql] Nested transaction state error");
    const transaction = new mssql.Transaction(await this.pool());
    await transaction.begin();
    this.#transaction = transaction;
    this.#txDepth = 1;
    try {
      const result = await fn(this);
      await transaction.commit();
      return result;
    } catch (error) {
      await transaction.rollback();
      throw error;
    } finally {
      this.#transaction = undefined;
      this.#txDepth = 0;
    }
  }

  /**
   * Run pending migrations (each in its own transaction) and record them
   * in `allinone_migrations`. Safe to re-run — already-applied ids skip.
   */
  async migrate(migrations: readonly Migration[] = []): Promise<void> {
    await this.query(
      `IF OBJECT_ID(N'[${MIGRATIONS_TABLE}]', N'U') IS NULL ` +
        `BEGIN CREATE TABLE [${MIGRATIONS_TABLE}] (` +
        "[id] NVARCHAR(255) NOT NULL PRIMARY KEY," +
        "[applied_at] DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()); END",
    );
    const { rows } = await this.query<{ id: string }>(`SELECT [id] FROM [${MIGRATIONS_TABLE}]`);
    const applied = new Set(rows.map((r) => r.id));
    for (const migration of migrations) {
      if (applied.has(migration.id)) continue;
      await this.transaction(async (tx) => {
        if (!(tx instanceof MssqlAdapter)) throw new Error("unreachable");
        await migration.up(tx);
        await tx.query(`INSERT INTO [${MIGRATIONS_TABLE}] ([id]) VALUES (@id)`, {
          id: migration.id,
        });
      });
    }
  }

  /**
   * Run `fn` with the `tenant_id` session context set inside a transaction.
   *
   * SQL Server RLS predicates are deployment-specific (predicate functions
   * differ per tenant graph) — this helper only sets the context; your DBA
   * owns the SECURITY POLICY that consumes it. Primary protection remains
   * the checked `tenant_id` predicates in every query.
   */
  async withTenantSetting<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return this.transaction(async () => {
      await this.query("EXEC sp_set_session_context N'tenant_id', @tenantId", {
        tenantId,
      });
      return fn();
    });
  }

  isConnected(): boolean {
    return this.#connected;
  }
}

export interface Migration {
  id: string;
  description?: string;
  up(tx: MssqlAdapter): Promise<void>;
}
