import { describe, expect, it } from "vitest";
import { createMemoryAdapter, runAdapterConformance } from "./index.js";

describe("memory adapter", () => {
  it("passes conformance contract", async () => {
    await runAdapterConformance(createMemoryAdapter());
  });

  it("honestly declares no transactions", () => {
    const adapter = createMemoryAdapter();
    expect(adapter.capabilities.transactions).toBe(false);
    expect(adapter.capabilities.joins).toBe(false);
  });

  it("filters + sorts + paginates", async () => {
    const adapter = createMemoryAdapter();
    await adapter.connect();
    await adapter.insert("items", [
      { id: "a", n: 3 },
      { id: "b", n: 1 },
      { id: "c", n: 2 },
    ]);
    const page = await adapter.find("items", {
      sort: [{ field: "n", direction: "asc" }],
      limit: 1,
      offset: 1,
    });
    expect(page[0]?.["id"]).toBe("c");
    await adapter.disconnect();
  });

  it("isolates tenants at query time", async () => {
    const adapter = createMemoryAdapter();
    await adapter.connect();
    await adapter.insert("rows", [{ v: 1 }], { tenantId: "t1" });
    const other = await adapter.find("rows", { tenantId: "t2" });
    expect(other).toHaveLength(0);
    await adapter.disconnect();
  });
});
