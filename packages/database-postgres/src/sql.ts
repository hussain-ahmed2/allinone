/**
 * SQL building helpers — identifier validation + parameterized queries.
 *
 * Threat model: values are ALWAYS bound as parameters ($1, $2, ...).
 * Identifiers (table/field names) cannot be parameterized in Postgres,
 * so they are validated against a strict whitelist before embedding.
 * A table/field name that fails validation is rejected — never quoted
 * through and hoping for the best.
 */
import type { Filter, QueryOptions } from "@allinone/database";

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Validate a table or field identifier. Throws on anything unsafe. */
export function assertIdentifier(name: string, kind: "table" | "field"): string {
  if (!IDENTIFIER_RE.test(name)) {
    throw new Error(
      `[allinone/database-postgres] Invalid ${kind} identifier: ${JSON.stringify(name)}. ` +
        `Only /^[A-Za-z_][A-Za-z0-9_]{0,63}$/ identifiers are allowed.`,
    );
  }
  return name;
}

/** Quote a pre-validated identifier. */
export function quoteIdentifier(name: string): string {
  return `"${name}"`;
}

/**
 * Fully-qualified table reference for schema-per-tenant isolation.
 * Both identifiers are validated — an unsafe schema is rejected.
 */
export function tableRef(collection: string, schema?: string): string {
  const table = quoteIdentifier(assertIdentifier(collection, "table"));
  if (schema === undefined) return table;
  return `${quoteIdentifier(assertIdentifier(schema, "table"))}.${table}`;
}

/** Escape LIKE/ILIKE wildcards in user data (pattern injection defense). */
function escapeLike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

export interface BuiltQuery {
  text: string;
  params: unknown[];
}

/** Parameter bag used while building parameterized queries. */
export interface ParamBag {
  params: unknown[];
  push(value: unknown): string;
}

function createParamBag(): ParamBag {
  const params: unknown[] = [];
  return {
    params,
    push(value: unknown): string {
      params.push(value);
      return "$" + String(params.length);
    },
  };
}

function toText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return JSON.stringify(value);
}

/**
 * Build a filter expression (parameterized) for one filter.
 * Field names are validated + embedded; values are always bound.
 */
export function buildFilterClause(filter: Filter, bag: ParamBag): string {
  const field = assertIdentifier(filter.field, "field");
  const jsonText = `("data" ->> '${field}')`;
  switch (filter.operator) {
    case "eq":
      return `${jsonText} = ${bag.push(toText(filter.value))}`;
    case "ne":
      return `${jsonText} <> ${bag.push(toText(filter.value))}`;
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      const op =
        filter.operator === "gt"
          ? ">"
          : filter.operator === "gte"
            ? ">="
            : filter.operator === "lt"
              ? "<"
              : "<=";
      if (typeof filter.value === "number") {
        return `(${jsonText})::numeric ${op} ${bag.push(filter.value)}`;
      }
      return `${jsonText} ${op} ${bag.push(toText(filter.value))}`;
    }
    case "in":
    case "nin": {
      const values = filter.value;
      if (!Array.isArray(values) || values.length === 0) {
        throw new Error(
          `[allinone/database-postgres] Filter "${filter.operator}" requires a non-empty array`,
        );
      }
      const placeholders = values.map((v) => bag.push(toText(v))).join(", ");
      const keyword = filter.operator === "in" ? "IN" : "NOT IN";
      return `${jsonText} ${keyword} (${placeholders})`;
    }
    case "contains": {
      // No ESCAPE clause — backslash is the default escape in Postgres.
      const pattern = `%${escapeLike(toText(filter.value))}%`;
      return `${jsonText} ILIKE ${bag.push(pattern)}`;
    }
    case "isNull":
      return `${jsonText} IS NULL`;
    case "isNotNull":
      return `${jsonText} IS NOT NULL`;
    default: {
      const _exhaustive: never = filter.operator;
      throw new Error(
        `[allinone/database-postgres] Unsupported filter operator: ${String(_exhaustive)}`,
      );
    }
  }
}

/**
 * Build a SELECT for one collection.
 * Always excludes soft-deleted rows and scopes to tenantId when provided.
 */
export function buildSelectQuery(
  collection: string,
  options: QueryOptions | undefined,
  tenantId: string | undefined,
  schema?: string,
): BuiltQuery {
  const table = tableRef(collection, schema);
  const bag = createParamBag();
  const clauses: string[] = ['"deleted_at" IS NULL'];

  if (tenantId !== undefined) {
    clauses.push(`"tenant_id" = ${bag.push(tenantId)}`);
  }
  for (const filter of options?.filters ?? []) {
    clauses.push(buildFilterClause(filter, bag));
  }

  let text =
    `SELECT "id", "tenant_id", "data", "created_at", "updated_at", "version" ` +
    `FROM ${table} WHERE ${clauses.join(" AND ")}`;

  const sorts = options?.sort ?? [];
  if (sorts.length > 0) {
    const parts = sorts.map((s) => {
      const f = assertIdentifier(s.field, "field");
      return `("data" ->> '${f}') ${s.direction === "asc" ? "ASC" : "DESC"}`;
    });
    text += ` ORDER BY ${parts.join(", ")}`;
  }

  const limit = options?.limit;
  const offset = options?.offset;
  if (limit !== undefined) {
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error("[allinone/database-postgres] limit must be a non-negative integer");
    }
    text += ` LIMIT ${bag.push(limit)}`;
  }
  if (offset !== undefined) {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error("[allinone/database-postgres] offset must be a non-negative integer");
    }
    text += ` OFFSET ${bag.push(offset)}`;
  }

  return { text, params: bag.params };
}

