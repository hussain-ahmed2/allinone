/**
 * Client-safe constants (no platform imports — this file may be bundled
 * for the browser). Type-only imports are erased at compile time.
 */
import type { Role } from "@allinone/auth";

export const ROLES = new Map<string, Role>([
  ["admin", { id: "admin", name: "Admin", permissions: ["users.*", "posts.*", "cms.posts.*"] }],
  ["editor", { id: "editor", name: "Editor", permissions: ["posts.read", "posts.create"] }],
  ["viewer", { id: "viewer", name: "Viewer", permissions: ["posts.read"] }],
]);
