/**
 * Deterministic regression tests for F-01 (same-skill state consistency).
 * Uses barrier / deferred hooks rather than arbitrary sleep() races to prove:
 *
 * 1. Two concurrent edits to different files on the same skill are both preserved.
 * 2. A validation operation cannot compute against V1 and later attach that report to V2.
 * 3. Same-file concurrent edits have a deterministic serialized outcome based on lock acquisition order.
 * 4. A failed locked operation does not poison the queue or block subsequent same-skill operations.
 * 5. Independent skill IDs execute concurrently without blocking each other.
 * 6. Provenance removal, manifest hashes/byte counts, atomic persistence, and export revalidation remain intact.
 */
import { describe, it, expect } from "vitest";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import request from "supertest";
import { createStore, type StoreTestHooks, type StoredSkill } from "../src/server/store.js";
import { createApp } from "../src/server/app.js";
import { validatePackage } from "../src/core/validate.js";
import { manifestFor } from "../src/core/build.js";
import { normalizeSource } from "../src/core/ingest.js";
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

function skillInstructions(id: string, description = "demo"): string {
  return `---
name: ${id}
description: ${description}
---

# Reference editing guide

## When to use this skill
Use this guide when updating the reference documents.

## Inputs required
Read the current reference files and the requested changes.

## Workflow
Apply the requested changes to the relevant reference file, then inspect the saved contents.

## Constraints
Preserve unrelated reference content while editing.

## Verification
Confirm the saved files contain the requested changes and validation passes.

## Common pitfalls
Do not mistake an earlier validation report for the state of a later edit.

## References
Consult [Reference A](references/a.md) and [Reference B](references/b.md).
`;
}

function sampleSkill(id: string): {
  id: string;
  skill: StoredSkill["skill"];
  analysis: StoredSkill["analysisSummary"];
  source: StoredSkill["source"];
  validation: StoredSkill["validation"];
  createdAt: string;
} {
  const file1 = { path: "SKILL.md", content: skillInstructions(id), purpose: "main" };
  const file2 = { path: "references/a.md", content: "# Ref A\n\nInitial content A", purpose: "reference" };
  const file3 = { path: "references/b.md", content: "# Ref B\n\nInitial content B", purpose: "reference" };
  const allFiles = [file1, file2, file3];
  const meta: StoredSkill["skill"]["meta"] = { name: id, displayName: id, description: "demo", version: "0.1.0", generator: "mock", generatedAt: new Date().toISOString(), gaps: [] };
  const source: StoredSkill["source"] = {
    name: "demo-source", type: "text",
    text: "# Source\n\nReference A describes the first editable document.\nReference B describes the second editable document.\nVerify saved changes before exporting.\n",
  };
  const normalized = normalizeSource({ type: source.type, name: source.name, content: source.text });
  const manifestFile = { path: "manifest.json", content: manifestFor(allFiles, meta, {
    name: source.name, sha256: normalized.sha256, lineCount: normalized.lineCount, notes: [],
  }), purpose: "manifest" };

  return {
    id,
    skill: {
      schemaVersion: "1",
      id,
      meta,
      plan: { whenToUse: [], inputs: [], steps: [], constraints: [], verification: [], pitfalls: [] },
      files: [...allFiles, manifestFile],
      provenance: [
        { filePath: "references/a.md", extraction: "rule", sourceLines: [1, 2] },
        { filePath: "references/b.md", extraction: "rule", sourceLines: [3, 4] },
      ],
    },
    analysis: { title: id, sectionCount: 1, procedureCount: 1, commandCount: 1, codeBlockCount: 0, lineCount: 10 },
    source,
    validation: { passed: true, executed: true, errorCount: 0, warningCount: 0, checks: [], validatorVersion: "1.0.0" },
    createdAt: new Date().toISOString(),
  };
}

