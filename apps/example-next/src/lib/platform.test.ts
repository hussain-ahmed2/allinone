import { describe, expect, it } from "vitest";
import {
  adminManifest,
  canPerform,
  createCsrfToken,
  issueSession,
  readSession,
  revokeSession,
} from "./platform.js";

describe("next platform helpers", () => {
  it("issues and reads sessions", () => {
    const id = issueSession({
      userId: "u1",
      tenantId: "t1",
      csrf: "csrf-token",
      memberships: ["t1"],
      roles: ["admin"],
    });
    const session = readSession(id);
    expect(session?.userId).toBe("u1");
    expect(session?.tenantId).toBe("t1");
    expect(readSession("nope")).toBeNull();
    expect(revokeSession(id)).toBe(true);
    expect(readSession(id)).toBeNull();
  });

  it("evaluates permissions with the server-side engine", () => {
    expect(canPerform({ id: "u1", roles: ["admin"] }, "read", "cms.posts")).toBe(true);
    expect(canPerform({ id: "u1", roles: ["viewer"] }, "create", "cms.posts")).toBe(false);
  });

  it("builds a permission-shaped manifest", () => {
    const manifest = adminManifest({ id: "u1", roles: ["editor"] }, "t1");
    expect(manifest.collections.map((c) => c.slug)).toEqual(["posts"]);
    expect(manifest.tenantId).toBe("t1");
  });

  it("mints distinct CSRF tokens", () => {
    expect(createCsrfToken()).not.toBe(createCsrfToken());
  });
});
