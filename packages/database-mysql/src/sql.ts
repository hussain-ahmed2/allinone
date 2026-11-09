/**
 * SQL building helpers — identifier validation + parameterized queries.
 *
 * Threat model: values are ALWAYS bound as parameters (`?`). Identifiers
 * (table/field names) cannot be parameterized, so they are validated
 * against a strict whitelist before embedding with backticks — a name
 * that fails validation is rejected, never quoted through and hoping
 * for the best.
 *
 * JSON paths use MySQL/MariaDB `->>` (unquoted JSON extract) with
 * `JSON_UNQUOTE(JSON_EXTRACT(...))` semantics: `data ->> '$.field'`.
 * Field validation rejects path-injection characters (no spaces, quotes,
 * or `$.` tricks beyond `.field` segments).
 */
import type { Filter, QueryOptions } from "@allinone/database";

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** Validate a table identifier. Throws on anything unsafe. */
export function assertIdentifier(name: string): string {
  if (!IDENTIFIER_RE.test(name)) {
    throw new Error(
      `[allinone/database-mysql] Invalid table identifier: ${JSON.stringify(name)}. ` +
        `Only /^[A-Za-z_][A-Za-z0-9_]{0,63}$/ identifiers are allowed.`,
    );
  }
  return name;
}

/** Validate a JSON field path (dots allowed for nested documents). */
export function assertField(field: string): string {
  if (field.startsWith("$") || !FIELD_RE.test(field)) {
    throw new Error(`[allinone/database-mysql] Invalid field: ${JSON.stringify(field)}`);
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
 * JSON-path expression for one field.
 * `JSON_UNQUOTE(JSON_EXTRACT(...))` works on MySQL 8 AND MariaDB 11 — the
 * `->>` operator is rejected by MariaDB, so it is avoided entirely.
 */
function jsonPath(field: string): string {
  const f = assertField(field);
  return "JSON_UNQUOTE(JSON_EXTRACT(`data`, '$." + f + "'))";
}

/** Assert a primitive value is safe for eq/ne/comparison operators. */
function assertPrimitive(value: unknown, operator: string): void {
  if (
    value !== null &&
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    throw new Error(
      `[allinone/database-mysql] Operator "${operator}" requires a primitive ` +
        `value (string/number/boolean/null) — got ${typeof value}.`,
    );
  }
}

/**
 * Build a filter clause (parameterized) for one filter.
 * Values are always bound; field names are validated + embedded.
 */
export function buildFilterClause(filter: Filter, bag: ParamBag): string {
  assertField(filter.field);
  const path = jsonPath(filter.field);
  switch (filter.operator) {
    case "eq":
      if (filter.value === null) return `${path} IS NULL`;
      assertPrimitive(filter.value, "eq");
      return `${path} = ${bag.push(toText(filter.value))}`;
    case "ne":
      if (filter.value === null) return `${path} IS NOT NULL`;
      assertPrimitive(filter.value, "ne");
      return `${path} <> ${bag.push(toText(filter.value))}`;
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
        return `CAST(${path} AS DECIMAL(20,6)) ${op} ${bag.push(filter.value)}`;
      }
      assertPrimitive(filter.value, filter.operator);
      return `${path} ${op} ${bag.push(toText(filter.value))}`;
    }
    case "in":
    case "nin": {
      const values = filter.value;
      if (!Array.isArray(values) || values.length === 0) {
        throw new Error(
          `[allinone/database-mysql] Filter "${filter.operator}" requires a non-empty array`,
        );
      }
      for (const v of values) assertPrimitive(v, filter.operator);
      const placeholders = values.map((v) => bag.push(toText(v))).join(", ");
      const keyword = filter.operator === "in" ? "IN" : "NOT IN";
      return `${path} ${keyword} (${placeholders})`;
    }
    case "contains": {
      if (typeof filter.value !== "string") {
        throw new Error("[allinone/database-mysql] contains requires a string value");
      }
      const pattern = `%${escapeLike(filter.value)}%`;
      return `${path} LIKE ${bag.push(pattern)} ESCAPE '\\\\'`;
    }
    case "isNull":
      return `${path} IS NULL`;
    case "isNotNull":
      return `${path} IS NOT NULL`;
    default: {
      const _exhaustive: never = filter.operator;
      throw new Error(
        `[allinone/database-mysql] Unsupported filter operator: ${String(_exhaustive)}`,
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
      return `JSON_UNQUOTE(JSON_EXTRACT(\`data\`, '$.${f}')) ${s.direction === "asc" ? "ASC" : "DESC"}`;
    });
    text += ` ORDER BY ${parts.join(", ")}`;
  }

  const limit = options?.limit;
  const offset = options?.offset;
  if (limit !== undefined) {
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error("[allinone/database-mysql] limit must be a non-negative integer");
    }
    text += ` LIMIT ${String(limit)}`;
  }
  if (offset !== undefined) {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error("[allinone/database-mysql] offset must be a non-negative integer");
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
    "`id` VARCHAR(64) NOT NULL,`tenant_id` VARCHAR(255) NULL," +
    "`data` JSON NOT NULL,`created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)," +
    "`updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)" +
    " ON UPDATE CURRENT_TIMESTAMP(6),`version` INT NOT NULL DEFAULT 1," +
    "`deleted_at` DATETIME(6) NULL,PRIMARY KEY (`id`)," +
    "KEY `idx_tenant` (`tenant_id`)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4";
  return { text, params: [] };
}

export interface InsertRow {
  id: string;
  tenantId: string | undefined;
  data: string; // JSON string
}

/** INSERT ... RETURNING equivalent: MySQL lacks RETURNING, insert + select. */
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
    `UPDATE ${table} SET \`deleted_at\` = CURRENT_TIMESTAMP(6) ` +
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
    `UPDATE ${table} SET \`data\` = ${jsonPh}, \`version\` = \`version\` + 1 ` +
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
    `UPDATE ${table} SET \`data\` = ${jsonPh}, \`version\` = \`version\` + 1 ` +
    `WHERE \`id\` = ${idPh} AND \`version\` = ${versionPh} AND \`deleted_at\` IS NULL`;
  if (tenantId !== undefined) {
    text += ` AND \`tenant_id\` = ${bag.push(tenantId)}`;
  }
  return { text, params: bag.params };
}
