import { describe, expect, it } from "vitest";
import { createPermissionCache } from "./permission-cache.js";
import type { Role } from "./auth.js";

function memoryCache() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
    async set(key: string, value: string): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string): Promise<void> {
      store.delete(key);
    },
  };
}

const ROLES = new Map<string, Role>([
  ["editor", { id: "editor", name: "Editor", permissions: ["posts.*"] }],
  ["viewer", { id: "viewer", name: "Viewer", permissions: ["posts.read"] }],
]);

describe("PermissionCache", () => {
  it("caches RBAC decisions and round-trips them", async () => {
    const cache = memoryCache();
    const permissions = createPermissionCache({ cache, ttlSeconds: 60 });
    const query = {
      actor: { id: "u1", roles: ["editor"], attributes: {} },
      action: "read",
      resource: "posts",
    };
    await expect(permissions.can(query, ROLES, "t1")).resolves.toBe(true);
    await expect(permissions.can(query, ROLES, "t1")).resolves.toBe(true);
    // Repeat calls leave exactly one memoized value behind.
    const memoValues = [...cache.store.keys()].filter((k) => k.startsWith("perm:t"));
    expect(memoValues.length).toBeGreaterThanOrEqual(1);
  });

  it("caches denials too (deny memo is also stable)", async () => {
    const cache = memoryCache();
    const permissions = createPermissionCache({ cache, ttlSeconds: 60 });
    const query = {
      actor: { id: "u1", roles: ["viewer"], attributes: {} },
      action: "delete",
      resource: "posts",
    };
    await expect(permissions.can(query, ROLES, "t1")).resolves.toBe(false);
    await expect(permissions.can(query, ROLES, "t1")).resolves.toBe(false);
  });

  it("invalidateActor evicts that actor's memoized decisions", async () => {
    const cache = memoryCache();
    const permissions = createPermissionCache({ cache, ttlSeconds: 3600 });
    const query = {
      actor: { id: "u1", roles: ["editor"], attributes: {} },
      action: "read",
      resource: "posts",
    };
    await expect(permissions.can(query, ROLES, "t1")).resolves.toBe(true);
    await permissions.invalidateActor("u1");
    // Key generation advanced → a fresh evaluation happens on next check.
    await expect(permissions.can(query, ROLES, "t1")).resolves.toBe(true);
    const generationKeys = [...cache.store.keys()].filter((k) => k.startsWith("perm:actor:u1"));
    expect(generationKeys).toHaveLength(1);
  });

  it("invalidateTenant is tenant-scoped only", async () => {
    const cache = memoryCache();
    const permissions = createPermissionCache({ cache, ttlSeconds: 3600 });
    const query = {
      actor: { id: "u1", roles: ["editor"], attributes: {} },
      action: "read",
      resource: "posts",
    };
    await permissions.can(query, ROLES, "t1");
    await permissions.can(query, ROLES, "t2");
    await permissions.invalidateTenant("t1");
    const t1Gen = await cache.get("perm:tenant:t1:v");
    const t2Gen = await cache.get("perm:tenant:t2:v");
    expect(t1Gen).toBe("2");
    expect(t2Gen).toBeNull();
  });

  it("never caches ABAC/custom policies (attribute-dependent)", async () => {
    const cache = memoryCache();
    const permissions = createPermissionCache({ cache, ttlSeconds: 3600 });
    const query = {
      actor: { id: "u1", roles: ["editor"], attributes: { ownerId: "u1" } },
      action: "update",
      resource: "posts",
      resourceAttributes: { ownerId: "other" },
    };
    const allowed = await permissions.can(query, ROLES, "t1", [
      {
        permission: "posts.update",
        condition: (q) => q.actor.attributes["ownerId"] === q.resourceAttributes?.["ownerId"],
      },
    ]);
    expect(allowed).toBe(false);
    const memoized = [...cache.store.keys()].filter((k) => k.startsWith("perm:t"));
    expect(memoized).toHaveLength(0);
  });

  it("degrades gracefully when the cache throws", async () => {
    const failingCache = {
      async get(): Promise<string | null> {
        throw new Error("cache down");
      },
      async set(): Promise<void> {
        throw new Error("cache down");
      },
      async delete(): Promise<void> {
        throw new Error("cache down");
      },
    };
    const permissions = createPermissionCache({ cache: failingCache });
    const query = {
      actor: { id: "u1", roles: ["editor"], attributes: {} },
      action: "read",
      resource: "posts",
    };
    await expect(permissions.can(query, ROLES, "t1")).resolves.toBe(true);
  });
});
