/**
 * Test-isolation helper for the skill store.
 *
 * Every test that persists skills creates its own unique temporary directory
 * (OS temp facilities) and passes it to createApp({ storeRoot }). Tests never
 * touch the production `.data/skills` store: no writes, and cleanup removes
 * only the temp root that the test itself created.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Create a unique temporary store root and return it with a cleanup function.
 * Cleanup removes ONLY this test's temp directory (never any production
 * path), and is safe to call more than once.
 */
export async function makeIsolatedStoreRoot(): Promise<{ storeRoot: string; cleanup: () => Promise<void> }> {
  const storeRoot = await mkdtemp(join(tmpdir(), "skillforge-test-store-"));
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await rm(storeRoot, { recursive: true, force: true }).catch(() => {});
  };
  return { storeRoot, cleanup };
}
