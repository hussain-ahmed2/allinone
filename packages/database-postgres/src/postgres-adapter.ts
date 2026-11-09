/**
 * PostgreSQL adapter for @allinone/database.
 *
 * Storage model: one table per collection with
 *   (id TEXT PK, tenant_id TEXT, data JSONB, created_at, updated_at,
 *    version INTEGER, deleted_at)
 * Application fields live in `data` (document-style JSONB) while
 * tenant isolation, soft delete, and optimistic locking are relational.
 *
 * Capabilities (see @allinone/database): transactions, nested
 * transactions (savepoints), foreign keys, joins (via `query()`),
 * JSONB queries, full-text search (via `query()`), migrations,
 * optimistic locking, row-level security (helper below), soft deletes.
 *
 * Safety: values are always parameterized; identifiers are whitelisted
 * (see ./sql.ts). Use `query()` only with parameterized SQL — never
 * interpolate values into raw text.
 */
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient, type QueryResultRow } from "pg";
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

/** Minimal queryable — pg Pool and PoolClient both satisfy this. */
export interface Queryable {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export interface PostgresAdapterOptions {
  /** Connection string, e.g. process.env.DATABASE_URL. */
  connectionString?: string;
  /** pg Pool config (host, port, user, password, database, ssl, ...). */
  pool?: ConstructorParameters<typeof Pool>[0];
  /** Pre-built pool or queryable — used by tests (pg-mem). */
  queryable?: Queryable;
  /** Max pool size (default 10). */
  max?: number;
  /**
   * Schema-per-tenant strategy: resolve the Postgres schema for a tenant.
   * When provided, every query is qualified with that schema
   * (e.g. `"tenant_acme"."users"`). Return `undefined` for shared-schema.
   */
  schemaProvider?: (tenantId: string) => string | undefined;
}

export interface PostgresRowRecord extends QueryResultRow {
  id: string;
  tenant_id: string | null;
  data: Record<string, unknown>;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
}

export const postgresCapabilities = {
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

function toRow(record: PostgresRowRecord): Row {
  return {
    ...record.data,
    id: record.id,
    ...(record.tenant_id ? { tenantId: record.tenant_id } : {}),
    _createdAt: new Date(record.created_at).toISOString(),
    _updatedAt: new Date(record.updated_at).toISOString(),
    _version: record.version,
  };
}

function toInsertId(row: Row): string {
  const id = row["id"];
  return typeof id === "string" && id.length > 0 ? id : `pg_${randomUUID().slice(0, 12)}`;
}

const MIGRATIONS_TABLE = "allinone_migrations";

/**
 * Create a PostgreSQL adapter.
 *
 * ```ts
 * const db = createPostgresAdapter({ connectionString: process.env.DATABASE_URL });
 * await db.connect(); // verifies the pool with SELECT 1
 * ```
 */
export function createPostgresAdapter(options: PostgresAdapterOptions = {}): PostgresAdapter {
  const schemaProvider = options.schemaProvider;
  if (options.queryable) {
    return new PostgresAdapter(options.queryable, undefined, schemaProvider);
  }
  const pool = new Pool(
    options.pool ?? {
      connectionString: options.connectionString ?? process.env["DATABASE_URL"],
      max: options.max ?? 10,
    },
  );
  return new PostgresAdapter(pool, pool, schemaProvider);
}

/** Conventional tenant schema name (`tenant_<slug>`). */
export function tenantSchemaName(slug: string): string {
  return `tenant_${slug.replace(/[^a-zA-Z0-9_]/g, "_").replace(/^./, (c) => (c >= "0" && c <= "9" ? "_" : c))}`;
}

export class PostgresAdapter implements DatabaseAdapter {
  readonly name = "postgres";
  readonly capabilities = { ...postgresCapabilities };
  readonly #queryable: Queryable;
  readonly #pool: Pool | undefined;
  readonly #schemaProvider: ((tenantId: string) => string | undefined) | undefined;
  #client: PoolClient | undefined;
  #txDepth = 0;
  #savepointSeq = 0;
  #connected = false;

  constructor(
    queryable: Queryable,
    pool: Pool | undefined,
    schemaProvider?: (tenantId: string) => string | undefined,
  ) {
    this.#queryable = queryable;
    this.#pool = pool;
    this.#schemaProvider = schemaProvider;
  }

  /** Resolve schema for tenant-scoped operations (undefined = shared). */
  #schemaFor(tenantId: string | undefined): string | undefined {
    return tenantId ? this.#schemaProvider?.(tenantId) : undefined;
  }

  /** Active executor — the tx client inside transactions, else the pool. */
  #exec(): Queryable {
    return this.#client ?? this.#queryable;
  }

  async connect(): Promise<void> {
    await this.query("SELECT 1 AS ok");
    this.#connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.#pool) await this.#pool.end();
    this.#connected = false;
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
    const started = performance.now();
    await this.query("SELECT 1");
    return { ok: true, latencyMs: Math.round(performance.now() - started) };
  }

