/**
 * Server-side platform singleton — never imported by client code.
 * The TanStack Start server-function transform strips handler bodies (and
 * therefore the dynamic import below) from the client bundle.
 */
import { createPlatform, presets } from "allinone";
import { can, generateToken, type Role } from "@allinone/auth";
import { buildAdminManifest } from "@allinone/infra";
import { ROLES } from "./roles.js";

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

export type { Role };
