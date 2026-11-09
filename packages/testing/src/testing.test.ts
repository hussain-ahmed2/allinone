import { describe, expect, it } from "vitest";
import { expectRejects, testDatabase } from "./index.js";

describe("test helpers", () => {
  it("creates isolated databases per test", async () => {
    const a = testDatabase();
    const b = testDatabase();
    await a.connect();
    await b.connect();
    await a.insert("t", [{ id: "1" }]);
    expect(await b.find("t")).toHaveLength(0);
    await a.disconnect();
    await b.disconnect();
  });

  it("expectRejects matches patterns", async () => {
    await expectRejects(Promise.reject(new Error("boom")), /boom/);
  });
});