  /**
   * Parameterized raw SQL escape hatch — for joins, full-text search,
   * and RLS setup. Always pass values via `params`; never interpolate.
   */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<{ rows: T[] }> {
    return this.#exec().query<T>(text, params);
  }

  async createTable(collection: string, schema?: string): Promise<void> {
    assertIdentifier(collection, "table");
    if (schema !== undefined) assertIdentifier(schema, "table");
    const q = buildCreateTableQuery(collection, schema);
    await this.query(q.text);
    // Tenant lookup index (btree — portable). JSONB GIN index is created
    // best-effort below for real Postgres; pg-mem may reject it.
    const table = schema ? `"${schema}"."${collection}"` : `"${collection}"`;
    await this.query(
      `CREATE INDEX IF NOT EXISTS "${collection}_tenant_idx" ON ${table} ("tenant_id")`,
    );
    try {
      await this.query(
        `CREATE INDEX IF NOT EXISTS "${collection}_data_gin_idx" ON ${table} USING GIN ("data")`,
      );
    } catch {
      // GIN is an optimization only — never fail table creation for it.
    }
  }

  /**
   * Provision a tenant schema + tables (separate-schema strategy).
   * The schema name comes from `schemaProvider` — create one per tenant
   * at tenant registration; queries then qualify via the provider.
   */
  async createTenantSchema(tenantId: string, collections: readonly string[]): Promise<void> {
    const schema = this.#schemaFor(tenantId);
    if (!schema) {
      throw new Error(
        "[allinone/database-postgres] No schema for tenant " +
          JSON.stringify(tenantId) +
          " — configure schemaProvider or use shared-schema strategy.",
      );
    }
    await this.query(`CREATE SCHEMA IF NOT EXISTS "${assertIdentifier(schema, "table")}"`);
    for (const collection of collections) {
      await this.createTable(collection, schema);
    }
  }

