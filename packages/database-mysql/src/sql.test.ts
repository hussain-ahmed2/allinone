import { describe, expect, it } from "vitest";
import {
  assertField,
  assertIdentifier,
  buildFilterClause,
  buildSelectQuery,
  type ParamBag,
} from "./sql.js";

function bag(): ParamBag {
  const params: unknown[] = [];
  return {
    params,
    push(value: unknown): string {
      params.push(value);
      return "?";
    },
  };
}

describe("identifiers", () => {
  it("accepts safe identifiers", () => {
    expect(assertIdentifier("users")).toBe("users");
    expect(assertField("address.city")).toBe("address.city");
  });

  it("rejects injection via table names", () => {
    expect(() => assertIdentifier('users"; DROP TABLE users; --')).toThrow(
      /Invalid table identifier/,
    );
    expect(() => assertIdentifier("users where 1=1")).toThrow(/Invalid table identifier/);
    expect(() => assertIdentifier("123abc")).toThrow(/Invalid table identifier/);
  });

  it("rejects path injection via fields", () => {
    expect(() => assertField("name' OR '1'='1")).toThrow(/Invalid field/);
    expect(() => assertField("$.quoted")).toThrow(/Invalid field/);
  });
});

describe("buildSelectQuery", () => {
  it("always excludes soft-deleted rows", () => {
    const q = buildSelectQuery("users", {}, undefined);
    expect(q.text).toContain("`deleted_at` IS NULL");
  });

  it("scopes by tenant when provided", () => {
    const q = buildSelectQuery("users", {}, "t1");
    expect(q.text).toContain("`tenant_id` = ?");
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

  it("escapes LIKE wildcards in contains", () => {
    const q = buildSelectQuery(
      "posts",
      { filters: [{ field: "title", operator: "contains", value: "50%" }] },
      undefined,
    );
    expect(q.params[0]).toBe("%50\\%%");
  });
});

describe("buildFilterClause", () => {
  it("supports null-safe eq/ne rows", () => {
    expect(buildFilterClause({ field: "x", operator: "eq", value: null }, bag())).toContain(
      "IS NULL",
    );
    expect(buildFilterClause({ field: "x", operator: "ne", value: null }, bag())).toContain(
      "IS NOT NULL",
    );
  });

  it("casts numeric comparators to DECIMAL", () => {
    const b = bag();
    const clause = buildFilterClause({ field: "score", operator: "gt", value: 10 }, b);
    expect(clause).toContain("CAST(");
    expect(b.params).toEqual([10]);
  });

  it("in/nin require non-empty arrays of primitives", () => {
    expect(() => buildFilterClause({ field: "id", operator: "in", value: [] }, bag())).toThrow(
      /non-empty/,
    );
    expect(() =>
      buildFilterClause({ field: "id", operator: "in", value: ["a", { $gt: "" }] }, bag()),
    ).toThrow(/primitive/);
  });

  it("rejects object values for eq (NoSQL-style attack)", () => {
    expect(() =>
      buildFilterClause({ field: "name", operator: "eq", value: { $gt: "" } }, bag()),
    ).toThrow(/primitive/);
  });
});
