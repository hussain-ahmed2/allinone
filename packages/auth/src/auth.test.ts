import { describe, expect, it } from "vitest";
import {
  AuthService,
  can,
  effectivePermissions,
  evaluatePolicy,
  hashToken,
  matchesPermission,
  type Role,
} from "./index.js";

describe("permissions", () => {
  it("matches wildcards", () => {
    expect(matchesPermission("*", "users.read")).toBe(true);
    expect(matchesPermission("users.*", "users.read")).toBe(true);
    expect(matchesPermission("users.*", "orgs.read")).toBe(false);
    expect(matchesPermission("users.read", "users.read")).toBe(true);
  });

  it("resolves role inheritance", () => {
    const roles = new Map<string, Role>([
      ["admin", { id: "admin", name: "Admin", permissions: ["users.*"], inherits: "user" }],
      ["user", { id: "user", name: "User", permissions: ["users.read", "posts.read"] }],
    ]);
    expect(effectivePermissions("admin", roles)).toContain("posts.read");
  });

  it("denies by default", () => {
    const decision = evaluatePolicy(
      { actor: { id: "u1", roles: ["user"], attributes: {} }, action: "delete", resource: "users" },
      new Map(),
    );
    expect(decision.allowed).toBe(false);
  });

  it("ABAC condition can deny an otherwise-granted permission", () => {
    const roles = new Map<string, Role>([
      ["editor", { id: "editor", name: "Editor", permissions: ["posts.update"] }],
    ]);
    const allowed = can(
      {
        actor: { id: "u1", roles: ["editor"], attributes: { ownerId: "u1" } },
        action: "update",
        resource: "posts",
        resourceAttributes: { ownerId: "u1" },
      },
      roles,
      [
        {
          permission: "posts.update",
          condition: (q) => q.actor.attributes["ownerId"] === q.resourceAttributes?.["ownerId"],
        },
      ],
    );
    expect(allowed).toBe(true);

    const denied = can(
      {
        actor: { id: "u1", roles: ["editor"], attributes: { ownerId: "u1" } },
        action: "update",
        resource: "posts",
        resourceAttributes: { ownerId: "other" },
      },
      roles,
      [
        {
          permission: "posts.update",
          condition: (q) => q.actor.attributes["ownerId"] === q.resourceAttributes?.["ownerId"],
        },
      ],
    );
    expect(denied).toBe(false);
  });
});

describe("AuthService", () => {
  it("registers, logs in, and rotates refresh tokens", async () => {
    const auth = new AuthService();
    await auth.register({ email: "a@example.com", password: "correct horse battery", name: "A" });
    const { refreshToken } = await auth.login({
      email: "a@example.com",
      password: "correct horse battery",
      tenantId: "t1",
    });
    expect(refreshToken).not.toBe(hashToken(refreshToken));
    const rotated = await auth.rotateRefresh(refreshToken);
    expect(rotated.refreshToken).not.toBe(refreshToken);
    // Reusing the old token is detected.
    await expect(auth.rotateRefresh(refreshToken)).rejects.toThrow(/reuse/);
  });

  it("rejects wrong passwords without enumerating accounts", async () => {
    const auth = new AuthService();
    await expect(
      auth.login({ email: "ghost@example.com", password: "whatever password 123", tenantId: "t1" }),
    ).rejects.toThrow(/Invalid credentials/);
  });

  it("locks out after repeated failures", async () => {
    const auth = new AuthService({ maxLoginAttempts: 2, lockoutSeconds: 60 });
    await auth.register({ email: "b@example.com", password: "correct horse battery", name: "B" });
    await expect(
      auth.login({ email: "b@example.com", password: "wrong wrong wrong", tenantId: "t1" }),
    ).rejects.toThrow();
    await expect(
      auth.login({ email: "b@example.com", password: "wrong wrong wrong", tenantId: "t1" }),
    ).rejects.toThrow();
    await expect(
      auth.login({ email: "b@example.com", password: "correct horse battery", tenantId: "t1" }),
    ).rejects.toThrow(/locked/);
  });
});
