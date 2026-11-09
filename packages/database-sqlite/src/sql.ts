/**
 * SQL building helpers — identifier validation + parameterized queries.
 *
 * SQLite constraints handled here:
 *  - Placeholders are `?` everywhere; values never interpolated.
 *  - Identifiers (tables/fields) whitelisted (`^[A-Za-z_][A-Za-z0-9_]{0,63}$`)
 *    and backtick-quoted.
 *  - JSON document access via `json_extract(data, '$.field')` — the path
 *    is built from validated field names only, then BOUND as a parameter
 *    (never interpolated) so attacker field names can't inject JSONPath.
 *  - LIMIT/OFFSET are validated non-negative integers embedded as literals
 *    (SQLite accepts bindings there, but literals of pre-validated ints
 *    are equally safe and avoid version quirks).
 */
import type { Filter, QueryOptions } from "@allinone/database";

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** Validate a table identifier. Throws on anything unsafe. */
export function assertIdentifier(name: string): string {
  if (!IDENTIFIER_RE.test(name)) {
    throw new Error(
      `[allinone/database-sqlite] Invalid table identifier: ${JSON.stringify(name)}. ` +
        `Only /^[A-Za-z_][A-Za-z0-9_]{0,63}$/ identifiers are allowed.`,
    );
  }
  return name;
}

/** Validate a JSON field path (dots allowed for nested documents). */
export function assertField(field: string): string {
  if (field.startsWith("$") || !FIELD_RE.test(field)) {
    throw new Error(`[allinone/database-sqlite] Invalid field: ${JSON.stringify(field)}`);
  }
  return field;
}

/** Backtick-quote a pre-validated identifier. */
export function quoteIdentifier(name: string): string {
  return "`" + name + "`";
}

/** Escape LIKE wildcards in user data (pattern injection defense). */
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
      return "?";
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
 * Build a filter clause (parameterized) for one filter.
 * The JSON path itself is passed as a bound parameter, so even a hostile
 * field name can never break out of the json_extract() call.
 */
export function buildFilterClause(filter: Filter, bag: ParamBag): string {
  const path = "$." + assertField(filter.field);
  const extract = `json_extract(\`data\`, ${bag.push(path)})`;
  switch (filter.operator) {
    case "eq":
      if (filter.value === null) return `${extract} IS NULL`;
      assertPrimitive(filter.value, "eq");
      return `${extract} = ${bag.push(toText(filter.value))}`;
    case "ne":
      if (filter.value === null) return `${extract} IS NOT NULL`;
      assertPrimitive(filter.value, "ne");
      return `${extract} <> ${bag.push(toText(filter.value))}`;
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
        return `CAST(${extract} AS REAL) ${op} ${bag.push(filter.value)}`;
      }
      assertPrimitive(filter.value, filter.operator);
      return `${extract} ${op} ${bag.push(toText(filter.value))}`;
    }
    case "in":
    case "nin": {
      const values = filter.value;
      if (!Array.isArray(values) || values.length === 0) {
        throw new Error(
          `[allinone/database-sqlite] Filter "${filter.operator}" requires a non-empty array`,
        );
      }
      for (const v of values) assertPrimitive(v, filter.operator);
      const placeholders = values.map((v) => bag.push(toText(v))).join(", ");
      const keyword = filter.operator === "in" ? "IN" : "NOT IN";
      return `${extract} ${keyword} (${placeholders})`;
    }
    case "contains": {
      if (typeof filter.value !== "string") {
        throw new Error("[allinone/database-sqlite] contains requires a string value");
      }
      const pattern = `%${escapeLike(filter.value)}%`;
      return `${extract} LIKE ${bag.push(pattern)} ESCAPE '\\'`;
    }
    case "isNull":
      return `${extract} IS NULL`;
    case "isNotNull":
      return `${extract} IS NOT NULL`;
    default: {
      const _exhaustive: never = filter.operator;
      throw new Error(
        `[allinone/database-sqlite] Unsupported filter operator: ${String(_exhaustive)}`,
      );
    }
  }
}

