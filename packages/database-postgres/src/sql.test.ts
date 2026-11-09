import { describe, expect, it } from "vitest";
import { assertIdentifier, buildFilterClause, buildInsertQuery, buildSelectQuery } from "./sql.js";
import type { ParamBag } from "./sql.js";

/** Local ParamBag factory for tests (uses the adapter's Queryable plumbing). */
function createParamBagForTests(): { bag: ParamBag } {
  const params: unknown[] = [];
  const bag: ParamBag = {
    params,
    push(value: unknown): string {
      params.push(value);
      return "$" + String(params.length);
    },
  };
  return { bag };
}

describe("identifiers", () => {
  it("accepts safe identifiers", () => {
    expect(assertIdentifier("users", "table")).toBe("users");
    expect(assertIdentifier("tenant_id", "field")).toBe("tenant_id");
  });

  it("rejects injection via table names", () => {
    expect(() => assertIdentifier('users"; DROP TABLE users; --', "table")).toThrow(
      /Invalid table identifier/,
    );
    expect(() => assertIdentifier("users where 1=1", "table")).toThrow(/Invalid table identifier/);
    expect(() => assertIdentifier("123abc", "table")).toThrow(/Invalid table identifier/);
    expect(() => assertIdentifier("", "table")).toThrow(/Invalid table identifier/);
  });

  it("rejects injection via field names", () => {
    expect(() => assertIdentifier("name' OR '1'='1", "field")).toThrow(/Invalid field identifier/);
  });
});

describe("buildSelectQuery", () => {
  it("always excludes soft-deleted rows", () => {
    const q = buildSelectQuery("users", {}, undefined);
    expect(q.text).toContain('"deleted_at" IS NULL');
  });

  it("scopes by tenant when provided", () => {
    const q = buildSelectQuery("users", {}, "t1");
    expect(q.text).toContain('"tenant_id" = $1');
    expect(q.params).toEqual(["t1"]);
  });

  it("parameterizes filter values (no interpolation)", () => {
    const q = buildSelectQuery(
      "users",
      { filters: [{ field: "name", operator: "eq", value: "x' OR 1=1 --" }] },
      undefined,
    );
    expect(q.text).not.toContain("x' OR 1=1");
    expect(q.params).toContain("x' OR 1=1 --");
  });

  it("rejects negative limit/offset", () => {
    expect(() => buildSelectQuery("users", { limit: -1 }, undefined)).toThrow(/limit/);
    expect(() => buildSelectQuery("users", { offset: -5 }, undefined)).toThrow(/offset/);
  });

  it("escapes ILIKE wildcards in contains", () => {
    const q = buildSelectQuery(
      "posts",
      { filters: [{ field: "title", operator: "contains", value: "50%" }] },
      undefined,
    );
    expect(q.params[0]).toBe("%50\\%%");
    expect(q.text).toContain("ILIKE");
  });
});

describe("buildFilterClause + insert", () => {
  it("supports numeric comparators", () => {
    const bag = createParamBagForTests();
    const clause = buildFilterClause({ field: "score", operator: "gt", value: 10 }, bag.bag);
    expect(clause).toContain("::numeric >");
    expect(bag.bag.params).toEqual([10]);
  });

  it("in/nin require non-empty arrays", () => {
    const bag = createParamBagForTests();
    expect(() => buildFilterClause({ field: "id", operator: "in", value: [] }, bag.bag)).toThrow(
      /non-empty/,
    );
  });

  it("insert returns parameterized RETURNING query", () => {
    const q = buildInsertQuery("users", [{ id: "u1", tenantId: "t1", data: "{}" }]);
    expect(q.text).toContain("INSERT INTO");
    expect(q.text).toContain("RETURNING");
    expect(q.params).toHaveLength(3);
  });
});
