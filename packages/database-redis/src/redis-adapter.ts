/**
 * Redis adapter for @allinone/database — key-value documents.
 *
 * Storage model: ` {ns}:{collection}:{id}` → JSON document:
 *   { ...data, tenantId?, _createdAt, _updatedAt, _version, deletedAt? }
 *
 * Honest capabilities: Redis has no multi-key transactions, joins, or
 * RLS — those are declared FALSE and `transaction()` throws
 * `UnsupportedCapabilityError` (never faked). Optimistic locking uses
 * an atomic Lua compare-and-set script on `_version`. Filtering runs
 * in-memory over SCAN results (fine for small collections; document
 * the SCAN cost — use Postgres/Mongo for relational workloads).
 *
 * NoSQL injection: filter values must be primitives (same rule as the
 * Mongo adapter) — objects are rejected before touching Redis.
 */
import { randomUUID } from "node:crypto";
import { createClient, type RedisClientType } from "redis";
import {
  type AdapterContext,
  type DatabaseAdapter,
  type Filter,
  type QueryOptions,
  type Row,
  UnsupportedCapabilityError,
} from "@allinone/database";

export interface RedisAdapterOptions {
  /** Redis URL (default: REDIS_URL or redis://127.0.0.1:6379). */
  url?: string;
  /** Key namespace — isolates deployments (and tests). Default "allinone". */
  namespace?: string;
  client?: RedisClientType;
}

export const redisCapabilities = {
  transactions: false,
  nestedTransactions: false,
  foreignKeys: false,
  joins: false,
  jsonQueries: true,
  fullTextSearch: false,
  schemaMigrations: false,
  optimisticLocking: true,
  rowLevelSecurity: false,
  softDeletes: true,
} as const;

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

export function assertCollection(name: string): string {
  if (!IDENTIFIER_RE.test(name)) {
    throw new Error(
      `[allinone/database-redis] Invalid collection: ${JSON.stringify(name)}. ` +
        `Use /^[A-Za-z_][A-Za-z0-9_]{0,63}$/ names.`,
    );
  }
  return name;
}

function assertField(field: string): string {
  if (field.startsWith("$") || !FIELD_RE.test(field)) {
    throw new Error(`[allinone/database-redis] Invalid field: ${JSON.stringify(field)}`);
  }
  return field;
}

function assertPrimitive(value: unknown, operator: string): void {
  if (
    value !== null &&
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    throw new Error(
      `[allinone/database-redis] Operator "${operator}" requires a primitive ` +
        `value (string/number/boolean/null) — got ${typeof value}.`,
    );
  }
}

function toId(row: Row): string {
  const id = row["id"];
  return typeof id === "string" && id.length > 0 ? id : `redis_${randomUUID().slice(0, 12)}`;
}

type Doc = Record<string, unknown> & { tenantId?: string };

function toRow(doc: Doc, id: string): Row {
  const { _createdAt, _updatedAt, _version, deletedAt: _d, ...rest } = doc;
  return {
    ...rest,
    id,
    ...(_createdAt ? { _createdAt } : {}),
    ...(_updatedAt ? { _updatedAt } : {}),
    ...(typeof _version === "number" ? { _version } : {}),
  };
}

export class RedisAdapter implements DatabaseAdapter {
  readonly name = "redis";
  readonly capabilities = { ...redisCapabilities };
  readonly #client: RedisClientType;
  readonly #ns: string;
  #connected = false;

  constructor(options: RedisAdapterOptions = {}) {
    this.#client =
      options.client ??
      createClient({
        url: options.url ?? process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379",
      });
    this.#ns = options.namespace ?? "allinone";
  }