function assertPrimitive(value: unknown, operator: string): void {
  if (
    value !== null &&
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    throw new Error(
      `[allinone/database-sqlite] Operator "${operator}" requires a primitive ` +
        `value (string/number/boolean/null) — got ${typeof value}.`,
    );
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
): BuiltQuery {
  const table = quoteIdentifier(assertIdentifier(collection));
  const bag = createParamBag();
  const clauses: string[] = ["`deleted_at` IS NULL"];

  if (tenantId !== undefined) {
    clauses.push(`\`tenant_id\` = ${bag.push(tenantId)}`);
  }
  for (const filter of options?.filters ?? []) {
    clauses.push(buildFilterClause(filter, bag));
  }

  let text =
    `SELECT \`id\`, \`tenant_id\`, \`data\`, \`created_at\`, \`updated_at\`, \`version\` ` +
    `FROM ${table} WHERE ${clauses.join(" AND ")}`;

  const sorts = options?.sort ?? [];
  if (sorts.length > 0) {
    const parts = sorts.map((s) => {
      const f = assertField(s.field);
      return `json_extract(\`data\`, '$.${f}') ${s.direction === "asc" ? "ASC" : "DESC"}`;
    });
    text += ` ORDER BY ${parts.join(", ")}`;
  }

  const limit = options?.limit;
  const offset = options?.offset;
  if (limit !== undefined) {
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error("[allinone/database-sqlite] limit must be a non-negative integer");
    }
    text += ` LIMIT ${String(limit)}`;
  }
  if (offset !== undefined) {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error("[allinone/database-sqlite] offset must be a non-negative integer");
    }
    text += ` OFFSET ${String(offset)}`;
  }

  return { text, params: bag.params };
}

/** CREATE TABLE statement for one collection (JSON document + metadata). */
export function buildCreateTableQuery(collection: string): BuiltQuery {
  const table = quoteIdentifier(assertIdentifier(collection));
  const text =
    `CREATE TABLE IF NOT EXISTS ${table} (` +
    "`id` TEXT NOT NULL,`tenant_id` TEXT NULL," +
    "`data` TEXT NOT NULL,`created_at` TEXT NOT NULL DEFAULT (datetime('now'))," +
    "`updated_at` TEXT NOT NULL DEFAULT (datetime('now'))," +
    "`version` INTEGER NOT NULL DEFAULT 1," +
    "`deleted_at` TEXT NULL,PRIMARY KEY (`id`))";
  return { text, params: [] };
}

export interface InsertRow {
  id: string;
  tenantId: string | undefined;
  data: string; // JSON string
}

/** INSERT rows (SQLite: no RETURNING — the adapter SELECTs after). */
export function buildInsertQuery(collection: string, rows: readonly InsertRow[]): BuiltQuery {
  const table = quoteIdentifier(assertIdentifier(collection));
  const bag = createParamBag();
  const tuples = rows.map(
    (r) => `(${bag.push(r.id)}, ${bag.push(r.tenantId ?? null)}, ${bag.push(r.data)})`,
  );
  const text = `INSERT INTO ${table} (\`id\`, \`tenant_id\`, \`data\`) VALUES ${tuples.join(", ")}`;
  return { text, params: bag.params };
}

/** Soft-delete UPDATE. */
export function buildSoftDeleteQuery(
  collection: string,
  id: string,
  tenantId: string | undefined,
): BuiltQuery {
  const table = quoteIdentifier(assertIdentifier(collection));
  const bag = createParamBag();
  const idPh = bag.push(id);
  let text =
    `UPDATE ${table} SET \`deleted_at\` = datetime('now') ` +
    `WHERE \`id\` = ${idPh} AND \`deleted_at\` IS NULL`;
  if (tenantId !== undefined) {
    text += ` AND \`tenant_id\` = ${bag.push(tenantId)}`;
  }
  return { text, params: bag.params };
}

/** UPDATE with full-document JSON (merged in JS). */
export function buildUpdateQuery(
  collection: string,
  id: string,
  fullJson: string,
  tenantId: string | undefined,
): BuiltQuery {
  const table = quoteIdentifier(assertIdentifier(collection));
  const bag = createParamBag();
  const jsonPh = bag.push(fullJson);
  const idPh = bag.push(id);
  let text =
    `UPDATE ${table} SET \`data\` = ${jsonPh}, ` +
    `\`updated_at\` = datetime('now'), \`version\` = \`version\` + 1 ` +
    `WHERE \`id\` = ${idPh} AND \`deleted_at\` IS NULL`;
  if (tenantId !== undefined) {
    text += ` AND \`tenant_id\` = ${bag.push(tenantId)}`;
  }
  return { text, params: bag.params };
}

/** Optimistic-locking UPDATE — fails (returns null) when version drifted. */
export function buildOptimisticUpdateQuery(
  collection: string,
  id: string,
  fullJson: string,
  expectedVersion: number,
  tenantId: string | undefined,
): BuiltQuery {
  const table = quoteIdentifier(assertIdentifier(collection));
  const bag = createParamBag();
  const jsonPh = bag.push(fullJson);
  const idPh = bag.push(id);
  const versionPh = bag.push(expectedVersion);
  let text =
    `UPDATE ${table} SET \`data\` = ${jsonPh}, ` +
    `\`updated_at\` = datetime('now'), \`version\` = \`version\` + 1 ` +
    `WHERE \`id\` = ${idPh} AND \`version\` = ${versionPh} AND \`deleted_at\` IS NULL`;
  if (tenantId !== undefined) {
    text += ` AND \`tenant_id\` = ${bag.push(tenantId)}`;
  }
  return { text, params: bag.params };
}
