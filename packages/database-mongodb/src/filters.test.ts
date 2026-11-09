import { describe, expect, it } from "vitest";
import { assertField, buildClause, buildQuery } from "./filters.js";

describe("assertField", () => {
  it("accepts safe fields incl. nested docs", () => {
    expect(assertField("name")).toBe("name");
    expect(assertField("address.city")).toBe("address.city");
  });

  it("rejects $-operators and internal fields", () => {
    expect(() => assertField("$where")).toThrow(/Invalid field/);
    expect(() => assertField("_version")).toThrow(/Invalid field/);
    expect(() => assertField("a b")).toThrow(/Invalid field/);
    expect(() => assertField('a"; evil')).toThrow(/Invalid field/);
  });
});

describe("NoSQL operator injection defenses", () => {
  it("rejects object values for eq (the classic { $gt: '' } attack)", () => {
    expect(() => buildClause({ field: "name", operator: "eq", value: { $gt: "" } })).toThrow(
      /requires a primitive/,
    );
    expect(() => buildClause({ field: "name", operator: "gt", value: { $ne: null } })).toThrow(
      /requires a primitive/,
    );
    expect(() => buildClause({ field: "name", operator: "ne", value: { $nin: [1] } })).toThrow(
      /requires a primitive/,
    );
  });

  it("rejects object/array members in in/nin", () => {
    expect(() => buildClause({ field: "id", operator: "in", value: ["a", { $gt: "" }] })).toThrow(
      /requires a primitive/,
    );
    expect(() => buildClause({ field: "id", operator: "in", value: [] })).toThrow(/non-empty/);
    expect(() => buildClause({ field: "id", operator: "in", value: "not-an-array" })).toThrow(
      /non-empty/,
    );
  });

  it("requires strings for contains", () => {
    expect(() => buildClause({ field: "title", operator: "contains", value: 42 })).toThrow(
      /requires a string/,
    );
  });

  it("escapes regex metacharacters in contains (pattern injection)", () => {
    const clause = buildClause({
      field: "title",
      operator: "contains",
      value: "a.c+j*",
    });
    const re = clause["title"] as RegExp;
    expect(re).toBeInstanceOf(RegExp);
    expect(re.source).toBe("a\\.c\\+j\\*");
  });

  it("primitives pass through untouched", () => {
    expect(buildClause({ field: "n", operator: "gt", value: 5 })).toEqual({
      n: { $gt: 5 },
    });
    expect(buildClause({ field: "ok", operator: "eq", value: true })).toEqual({ ok: true });
    expect(buildClause({ field: "x", operator: "eq", value: null })).toEqual({ x: null });
  });
});

describe("buildQuery", () => {
  it("always embeds soft-delete + tenant predicates", () => {
    const q = buildQuery([{ field: "a", operator: "eq", value: 1 }], "t1");
    const json = JSON.stringify(q);
    expect(json).toContain("deletedAt");
    expect(json).toContain("t1");
  });

  it("omits tenant predicate when unscoped (single-tenant mode)", () => {
    const q = buildQuery([], undefined);
    expect(q).toEqual({ deletedAt: { $exists: false } });
  });
});
