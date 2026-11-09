import { describe, expect, it } from "vitest";
import { buildAdminManifest } from "./admin.js";
import type { Role } from "@allinone/auth";

const ROLES = new Map<string, Role>([
  ["admin", { id: "admin", name: "Admin", permissions: ["*"] }],
  ["editor", { id: "editor", name: "Editor", permissions: ["posts.*"] }],
  ["viewer", { id: "viewer", name: "Viewer", permissions: ["posts.read", "audit.read"] }],
]);

describe("buildAdminManifest", () => {
  it("gives admins the full manifest", () => {
    const manifest = buildAdminManifest({
      actor: { id: "u1", roles: ["admin"] },
      tenantId: "t1",
      rolesById: ROLES,
    });
    expect(manifest.modules.map((m) => m.name)).toContain("dashboard");
    expect(manifest.modules.map((m) => m.name)).toContain("operations");
    expect(manifest.collections.map((c) => c.slug)).toEqual(["users", "posts"]);
    expect(manifest.actor.roles).toEqual(["admin"]);
    expect(manifest.tenantId).toBe("t1");
  });

  it("filters sections by permission (never just hides)", () => {
    const manifest = buildAdminManifest({
      actor: { id: "u2", roles: ["editor"] },
      tenantId: "t1",
      rolesById: ROLES,
    });
    // Editor: posts.* but not users.read / roles.read / audit.read.
    const slugs = manifest.modules.flatMap((m) => m.sections.map((s) => s.slug));
    expect(slugs).toContain("posts");
    expect(slugs).not.toContain("users");
    expect(slugs).not.toContain("audit-logs");
    expect(manifest.collections.map((c) => c.slug)).toEqual(["posts"]);
  });

  it("keeps unpermissioned sections visible to everyone", () => {
    const manifest = buildAdminManifest({
      actor: { id: "u3", roles: ["viewer"] },
      tenantId: "t1",
      rolesById: ROLES,
    });
    const slugs = manifest.modules.flatMap((m) => m.sections.map((s) => s.slug));
    expect(slugs).toContain("overview");
    expect(slugs).toContain("posts");
    expect(slugs).toContain("audit-logs");
    expect(slugs).not.toContain("users");
  });

  it("honors custom config overrides", () => {
    const manifest = buildAdminManifest({
      actor: { id: "u1", roles: ["admin"] },
      tenantId: "t1",
      rolesById: ROLES,
      config: {
        collections: [
          {
            slug: "orders",
            name: "Orders",
            permissions: { read: "orders.read" },
            fields: [{ key: "total", type: "number", required: true }],
          },
        ],
        actions: ["refund"],
        widgets: ["sales"],
      },
    });
    expect(manifest.collections.map((c) => c.slug)).toEqual(["orders"]);
    expect(manifest.actions).toEqual(["refund"]);
    expect(manifest.widgets).toEqual(["sales"]);
  });

  it("empty custom module lists keep defaults", () => {
    const manifest = buildAdminManifest({
      actor: { id: "u1", roles: ["admin"] },
      tenantId: "t1",
      rolesById: ROLES,
      config: { extraModules: [] },
    });
    expect(manifest.modules.length).toBeGreaterThan(0);
  });
});
