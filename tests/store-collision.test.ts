/**
 * Regression tests for F-01, T-02, and I-01:
 * - Same-id mutation & collision policy (F-01)
 * - Atomic write centralization & failure cleanup (I-01, T-02)
 * - Eviction serialization with concurrent edits (F-01, T-02)
 */
import { describe, it, expect } from "vitest";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import request from "supertest";
import {
  createStore,
  SkillIdConflictError,
  MAX_STORED,
  type StoreTestHooks,
  type StoredSkill,
} from "../src/server/store.js";
import { createApp } from "../src/server/app.js";
import { validatePackage } from "../src/core/validate.js";
import { sha256 } from "../src/core/util.js";
import { makeIsolatedStoreRoot } from "./helpers/store-isolation.js";

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function eventsOf(text: string) {
  return text
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
}

function sampleSkill(id: string, customText = "Initial content A"): {
  id: string;
  skill: StoredSkill["skill"];
  analysis: StoredSkill["analysisSummary"];
  source: StoredSkill["source"];
  validation: StoredSkill["validation"];
  createdAt: string;
} {
  const file1 = { path: "SKILL.md", content: "---\nname: " + id + "\ndescription: demo\n---\n\n# Guide\n\nContent", purpose: "main" };
  const file2 = { path: "references/a.md", content: `# Ref A\n\n${customText}`, purpose: "reference" };
  const allFiles = [file1, file2];
  const manifest = {
    schemaVersion: "1",
    generator: "mock",
    generatedAt: new Date().toISOString(),
    files: allFiles.map((f) => ({ path: f.path, bytes: Buffer.byteLength(f.content, "utf8"), sha256: sha256(f.content) })),
    source: { name: "demo-source", sha256: sha256("source text with sufficient length for testing"), lineCount: 10, notes: [] },
  };
  const manifestFile = { path: "manifest.json", content: JSON.stringify(manifest, null, 2), purpose: "manifest" };

  return {
    id,
    skill: {
      schemaVersion: "1",
      id,
      meta: { name: id, displayName: id, description: "demo", version: "0.1.0", generator: "mock", generatedAt: new Date().toISOString(), gaps: [] },
      plan: { whenToUse: [], inputs: [], steps: [], constraints: [], verification: [], pitfalls: [] },
      files: [...allFiles, manifestFile],
      provenance: [
        { filePath: "references/a.md", extraction: "rule", sourceLines: [1, 2] },
      ],
    },
    analysis: { title: id, sectionCount: 1, procedureCount: 1, commandCount: 1, codeBlockCount: 0, lineCount: 10 },
    source: { name: "demo-source", type: "text", text: "# Source\n\nA valid source document with enough text to normalize properly." },
    validation: { passed: true, executed: true, errorCount: 0, warningCount: 0, checks: [], validatorVersion: "1.0.0" },
    createdAt: new Date().toISOString(),
  };
}

