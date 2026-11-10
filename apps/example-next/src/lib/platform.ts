/**
 * Server-only platform singleton for the Next.js App Router.
 *
 * One instance per server process: `createPlatform()` at module scope,
 * `initialize()` once (idempotent), `shutdown()` on process exit.
 * Client components never import this module.
 *
 * `import "server-only"` is intentionally omitted: the marker package
 * throws when imported outside a React Server Component boundary (e.g.
 * Vitest), which would break unit tests of these helpers. In a real
 * app, add the marker to the module that touches the platform if you
 * want the extra bundler-time guard.
 */
import { createPlatform, presets } from "allinone";
import { can, generateToken } from "@allinone/auth";
import { buildAdminManifest } from "@allinone/infra";
import type { Role } from "@allinone/auth";

export const ROLES = new Map<string, Role>([
  ["admin", { id: "admin", name: "Admin", permissions: ["users.*", "posts.*", "cms.posts.*"] }],
  ["editor", { id: "editor", name: "Editor", permissions: ["posts.read", "posts.create"] }],
  ["viewer", { id: "viewer", name: "Viewer", permissions: ["posts.read"] }],
]);

const platform = createPlatform({
  preset: presets.saas(),
  database: { adapter: "memory" },
  auth: { mfa: true },
  authorization: { mode: "rbac-abac", defaultDeny: true },
  cms: { enabled: true },
});

let initialized = false;

export async function getPlatform() {
  if (!initialized) {
    await platform.initialize();
    initialized = true;
  }
  return platform;
}

export interface SessionRow {
  userId: string;
  tenantId: string;
  csrf: string;
  memberships: string[];
  roles: string[];
}

const sessions = new Map<string, SessionRow>();

export function issueSession(row: SessionRow): string {
  const id = generateToken();
  sessions.set(id, row);
  return id;
}

export function readSession(sessionId: string | undefined): SessionRow | null {
  if (!sessionId) return null;
  return sessions.get(sessionId) ?? null;
}

export function revokeSession(sessionId: string): boolean {
  return sessions.delete(sessionId);
}

export function createCsrfToken(): string {
  return generateToken();
}

export function canPerform(
  actor: { id: string; roles: string[] },
  action: string,
  resource: string,
): boolean {
  return can({ actor: { ...actor, attributes: {} }, action, resource }, ROLES);
}

export function adminManifest(actor: { id: string; roles: string[] }, tenantId: string) {
  return buildAdminManifest({
    actor: { ...actor, attributes: {} },
    tenantId,
    rolesById: ROLES,
  });
}
