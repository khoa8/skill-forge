import { describe, it, expect, vi } from "vitest";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import request from "supertest";
import { createStore, MAX_STORED, type SkillStore } from "../src/server/store.js";
import { createApp } from "../src/server/app.js";
import { runPipeline } from "../src/core/pipeline.js";
import { getSample } from "../src/core/samples.js";
import { makeIsolatedStoreRoot } from "./helpers/store-isolation.js";

// Gate the commit primitive itself, after dispatch, rather than a pre-check hook.
const commitIO = vi.hoisted(() => ({
  intercept: undefined as undefined | ((path: string, perform: () => Promise<void>) => Promise<void>),
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    rename: (from: string, to: string) => commitIO.intercept
      ? commitIO.intercept(from, () => fs.rename(from, to)) : fs.rename(from, to),
    unlink: (path: string) => commitIO.intercept
      ? commitIO.intercept(path, () => fs.unlink(path)) : fs.unlink(path),
  };
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

async function fixture(): Promise<Parameters<SkillStore["saveSkill"]>[0]> {
  const sample = getSample("meridian-payments-api");
  for await (const e of runPipeline({ type: "sample", name: sample.meta.title, content: sample.content }, { provider: "mock" })) {
    if (e.type === "result") return { id: "incoming", skill: e.skill, source: { name: sample.meta.title, type: "sample", text: sample.content }, analysis: { title: e.analysis.title, sectionCount: 1, procedureCount: 1, commandCount: 1, codeBlockCount: 1, lineCount: e.analysis.lineCount }, validation: e.validation, createdAt: "2026-01-01" };
  }
  throw new Error("No fixture result");
}
const stale = "skill.json.12345678-1234-4123-8123-123456789abc.tmp";

describe("persisted integrity", () => {
  it.each(["{secret", '{"createdAt":"2026"}'])("fails closed for damaged committed state %s", async (raw) => {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    try {
      const store = createStore(storeRoot);
      expect(await store.getSkill("incoming")).toBeUndefined();
      await mkdir(join(storeRoot, "incoming"));
      await writeFile(join(storeRoot, "incoming", "skill.json"), raw);
      for (const op of [() => store.getSkill("incoming"), () => store.listSkills(), async () => store.saveSkill(await fixture()), async () => store.saveSkill({ ...await fixture(), id: "other" })]) {
        await expect(op()).rejects.toMatchObject({ code: "store_record_corrupt" });
      }
      expect(await readFile(join(storeRoot, "incoming", "skill.json"), "utf8")).toBe(raw);
      const app = createApp({ provider: "mock", hasApiKey: false }, { storeRoot });
      for (const [method, path, body] of [
        ["get", "/api/skills", {}], ["get", "/api/skills/incoming", {}],
        ["get", "/api/skills/incoming/provenance/excerpt?start=1&end=2", {}],
        ["post", "/api/skills/incoming/validate", {}],
        ["post", "/api/skills/incoming/update-file", { path: "SKILL.md", content: "edited" }],
        ["post", "/api/skills/incoming/export", { target: "generic" }],
      ] as const) {
        const res = await request(app)[method](path).send(body).expect(500);
        expect(res.body).toEqual({ error: "Stored skill record is corrupted and cannot be used.", code: "store_record_corrupt" });
      }
      const generated = await request(app).post("/api/generate").send({ sourceType: "sample", sampleId: "meridian-payments-api", requestedName: "incoming" });
      expect(generated.text).toContain('"code":"store_record_corrupt"');
      expect(generated.text).not.toContain('"type":"result"');
    } finally { await cleanup(); }
  });

  it("wraps operational read failures safely", async () => {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    try {
      const store = createStore(storeRoot, { beforeRead: () => { throw Object.assign(new Error("/private/secret"), { code: "EIO" }); } });
      await expect(store.getSkill("incoming")).rejects.toMatchObject({ code: "store_read_failed", message: "Stored skill records could not be read." });
      const app = createApp({ provider: "mock", hasApiKey: false }, { storeRoot, loadSkill: store.getSkill });
      const res = await request(app).get("/api/skills/incoming").expect(500);
      expect(res.body.code).toBe("store_read_failed");
      expect(res.text).not.toContain("private");
    } finally { await cleanup(); }
  });

  it("recovers owned temps on mutation after restart and preserves unknown files and legacy records", async () => {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    try {
      const dir = join(storeRoot, "incoming");
      await mkdir(dir);
      await writeFile(join(dir, stale), "uncommitted");
      await writeFile(join(dir, "skill.json.unknown.tmp"), "unknown");
      const store = createStore(storeRoot);
      expect(await store.getSkill("incoming")).toBeUndefined();
      await store.saveSkill(await fixture());
      expect(await readdir(dir)).toEqual(expect.arrayContaining(["skill.json", "skill.json.unknown.tmp"]));
      expect(await readdir(dir)).not.toContain(stale);
      const payload = JSON.parse(await readFile(join(dir, "skill.json"), "utf8"));
      delete payload.storeVersion;
      await writeFile(join(dir, "skill.json"), JSON.stringify(payload));
      await writeFile(join(dir, stale), "interrupted edit");
      const restarted = createStore(storeRoot);
      expect(await restarted.getSkill("incoming")).toBeDefined();
      await restarted.revalidateSkill("incoming", () => payload.validation);
      expect(await readdir(dir)).not.toContain(stale);
      expect(await readFile(join(dir, "skill.json.unknown.tmp"), "utf8")).toBe("unknown");
    } finally { await cleanup(); }
  });
});

for (const atCapacity of [false, true]) {
  it.each([false, true])(`cancellation with capacity=${atCapacity}, afterCommit=%s`, async (afterCommit) => {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    const abort = new AbortController();
    const entry = await fixture();
    let active = false;
    const store = createStore(storeRoot, {
      beforeRename: async (_id, temp) => { if (active && !atCapacity && !afterCommit) { expect(await readFile(temp, "utf8")).toContain('"id"'); abort.abort(); } },
      beforeEvict: async () => { if (active && !afterCommit) { expect(await readFile(join(storeRoot, "incoming", "skill.json"), "utf8")).toContain('"id"'); abort.abort(); } },
      afterCommit: () => { if (active && afterCommit) abort.abort(); },
    });
    try {
      if (atCapacity) for (let i = 0; i < MAX_STORED; i++) await store.saveSkill({ ...entry, id: `retained-${i}`, createdAt: new Date(i * 1000).toISOString() });
      const original = await store.listSkills();
      active = true;
      const save = store.saveSkill(entry, { signal: abort.signal });
      if (afterCommit) await save;
      else await expect(save).rejects.toMatchObject({ name: "AbortError", code: "store_aborted" });
      const restarted = createStore(storeRoot);
      expect(Boolean(await restarted.getSkill("incoming"))).toBe(afterCommit);
      if (!afterCommit) expect(await restarted.listSkills()).toEqual(original);
      if (atCapacity) {
        expect(await restarted.listSkills()).toHaveLength(MAX_STORED);
        expect(Boolean(await restarted.getSkill("retained-0"))).toBe(!afterCommit);
      }
      for (const item of await restarted.listSkills()) expect(await restarted.getSkill(item.id)).toBeDefined();
      for (const id of await readdir(storeRoot)) expect((await readdir(join(storeRoot, id))).filter(f => f.endsWith(".tmp"))).toEqual([]);
    } finally { await cleanup(); }
  });
}

it("refuses an at-capacity save when a retained record is corrupt", async () => {
  const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
  try {
    const entry = await fixture();
    const store = createStore(storeRoot);
    for (let i = 0; i < MAX_STORED; i++) await store.saveSkill({ ...entry, id: `retained-${i}` });
    await writeFile(join(storeRoot, "retained-0", "skill.json"), "damaged");
    await expect(store.saveSkill(entry)).rejects.toMatchObject({ code: "store_record_corrupt" });
    expect(await readdir(storeRoot)).toHaveLength(MAX_STORED);
    expect(await readFile(join(storeRoot, "retained-0", "skill.json"), "utf8")).toBe("damaged");
    expect(await store.getSkill("incoming")).toBeUndefined();
  } finally { await cleanup(); }
});

it("reports safe write failures without a successful generation result", async () => {
  const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
  try {
    const store = createStore(storeRoot, { beforeRename: () => { throw new Error("/private/secret record content"); } });
    const app = createApp({ provider: "mock", hasApiKey: false }, { storeRoot, saveSkill: store.saveSkill });
    const res = await request(app).post("/api/generate").send({ sourceType: "sample", sampleId: "meridian-payments-api" });
    expect(res.text).toContain('"code":"store_write_failed"');
    expect(res.text).not.toContain('"type":"result"');
    expect(res.text).not.toContain("/private/secret");
    expect(await store.listSkills()).toEqual([]);
  } finally { await cleanup(); }
});

for (const atCapacity of [false, true]) {
  it.each(["before-mutation", "before-completion-observed"] as const)(
    `arbitrates in-flight commit cancellation at capacity=${atCapacity}: %s`, async (window) => {
      const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
      const entered = deferred();
      const release = deferred();
      const abort = new AbortController();
      const store = createStore(storeRoot);
      let pending: Promise<unknown> | undefined;
      try {
        const entry = await fixture();
        if (atCapacity) for (let i = 0; i < MAX_STORED; i++) {
          await store.saveSkill({ ...entry, id: `retained-${i}`, createdAt: new Date(i * 1000).toISOString() });
        }
        const original = await store.listSkills();
        const victimPath = join(storeRoot, "retained-0", "skill.json");
        const victimBytes = atCapacity ? await readFile(victimPath) : undefined;
        await mkdir(join(storeRoot, "incoming"), { recursive: true });
        await writeFile(join(storeRoot, "incoming", "unknown"), "keep me");
        let intercepted = false;
        commitIO.intercept = async (path, perform) => {
          const target = atCapacity ? path === victimPath : path.startsWith(join(storeRoot, "incoming", "skill.json."));
          if (!target || intercepted) return perform();
          intercepted = true;
          if (window === "before-completion-observed") await perform();
          entered.resolve();
          await release.promise;
          if (window === "before-mutation") await perform();
        };
        // Attach rejection handling before releasing the primitive.
        pending = store.saveSkill(entry, { signal: abort.signal }).then(
          () => ({ committed: true }), err => ({ error: err }),
        );
        await entered.promise;
        if (atCapacity) expect(await readFile(join(storeRoot, "incoming", "skill.json"), "utf8")).toContain('"id"');
        abort.abort();
        release.resolve();
        expect(await pending).toMatchObject({ error: { code: "store_aborted" } });
        const restarted = createStore(storeRoot);
        expect(await restarted.getSkill("incoming")).toBeUndefined();
        expect(await restarted.listSkills()).toEqual(original);
        if (atCapacity) expect(await readFile(victimPath)).toEqual(victimBytes);
        expect(await readFile(join(storeRoot, "incoming", "unknown"), "utf8")).toBe("keep me");
        for (const id of await readdir(storeRoot)) {
          expect((await readdir(join(storeRoot, id))).filter(name => name.endsWith(".tmp"))).toEqual([]);
        }
      } finally {
        release.resolve();
        await pending;
        commitIO.intercept = undefined;
        await cleanup();
      }
    },
  );
}

it.each(["removal-failed", "restoration-failed", "commit-first"] as const)(
  "handles capacity arbitration outcome: %s", async (outcome) => {
    const { storeRoot, cleanup } = await makeIsolatedStoreRoot();
    const entered = deferred();
    const release = deferred();
    const abort = new AbortController();
    let pending: Promise<unknown> | undefined;
    let active = false;
    const store = createStore(storeRoot, {
      afterCommit: () => { if (active && outcome === "commit-first") abort.abort(); },
    });
    try {
      const entry = await fixture();
      for (let i = 0; i < MAX_STORED; i++) {
        await store.saveSkill({ ...entry, id: `retained-${i}`, createdAt: new Date(i * 1000).toISOString() });
      }
      const victimDir = join(storeRoot, "retained-0");
      const victimPath = join(victimDir, "skill.json");
      const victimBytes = await readFile(victimPath);
      const original = await store.listSkills();
      active = true;
      commitIO.intercept = async (path, perform) => {
        if (path === victimPath) {
          entered.resolve();
          await release.promise;
          if (outcome === "removal-failed") throw new Error("injected removal failure");
        } else if (outcome === "restoration-failed" && path.startsWith(`${victimPath}.`)) {
          throw new Error("injected restoration failure");
        }
        await perform();
      };
      pending = store.saveSkill(entry, { signal: abort.signal }).then(
        () => ({ committed: true }), err => ({ error: err }),
      );
      await entered.promise;
      if (outcome !== "commit-first") abort.abort();
      release.resolve();
      const result = await pending;
      const restarted = createStore(storeRoot);
      expect(await restarted.listSkills()).toHaveLength(MAX_STORED);
      if (outcome === "removal-failed") {
        expect(result).toMatchObject({ error: { message: "injected removal failure" } });
        expect(await restarted.listSkills()).toEqual(original);
        expect(await readFile(victimPath)).toEqual(victimBytes);
      } else if (outcome === "restoration-failed") {
        expect(result).toMatchObject({ error: { message: "injected restoration failure" } });
        expect(await restarted.getSkill("incoming")).toBeDefined();
        expect(await restarted.getSkill("retained-0")).toBeUndefined();
        const staged = await readdir(victimDir);
        expect(staged).toHaveLength(1);
        expect(staged[0]).toMatch(/^skill\.json\..*\.tmp$/);
        expect(await readFile(join(victimDir, staged[0]!))).toEqual(victimBytes);
      } else {
        expect(result).toEqual({ committed: true });
        expect(abort.signal.aborted).toBe(true);
        expect(await restarted.getSkill("incoming")).toBeDefined();
        expect(await restarted.getSkill("retained-0")).toBeUndefined();
      }
    } finally {
      release.resolve();
      await pending;
      commitIO.intercept = undefined;
      await cleanup();
    }
  },
);