/** CREATE TABLE statement for one collection (JSONB document + metadata). */
export function buildCreateTableQuery(collection: string, schema?: string): BuiltQuery {
  const table = tableRef(collection, schema);
  const text =
    `CREATE TABLE IF NOT EXISTS ${table} (` +
    `"id" TEXT PRIMARY KEY, ` +
    `"tenant_id" TEXT, ` +
    `"data" JSONB NOT NULL DEFAULT '{}'::jsonb, ` +
    `"created_at" TIMESTAMPTZ NOT NULL DEFAULT now(), ` +
    `"updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(), ` +
    `"version" INTEGER NOT NULL DEFAULT 1, ` +
    `"deleted_at" TIMESTAMPTZ)`;
  return { text, params: [] };
}

export interface InsertRow {
  id: string;
  tenantId: string | undefined;
  data: string; // JSON string
}

/** INSERT ... RETURNING for a batch. */
export function buildInsertQuery(
  collection: string,
  rows: readonly InsertRow[],
  schema?: string,
): BuiltQuery {
  const table = tableRef(collection, schema);
  const bag = createParamBag();
  const tuples = rows.map(
    (r) => `(${bag.push(r.id)}, ${bag.push(r.tenantId ?? null)}, ${bag.push(r.data)}::jsonb)`,
  );
  const text =
    `INSERT INTO ${table} ("id", "tenant_id", "data") VALUES ${tuples.join(", ")} ` +
    `RETURNING "id", "tenant_id", "data", "created_at", "updated_at", "version"`;
  return { text, params: bag.params };
}

/** Soft-delete UPDATE ... RETURNING. */
export function buildSoftDeleteQuery(
  collection: string,
  id: string,
  tenantId: string | undefined,
  schema?: string,
): BuiltQuery {
  const table = tableRef(collection, schema);
  const bag = createParamBag();
  const idPh = bag.push(id);
  let text =
    `UPDATE ${table} SET "deleted_at" = now(), "updated_at" = now() ` +
    `WHERE "id" = ${idPh} AND "deleted_at" IS NULL`;
  if (tenantId !== undefined) {
    text += ` AND "tenant_id" = ${bag.push(tenantId)}`;
  }
  text += ` RETURNING "id", "tenant_id", "data", "created_at", "updated_at", "version"`;
  return { text, params: bag.params };
}

/**
 * UPDATE ... RETURNING with full-document JSON (merged in JS).
 * Full assignment (not JSONB `||`) keeps behavior identical on
 * Postgres and pg-mem, where `||` merge is unreliable.
 */
export function buildUpdateQuery(
  collection: string,
  id: string,
  fullJson: string,
  tenantId: string | undefined,
  schema?: string,
): BuiltQuery {
  const table = tableRef(collection, schema);
  const bag = createParamBag();
  const jsonPh = bag.push(fullJson);
  const idPh = bag.push(id);
  let text =
    `UPDATE ${table} SET "data" = ${jsonPh}::jsonb, ` +
    `"updated_at" = now(), "version" = "version" + 1 ` +
    `WHERE "id" = ${idPh} AND "deleted_at" IS NULL`;
  if (tenantId !== undefined) {
    text += ` AND "tenant_id" = ${bag.push(tenantId)}`;
  }
  text += ` RETURNING "id", "tenant_id", "data", "created_at", "updated_at", "version"`;
  return { text, params: bag.params };
}

/** Optimistic-locking UPDATE — fails (returns null) when version drifted. */
export function buildOptimisticUpdateQuery(
  collection: string,
  id: string,
  fullJson: string,
  expectedVersion: number,
  tenantId: string | undefined,
  schema?: string,
): BuiltQuery {
  const table = tableRef(collection, schema);
  const bag = createParamBag();
  const jsonPh = bag.push(fullJson);
  const idPh = bag.push(id);
  const versionPh = bag.push(expectedVersion);
  let text =
    `UPDATE ${table} SET "data" = ${jsonPh}::jsonb, ` +
    `"updated_at" = now(), "version" = "version" + 1 ` +
    `WHERE "id" = ${idPh} AND "version" = ${versionPh} AND "deleted_at" IS NULL`;
  if (tenantId !== undefined) {
    text += ` AND "tenant_id" = ${bag.push(tenantId)}`;
  }
  text += ` RETURNING "id", "tenant_id", "data", "created_at", "updated_at", "version"`;
  return { text, params: bag.params };
}
