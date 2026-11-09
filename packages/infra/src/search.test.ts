import { describe, expect, it } from "vitest";
import { createMemoryAdapter } from "@allinone/database";
import { createSearchIndex, searchAcross } from "./search.js";

describe("searchAcross", () => {
  it("matches contains across fields with OR semantics", async () => {
    const db = createMemoryAdapter();
    await db.connect();
    if (!db.createTable) throw new Error("unsupported");
    await db.createTable("posts");
    await db.insert("posts", [
      { id: "p1", title: "deploy guide", body: "plain" },
      { id: "p2", title: "Notes", body: "deployment runbook" },
      { id: "p3", title: "Other", body: "unrelated" },
    ]);
    const hits = await searchAcross(db, "posts", {
      query: "deploy",
      fields: ["title", "body"],
    });
    expect(hits.map((r) => r["id"]).sort()).toEqual(["p1", "p2"]);
    await db.disconnect();
  });

  it("returns empty for blank queries and honors limit", async () => {
    const db = createMemoryAdapter();
    await db.connect();
    if (!db.createTable) throw new Error("unsupported");
    await db.createTable("docs");
    await db.insert("docs", [{ id: "a", text: "alpha beta" }]);
    expect(await searchAcross(db, "docs", { query: "  ", fields: ["text"] })).toEqual([]);
    const limited = await searchAcross(db, "docs", {
      query: "alpha",
      fields: ["text"],
      limit: 1,
    });
    expect(limited).toHaveLength(1);
    await db.disconnect();
  });
});

describe("MemorySearchIndex", () => {
  it("prefix-matches tokens and requires all query tokens", () => {
    const index = createSearchIndex();
    index.add({ id: "1", tenantId: "t1", text: "Deploying production guides" });
    index.add({ id: "2", tenantId: "t1", text: "Deployment checklists" });
    expect(index.search({ tenantId: "t1", query: "deploy" }).map((d) => d.id)).toEqual(
      expect.arrayContaining(["1", "2"]),
    );
    expect(index.search({ tenantId: "t1", query: "production guides" })).toHaveLength(1);
  });

  it("is tenant-scoped and limitable", () => {
    const index = createSearchIndex();
    index.add({ id: "1", tenantId: "t1", text: "alpha" });
    index.add({ id: "2", tenantId: "t2", text: "alpha" });
    expect(index.search({ tenantId: "t1", query: "alpha" }).map((d) => d.id)).toEqual(["1"]);
    expect(index.search({ query: "alpha", limit: 1 })).toHaveLength(1);
    expect(index.size()).toBe(2);
    index.clearTenant("t1");
    expect(index.search({ tenantId: "t1", query: "alpha" })).toHaveLength(0);
  });
});
