/**
 * Admin metadata engine — the backend contract for the framework's
 * admin UI renderer.
 *
 * The platform exposes DESCRIPTIVE metadata (navigation, pages,
 * collections, actions, dashboard data) instead of a coupled frontend.
 * Your framework's rendering engine turns this manifest into screens;
 * fields/components are referenced by name, never framework-coupled.
 *
 * Every entry is permission-gated server-side: an actor sees only what
 * their roles permit (dead sections are omitted, never just hidden).
 */
import { can, type Role } from "@allinone/auth";

export interface AdminCollectionField {
  key: string;
  type: string;
  required: boolean;
  /** Component contract the renderer should use (e.g. "text", "select"). */
  component?: string;
  options?: string[];
}

export interface AdminCollection {
  slug: string;
  name: string;
  /** List/creation permissions required to see this collection. */
  permissions: { read: string; create?: string };
  fields: readonly AdminCollectionField[];
  hasPublish?: boolean;
}

export interface AdminModule {
  name: string;
  label: string;
  /** Sections (pages) under this module. */
  sections: readonly AdminSection[];
}

export interface AdminSection {
  slug: string;
  label: string;
  icon?: string;
  /** Permission required to see this section. */
  permission?: string;
  /** Manifest node the renderer shows (e.g. "users", "audit-logs"). */
  view?: string;
}

export interface AdminManifest {
  generatedAt: string;
  actor: { id: string; roles: string[] };
  tenantId: string;
  modules: AdminModule[];
  collections: AdminCollection[];
  /** Handlers the renderer may invoke (server-enforced, see note). */
  actions: string[];
  widgets: string[];
}

export interface AdminConfig {
  collections?: readonly AdminCollection[];
  extraModules?: readonly AdminModule[];
  actions?: readonly string[];
  widgets?: readonly string[];
}

const DEFAULT_COLLECTIONS: readonly AdminCollection[] = [
  {
    slug: "users",
    name: "Users",
    permissions: { read: "users.read", create: "users.create" },
    fields: [
      { key: "id", type: "string", required: true, component: "text" },
      { key: "email", type: "email", required: true, component: "text" },
      { key: "name", type: "string", required: true, component: "text" },
      {
        key: "role",
        type: "enum",
        required: false,
        component: "select",
        options: ["admin", "editor", "viewer"],
      },
    ],
  },
  {
    slug: "posts",
    name: "Posts",
    permissions: { read: "posts.read", create: "posts.create" },
    hasPublish: true,
    fields: [
      { key: "title", type: "string", required: true, component: "text" },
      { key: "slug", type: "string", required: true, component: "text" },
      { key: "body", type: "string", required: false, component: "textarea" },
      {
        key: "status",
        type: "enum",
        required: true,
        component: "select",
        options: ["draft", "in-review", "published", "archived"],
      },
    ],
  },
];

const DEFAULT_MODULES: readonly AdminModule[] = [
  {
    name: "dashboard",
    label: "Dashboard",
    sections: [{ slug: "overview", label: "Overview", view: "dashboard", icon: "home" }],
  },
  {
    name: "management",
    label: "Manage",
    sections: [
      { slug: "users", label: "Users", permission: "users.read", view: "users" },
      { slug: "roles", label: "Roles", permission: "roles.read", view: "roles" },
      { slug: "tenants", label: "Tenants", permission: "tenants.read", view: "tenants" },
    ],
  },
  {
    name: "content",
    label: "Content",
    sections: [
      { slug: "posts", label: "Posts", permission: "posts.read", view: "posts" },
      { slug: "media", label: "Media library", permission: "media.read", view: "media" },
    ],
  },
  {
    name: "operations",
    label: "Operations",
    sections: [
      { slug: "audit-logs", label: "Audit logs", permission: "audit.read", view: "audit-logs" },
      { slug: "api-keys", label: "API keys", permission: "keys.read", view: "api-keys" },
      { slug: "webhooks", label: "Webhooks", permission: "webhooks.read", view: "webhooks" },
      { slug: "health", label: "System health", permission: "health.read", view: "health" },
    ],
  },
];

/**
 * Build the renderable admin manifest for an actor + tenant.
 * Permission checks run server-side; non-permitted sections are omitted.
 */
export function buildAdminManifest(input: {
  actor: { id: string; roles: string[]; attributes?: Record<string, unknown> };
  tenantId: string;
  rolesById: Map<string, Role>;
  config?: AdminConfig;
}): AdminManifest {
  const config = input.config ?? {};
  const canAccess = (permission: string): boolean => {
    const [resource, action] = splitPermission(permission);
    return can(
      {
        actor: {
          id: input.actor.id,
          roles: input.actor.roles,
          attributes: input.actor.attributes ?? {},
        },
        action,
        resource,
      },
      input.rolesById,
    );
  };

  const filterModule = (module: AdminModule): AdminModule | null => {
    const sections = module.sections.filter(
      (section) => !section.permission || canAccess(section.permission),
    );
    return sections.length > 0 ? { ...module, sections } : null;
  };

  const modules = [...(config.extraModules ?? []), ...DEFAULT_MODULES]
    .map(filterModule)
    .filter((m): m is AdminModule => m !== null);

  const collections = (config.collections ?? DEFAULT_COLLECTIONS).filter((collection) =>
    canAccess(collection.permissions.read),
  );

  return {
    generatedAt: new Date().toISOString(),
    actor: { id: input.actor.id, roles: input.actor.roles },
    tenantId: input.tenantId,
    modules,
    collections,
    actions: [...(config.actions ?? ["publish", "revoke-key", "resend-invite", "export"])],
    widgets: [...(config.widgets ?? ["activity", "tenants", "system-health"])],
  };
}

function splitPermission(permission: string): [string, string] {
  const dot = permission.lastIndexOf(".");
  if (dot === -1) return [permission, ""];
  return [permission.slice(0, dot), permission.slice(dot + 1)];
}
