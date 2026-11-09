/**
 * @allinone/testing — shared test helpers.
 */
import { createMemoryAdapter } from "@allinone/database";

/** Fresh, isolated memory adapter per test (no cross-test leakage). */
export function testDatabase() {
  return createMemoryAdapter();
}

/** Assert a promise rejects with a message matching the pattern. */
export async function expectRejects(
  promise: Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!pattern.test(message)) {
      throw new Error(`Expected rejection matching ${String(pattern)}, got: ${message}`);
    }
    return;
  }
  throw new Error(`Expected rejection matching ${String(pattern)}, but promise resolved`);
}