describe("F-01 same-skill state consistency", () => {
  it("starts with a canonical-valid fixture and consistent manifest", () => {
    const fixture = sampleSkill("fixture-contract");
    const source = normalizeSource({ type: fixture.source.type, name: fixture.source.name, content: fixture.source.text });
    const report = validatePackage({ skill: fixture.skill, sourceText: source.text });
    expect(report.executed).toBe(true);
    expect(report.checks.filter((check) => check.status === "fail")).toEqual([]);
    expect(report.passed).toBe(true);
  });
  it("1. two concurrent edits to different files on the same skill are both preserved", async () => {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    try {
      const barrierA = createDeferred<void>();
      const gateA = createDeferred<void>();
      let hookTriggered = false;

      const testHooks: StoreTestHooks = {
        afterLoad: async (id, op) => {
          if (id === "diff-files" && op === "updateFileContent" && !hookTriggered) {
            hookTriggered = true;
            barrierA.resolve();
            await gateA.promise;
          }
        },
      };

      const store = createStore(storeRoot, testHooks);
      await store.saveSkill(sampleSkill("diff-files"));

      const defaultValidator = (s: StoredSkill["skill"], src: string, st: StoredSkill["source"]["type"]) =>
        validatePackage({ skill: s, sourceText: src, sourceType: st });

      // Start Operation A (edits references/a.md)
      const opAPromise = store.updateFileContent(
        "diff-files",
        "references/a.md",
        "# Ref A Edited\n\nUpdated by Operation A",
        defaultValidator,
      );

      // Wait until Operation A has entered the critical section and loaded state
      await barrierA.promise;

      // Start Operation B (edits references/b.md) while Operation A is still inside the consistency boundary
      const opBPromise = store.updateFileContent(
        "diff-files",
        "references/b.md",
        "# Ref B Edited\n\nUpdated by Operation B",
        defaultValidator,
      );

      // Release Operation A to finish its persist and unlock
      gateA.resolve();

      const [resA, resB] = await Promise.all([opAPromise, opBPromise]);

      // Both edits completed successfully
      expect(resA.skill.files.find((f) => f.path === "references/a.md")?.content).toBe("# Ref A Edited\n\nUpdated by Operation A");
      expect(resB.skill.files.find((f) => f.path === "references/b.md")?.content).toBe("# Ref B Edited\n\nUpdated by Operation B");

      // Verify the final persisted state from disk
      const finalSkill = await store.getSkill("diff-files");
      expect(finalSkill).toBeDefined();
      const fileA = finalSkill!.skill.files.find((f) => f.path === "references/a.md");
      const fileB = finalSkill!.skill.files.find((f) => f.path === "references/b.md");

      // Both edits are present in the final state
      expect(fileA?.content).toBe("# Ref A Edited\n\nUpdated by Operation A");
      expect(fileA?.userEdited).toBe(true);
      expect(fileB?.content).toBe("# Ref B Edited\n\nUpdated by Operation B");
      expect(fileB?.userEdited).toBe(true);

      // Provenance entries for both edited files were dropped
      expect(finalSkill!.skill.provenance.find((p) => p.filePath === "references/a.md")).toBeUndefined();
      expect(finalSkill!.skill.provenance.find((p) => p.filePath === "references/b.md")).toBeUndefined();

      // Manifest hashes and bytes match both edited files
      const manifestFile = finalSkill!.skill.files.find((f) => f.path === "manifest.json");
      const manifest = JSON.parse(manifestFile!.content);
      const entryA = manifest.files.find((f: { path: string }) => f.path === "references/a.md");
      const entryB = manifest.files.find((f: { path: string }) => f.path === "references/b.md");
      expect(entryA.sha256).toBe(sha256(fileA!.content));
      expect(entryA.bytes).toBe(Buffer.byteLength(fileA!.content, "utf8"));
      expect(entryB.sha256).toBe(sha256(fileB!.content));
      expect(entryB.bytes).toBe(Buffer.byteLength(fileB!.content, "utf8"));

      // Validation executed and passed for the final state
      expect(finalSkill!.validation.passed).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("2. validation operation cannot compute against V1 and later attach that report to V2", async () => {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    try {
      const barrierVal = createDeferred<void>();
      const gateVal = createDeferred<void>();
      let hookTriggered = false;

      const testHooks: StoreTestHooks = {
        afterLoad: async (id, op) => {
          if (id === "stale-val" && op === "revalidateSkill" && !hookTriggered) {
            hookTriggered = true;
            barrierVal.resolve();
            await gateVal.promise;
          }
        },
      };

      const store = createStore(storeRoot, testHooks);

      // Base skill has an invalid SKILL.md (no front matter -> fails validation)
      const base = sampleSkill("stale-val");
      const brokenContent = "Missing front matter entirely.\n\n# Body without YAML";
      base.skill.files.find((f) => f.path === "SKILL.md")!.content = brokenContent;
      base.validation = { passed: false, executed: true, errorCount: 2, warningCount: 0, checks: [], validatorVersion: "1.0.0" };
      await store.saveSkill(base);

      const defaultValidator = (s: StoredSkill["skill"], src: string, st: StoredSkill["source"]["type"]) =>
        validatePackage({ skill: s, sourceText: src, sourceType: st });

      // Operation A: starts revalidateSkill against V1 (invalid)
      const valPromise = store.revalidateSkill("stale-val", defaultValidator);

      // Wait until Operation A has loaded V1 inside the lock
      await barrierVal.promise;

      // While Operation A holds the lock, Operation B is initiated to repair SKILL.md to V2 (valid)
      const repairedContent = skillInstructions("stale-val", "repaired");
      const editPromise = store.updateFileContent(
        "stale-val",
        "SKILL.md",
        repairedContent,
        defaultValidator,
      );

      // Release Operation A to finish its V1 validation and unlock
      gateVal.resolve();

      const [valReport, editSkill] = await Promise.all([valPromise, editPromise]);

      // Operation A computed against V1, so its returned report reflects V1 (failed)
      expect(valReport.passed).toBe(false);
      expect(valReport.checks).toContainEqual(expect.objectContaining({ id: "frontmatter-parse", status: "fail" }));

      // Operation B then executed against V1, applied the repair, validated V2, and persisted V2
      expect(editSkill.validation.passed).toBe(true);

      // Check final state on disk: MUST BE V2 with V2's validation report (passed: true), NEVER V2 with V1's failure
      const finalStored = await store.getSkill("stale-val");
      expect(finalStored).toBeDefined();
      expect(finalStored!.skill.files.find((f) => f.path === "SKILL.md")?.content).toBe(repairedContent);
      expect(finalStored!.validation.passed).toBe(true);
      expect(finalStored!.validation.errorCount).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it("3. same-file concurrent edits have a deterministic serialized outcome based on lock acquisition order", async () => {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    try {
      const barrierFirst = createDeferred<void>();
      const gateFirst = createDeferred<void>();
      let hookTriggered = false;

      const testHooks: StoreTestHooks = {
        afterLoad: async (id, op) => {
          if (id === "same-file" && op === "updateFileContent" && !hookTriggered) {
            hookTriggered = true;
            barrierFirst.resolve();
            await gateFirst.promise;
          }
        },
      };

      const store = createStore(storeRoot, testHooks);
      await store.saveSkill(sampleSkill("same-file"));

      const defaultValidator = (s: StoredSkill["skill"], src: string, st: StoredSkill["source"]["type"]) =>
        validatePackage({ skill: s, sourceText: src, sourceType: st });

      // First operation acquires lock
      const op1Promise = store.updateFileContent(
        "same-file",
        "references/a.md",
        "# Content A - From Op 1",
        defaultValidator,
      );

      await barrierFirst.promise;

      // Second operation attempts to edit same file, queues behind first operation
      const op2Promise = store.updateFileContent(
        "same-file",
        "references/a.md",
        "# Content A - From Op 2 (Last Acquired Wins)",
        defaultValidator,
      );

      // Release first operation
      gateFirst.resolve();

      const [res1, res2] = await Promise.all([op1Promise, op2Promise]);

      expect(res1.skill.files.find((f) => f.path === "references/a.md")?.content).toBe("# Content A - From Op 1");
      expect(res2.skill.files.find((f) => f.path === "references/a.md")?.content).toBe(
        "# Content A - From Op 2 (Last Acquired Wins)",
      );

      // Persisted state matches the last acquired operation
      const finalSkill = await store.getSkill("same-file");
      expect(finalSkill!.skill.files.find((f) => f.path === "references/a.md")?.content).toBe(
        "# Content A - From Op 2 (Last Acquired Wins)",
      );
      expect(finalSkill!.validation.passed).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("4. a failed locked operation does not poison the queue or block subsequent same-skill operations", async () => {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    try {
      const store = createStore(storeRoot);
      await store.saveSkill(sampleSkill("err-recovery"));

      const defaultValidator = (s: StoredSkill["skill"], src: string, st: StoredSkill["source"]["type"]) =>
        validatePackage({ skill: s, sourceText: src, sourceType: st });

      // Operation 1: fails with EditError (file not found)
      await expect(
        store.updateFileContent("err-recovery", "references/nonexistent.md", "bad", defaultValidator),
      ).rejects.toThrow("No file \"references/nonexistent.md\" in skill \"err-recovery\"");

      // Operation 2 on same skill must succeed immediately without deadlock or queue poisoning
      const op2 = await store.updateFileContent(
        "err-recovery",
        "references/a.md",
        "# Updated After Failure",
        defaultValidator,
      );

      expect(op2.skill.files.find((f) => f.path === "references/a.md")?.content).toBe("# Updated After Failure");
      const diskSkill = await store.getSkill("err-recovery");
      expect(diskSkill!.skill.files.find((f) => f.path === "references/a.md")?.content).toBe("# Updated After Failure");
    } finally {
      await cleanup();
    }
  });

  it("5. independent skill IDs execute concurrently without blocking each other", async () => {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    try {
      const barrier1 = createDeferred<void>();
      const gate1 = createDeferred<void>();

      const testHooks: StoreTestHooks = {
        afterLoad: async (id) => {
          if (id === "skill-one") {
            barrier1.resolve();
            await gate1.promise;
          }
        },
      };

      const store = createStore(storeRoot, testHooks);
      await store.saveSkill(sampleSkill("skill-one"));
      await store.saveSkill(sampleSkill("skill-two"));

      const defaultValidator = (s: StoredSkill["skill"], src: string, st: StoredSkill["source"]["type"]) =>
        validatePackage({ skill: s, sourceText: src, sourceType: st });

      // Operation on skill-one pauses inside the lock
      const op1Promise = store.updateFileContent(
        "skill-one",
        "references/a.md",
        "# Content for Skill One",
        defaultValidator,
      );

      await barrier1.promise;

      // Operation on skill-two should complete independently while skill-one is paused
      const op2 = await store.updateFileContent(
        "skill-two",
        "references/a.md",
        "# Content for Skill Two",
        defaultValidator,
      );
      expect(op2.skill.files.find((f) => f.path === "references/a.md")?.content).toBe("# Content for Skill Two");

      // Now release skill-one
      gate1.resolve();
      const op1 = await op1Promise;
      expect(op1.skill.files.find((f) => f.path === "references/a.md")?.content).toBe("# Content for Skill One");
    } finally {
      await cleanup();
    }
  });

  it("6. HTTP route parity: /validate and /update-file preserve atomic persistence, provenance, and export gates", async () => {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    try {
      const app = createApp({ provider: "mock", hasApiKey: false }, { storeRoot });

      // Generate a skill via API
      const genRes = await request(app)
        .post("/api/generate")
        .send({ sourceType: "sample", sampleId: "meridian-payments-api", requestedName: "http-parity" })
        .expect(200);
      const result = eventsOf(genRes.text).find((e: { type: string }) => e.type === "result");
      expect(result.validation.passed).toBe(true);

      // Verify revalidate route updates validation atomically
      const valRes = await request(app).post("/api/skills/http-parity/validate").expect(200);
      expect(valRes.body.validation.passed).toBe(true);

      // Edit a file
      const editRes = await request(app)
        .post("/api/skills/http-parity/update-file")
        .send({ path: "references/test-cards.md", content: "# User Custom Cards\n\nCard 4242..." })
        .expect(200);
      expect(editRes.body.validation.passed).toBe(true);
      expect(editRes.body.skill.provenance.some((p: { filePath: string }) => p.filePath === "references/test-cards.md")).toBe(false);

      // No stray tmp files left in skill directory
      const files = await readdir(join(storeRoot, "http-parity"));
      expect(files.some((f) => f.endsWith(".tmp"))).toBe(false);
      expect(files).toContain("skill.json");

      // Export performs fresh revalidation
      const exportRes = await request(app)
        .post("/api/skills/http-parity/export")
        .send({ target: "generic" })
        .expect(200);
      expect(exportRes.headers["content-type"]).toBe("application/zip");
    } finally {
      await cleanup();
    }
  });
});
