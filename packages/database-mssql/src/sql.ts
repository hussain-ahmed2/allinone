/**
 * SQL building helpers — identifier validation + parameterized queries.
 *
 * T-SQL notes (documented for maintainers):
 *  - Values are ALWAYS bound as parameters (@p0, @p1, ...) — the driver
 *    infers types (NVARCHAR for strings, INT for numbers). JSON paths
 *    are bound as @parameters too, never interpolated.
 *  - Identifiers cannot be bound; they are whitelist-validated and
 *    bracket-quoted. A name that fails validation is rejected.
 *  - `JSON_VALUE(data, @path)` is T-SQL's JSON path extract; it returns
 *    SQL NULL for missing keys (keeps isNull semantics).
 */
import type { Filter, QueryOptions } from "@allinone/database";

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** Validate a table identifier. Throws on anything unsafe. */
export function assertIdentifier(name: string): string {
  if (!IDENTIFIER_RE.test(name)) {
    throw new Error(
      `[allinone/database-mssql] Invalid table identifier: ${JSON.stringify(name)}. ` +
        `Only /^[A-Za-z_][A-Za-z0-9_]{0,63}$/ identifiers are allowed.`,
    );
  }
  return name;
}

/** Validate a JSON field path (dots allowed for nested documents). */
export function assertField(field: string): string {
  if (field.startsWith("$") || !FIELD_RE.test(field)) {
    throw new Error(`[allinone/database-mssql] Invalid field: ${JSON.stringify(field)}`);
  }
  return field;
}

/** Bracket-quote a pre-validated identifier. */
export function quoteIdentifier(name: string): string {
  return "[" + name + "]";
}

export interface BuiltQuery {
  text: string;
  params: Record<string, unknown>;
}

function toText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return JSON.stringify(value);
}

function assertPrimitive(value: unknown, operator: string): void {
  if (
    value !== null &&
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    throw new Error(
      `[allinone/database-mssql] Operator "${operator}" requires a primitive ` +
        `value (string/number/boolean/null) — got ${typeof value}.`,
    );
  }
}

class ParamBag {
  readonly params: Record<string, unknown> = {};
  #seq = 0;

