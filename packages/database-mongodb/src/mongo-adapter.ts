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
  #db: Db | undefined;
  #connected = false;

  constructor(options: MongoAdapterOptions = {}) {
    this.#client =
      options.client ??
      new MongoClient(
        options.connectionString ?? process.env["MONGO_URL"] ?? "mongodb://127.0.0.1:27017",
      );
    this.#dbName = options.dbName ?? "allinone";
  }

  readonly #dbName: string;

  #collection(name: string): ReturnType<Db["collection"]> {
    if (!this.#db) throw new Error("[allinone/database-mongodb] Adapter not connected");
    return this.#db.collection(name);
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

  async createCollection(name: string): Promise<void> {
    if (!this.#db) throw new Error("[allinone/database-mongodb] Adapter not connected");
    await this.#db.createCollection(name);
    await this.#db
      .collection(name)
      .createIndex({ tenantId: 1 }, { sparse: true, name: "tenant_idx" });
    await this.#db
      .collection(name)
      .createIndex({ deletedAt: 1 }, { sparse: true, name: "deleted_idx" });
  }

  async createTable(collection: string): Promise<void> {
    await this.createCollection(collection);
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
    await this.#collection(collection).insertMany(docs);
    return docs.map(toRow);
  }

  async find(collection: string, options?: QueryOptions, ctx?: AdapterContext): Promise<Row[]> {
    const tenantId = options?.tenantId ?? ctx?.tenantId;
    const query = buildQuery(options?.filters ?? [], tenantId);
    let cursor = this.#collection(collection).find(query);
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
    const result = await this.#collection(collection).findOneAndUpdate(filter, update, {
      returnDocument: "after",
    });
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
    const result = await this.#collection(collection).findOneAndUpdate(filter, update, {
      returnDocument: "after",
    });
    return result ? toRow(result) : null;
  }

  async remove(collection: string, id: string, ctx?: AdapterContext): Promise<boolean> {
    const filter: MongoFilterClause = { _id: id, deletedAt: { $exists: false } };
    if (ctx?.tenantId !== undefined) filter["tenantId"] = ctx.tenantId;
    const result = await this.#collection(collection).findOneAndUpdate(
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
    const result = await this.#collection(collection).deleteOne(filter);
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
  ): Promise<unknown[]> {
    if (!Array.isArray(pipeline)) {
      throw new Error("[allinone/database-mongodb] pipeline must be an array");
    }
    return this.#collection(collection).aggregate(pipeline).toArray();
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