  #key(collection: string, id: string): string {
    return `${this.#ns}:${assertCollection(collection)}:${id}`;
  }

  #prefix(collection: string): string {
    return `${this.#ns}:${assertCollection(collection)}:`;
  }

  async connect(): Promise<void> {
    if (!this.#client.isOpen) await this.#client.connect();
    await this.#client.ping();
    this.#connected = true;
  }

  async disconnect(): Promise<void> {
    await this.#client.quit();
    this.#connected = false;
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
    const started = performance.now();
    await this.#client.ping();
    return { ok: this.#connected, latencyMs: Math.round(performance.now() - started) };
  }

  /** Key-prefix DDL is implicit in Redis — no-op beyond validation. */
  async createTable(collection: string): Promise<void> {
    assertCollection(collection);
  }

  async insert(collection: string, rows: readonly Row[], ctx?: AdapterContext): Promise<Row[]> {
    if (rows.length === 0) return [];
    const now = new Date().toISOString();
    const docs = rows.map((row) => {
      const id = toId(row);
      const doc: Doc = {
        ...row,
        ...(ctx?.tenantId ? { tenantId: ctx.tenantId } : {}),
        _createdAt: now,
        _updatedAt: now,
        _version: 1,
      };
      return { id, doc };
    });
    const multi = this.#client.multi();
    for (const { id, doc } of docs) {
      multi.set(this.#key(collection, id), JSON.stringify(doc));
    }
    await multi.exec();
    return docs.map(({ id, doc }) => toRow(doc, id));
  }

  async find(collection: string, options?: QueryOptions, ctx?: AdapterContext): Promise<Row[]> {
    const tenantId = options?.tenantId ?? ctx?.tenantId;
    // SCAN all keys for the collection (documented cost; fine for KV sizes).
    const keys: string[] = [];
    let cursor = "0";
    do {
      const result = await this.#client.scan(cursor, {
        MATCH: `${this.#prefix(collection)}*`,
        COUNT: 100,
      });
      cursor = result.cursor;
      keys.push(...result.keys);
    } while (cursor !== "0");

    const docs: (string | null)[] = await Promise.all(keys.map((key) => this.#client.get(key)));
    let rows: Row[] = [];
    docs.forEach((raw, index) => {
      if (!raw) return;
      const parsed: Doc = JSON.parse(raw) as Doc;
      if (parsed["deletedAt"]) return; // soft-deleted
      const key = keys[index];
      if (!key) return;
      rows.push(toRow(parsed, key.split(":").pop() ?? ""));
    });

    if (tenantId !== undefined) {
      rows = rows.filter((r) => r["tenantId"] === tenantId);
    }
    for (const filter of options?.filters ?? []) {
      rows = rows.filter((row) => matchesFilter(row, filter));
    }
    const sorts = options?.sort ?? [];
    const toSortString = (v: unknown): string =>
      typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
    for (const s of [...sorts].reverse()) {
      rows = [...rows].sort((a, b) => {
        const av = a[s.field];
        const bv = b[s.field];
        if (av === bv) return 0;
        const cmp =
          typeof av === "number" && typeof bv === "number"
            ? av - bv
            : toSortString(av).localeCompare(toSortString(bv));
        return s.direction === "asc" ? cmp : -cmp;
      });
    }
    const offset = options?.offset ?? 0;
    const limit = options?.limit;
    rows = rows.slice(offset, limit !== undefined ? offset + limit : undefined);
    return rows;
  }

  async update(
    collection: string,
    id: string,
    patch: Row,
    ctx?: AdapterContext,
  ): Promise<Row | null> {
    // Read-modify-write: cheap and correct enough without CAS semantics.
    const key = this.#key(collection, id);
    const raw = await this.#client.get(key);
    if (!raw) return null;
    const doc: Doc = JSON.parse(raw) as Doc;
    if (doc["deletedAt"]) return null;
    if (ctx?.tenantId !== undefined && doc["tenantId"] !== ctx.tenantId) return null;
    const merged: Row = { ...doc, ...patch, _version: Number(doc["_version"] ?? 1) + 1 };
    merged["_updatedAt"] = new Date().toISOString();
    await this.#client.set(key, JSON.stringify(merged));
    return toRow(merged, id);
  }

  /**
   * Optimistic-locking update via atomic Lua compare-and-set on
   * `_version`. Returns null when the expected version drifted.
   */
  async updateOptimistic(
    collection: string,
    id: string,
    patch: Row,
    expectedVersion: number,
    ctx?: AdapterContext,
  ): Promise<Row | null> {
    const key = this.#key(collection, id);
    const raw = await this.#client.get(key);
    if (!raw) return null;
    const doc: Doc = JSON.parse(raw) as Doc;
    if (doc["deletedAt"]) return null;
    if (ctx?.tenantId !== undefined && doc["tenantId"] !== ctx.tenantId) return null;
    const merged: Row = { ...doc, ...patch, _version: expectedVersion + 1 };
    merged["_updatedAt"] = new Date().toISOString();
    const script = `
local cur = redis.call('GET', KEYS[1])
if not cur then return 0 end
local decoded = cjson.decode(cur)
if decoded._version ~= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], ARGV[2])
return 1
`;
    const result = (await this.#client.eval(script, {
      keys: [key],
      arguments: [String(expectedVersion), JSON.stringify(merged)],
    })) as unknown as number;
    return result === 1 ? toRow(merged, id) : null;
  }

  async remove(collection: string, id: string, ctx?: AdapterContext): Promise<boolean> {
    const key = this.#key(collection, id);
    const raw = await this.#client.get(key);
    if (!raw) return false;
    const doc: Doc = JSON.parse(raw) as Doc;
    if (doc["deletedAt"]) return false;
    if (ctx?.tenantId !== undefined && doc["tenantId"] !== ctx.tenantId) return false;
    doc["deletedAt"] = new Date().toISOString();
    await this.#client.set(key, JSON.stringify(doc));
    return true;
  }

  /**
   * Hard-delete escape hatch (GDPR erasure). `remove()` soft-deletes.
   */
  async hardRemove(collection: string, id: string, ctx?: AdapterContext): Promise<boolean> {
    const key = this.#key(collection, id);
    const raw = await this.#client.get(key);
    if (!raw) return false;
    if (ctx?.tenantId !== undefined) {
      const doc: Doc = JSON.parse(raw) as Doc;
      if (doc["tenantId"] !== ctx.tenantId) return false;
    }
    return (await this.#client.del(key)) > 0;
  }

  /** Transactions are not modeled on Redis — never simulated. */
  async transaction<T>(_fn: (tx: DatabaseAdapter) => Promise<T>): Promise<T> {
    throw new UnsupportedCapabilityError("transactions", this.name);
  }

  /** Schemaless KV store has no DDL to migrate. */
  async migrate(): Promise<void> {
    throw new UnsupportedCapabilityError("schemaMigrations", this.name);
  }

  /**
   * @allinone/infra `CacheProvider` over a `cache:` namespace
   * (tenant-safe: callers namespace keys via `tenantCacheKey`).
   */
  asCacheProvider(): {
    readonly name: string;
    get(key: string): Promise<string | null>;
    set(key: string, value: string, ttlSeconds: number): Promise<void>;
    delete(key: string): Promise<void>;
  } {
    const client = this.#client;
    const prefix = `${this.#ns}:cache:`;
    return {
      name: "redis",
      async get(key: string): Promise<string | null> {
        return client.get(prefix + key);
      },
      async set(key: string, value: string, ttlSeconds: number): Promise<void> {
        await client.set(prefix + key, value, { EX: ttlSeconds });
      },
      async delete(key: string): Promise<void> {
        await client.del(prefix + key);
      },
    };
  }

  isConnected(): boolean {
    return this.#connected;
  }
}

export interface CacheConfig {
  namespace?: string;
}

/** Standalone cache provider (no DatabaseAdapter required). */
export function createRedisCache(
  url?: string,
  options: CacheConfig = {},
): {
  readonly name: string;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
} {
  const client = createClient({ url: url ?? process.env["REDIS_URL"] ?? "redis://127.0.0.1:6379" });
  const prefix = `${options.namespace ?? "allinone"}:cache:`;
  return {
    name: "redis",
    async get(key: string): Promise<string | null> {
      return client.get(prefix + key);
    },
    async set(key: string, value: string, ttlSeconds: number): Promise<void> {
      await client.set(prefix + key, value, { EX: ttlSeconds });
    },
    async delete(key: string): Promise<void> {
      await client.del(prefix + key);
    },
    async connect(): Promise<void> {
      if (!client.isOpen) await client.connect();
    },
    async disconnect(): Promise<void> {
      await client.quit();
    },
  };
}

export function createRedisAdapter(options: RedisAdapterOptions = {}): RedisAdapter {
  return new RedisAdapter(options);
}

/** In-memory filter matcher (values validated as primitives first). */
function matchesFilter(row: Row, filter: Filter): boolean {
  const field = assertField(filter.field);
  const value = row[field];
  switch (filter.operator) {
    case "eq":
      assertPrimitive(filter.value, "eq");
      return value === filter.value;
    case "ne":
      assertPrimitive(filter.value, "ne");
      return value !== filter.value;
    case "gt":
      assertPrimitive(filter.value, "gt");
      return (value as number) > (filter.value as number);
    case "gte":
      assertPrimitive(filter.value, "gte");
      return (value as number) >= (filter.value as number);
    case "lt":
      assertPrimitive(filter.value, "lt");
      return (value as number) < (filter.value as number);
    case "lte":
      assertPrimitive(filter.value, "lte");
      return (value as number) <= (filter.value as number);
    case "in":
      assertPrimitiveArray(filter.value, "in");
      return (filter.value as unknown[]).includes(value);
    case "nin":
      assertPrimitiveArray(filter.value, "nin");
      return !(filter.value as unknown[]).includes(value);
    case "contains": {
      if (typeof filter.value !== "string") {
        throw new Error("[allinone/database-redis] contains requires a string value");
      }
      return typeof value === "string" && value.includes(filter.value);
    }
    case "isNull":
      return value === null || value === undefined;
    case "isNotNull":
      return value !== null && value !== undefined;
    default: {
      const _exhaustive: never = filter.operator;
      throw new Error(`[allinone/database-redis] Unsupported operator: ${String(_exhaustive)}`);
    }
  }
}

function assertPrimitiveArray(value: unknown, operator: string): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`[allinone/database-redis] Operator "${operator}" requires a non-empty array`);
  }
  for (const item of value) assertPrimitive(item, operator);
}
