/**
 * Filter → Mongo query translation with NoSQL-injection defenses.
 *
 * Threat model (document DB): an attacker who controls a filter value
 * must never be able to smuggle query operators (`$gt`, `$ne`, ...)
 * into the query. Rules:
 *  - Values for `eq/ne/gt/gte/lt/lte` must be PRIMITIVES
 *    (string/number/boolean/null). Objects/arrays are rejected —
 *    an object value is exactly how NoSQL operator injection works.
 *  - `in/nin` values must be arrays of primitives only.
 *  - Field names are whitelisted (`/^[A-Za-z_][A-Za-z0-9_.]*$/`,
 *    no `$` prefix, no leading `_` internals). Dot-notation is allowed
 *    for nested documents but `tenantId` is always OR-ed in by the
 *    adapter itself — clients can never remove the tenant predicate.
 */
import type { Filter } from "@allinone/database";

const FIELD_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

/** Validate a field name. Throws on anything unsafe. */
export function assertField(field: string): string {
  if (field.startsWith("$") || field.startsWith("_")) {
    throw new Error(`[allinone/database-mongodb] Invalid field: ${JSON.stringify(field)}`);
  }
  if (!FIELD_RE.test(field)) {
    throw new Error(`[allinone/database-mongodb] Invalid field: ${JSON.stringify(field)}`);
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
      `[allinone/database-mongodb] Operator "${operator}" requires a primitive ` +
        `value (string/number/boolean/null) — got ${typeof value}. ` +
        `Objects are rejected to prevent NoSQL operator injection.`,
    );
  }
}

function assertPrimitiveArray(value: unknown, operator: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      `[allinone/database-mongodb] Operator "${operator}" requires a non-empty array of primitives`,
    );
  }
  for (const item of value) assertPrimitive(item, operator);
  return value;
}

export type MongoFilterClause = Record<string, unknown>;

/** Translate one Filter into a Mongo query clause (safe by construction). */
export function buildClause(filter: Filter): MongoFilterClause {
  const field = assertField(filter.field);
  switch (filter.operator) {
    case "eq":
      assertPrimitive(filter.value, "eq");
      return { [field]: filter.value };
    case "ne":
      assertPrimitive(filter.value, "ne");
      return { [field]: { $ne: filter.value } };
    case "gt":
      assertPrimitive(filter.value, "gt");
      return { [field]: { $gt: filter.value } };
    case "gte":
      assertPrimitive(filter.value, "gte");
      return { [field]: { $gte: filter.value } };
    case "lt":
      assertPrimitive(filter.value, "lt");
      return { [field]: { $lt: filter.value } };
    case "lte":
      assertPrimitive(filter.value, "lte");
      return { [field]: { $lte: filter.value } };
    case "in":
      return { [field]: { $in: assertPrimitiveArray(filter.value, "in") } };
    case "nin":
      return { [field]: { $nin: assertPrimitiveArray(filter.value, "nin") } };
    case "contains": {
      // Text match on stored strings. Escaping regex metacharacters
      // prevents pattern injection through the search value.
      if (typeof filter.value !== "string") {
        throw new Error(`[allinone/database-mongodb] Operator "contains" requires a string value`);
      }
      const escaped = filter.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return { [field]: new RegExp(escaped) };
    }
    case "isNull":
      return { [field]: { $in: [null] } };
    case "isNotNull":
      return { [field]: { $ne: null, $exists: true } };
    default: {
      const _exhaustive: never = filter.operator;
      throw new Error(`[allinone/database-mongodb] Unsupported operator: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Combine clauses into one query with $and. The adapter always embeds
 * tenant + soft-delete predicates itself; caller clauses can only narrow.
 */
export function buildQuery(
  filters: readonly Filter[],
  tenantId: string | undefined,
): MongoFilterClause {
  const and: MongoFilterClause[] = [];
  if (tenantId !== undefined) and.push({ tenantId });
  and.push({ deletedAt: { $exists: false } });
  for (const filter of filters) and.push(buildClause(filter));
  const [first] = and;
  return and.length === 1 && first ? first : { $and: and };
}
