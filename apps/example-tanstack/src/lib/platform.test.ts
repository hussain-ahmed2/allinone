import { describe, expect, it } from "vitest";
import { adminManifest, canPerform, issueSession, readSession } from "./platform.js";

describe("tanstack platform helpers", () => {
  it("issues and reads sessions", () => {
    const id = issueSession({
      userId: "u1",
      tenantId: "t1",
      csrf: "c",
      memberships: ["t1"],
      roles: ["admin"],
    });
    expect(readSession(id)?.userId).toBe("u1");
    expect(readSession("missing")).toBeNull();
  });

  it("evaluates permissions", () => {
    expect(canPerform({ id: "u1", roles: ["admin"] }, "read", "cms.posts")).toBe(true);
    expect(canPerform({ id: "u1", roles: ["viewer"] }, "create", "cms.posts")).toBe(false);
  });

  it("builds a permission-shaped manifest", () => {
    const manifest = adminManifest({ id: "u1", roles: ["editor"] }, "t1");
    expect(manifest.collections.map((c) => c.slug)).toEqual(["posts"]);
  });
});
