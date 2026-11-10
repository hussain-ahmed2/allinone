/**
 * Start entry — TanStack Start's application entry point.
 *
 * `createStart` wires the server runtime (RPC handler, middleware, env).
 * The platform singleton lives in `src/lib/platform.ts` and is only
 * reachable from server functions.
 */
import { createStart } from "@tanstack/react-start";

export const createStartFn = createStart(() => ({
  // Middleware / context can be registered here (e.g. request id, session).
}));
