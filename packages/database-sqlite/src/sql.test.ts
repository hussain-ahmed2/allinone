import { describe, expect, it } from "vitest";
import { assertField, assertIdentifier, buildSelectQuery } from "./sql.js";

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

  it("parameterizes values and JSON paths", () => {
    const q = buildSelectQuery(
      "users",
      { filters: [{ field: "name", operator: "eq", value: "x' OR 1=1 --" }] },
      undefined,
    );
    expect(q.text).not.toContain("x' OR 1=1");
    expect(q.params).toContain("$.name");
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
    expect(q.params[q.params.length - 1]).toBe("%50\\%%");
  });

  it("null-safe eq/ne rows", () => {
    const eq = buildSelectQuery(
      "t",
      { filters: [{ field: "x", operator: "eq", value: null }] },
      undefined,
    );
    expect(eq.text).toContain("IS NULL");
  });

  it("rejects object values for eq (NoSQL-style attack)", () => {
    expect(() =>
      buildSelectQuery(
        "t",
        { filters: [{ field: "x", operator: "eq", value: { $gt: "" } }] },
        undefined,
      ),
    ).toThrow(/primitive/);
  });
});
