/**
 * MongoDB adapter for @allinone/database.
 *
 * Document model: one collection per collection, application fields at
 * top level (document-native). System fields: `_id` (string id),
 * `tenantId`, `_createdAt`, `_updatedAt`, `_version`, `deletedAt`.
 *
 * Honest capabilities: transactions require a replica set, so the
 * standalone default declares them FALSE and `transaction()` throws
 * `UnsupportedCapabilityError` (never faked). Nested transactions,
 * foreign keys, joins, and RLS are unavailable on MongoDB and
 * declared false. Optimistic locking uses `_version`; soft delete
 * uses `deletedAt`.
 *
 * NoSQL injection: filter values must be primitives (see ./filters.ts).
 * An attacker-supplied object like `{ $gt: "" }` is rejected, never
 * passed through as a query operator.
 */
import { randomUUID } from "node:crypto";
import { MongoClient, type Db, type Document, type UpdateFilter } from "mongodb";
import {
  type AdapterContext,
  type DatabaseAdapter,
  type QueryOptions,
  type Row,
  UnsupportedCapabilityError,
} from "@allinone/database";
import { buildQuery, type MongoFilterClause } from "./filters.js";

export interface MongoAdapterOptions {
  /** Connection string (default: MONGO_URL or localhost). */
  connectionString?: string;
  dbName?: string;
  client?: MongoClient;
  /**
   * Database-per-tenant strategy: resolve the Mongo database name for
   * a tenant. When provided, every query runs against that tenant's
   * database (hard isolation). `undefined` means shared-schema.
   */
  dbProvider?: (tenantId: string) => string | undefined;
}

