/**
 * MySQL / MariaDB adapter for @allinone/database.
 *
 * Storage model: one InnoDB table per collection with
 *   (id VARCHAR PK, tenant_id VARCHAR, data JSON, created_at,
 *    updated_at ON UPDATE, version, deleted_at)
 * Application fields live in `data`; tenant isolation, soft delete,
 * and optimistic locking are columns.
 *
 * Safety: values are always bound with `?` placeholders
 * (mysql2 prepared statements). Table/field identifiers are
 * whitelisted (see ./sql.ts). LIMIT/OFFSET are validated integers
 * embedded as literals (binding support varies across MySQL versions).
 */
import { randomUUID } from "node:crypto";
import mysql, {
  type Pool as MysqlPool,
  type PoolConnection,
  type ResultSetHeader,
  type RowDataPacket,
} from "mysql2/promise";
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

export interface MysqlAdapterOptions {
  /** Connection string: mysql://user:pass@host:port/db */
  connectionString?: string;
  /** mysql2 pool config (host, user, password, database, charset, ...). */
  pool?: mysql.PoolOptions;
  max?: number;
}

export interface MysqlRowRecord extends RowDataPacket {
  id: string;
  tenant_id: string | null;
  data: Record<string, unknown> | string;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
}

export const mysqlCapabilities = {
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

function parseData(data: Record<string, unknown> | string): Record<string, unknown> {
  return typeof data === "string" ? (JSON.parse(data) as Record<string, unknown>) : data;
}

function toRow(record: MysqlRowRecord): Row {
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
  return typeof id === "string" && id.length > 0 ? id : `mysql_${randomUUID().slice(0, 12)}`;
}

const MIGRATIONS_TABLE = "allinone_migrations";

export function createMysqlAdapter(options: MysqlAdapterOptions = {}): MysqlAdapter {
  const pool = mysql.createPool(
    options.pool ?? {
      ...(options.connectionString
        ? { uri: options.connectionString }
        : {
            host: "127.0.0.1",
            user: "root",
            database: "allinone",
          }),
      ...(options.max !== undefined ? { connectionLimit: options.max } : {}),
      charset: "utf8mb4",
      connectTimeout: 10_000,
    },
  );
  return new MysqlAdapter(pool);
}

export class MysqlAdapter implements DatabaseAdapter {
  readonly name = "mysql";
  readonly capabilities = { ...mysqlCapabilities };
  readonly #pool: MysqlPool;
  #client: PoolConnection | undefined;
  #txDepth = 0;
  #savepointSeq = 0;
  #connected = false;

  constructor(pool: MysqlPool) {
    this.#pool = pool;
  }

  private async exec<T extends RowDataPacket = RowDataPacket>(
    text: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const executor = this.#client ?? this.#pool;
    const [rows] = await (executor as MysqlPool).query(text, params);
    return rows as T[];
  }

  private async execHeader(text: string, params: unknown[] = []): Promise<ResultSetHeader> {
    const executor = this.#client ?? this.#pool;
    const [result] = await (executor as MysqlPool).query(text, params);
    return result as ResultSetHeader;
  }

  async connect(): Promise<void> {
    await this.query("SELECT 1 AS ok");
    this.#connected = true;
  }

  async disconnect(): Promise<void> {
    await this.#pool.end();
    this.#connected = false;
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
    const started = performance.now();
    await this.query("SELECT 1");
    return { ok: true, latencyMs: Math.round(performance.now() - started) };
  }

  /** Parameterized raw SQL escape hatch — joins, FULLTEXT search, admin DDL. */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  async query<T extends RowDataPacket = RowDataPacket>(
    text: string,
    params: unknown[] = [],
  ): Promise<{ rows: T[] }> {
    return { rows: await this.exec<T>(text, params) };
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
    await this.execHeader(q.text, q.params);
    const ids = insertRows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(", ");
    const found = await this.exec<MysqlRowRecord>(
      `SELECT \`id\`, \`tenant_id\`, \`data\`, \`created_at\`, \`updated_at\`, \`version\` ` +
        `FROM \`${assertIdentifier(collection)}\` WHERE \`id\` IN (${placeholders})`,
      ids,
    );
    const byId = new Map(found.map((r) => [r.id, r]));
    return insertRows
      .map((r) => byId.get(r.id))
      .filter((r): r is MysqlRowRecord => r !== undefined)
      .map(toRow);
  }

  async find(collection: string, options?: QueryOptions, ctx?: AdapterContext): Promise<Row[]> {
    const tenantId = options?.tenantId ?? ctx?.tenantId;
    const q = buildSelectQuery(collection, options, tenantId);
    const rows = await this.exec<MysqlRowRecord>(q.text, q.params);
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
  ): Promise<MysqlRowRecord | null> {
    const table = `\`${assertIdentifier(collection)}\``;
    const params: unknown[] = [id];
    let text =
      `SELECT \`id\`, \`tenant_id\`, \`data\`, \`created_at\`, \`updated_at\`, \`version\` ` +
      `FROM ${table} WHERE \`id\` = ? AND \`deleted_at\` IS NULL`;
    if (tenantId !== undefined) {
      params.push(tenantId);
      text += " AND `tenant_id` = ?";
    }
    const rows = await this.exec<MysqlRowRecord>(text, params);
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
    await this.execHeader(q.text, q.params);
    return this.#getRecord(collection, id, tenantId).then((r) => (r ? toRow(r) : null));
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
    const header = await this.execHeader(q.text, q.params);
    if (header.affectedRows === 0) return null;
    const fresh = await this.#getRecord(collection, id, tenantId);
    return fresh ? toRow(fresh) : null;
  }

  async remove(collection: string, id: string, ctx?: AdapterContext): Promise<boolean> {
    const tenantId = ctx?.tenantId;
    const q = buildSoftDeleteQuery(collection, id, tenantId);
    const header = await this.execHeader(q.text, q.params);
    return header.affectedRows > 0;
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
    const header = await this.execHeader(text, params);
    return header.affectedRows > 0;
  }

  async transaction<T>(fn: (tx: DatabaseAdapter) => Promise<T>): Promise<T> {
    if (this.#txDepth > 0) {
      this.#savepointSeq += 1;
      const sp = "sp_" + String(this.#savepointSeq);
      await this.query(`SAVEPOINT \`${sp}\``);
      this.#txDepth += 1;
      try {
        const result = await fn(this);
        await this.query(`RELEASE SAVEPOINT \`${sp}\``);
        return result;
      } catch (error) {
        await this.query(`ROLLBACK TO SAVEPOINT \`${sp}\``);
        await this.query(`RELEASE SAVEPOINT \`${sp}\``);
        throw error;
      } finally {
        this.#txDepth -= 1;
      }
    }

    if (this.#client) throw new Error("[allinone/database-mysql] Nested transaction state error");
    const client = await this.#pool.getConnection();
    this.#client = client;
    this.#txDepth = 1;
    try {
      await client.beginTransaction();
      const result = await fn(this);
      await client.commit();
      return result;
    } catch (error) {
      await client.rollback();
      throw error;
    } finally {
      this.#client = undefined;
      this.#txDepth = 0;
      client.release();
    }
  }

  /**
   * Run pending migrations (each in its own transaction) and record them
   * in `allinone_migrations`. Safe to re-run — already-applied ids skip.
   */
  async migrate(migrations: readonly Migration[] = []): Promise<void> {
    await this.query(
      `CREATE TABLE IF NOT EXISTS \`${MIGRATIONS_TABLE}\` (` +
        "`id` VARCHAR(255) NOT NULL," +
        "`applied_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)," +
        "PRIMARY KEY (`id`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
    );
    const { rows } = await this.query<RowDataPacket & { id: string }>(
      `SELECT \`id\` FROM \`${MIGRATIONS_TABLE}\``,
    );
    const applied = new Set(rows.map((r) => r.id));
    for (const migration of migrations) {
      if (applied.has(migration.id)) continue;
      await this.transaction(async (tx) => {
        if (!(tx instanceof MysqlAdapter)) throw new Error("unreachable");
        await migration.up(tx);
        await tx.query(`INSERT INTO \`${MIGRATIONS_TABLE}\` (\`id\`) VALUES (?)`, [migration.id]);
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
  up(tx: MysqlAdapter): Promise<void>;
}
