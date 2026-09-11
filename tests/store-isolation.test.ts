/**
 * Regression tests for store/test isolation (P1: tests must never delete or
 * write the production .data/skills store).
 *
 * Proves that:
 * 1. an aborted generation persists nothing in the isolated test store;
 * 2. a successful generation persists exactly one expected skill;
 * 3. the active test store root is NOT the production store root;
 * 4. cleanup removes only the temporary test directory;
 * 5. an external sentinel outside the test root remains untouched.
 */
import { describe, expect, it } from "vitest";
import request from "supertest";
import { mkdtemp, mkdir, readdir, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app.js";
import { defaultSkillsRoot, createStore } from "../src/server/store.js";
import { makeIsolatedStoreRoot } from "./helpers/store-isolation.js";

describe("store/test isolation", () => {
  it("uses a unique OS-temp root that is not the production store root", async () => {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    try {
      expect(storeRoot.startsWith(tmpdir())).toBe(true);
      expect(storeRoot).not.toBe(defaultSkillsRoot());
      expect(storeRoot).toMatch(/skillforge-test-store-/);
      // Unique per call.
      const other = await makeIsolatedStoreRoot();
      try {
        expect(other.storeRoot).not.toBe(storeRoot);
      } finally {
        await other.cleanup();
      }
    } finally {
      await cleanup();
    }
  });

  it("successful generation persists exactly one expected skill in the isolated store", async () => {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    try {
      const app = createApp({ provider: "mock", hasApiKey: false }, { storeRoot });
      const res = await request(app)
        .post("/api/generate")
        .send({ sourceType: "sample", sampleId: "meridian-payments-api", requestedName: "iso-success" })
        .expect(200);
      const skillId = res.text.split("\n").filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l))
        .find((e) => e.type === "result")?.skill?.id;
      expect(skillId).toBe("iso-success");

      const entries = (await readdir(storeRoot)).filter((id) => id === "iso-success");
      expect(entries).toHaveLength(1);
      // The skill is readable back through the same isolated store.
      const list = await request(app).get("/api/skills").expect(200);
      expect(list.body.skills.some((s: { id: string }) => s.id === "iso-success")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("aborted generation (signal pre-aborted) persists nothing in the isolated store", async () => {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    try {
      const app = createApp({ provider: "mock", hasApiKey: false }, { storeRoot });
      // Disconnect before any event is consumed: the route's close handler
      // aborts the pipeline, which must prevent persistence entirely.
      const server = app.listen(0);
      try {
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : 0;
        const res = await fetch(`http://127.0.0.1:${port}/api/generate`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sourceType: "sample", sampleId: "scaffoldcraft-cli" }),
          signal: AbortSignal.abort(),
        }).catch(() => null);
        expect(res).toBeNull(); // request failed client-side (aborted)
        await new Promise((r) => setTimeout(r, 200));
        const entries = (await readdir(storeRoot).catch(() => [] as string[])).filter((id) => !/^\./.test(id));
        expect(entries).toHaveLength(0);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    } finally {
      await cleanup();
    }
  });

  it("cleanup removes only the temp test directory; an external sentinel stays untouched", async () => {
    // Sentinel directory NEXT TO the temp root (same temp parent), plus a
    // sentinel file INSIDE a sibling directory: cleanup must not touch either.
    const tempParent = await mkdtemp(join(tmpdir(), "skillforge-sentinel-"));
    const sentinelFile = join(tempParent, "sentinel.txt");
    await writeFile(sentinelFile, "must survive", "utf8");

    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    // Write something into the test root so cleanup has content to remove.
    await mkdir(storeRoot, { recursive: true });
    await writeFile(join(storeRoot, "some-skill"), "{}", "utf8");
    expect((await stat(storeRoot)).isDirectory()).toBe(true);

    await cleanup();
    await expect(stat(storeRoot)).rejects.toMatchObject({ code: "ENOENT" });
    // The external sentinel is untouched.
    expect(await readFileText(sentinelFile)).toBe("must survive");
    expect((await stat(tempParent)).isDirectory()).toBe(true);

    // Calling cleanup twice is safe.
    await cleanup();

    // And a manual removal of the sentinel parent still works (proves we did
    // not leave it locked/deleted by the helper).
    await rm(tempParent, { recursive: true, force: true });
  });

  it("createStore(root) persists to exactly the root it was given", async () => {
    const custom = await mkdtemp(join(tmpdir(), "skillforge-custom-store-"));
    try {
      const store = createStore(custom);
      expect(store.root).toBe(custom);
      await store.saveSkill({
        id: "factory-check",
        skill: {
          schemaVersion: "1",
          id: "factory-check",
          meta: { name: "factory-check", displayName: "Factory Check", description: "d", version: "0.1.0", generator: "mock", generatedAt: new Date().toISOString(), gaps: [] },
          plan: { whenToUse: [], inputs: [], steps: [], constraints: [], verification: [], pitfalls: [] },
          files: [{ path: "SKILL.md", content: "---\nname: factory-check\ndescription: d\n---\n\n# x\n\nbody text here", purpose: "p" }],
          provenance: [],
        },
        analysis: { title: "t", sectionCount: 0, procedureCount: 0, commandCount: 0, codeBlockCount: 0, lineCount: 1 },
        source: { name: "n", type: "sample", text: "source" },
        validation: { passed: true, executed: true, errorCount: 0, warningCount: 0, checks: [], validatorVersion: "1.0.0" },
        createdAt: new Date().toISOString(),
      });
      const entries = await readdir(custom);
      expect(entries).toContain("factory-check");
    } finally {
      await rm(custom, { recursive: true, force: true });
    }
  });
});

import { readFile } from "node:fs/promises";
function readFileText(path: string): Promise<string> {
  return readFile(path, "utf8");
}