  push(value: unknown): string {
    const name = "p" + String(this.#seq++);
    this.params[name] = value;
    return `@${name}`;
  }
}

/** JSON-path expression bound as a parameter (never interpolated). */
function jsonPath(field: string, bag: ParamBag): string {
  return `JSON_VALUE([data], ${bag.push("$." + assertField(field))})`;
}

/** Build a filter clause (parameterized) for one filter. */
export function buildFilterClause(filter: Filter, bag: ParamBag): string {
  const path = jsonPath(filter.field, bag);
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
        return `CAST(${path} AS DECIMAL(18,6)) ${op} ${bag.push(filter.value)}`;
      }
      assertPrimitive(filter.value, filter.operator);
      return `${path} ${op} ${bag.push(toText(filter.value))}`;
    }
    case "in":
    case "nin": {
      const values = filter.value;
      if (!Array.isArray(values) || values.length === 0) {
        throw new Error(
          `[allinone/database-mssql] Filter "${filter.operator}" requires a non-empty array`,
        );
      }
      for (const v of values) assertPrimitive(v, filter.operator);
      const placeholders = values.map((v) => bag.push(toText(v))).join(", ");
      const keyword = filter.operator === "in" ? "IN" : "NOT IN";
      return `${path} ${keyword} (${placeholders})`;
    }
    case "contains": {
      if (typeof filter.value !== "string") {
        throw new Error("[allinone/database-mssql] contains requires a string value");
      }
      const escaped = filter.value
        .replace(/\\/g, "\\\\")
        .replace(/%/g, "\\%")
        .replace(/_/g, "\\_")
        .replace(/\[/g, "[[]");
      return `${path} LIKE ${bag.push("%" + escaped + "%")} ESCAPE '\\'`;
    }
    case "isNull":
      return `${path} IS NULL`;
    case "isNotNull":
      return `${path} IS NOT NULL`;
    default: {
      const _exhaustive: never = filter.operator;
      throw new Error(
        `[allinone/database-mssql] Unsupported filter operator: ${String(_exhaustive)}`,
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
  const bag = new ParamBag();
  const clauses: string[] = ["[deleted_at] IS NULL"];

  if (tenantId !== undefined) {
    clauses.push(`[tenant_id] = ${bag.push(tenantId)}`);
  }
  for (const filter of options?.filters ?? []) {
    clauses.push(buildFilterClause(filter, bag));
  }

  let text =
    `SELECT [id], [tenant_id], [data], [created_at], [updated_at], [version] ` +
    `FROM ${table} WHERE ${clauses.join(" AND ")}`;

  const sorts = options?.sort ?? [];
  if (sorts.length > 0) {
    const parts = sorts.map((s) => {
      const path = jsonPath(s.field, bag);
      return `${path} ${s.direction === "asc" ? "ASC" : "DESC"}`;
    });
    text += ` ORDER BY ${parts.join(", ")}`;
  }

  const limit = options?.limit;
  const offset = options?.offset;
  if (limit !== undefined) {
    if (!Number.isInteger(limit) || limit < 0) {
      throw new Error("[allinone/database-mssql] limit must be a non-negative integer");
    }
    text += ` OFFSET ${String(offset ?? 0)} ROWS FETCH NEXT ${String(limit)} ROWS ONLY`;
  } else if (offset !== undefined) {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error("[allinone/database-mssql] offset must be a non-negative integer");
    }
    text += ` OFFSET ${String(offset)} ROWS`;
  }

  return { text, params: bag.params };
}

/** CREATE TABLE statement for one collection (JSON document + metadata). */
export function buildCreateTableQuery(collection: string): BuiltQuery {
  const table = quoteIdentifier(assertIdentifier(collection));
  const text =
    `IF OBJECT_ID(N'${table}', N'U') IS NULL ` +
    `BEGIN CREATE TABLE ${table} (` +
    "[id] NVARCHAR(64) NOT NULL PRIMARY KEY," +
    "[tenant_id] NVARCHAR(255) NULL," +
    "[data] NVARCHAR(MAX) NOT NULL," +
    "[created_at] DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()," +
    "[updated_at] DATETIME2 NOT NULL DEFAULT SYSUTCDATETIME()," +
    "[version] INT NOT NULL DEFAULT 1," +
    "[deleted_at] DATETIME2 NULL); " +
    `CREATE INDEX [idx_tenant] ON ${table} ([tenant_id]); END`;
  return { text, params: {} };
}

/** INSERT rows (T-SQL has no RETURNING — the adapter SELECTs after). */
export function buildInsertQuery(collection: string, rows: readonly InsertRow[]): BuiltQuery {
  const table = quoteIdentifier(assertIdentifier(collection));
  const bag = new ParamBag();
  const tuples = rows.map(
    (r) => `(${bag.push(r.id)}, ${bag.push(r.tenantId ?? null)}, ${bag.push(r.data)})`,
  );
  const text = `INSERT INTO ${table} ([id], [tenant_id], [data]) VALUES ${tuples.join(", ")}`;
  return { text, params: bag.params };
}

export interface InsertRow {
  id: string;
  tenantId: string | undefined;
  data: string; // JSON string
}

/** Soft-delete UPDATE. */
export function buildSoftDeleteQuery(
  collection: string,
  id: string,
  tenantId: string | undefined,
): BuiltQuery {
  const table = quoteIdentifier(assertIdentifier(collection));
  const bag = new ParamBag();
  const idPh = bag.push(id);
  let text =
    `UPDATE ${table} SET [deleted_at] = SYSUTCDATETIME() ` +
    `WHERE [id] = ${idPh} AND [deleted_at] IS NULL`;
  if (tenantId !== undefined) {
    text += ` AND [tenant_id] = ${bag.push(tenantId)}`;
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
  const bag = new ParamBag();
  const jsonPh = bag.push(fullJson);
  const idPh = bag.push(id);
  let text =
    `UPDATE ${table} SET [data] = ${jsonPh}, ` +
    `[updated_at] = SYSUTCDATETIME(), [version] = [version] + 1 ` +
    `WHERE [id] = ${idPh} AND [deleted_at] IS NULL`;
  if (tenantId !== undefined) {
    text += ` AND [tenant_id] = ${bag.push(tenantId)}`;
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
  const bag = new ParamBag();
  const jsonPh = bag.push(fullJson);
  const idPh = bag.push(id);
  const versionPh = bag.push(expectedVersion);
  let text =
    `UPDATE ${table} SET [data] = ${jsonPh}, ` +
    `[updated_at] = SYSUTCDATETIME(), [version] = [version] + 1 ` +
    `WHERE [id] = ${idPh} AND [version] = ${versionPh} AND [deleted_at] IS NULL`;
  if (tenantId !== undefined) {
    text += ` AND [tenant_id] = ${bag.push(tenantId)}`;
  }
  return { text, params: bag.params };
}