const DB_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Conventional per-tenant database name (`app_<slug>`). */
export function tenantDbName(slug: string): string {
  return `app_${slug.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

export function assertDbName(name: string): string {
  if (!DB_NAME_RE.test(name)) {
    throw new Error(
      `[allinone/database-mongodb] Invalid database name: ${JSON.stringify(name)}. ` +
        `Use /^[A-Za-z0-9_-]{1,64}$/ names.`,
    );
  }
  return name;
}

export const mongoCapabilities = {
  // Multi-doc transactions REQUIRE a replica set. The default
  // standalone topology does not support them, so we declare false
  // and fail loudly rather than pretending.
  transactions: false,
  nestedTransactions: false,
  foreignKeys: false,
  joins: false,
  jsonQueries: false,
  fullTextSearch: true,
  schemaMigrations: false,
  optimisticLocking: true,
  rowLevelSecurity: false,
  softDeletes: true,
} as const;

type MongoDoc = Document;

function toId(row: Row): string {
  const id = row["id"];
  return typeof id === "string" && id.length > 0 ? id : `mongo_${randomUUID().slice(0, 12)}`;
}

function toRow(doc: MongoDoc): Row {
  const { _id, tenantId, _createdAt, _updatedAt, _version, deletedAt: _d, ...rest } = doc;
  return {
    ...rest,
    id: String(_id),
    ...(tenantId ? { tenantId } : {}),
    _createdAt,
    _updatedAt,
    _version,
  };
}

export class MongoAdapter implements DatabaseAdapter {
  readonly name = "mongodb";
  readonly capabilities = { ...mongoCapabilities };
  readonly #client: MongoClient;
  readonly #dbProvider: ((tenantId: string) => string | undefined) | undefined;
  #db: Db | undefined;
  #connected = false;

  constructor(options: MongoAdapterOptions = {}) {
    this.#client =
      options.client ??
      new MongoClient(
        options.connectionString ?? process.env["MONGO_URL"] ?? "mongodb://127.0.0.1:27017",
      );
    this.#dbName = options.dbName ?? "allinone";
    this.#dbProvider = options.dbProvider;
  }

  readonly #dbName: string;

  /** Resolve the Db handle for a tenant (base db when unscoped). */
  #dbFor(tenantId: string | undefined): Db {
    if (!this.#db) throw new Error("[allinone/database-mongodb] Adapter not connected");
    const name = tenantId ? this.#dbProvider?.(tenantId) : undefined;
    return name ? this.#client.db(assertDbName(name)) : this.#db;
  }

  #collection(name: string, tenantId?: string): ReturnType<Db["collection"]> {
    return this.#dbFor(tenantId).collection(name);
  }

  async connect(): Promise<void> {
    await this.#client.connect();
    this.#db = this.#client.db(this.#dbName);
    // Verify reachability.
    await this.#db.command({ ping: 1 });
    this.#connected = true;
  }

  async disconnect(): Promise<void> {
    await this.#client.close();
    this.#connected = false;
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
    const started = performance.now();
    await this.#client.db(this.#dbName).command({ ping: 1 });
    return { ok: this.#connected, latencyMs: Math.round(performance.now() - started) };
  }

  async createCollection(name: string, tenantId?: string): Promise<void> {
    const db = this.#dbFor(tenantId);
    await db.createCollection(name);
    await db.collection(name).createIndex({ tenantId: 1 }, { sparse: true, name: "tenant_idx" });
    await db.collection(name).createIndex({ deletedAt: 1 }, { sparse: true, name: "deleted_idx" });
  }

  async createTable(collection: string, tenantId?: string): Promise<void> {
    await this.createCollection(collection, tenantId);
  }

  /**
   * Provision a tenant database + collections (database-per-tenant).
   * Point `dbProvider` at this mapping; queries route by tenant afterwards.
   */
  async createTenantDatabase(tenantId: string, collections: readonly string[]): Promise<void> {
    const name = this.#dbProvider?.(tenantId);
    if (!name) {
      throw new Error(
        "[allinone/database-mongodb] No database for tenant " +
          JSON.stringify(tenantId) +
          " — configure dbProvider or use shared-schema strategy.",
      );
    }
    for (const collection of collections) {
      await this.createTable(collection, tenantId);
    }
  }

  async insert(collection: string, rows: readonly Row[], ctx?: AdapterContext): Promise<Row[]> {
    if (rows.length === 0) return [];
    const now = new Date().toISOString();
    const docs: MongoDoc[] = rows.map((row) => ({
      ...row,
      _id: toId(row),
      ...(ctx?.tenantId ? { tenantId: ctx.tenantId } : {}),
      _createdAt: now,
      _updatedAt: now,
      _version: 1,
    }));
    await this.#collection(collection, ctx?.tenantId).insertMany(docs);
    return docs.map(toRow);
  }

  async find(collection: string, options?: QueryOptions, ctx?: AdapterContext): Promise<Row[]> {
    const tenantId = options?.tenantId ?? ctx?.tenantId;
    const query = buildQuery(options?.filters ?? [], tenantId);
    let cursor = this.#collection(collection, tenantId).find(query);
    const sorts = options?.sort ?? [];
    if (sorts.length > 0) {
      const spec: Record<string, 1 | -1> = {};
      for (const s of sorts) spec[s.field] = s.direction === "asc" ? 1 : -1;
      cursor = cursor.sort(spec);
    }
    const limit = options?.limit;
    const offset = options?.offset;
    if (limit !== undefined) {
      if (!Number.isInteger(limit) || limit < 0) {
        throw new Error("[allinone/database-mongodb] limit must be a non-negative integer");
      }
      cursor = cursor.limit(limit);
    }
    if (offset !== undefined) {
      if (!Number.isInteger(offset) || offset < 0) {
        throw new Error("[allinone/database-mongodb] offset must be a non-negative integer");
      }
      cursor = cursor.skip(offset);
    }
    const docs = await cursor.toArray();
    return docs.map(toRow);
  }

  async update(
    collection: string,
    id: string,
    patch: Row,
    ctx?: AdapterContext,
  ): Promise<Row | null> {
    const filter: MongoFilterClause = { _id: id, deletedAt: { $exists: false } };
    if (ctx?.tenantId !== undefined) filter["tenantId"] = ctx.tenantId;
    const update: UpdateFilter<MongoDoc> = {
      $set: { ...patch, _updatedAt: new Date().toISOString() },
      $inc: { _version: 1 },
    };
    const result = await this.#collection(collection, ctx?.tenantId).findOneAndUpdate(
      filter,
      update,
      {
        returnDocument: "after",
      },
    );
    return result ? toRow(result) : null;
  }

  /**
   * Optimistic-locking update — returns null when the expected
   * version no longer matches (lost update detected).
   */
  async updateOptimistic(
    collection: string,
    id: string,
    patch: Row,
    expectedVersion: number,
    ctx?: AdapterContext,
  ): Promise<Row | null> {
    const filter: MongoFilterClause = {
      _id: id,
      _version: expectedVersion,
      deletedAt: { $exists: false },
    };
    if (ctx?.tenantId !== undefined) filter["tenantId"] = ctx.tenantId;
    const update: UpdateFilter<MongoDoc> = {
      $set: { ...patch, _updatedAt: new Date().toISOString() },
      $inc: { _version: 1 },
    };
    const result = await this.#collection(collection, ctx?.tenantId).findOneAndUpdate(
      filter,
      update,
      {
        returnDocument: "after",
      },
    );
    return result ? toRow(result) : null;
  }

  async remove(collection: string, id: string, ctx?: AdapterContext): Promise<boolean> {
    const filter: MongoFilterClause = { _id: id, deletedAt: { $exists: false } };
    if (ctx?.tenantId !== undefined) filter["tenantId"] = ctx.tenantId;
    const result = await this.#collection(collection, ctx?.tenantId).findOneAndUpdate(
      filter,
      { $set: { deletedAt: new Date().toISOString() } },
      { returnDocument: "after" },
    );
    return result !== null;
  }

  /**
   * Hard-delete escape hatch (GDPR erasure). `remove()` soft-deletes.
   */
  async hardRemove(collection: string, id: string, ctx?: AdapterContext): Promise<boolean> {
    const filter: MongoFilterClause = { _id: id };
    if (ctx?.tenantId !== undefined) filter["tenantId"] = ctx.tenantId;
    const result = await this.#collection(collection, ctx?.tenantId).deleteOne(filter);
    return result.deletedCount > 0;
  }

  /** Transactions require a replica set — never simulated on standalone. */
  async transaction<T>(_fn: (tx: DatabaseAdapter) => Promise<T>): Promise<T> {
    throw new UnsupportedCapabilityError("transactions", this.name);
  }

  /** Data migrations without DDL (document DB is schemaless). */
  async migrate(migrations: readonly Migration[] = []): Promise<void> {
    if (!this.#db) throw new Error("[allinone/database-mongodb] Adapter not connected");
    const store = this.#db.collection("allinone_migrations");
    const applied = new Set((await store.find({}).toArray()).map((d) => String(d["id"])));
    for (const migration of migrations) {
      if (applied.has(migration.id)) continue;
      await migration.up(this);
      await store.insertOne({ id: migration.id, appliedAt: new Date().toISOString() });
    }
  }

  /**
   * Aggregation escape hatch — for reports, full-text pipelines, etc.
   * Pipelines are code; only trusted developers may call this directly.
   */
  async aggregate(
    collection: string,
    pipeline: readonly Record<string, unknown>[],
    tenantId?: string,
  ): Promise<unknown[]> {
    if (!Array.isArray(pipeline)) {
      throw new Error("[allinone/database-mongodb] pipeline must be an array");
    }
    return this.#collection(collection, tenantId).aggregate(pipeline).toArray();
  }

  isConnected(): boolean {
    return this.#connected;
  }
}

export interface Migration {
  id: string;
  description?: string;
  up(adapter: MongoAdapter): Promise<void>;
}

export function createMongoAdapter(options: MongoAdapterOptions = {}): MongoAdapter {
  return new MongoAdapter(options);
}