describe("F-01 / T-02 / I-01: Persistence consistency and collision policy", () => {
  it("F01-A: save versus edit race reports typed collision and preserves acknowledged edit", async () => {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    try {
      const barrier = createDeferred<void>();
      const gate = createDeferred<void>();
      let hookCalled = false;

      const testHooks: StoreTestHooks = {
        afterLoad: async (id, op) => {
          if (id === "race-edit" && op === "updateFileContent" && !hookCalled) {
            hookCalled = true;
            barrier.resolve();
            await gate.promise;
          }
        },
      };

      const store = createStore(storeRoot, testHooks);
      await store.saveSkill(sampleSkill("race-edit", "Original Text"));

      const defaultValidator = (s: StoredSkill["skill"], src: string, st: StoredSkill["source"]["type"]) =>
        validatePackage({ skill: s, sourceText: src, sourceType: st });

      // Begin edit (pauses inside lock after loading record)
      const editPromise = store.updateFileContent(
        "race-edit",
        "references/a.md",
        "# Ref A\n\nUpdated by Edit",
        defaultValidator,
      );

      await barrier.promise;

      // Attempt generation save for same id
      const savePromise = store.saveSkill(sampleSkill("race-edit", "Generated Replacement"));

      // Release edit
      gate.resolve();

      const [editResult, saveResult] = await Promise.allSettled([editPromise, savePromise]);

      expect(editResult.status).toBe("fulfilled");
      expect(saveResult.status).toBe("rejected");
      if (saveResult.status === "rejected") {
        expect(saveResult.reason).toBeInstanceOf(SkillIdConflictError);
        expect((saveResult.reason as SkillIdConflictError).code).toBe("skill_id_conflict");
      }

      // Stored state on disk contains the acknowledged edit
      const finalSkill = await store.getSkill("race-edit");
      expect(finalSkill).toBeDefined();
      expect(finalSkill!.skill.files.find((f) => f.path === "references/a.md")?.content).toBe("# Ref A\n\nUpdated by Edit");
      expect(finalSkill!.skill.files.find((f) => f.path === "references/a.md")?.userEdited).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("F01-B: save versus revalidate race reports typed collision and does not overwrite", async () => {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    try {
      const barrier = createDeferred<void>();
      const gate = createDeferred<void>();
      let hookCalled = false;

      const testHooks: StoreTestHooks = {
        afterLoad: async (id, op) => {
          if (id === "race-reval" && op === "revalidateSkill" && !hookCalled) {
            hookCalled = true;
            barrier.resolve();
            await gate.promise;
          }
        },
      };

      const store = createStore(storeRoot, testHooks);
      await store.saveSkill(sampleSkill("race-reval", "Reval Content"));

      const defaultValidator = (s: StoredSkill["skill"], src: string, st: StoredSkill["source"]["type"]) =>
        validatePackage({ skill: s, sourceText: src, sourceType: st });

      const revalPromise = store.revalidateSkill("race-reval", defaultValidator);
      await barrier.promise;

      const savePromise = store.saveSkill(sampleSkill("race-reval", "Overwrite Attempt"));
      gate.resolve();

      const [revalResult, saveResult] = await Promise.allSettled([revalPromise, savePromise]);

      expect(revalResult.status).toBe("fulfilled");
      expect(saveResult.status).toBe("rejected");
      if (saveResult.status === "rejected") {
        expect(saveResult.reason).toBeInstanceOf(SkillIdConflictError);
        expect((saveResult.reason as SkillIdConflictError).code).toBe("skill_id_conflict");
      }

      const finalSkill = await store.getSkill("race-reval");
      expect(finalSkill!.skill.files.find((f) => f.path === "references/a.md")?.content).toBe("# Ref A\n\nReval Content");
    } finally {
      await cleanup();
    }
  });

  it("F01-C: sequential collision raises typed conflict and keeps existing record unchanged", async () => {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    try {
      const store = createStore(storeRoot);
      const v1 = sampleSkill("seq-conflict", "V1 Content");
      await store.saveSkill(v1);

      const v2 = sampleSkill("seq-conflict", "V2 Content");
      await expect(store.saveSkill(v2)).rejects.toThrow(SkillIdConflictError);

      try {
        await store.saveSkill(v2);
        expect.unreachable("saveSkill should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(SkillIdConflictError);
        expect((err as SkillIdConflictError).code).toBe("skill_id_conflict");
      }

      const stored = await store.getSkill("seq-conflict");
      expect(stored!.skill.files.find((f) => f.path === "references/a.md")?.content).toBe("# Ref A\n\nV1 Content");
    } finally {
      await cleanup();
    }
  });

  it("F01-D: saves with different IDs both succeed concurrently", async () => {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    try {
      const store = createStore(storeRoot);
      const [r1, r2] = await Promise.all([
        store.saveSkill(sampleSkill("diff-one")),
        store.saveSkill(sampleSkill("diff-two")),
      ]);
      expect(r1).toBeUndefined();
      expect(r2).toBeUndefined();

      const s1 = await store.getSkill("diff-one");
      const s2 = await store.getSkill("diff-two");
      expect(s1).toBeDefined();
      expect(s2).toBeDefined();
    } finally {
      await cleanup();
    }
  });

  it("F01-E: API stream emits typed error and no result event on id collision", async () => {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    try {
      const store = createStore(storeRoot);
      await store.saveSkill(sampleSkill("existing-sample", "Pre-existing content"));

      const app = createApp({ provider: "mock", hasApiKey: false }, { storeRoot });

      const res = await request(app)
        .post("/api/generate")
        .send({
          sourceType: "sample",
          sampleId: "meridian-payments-api",
          requestedName: "existing-sample",
        })
        .expect(200);

      const events = eventsOf(res.text);
      const errorEvent = events.find((e) => e.type === "error");
      const resultEvent = events.find((e) => e.type === "result");

      expect(resultEvent).toBeUndefined();
      expect(errorEvent).toBeDefined();
      expect(errorEvent.code).toBe("skill_id_conflict");
      expect(errorEvent.message).toMatch(/A skill with this id already exists/);

      // Existing skill remains untouched
      const stored = await store.getSkill("existing-sample");
      expect(stored!.skill.files.find((f) => f.path === "references/a.md")?.content).toBe("# Ref A\n\nPre-existing content");
    } finally {
      await cleanup();
    }
  });

  it("T02-A: write/rename failure cleans up temp files, preserves valid record, and allows later ops", async () => {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    try {
      let shouldFail = false;
      const testHooks: StoreTestHooks = {
        beforeRename: async (_id, tmpPath) => {
          if (shouldFail) {
            throw new Error("Simulated disk I/O rename failure");
          }
        },
      };

      const store = createStore(storeRoot, testHooks);
      await store.saveSkill(sampleSkill("cleanup-test", "Initial Valid Content"));

      const dir = join(storeRoot, "cleanup-test");
      let filesBefore = await readdir(dir);
      expect(filesBefore).toContain("skill.json");
      expect(filesBefore.some((f) => f.endsWith(".tmp"))).toBe(false);

      // Now trigger failure
      shouldFail = true;
      const defaultValidator = (s: StoredSkill["skill"], src: string, st: StoredSkill["source"]["type"]) =>
        validatePackage({ skill: s, sourceText: src, sourceType: st });

      await expect(
        store.updateFileContent("cleanup-test", "references/a.md", "Failed Edit", defaultValidator),
      ).rejects.toThrow("Simulated disk I/O rename failure");

      // Verify no orphan .tmp remains
      const filesAfterFail = await readdir(dir);
      expect(filesAfterFail.some((f) => f.endsWith(".tmp"))).toBe(false);

      // Previous record remains intact and readable
      const existing = await store.getSkill("cleanup-test");
      expect(existing).toBeDefined();
      expect(existing!.skill.files.find((f) => f.path === "references/a.md")?.content).toBe("# Ref A\n\nInitial Valid Content");

      // Later operations succeed cleanly
      shouldFail = false;
      await store.updateFileContent("cleanup-test", "references/a.md", "# Ref A\n\nSuccess After Failure", defaultValidator);
      const filesAfterSuccess = await readdir(dir);
      expect(filesAfterSuccess.some((f) => f.endsWith(".tmp"))).toBe(false);
      const recovered = await store.getSkill("cleanup-test");
      expect(recovered!.skill.files.find((f) => f.path === "references/a.md")?.content).toBe("# Ref A\n\nSuccess After Failure");
    } finally {
      await cleanup();
    }
  });

  it("T02-B: persistence failure does not delete or corrupt unrelated retained entries", async () => {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    try {
      let failId: string | null = null;
      const testHooks: StoreTestHooks = {
        beforeRename: async (id) => {
          if (id === failId) {
            throw new Error(`Intentional write failure for ${id}`);
          }
        },
      };

      const store = createStore(storeRoot, testHooks);
      await store.saveSkill(sampleSkill("skill-alpha", "Alpha Content"));
      await store.saveSkill(sampleSkill("skill-beta", "Beta Content"));

      failId = "skill-gamma";
      await expect(store.saveSkill(sampleSkill("skill-gamma", "Gamma Content"))).rejects.toThrow("Intentional write failure");

      // Unrelated entries survive
      const alpha = await store.getSkill("skill-alpha");
      const beta = await store.getSkill("skill-beta");
      expect(alpha).toBeDefined();
      expect(beta).toBeDefined();
      expect(alpha!.skill.files.find((f) => f.path === "references/a.md")?.content).toBe("# Ref A\n\nAlpha Content");
      expect(beta!.skill.files.find((f) => f.path === "references/a.md")?.content).toBe("# Ref A\n\nBeta Content");
    } finally {
      await cleanup();
    }
  });

  it("T02-C: capacity saves evict oldest while serializing with concurrent mutation of victim", async () => {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    try {
      const barrierVictim = createDeferred<void>();
      const gateVictim = createDeferred<void>();
      let hookTriggered = false;

      const testHooks: StoreTestHooks = {
        afterLoad: async (id, op) => {
          if (id === "skill-00" && op === "updateFileContent" && !hookTriggered) {
            hookTriggered = true;
            barrierVictim.resolve();
            await gateVictim.promise;
          }
        },
      };

      const store = createStore(storeRoot, testHooks);

      // Populate store to capacity (MAX_STORED = 50)
      // skill-00 will be the oldest
      const baseTime = 1700000000000;
      for (let i = 0; i < MAX_STORED; i++) {
        const id = `skill-${String(i).padStart(2, "0")}`;
        const skill = sampleSkill(id);
        skill.createdAt = new Date(baseTime + i * 1000).toISOString();
        await store.saveSkill(skill);
      }

      const initialList = await store.listSkills();
      expect(initialList.length).toBe(MAX_STORED);

      const defaultValidator = (s: StoredSkill["skill"], src: string, st: StoredSkill["source"]["type"]) =>
        validatePackage({ skill: s, sourceText: src, sourceType: st });

      // Start an edit on the oldest skill ("skill-00") that pauses inside its per-id lock
      const editVictimPromise = store.updateFileContent(
        "skill-00",
        "references/a.md",
        "# Ref A\n\nVictim Edit in Flight",
        defaultValidator,
      );

      await barrierVictim.promise;

      // In parallel, issue a saveSkill that exceeds capacity and must evict the oldest
      const newSkill = sampleSkill("skill-new");
      newSkill.createdAt = new Date(baseTime + (MAX_STORED + 1) * 1000).toISOString();
      const savePromise = store.saveSkill(newSkill);

      // Release the victim edit so it completes before eviction acquires the lock
      gateVictim.resolve();

      await Promise.all([editVictimPromise, savePromise]);

      // Check capacity accounting
      const finalList = await store.listSkills();
      expect(finalList.length).toBe(MAX_STORED);
      expect(finalList.some((s) => s.id === "skill-new")).toBe(true);
      expect(finalList.some((s) => s.id === "skill-00")).toBe(false);

      // No stray tmp files
      const rootEntries = await readdir(storeRoot);
      for (const entry of rootEntries) {
        const files = await readdir(join(storeRoot, entry));
        expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
      }
    } finally {
      await cleanup();
    }
  });
});


describe("capacity transition failure safety", () => {
  it.each(["incoming", "eviction"] as const)("preserves every retained record on %s failure", async (phase) => {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    let failing = false;
    const store = createStore(storeRoot, {
      beforeRename: (id) => {
        if (failing && phase === "incoming" && id === "incoming") throw new Error("injected incoming failure");
      },
      beforeEvict: () => {
        if (failing && phase === "eviction") throw new Error("injected eviction failure");
      },
    });
    try {
      const originals = [];
      for (let i = 0; i < MAX_STORED; i++) {
        const entry = sampleSkill(`retained-${i}`);
        entry.createdAt = new Date(1700000000000 + i * 1000).toISOString();
        await store.saveSkill(entry);
        originals.push(await store.getSkill(entry.id));
      }
      failing = true;
      await expect(store.saveSkill(sampleSkill("incoming"))).rejects.toThrow(`injected ${phase} failure`);
      expect(await store.getSkill("incoming")).toBeUndefined();
      expect(await store.listSkills()).toHaveLength(MAX_STORED);
      for (const original of originals) expect(await store.getSkill(original!.id)).toEqual(original);
      for (const id of await readdir(storeRoot)) {
        expect(await readdir(join(storeRoot, id))).toEqual(["skill.json"]);
      }
      failing = false;
      await store.saveSkill(sampleSkill("incoming"));
      expect(await store.getSkill("incoming")).toBeDefined();
      expect(await store.getSkill("retained-0")).toBeUndefined();
      expect(await store.listSkills()).toHaveLength(MAX_STORED);
    } finally { await cleanup(); }
  });
});
