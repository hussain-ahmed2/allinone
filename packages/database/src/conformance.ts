/**
 * Adapter conformance contract — every database adapter must pass these
 * assertions. Document unsupported capabilities as explicit exceptions;
 * never claim support before this passes.
 *
 * Framework-free (no test-runner import) so production code may import it
 * without pulling in a test framework.
 */
import { assertCapability, type DatabaseAdapter } from "./database.js";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`[allinone/database] Conformance failed: ${message}`);
}

function assertThrows(fn: () => void, message: string): void {
  try {
    fn();
  } catch {
    return;
  }
  throw new Error(`[allinone/database] Conformance failed (expected throw): ${message}`);
}

async function assertRejects(promise: Promise<unknown>, message: string): Promise<void> {
  try {
    await promise;
  } catch {
    return;
  }
  throw new Error(`[allinone/database] Conformance failed (expected rejection): ${message}`);
}

/** Basic CRUD + tenant isolation contract. */
export async function runAdapterConformance(adapter: DatabaseAdapter): Promise<void> {
  await adapter.connect();
  try {
    await adapter.createTable?.("conformance_items");
    // Insert + find round-trip.
    const [inserted] = await adapter.insert("conformance_items", [{ name: "alpha", score: 1 }]);
    assert(inserted?.["id"] !== undefined, "insert must assign an id");

    const found = await adapter.find("conformance_items", {
      filters: [{ field: "name", operator: "eq", value: "alpha" }],
    });
    assert(found.length >= 1, "find must return the inserted row");

    // Update round-trip.
    const id = inserted?.["id"] as string;
    const updated = await adapter.update("conformance_items", id, {
      score: 2,
    });
    assert(updated?.["score"] === 2, "update must persist the patch");

    // Tenant isolation — cross-tenant find returns zero rows.
    const scoped = await adapter.find(
      "conformance_items",
      { tenantId: "tenant_other" },
      { tenantId: "tenant_other" },
    );
    assert(
      scoped.every((r) => r["tenantId"] === "tenant_other"),
      "tenant isolation violated",
    );

    // Remove.
    const removed = await adapter.remove("conformance_items", id);
    assert(removed, "remove must delete the row");

    // Unsupported capabilities must throw loudly, never silently simulate.
    if (!adapter.capabilities.transactions) {
      await assertRejects(
        adapter.transaction(() => Promise.resolve(undefined)),
        "transactions unsupported must reject",
      );
      assertThrows(() => {
        assertCapability(adapter, "transactions");
      }, "assertCapability(transactions) must throw");
    }
  } finally {
    await adapter.disconnect();
  }
}