  async insert(collection: string, rows: readonly Row[], ctx?: AdapterContext): Promise<Row[]> {
    if (rows.length === 0) return [];
    const tenantId = ctx?.tenantId;
    const insertRows = rows.map((row) => ({
      id: toInsertId(row),
      tenantId,
      data: JSON.stringify(row),
    }));
    const q = buildInsertQuery(collection, insertRows, this.#schemaFor(tenantId));
    const result = await this.query<PostgresRowRecord>(q.text, q.params);
    return result.rows.map(toRow);
  }

  async find(collection: string, options?: QueryOptions, ctx?: AdapterContext): Promise<Row[]> {
    const tenantId = options?.tenantId ?? ctx?.tenantId;
    const q = buildSelectQuery(collection, options, tenantId, this.#schemaFor(tenantId));
    const result = await this.query<PostgresRowRecord>(q.text, q.params);
    return result.rows.map(toRow);
  }

  /**
   * Read one non-deleted row (tenant-scoped when `tenantId` is set).
   * Used for read-modify-write updates.
   */
  async #getRecord(
    collection: string,
    id: string,
    tenantId: string | undefined,
  ): Promise<PostgresRowRecord | null> {
    const schema = this.#schemaFor(tenantId);
    const table = schema
      ? `"${assertIdentifier(schema, "table")}"."${assertIdentifier(collection, "table")}"`
      : `"${assertIdentifier(collection, "table")}"`;
    const params: unknown[] = [id];
    let text =
      `SELECT "id", "tenant_id", "data", "created_at", "updated_at", "version" ` +
      `FROM ${table} WHERE "id" = $1 AND "deleted_at" IS NULL`;
    if (tenantId !== undefined) {
      params.push(tenantId);
      text += ` AND "tenant_id" = $${String(params.length)}`;
    }
    const result = await this.query<PostgresRowRecord>(text, params);
    return result.rows[0] ?? null;
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
    const merged: Row = { ...existing.data, ...patch };
    const q = buildUpdateQuery(
      collection,
      id,
      JSON.stringify(merged),
      tenantId,
      this.#schemaFor(tenantId),
    );
    const result = await this.query<PostgresRowRecord>(q.text, q.params);
    const [record] = result.rows;
    return record ? toRow(record) : null;
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
    const merged: Row = { ...existing.data, ...patch };
    const q = buildOptimisticUpdateQuery(
      collection,
      id,
      JSON.stringify(merged),
      expectedVersion,
      tenantId,
      this.#schemaFor(tenantId),
    );
    const result = await this.query<PostgresRowRecord>(q.text, q.params);
    const [record] = result.rows;
    return record ? toRow(record) : null;
  }

  async remove(collection: string, id: string, ctx?: AdapterContext): Promise<boolean> {
    const tenantId = ctx?.tenantId;
    const q = buildSoftDeleteQuery(collection, id, tenantId, this.#schemaFor(tenantId));
    const result = await this.query<PostgresRowRecord>(q.text, q.params);
    return result.rows.length > 0;
  }

  /**
   * Hard-delete escape hatch — for GDPR-style erasure where soft delete
   * is not acceptable. Soft-delete remains the default (`remove()`).
   */
  async hardRemove(collection: string, id: string, ctx?: AdapterContext): Promise<boolean> {
    const schema = this.#schemaFor(ctx?.tenantId);
    const table = schema
      ? `"${assertIdentifier(schema, "table")}"."${assertIdentifier(collection, "table")}"`
      : `"${assertIdentifier(collection, "table")}"`;
    const params: unknown[] = [id];
    let text = `DELETE FROM ${table} WHERE "id" = $1`;
    if (ctx?.tenantId !== undefined) {
      params.push(ctx.tenantId);
      text += ` AND "tenant_id" = $${String(params.length)}`;
    }
    text += ` RETURNING "id"`;
    const result = await this.query(text, params);
    return result.rows.length > 0;
  }

  async transaction<T>(fn: (tx: DatabaseAdapter) => Promise<T>): Promise<T> {
    if (this.#txDepth > 0) {
      // Nested: savepoint so inner failure doesn't poison the outer tx.
      this.#savepointSeq += 1;
      const sp = "sp_" + String(this.#savepointSeq);
      await this.query(`SAVEPOINT "${sp}"`);
      this.#txDepth += 1;
      try {
        const result = await fn(this);
        await this.query(`RELEASE SAVEPOINT "${sp}"`);
        return result;
      } catch (error) {
        await this.query(`ROLLBACK TO SAVEPOINT "${sp}"`);
        await this.query(`RELEASE SAVEPOINT "${sp}"`);
        throw error;
      } finally {
        this.#txDepth -= 1;
      }
    }

    const queryable = this.#queryable as Queryable & {
      connect?: () => Promise<PoolClient>;
    };
    let client: (Queryable & { release?: () => void }) | undefined;
    let ownsClient = false;
    if (this.#pool) {
      client = await this.#pool.connect();
      ownsClient = true;
    } else if (typeof queryable.connect === "function") {
      client = await queryable.connect();
      ownsClient = true;
    } else {
      // Single-client queryable (e.g. a test client): run BEGIN/COMMIT
      // on it directly. Correct for tests; production must use a Pool.
      client = this.#queryable;
    }
    const previousClient = this.#client;
    this.#client = client as PoolClient;
    this.#txDepth = 1;
    try {
      await client.query("BEGIN");
      const result = await fn(this);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      this.#client = previousClient;
      this.#txDepth = 0;
      if (ownsClient) client.release?.();
    }
  }

  /**
   * Run pending migrations (each in its own transaction) and record them
   * in `allinone_migrations`. Safe to re-run — already-applied ids skip.
   */
  async migrate(migrations: readonly Migration[] = []): Promise<void> {
    await this.query(
      `CREATE TABLE IF NOT EXISTS "${MIGRATIONS_TABLE}" (` +
        `"id" TEXT PRIMARY KEY, "applied_at" TIMESTAMPTZ NOT NULL)`,
    );
    const { rows } = await this.query<{ id: string }>(`SELECT "id" FROM "${MIGRATIONS_TABLE}"`);
    const applied = new Set(rows.map((r) => r.id));
    for (const migration of migrations) {
      if (applied.has(migration.id)) continue;
      await this.transaction(async (tx) => {
        if (!(tx instanceof PostgresAdapter)) throw new Error("unreachable");
        await migration.up(tx);
        // Timestamp from JS (not DEFAULT now()) — portable to pg-mem.
        await tx.query(`INSERT INTO "${MIGRATIONS_TABLE}" ("id", "applied_at") VALUES ($1, $2)`, [
          migration.id,
          new Date().toISOString(),
        ]);
      });
    }
  }

  /**
   * Enable row-level security for defense-in-depth tenant isolation.
   * The app must `SET LOCAL app.tenant_id = '<id>'` inside each
   * transaction (see `withTenantSetting`). Policies are per-tenant:
   * rows are visible only when tenant_id matches the setting.
   */
  async enableTenantRowLevelSecurity(
    collection: string,
    policyName = "tenant_isolation",
  ): Promise<void> {
    const table = assertIdentifier(collection, "table");
    await this.query(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
    await this.query(
      `CREATE POLICY "${policyName}" ON "${table}" ` +
        `USING ("tenant_id" = current_setting('app.tenant_id', true))`,
    );
    await this.query(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
  }

  /**
   * Run `fn` with `app.tenant_id` set inside a transaction — pairs
   * with `enableTenantRowLevelSecurity` for DB-enforced isolation.
   */
  async withTenantSetting<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return this.transaction(async () => {
      await this.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
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
  up(tx: PostgresAdapter): Promise<void>;
}
