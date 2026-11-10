/**
 * Server entry — TanStack Start's request handler.
 *
 * `createStartHandler` wires the router's SSR + the server-function RPC
 * endpoint. The platform singleton lives in `src/lib/platform.ts` and is
 * only reachable from server functions (never bundled to the browser).
 */
import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";

export default createStartHandler(defaultStreamHandler);
