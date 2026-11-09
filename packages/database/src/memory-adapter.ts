/**
 * In-memory adapter — used for tests, examples, and local development.
 * Declares honest capabilities (no transactions/joins across "tables"),
 * so code paths that need real transactional support fail loudly
 * instead of silently passing on a fake that cannot provide them.
 */
import {
  assertCapability,
  type AdapterContext,
  type DatabaseAdapter,
  type QueryOptions,
  type Row,
} from "./database.js";

export const memoryCapabilities = {
  transactions: false,
  nestedTransactions: false,
  foreignKeys: false,
  joins: false,
  jsonQueries: true,
  fullTextSearch: false,
  schemaMigrations: false,
  optimisticLocking: false,
  rowLevelSecurity: false,
  softDeletes: false,
} as const;

/**
 * Create an in-memory adapter.
 * Thread-safe within a single Node process; not shared across processes.
 */
export function createMemoryAdapter(): DatabaseAdapter {
  const store = new Map<string, Map<string, Row>>();
  let connected = false;
  let seq = 0;

  function table(name: string): Map<string, Row> {
    let t = store.get(name);
    if (!t) {
      t = new Map();
      store.set(name, t);
    }
    return t;
  }

  function nextId(): string {
    seq += 1;
    return `mem_${seq.toString(36)}_${Date.now().toString(36)}`;
  }

  function matches(row: Row, options?: QueryOptions): boolean {
    const filters = options?.filters ?? [];
    // Tenant isolation — defense in depth: never leak cross-tenant rows.
    if (options?.tenantId !== undefined && row["tenantId"] !== options.tenantId) {
      return false;
    }
    for (const f of filters) {
      const v = row[f.field];
      switch (f.operator) {
        case "eq":
          if (v !== f.value) return false;
          break;
        case "ne":
          if (v === f.value) return false;
          break;
        case "gt":
          if (!(typeof v === "number" && typeof f.value === "number" && v > f.value)) return false;
          break;
        case "gte":
          if (!(typeof v === "number" && typeof f.value === "number" && v >= f.value)) return false;
          break;
        case "lt":
          if (!(typeof v === "number" && typeof f.value === "number" && v < f.value)) return false;
          break;
        case "lte":
          if (!(typeof v === "number" && typeof f.value === "number" && v <= f.value)) return false;
          break;
        case "in":
          if (!Array.isArray(f.value) || !f.value.includes(v)) return false;
          break;
        case "nin":
          if (Array.isArray(f.value) && f.value.includes(v)) return false;
          break;
        case "contains":
          if (typeof v !== "string" || typeof f.value !== "string" || !v.includes(f.value))
            return false;
          break;
        case "isNull":
          if (v !== null && v !== undefined) return false;
          break;
        case "isNotNull":
          if (v === null || v === undefined) return false;
          break;
      }
    }
    return true;
  }

  const adapter: DatabaseAdapter = {
    name: "memory",
    capabilities: { ...memoryCapabilities },
    async connect(): Promise<void> {
      connected = true;
    },
    async disconnect(): Promise<void> {
      connected = false;
    },
    async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
      const started = performance.now();
      return { ok: connected, latencyMs: Math.round(performance.now() - started) };
    },
    async createTable(collection: string): Promise<void> {
      table(collection);
    },
    async insert(collection: string, rows: readonly Row[], ctx?: AdapterContext): Promise<Row[]> {
      if (!connected) throw new Error("[allinone/database] Adapter not connected");
      const t = table(collection);
      const out: Row[] = rows.map((r) => {
        const id = typeof r["id"] === "string" ? r["id"] : nextId();
        const row: Row = {
          ...r,
          id,
          _createdAt: new Date().toISOString(),
          ...(ctx?.tenantId ? { tenantId: ctx.tenantId } : {}),
        };
        t.set(id, row);
        return row;
      });
      return out;
    },
    async find(collection: string, options?: QueryOptions, _ctx?: AdapterContext): Promise<Row[]> {
      if (!connected) throw new Error("[allinone/database] Adapter not connected");
      let rows = [...table(collection).values()].filter((r) => matches(r, options));
      const sort = options?.sort ?? [];
      for (const s of [...sort].reverse()) {
        rows = rows.sort((a, b) => {
          const av = a[s.field];
          const bv = b[s.field];
          if (av === bv) return 0;
          // JSON rows only — sort by numbers numerically, otherwise by string form.
          const toSortString = (v: unknown): string =>
            typeof v === "string" ? v : v === null || v === undefined ? "" : JSON.stringify(v);
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
    },
    async update(
      collection: string,
      id: string,
      patch: Row,
      ctx?: AdapterContext,
    ): Promise<Row | null> {
      if (!connected) throw new Error("[allinone/database] Adapter not connected");
      const t = table(collection);
      const existing = t.get(id);
      if (!existing) return null;
      if (
        ctx?.tenantId !== undefined &&
        existing["tenantId"] !== undefined &&
        existing["tenantId"] !== ctx.tenantId
      ) {
        return null;
      }
      const updated: Row = { ...existing, ...patch, id, _updatedAt: new Date().toISOString() };
      t.set(id, updated);
      return updated;
    },
    async remove(collection: string, id: string, ctx?: AdapterContext): Promise<boolean> {
      if (!connected) throw new Error("[allinone/database] Adapter not connected");
      const t = table(collection);
      const existing = t.get(id);
      if (!existing) return false;
      if (
        ctx?.tenantId !== undefined &&
        existing["tenantId"] !== undefined &&
        existing["tenantId"] !== ctx.tenantId
      ) {
        return false;
      }
      return t.delete(id);
    },
    async transaction<T>(_fn: (tx: DatabaseAdapter) => Promise<T>): Promise<T> {
      assertCapability(adapter, "transactions");
      throw new Error("unreachable");
    },
  };
  return adapter;
}
