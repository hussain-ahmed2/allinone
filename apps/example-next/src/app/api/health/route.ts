import { NextResponse } from "next/server";
import { getPlatform } from "@/lib/platform";

/**
 * Health endpoint (public) — the Next.js equivalent of the Express
 * `/health` route. Verifies the datastore is reachable.
 */
export async function GET(): Promise<NextResponse> {
  const platform = await getPlatform();
  const database = await platform.database.healthCheck();
  return NextResponse.json({ ok: database.ok, database, service: "example-next" });
}
