/**
 * File-backed skill store.
 *
 * Generated skills persist under <data-root>/skills/<id>/ as canonical JSON
 * (skill + validation + source), so a server restart keeps the user's
 * generated packages. Bounded: newest MAX_STORED entries are kept, oldest
 * evicted. Writes are atomic (tmp file + rename). IDs are validated before
 * touching the filesystem (they are generated slugs, but never trust input).
 *
 * The store root is injectable (createStore(root)) so tests run against
 * isolated temporary directories and can never touch production data; the
 * module-level exports delegate to the default store for normal use.
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CanonicalSkill, SourceAnalysis, ValidationReport, SourceType, RepositoryAnalysis } from "../core/types.js";
import { normalizeSource } from "../core/ingest.js";
import { manifestFor, manifestRepositoryBlock, qualifyEditedFileContent } from "../core/build.js";

export const MAX_STORED = 50;

/** Default persistence root: `<cwd>/.data/skills`, relocatable via
 * SKILLFORGE_DATA_ROOT (that variable names the `.data` parent directory). */
export function defaultSkillsRoot(): string {
  const base = process.env.SKILLFORGE_DATA_ROOT?.trim() || join(process.cwd(), ".data");
  return join(base, "skills");
}

const StoredSkillSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,80}$/),
  createdAt: z.string(),
  skill: CanonicalSkill,
  analysisSummary: z.object({
    title: z.string(),
    sectionCount: z.number(),
    procedureCount: z.number(),
    commandCount: z.number(),
    codeBlockCount: z.number(),
    lineCount: z.number(),
  }),
  source: z.object({
    name: z.string(),
    type: SourceType,
    text: z.string(),
    /** Adapter ingestion notes (truncation, skipped files, redirects).
     * Optional for backwards compatibility with previously stored skills. */
    notes: z.array(z.string()).optional(),
    /** Structured repository analysis for github-codebase sources.
     * Optional for backwards compatibility with previously stored skills. */
    repository: RepositoryAnalysis.optional(),
  }),
  validation: ValidationReport,
});
export type StoredSkill = z.infer<typeof StoredSkillSchema>;

const STORE_VERSION = 1;

/**
 * Per-key async serialization lock.
 * Ensures operations on the same key execute strictly in lock-acquisition order.
 * Operations on different keys run concurrently.
 * Unhandled/rejected operations do not block subsequent operations.
 * Idle entries are cleaned up to prevent an unbounded map.
 */
export class AsyncKeyLock {
  private chains = new Map<string, Promise<void>>();

  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chained = prev.then(
      () => gate,
      () => gate,
    );
    this.chains.set(key, chained);

    try {
      await prev;
    } catch {
      // Ignore failures of prior operations; this operation gets its turn.
    }

    try {
      return await fn();
    } finally {
      release();
      if (this.chains.get(key) === chained) {
        this.chains.delete(key);
      }
    }
  }
}

export class SkillIdConflictError extends Error {
  readonly code = "skill_id_conflict";
  constructor(message: string = "A skill with this id already exists. Choose a different skill name before generating again.") {
    super(message);
    this.name = "SkillIdConflictError";
  }
}

export class SourceRenormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceRenormalizationError";
  }
}

export interface StoreTestHooks {
  afterLoad?: (id: string, op: "updateFileContent" | "revalidateSkill") => Promise<void> | void;
  beforePersist?: (id: string, op: "updateFileContent" | "revalidateSkill") => Promise<void> | void;
  beforeRename?: (id: string, tmpPath: string) => Promise<void> | void;
}

export interface SkillStore {
  /** Absolute path of this store's skills directory. */
  readonly root: string;
  saveSkill(entry: {
    id: string;
    skill: StoredSkill["skill"];
    analysis: StoredSkill["analysisSummary"];
    source: StoredSkill["source"];
    validation: ValidationReport;
    createdAt: string;
  }): Promise<void>;
  getSkill(id: string): Promise<StoredSkill | undefined>;
  listSkills(): Promise<
    { id: string; name: string; description: string; generator: string; createdAt: string; validationPassed: boolean; fileCount: number }[]
  >;
  revalidateSkill(
    id: string,
    revalidate: (
      skill: StoredSkill["skill"],
      sourceText: string,
      sourceType: SourceType,
    ) => ValidationReport,
  ): Promise<ValidationReport>;
  updateFileContent(
    id: string,
    path: string,
    content: string,
    revalidate: (
      skill: StoredSkill["skill"],
      sourceText: string,
      sourceType: SourceType,
    ) => ValidationReport,
  ): Promise<StoredSkill>;
  readonly _testHooks?: StoreTestHooks;
}

async function writeAtomicSkillRecord(
  dir: string,
  payload: object,
  id: string,
  testHooks?: StoreTestHooks,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `skill.json.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
    if (testHooks?.beforeRename) {
      await testHooks.beforeRename(id, tmp);
    }
    await rename(tmp, join(dir, "skill.json"));
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

export function createStore(
  root: string = defaultSkillsRoot(),
  testHooks?: StoreTestHooks,
): SkillStore {
  const lock = new AsyncKeyLock();
  const capacityLock = new AsyncKeyLock();

  function skillDir(id: string): string {
    // Defense in depth: id must be a plain slug — no slashes, dots, or escapes.
    if (!/^[a-z0-9-]{1,80}$/.test(id)) {
      throw new Error(`Refusing to use unsafe skill id "${id}" in the store.`);
    }
    return join(root, basename(id));
  }

  async function saveSkill(entry: {
    id: string;
    skill: StoredSkill["skill"];
    analysis: StoredSkill["analysisSummary"];
    source: StoredSkill["source"];
    validation: ValidationReport;
    createdAt: string;
  }): Promise<void> {
    await mkdir(root, { recursive: true });
    return capacityLock.withLock("save", async () => {
      return lock.withLock(entry.id, async () => {
        const existing = await getSkill(entry.id);
        if (existing) {
          throw new SkillIdConflictError(
            `A skill with this id already exists. Choose a different skill name before generating again.`,
          );
        }

        // Evict oldest when over capacity.
        const ids = await listIds();
        while (ids.length >= MAX_STORED) {
          const oldest = ids[ids.length - 1]!; // listIds returns newest-first
          if (oldest === entry.id) break;
          // Acquire victim's per-id lock before deleting it to avoid racing active mutations
          await lock.withLock(oldest, async () => {
            await rm(skillDir(oldest), { recursive: true, force: true });
          });
          ids.pop();
        }

        const { analysis, ...rest } = entry;
        const payload = { storeVersion: STORE_VERSION, ...rest, analysisSummary: analysis };
        const dir = skillDir(entry.id);
        await writeAtomicSkillRecord(dir, payload, entry.id, testHooks);
      });
    });
  }

  async function getSkill(id: string): Promise<StoredSkill | undefined> {
    try {
      const raw = await readFile(join(skillDir(id), "skill.json"), "utf8");
      const parsed = StoredSkillSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  async function listIds(): Promise<string[]> {
    try {
      const entries = await readdir(root);
      const withTime = await Promise.all(
        entries.map(async (id) => {
          if (!/^[a-z0-9-]{1,80}$/.test(id)) return null;
          const meta = await getSkillMeta(id);
          return meta ? { id, createdAt: meta.createdAt } : null;
        }),
      );
      return withTime
        .filter((x): x is { id: string; createdAt: string } => x !== null)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((x) => x.id);
    } catch {
      return [];
    }
  }

  async function getSkillMeta(id: string): Promise<{ createdAt: string } | null> {
    try {
      const raw = await readFile(join(skillDir(id), "skill.json"), "utf8");
      const data = JSON.parse(raw) as { createdAt?: string };
      return typeof data.createdAt === "string" ? { createdAt: data.createdAt } : null;
    } catch {
      return null;
    }
  }

  async function listSkills(): Promise<
    { id: string; name: string; description: string; generator: string; createdAt: string; validationPassed: boolean; fileCount: number }[]
  > {
    const ids = await listIds();
    const out = await Promise.all(
      ids.map(async (id) => {
        const s = await getSkill(id);
        if (!s) return null;
        return {
          id: s.id,
          name: s.skill.meta.displayName,
          description: s.skill.meta.description,
          generator: s.skill.meta.generator,
          createdAt: s.createdAt,
          validationPassed: s.validation.passed,
          fileCount: s.skill.files.length,
        };
      }),
    );
    return out.filter((x): x is NonNullable<typeof x> => x !== null);
  }

  async function revalidateSkill(
    id: string,
    revalidate: (
      skill: StoredSkill["skill"],
      sourceText: string,
      sourceType: SourceType,
    ) => ValidationReport,
  ): Promise<ValidationReport> {
    return lock.withLock(id, async () => {
      const existing = await getSkill(id);
      if (!existing) {
        throw new EditError(`No skill with id "${id}".`, "skill_not_found");
      }
      if (testHooks?.afterLoad) {
        await testHooks.afterLoad(id, "revalidateSkill");
      }
      let normalized;
      try {
        normalized = normalizeStoredSource(existing.source);
      } catch (err) {
        throw new SourceRenormalizationError(
          `The stored source could not be re-normalized: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const report = revalidate(
        existing.skill,
        normalized.text,
        existing.source.type,
      );
      existing.validation = report;
      if (testHooks?.beforePersist) {
        await testHooks.beforePersist(id, "revalidateSkill");
      }
      const dir = skillDir(id);
      await writeAtomicSkillRecord(dir, { storeVersion: STORE_VERSION, ...existing }, id, testHooks);
      return report;
    });
  }

  async function updateFileContent(
    id: string,
    path: string,
    content: string,
    revalidate: (
      skill: StoredSkill["skill"],
      sourceText: string,
      sourceType: SourceType,
    ) => ValidationReport,
  ): Promise<StoredSkill> {
    return lock.withLock(id, async () => {
      const existing = await getSkill(id);
      if (!existing) throw new EditError(`No skill with id "${id}".`, "skill_not_found");
      if (!isEditablePath(path)) {
        throw new EditError(
          `"${path}" is regenerated from the package inventory and cannot be edited directly.`,
          "file_not_editable",
        );
      }
      const file = existing.skill.files.find((f) => f.path === path);
      if (!file) {
        throw new EditError(`No file "${path}" in skill "${id}". Only existing files can be edited.`, "file_not_found");
      }
      if (Buffer.byteLength(content, "utf8") > MAX_EDIT_BYTES) {
        throw new EditError(
          `Edit is ${Buffer.byteLength(content, "utf8")} bytes; the per-file limit is ${MAX_EDIT_BYTES}.`,
          "edit_too_large",
        );
      }

      if (testHooks?.afterLoad) {
        await testHooks.afterLoad(id, "updateFileContent");
      }

      file.content = qualifyEditedFileContent(path, content, existing.source.name);
      file.userEdited = true;
      if (!file.purpose.startsWith("User-edited file; originally:")) {
        file.purpose = `User-edited file; originally: ${file.purpose}`;
      }
      existing.skill.provenance = existing.skill.provenance.filter((p) => p.filePath !== path);

      // Regenerate manifest.json from the new inventory (bytes + hashes resync).
      // Codebase provenance must survive edits: the compact manifest repository
      // block is rebuilt from the PERSISTED repository analysis (P1-4).
      let normalizedSource;
      try {
        normalizedSource = normalizeStoredSource(existing.source);
      } catch (err) {
        throw new SourceRenormalizationError(
          `The stored source could not be re-normalized: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const manifestFile = existing.skill.files.find((f) => f.path === "manifest.json");
      if (manifestFile) {
        manifestFile.content = manifestFor(
          existing.skill.files.filter((f) => f.path !== "manifest.json"),
          existing.skill.meta,
          {
            name: existing.source.name,
            sha256: normalizedSource.sha256,
            lineCount: normalizedSource.lineCount,
            notes: normalizedSource.notes,
            ...(existing.source.repository
              ? { repository: manifestRepositoryBlock(existing.source.repository) }
              : {}),
          },
        );
      }

      // Validation reflects the edited content before anything is served; the
      // source type rides along so codebase packages cannot lose their
      // repository provenance silently.
      existing.validation = revalidate(
        existing.skill,
        normalizedSource.text,
        existing.source.type,
      );

      if (testHooks?.beforePersist) {
        await testHooks.beforePersist(id, "updateFileContent");
      }

      const dir = skillDir(id);
      await writeAtomicSkillRecord(dir, { storeVersion: STORE_VERSION, ...existing }, id, testHooks);
      return existing;
    });
  }

  return {
    root,
    saveSkill,
    getSkill,
    listSkills,
    revalidateSkill,
    updateFileContent,
    _testHooks: testHooks,
  };
}

let defaultStoreSingleton: SkillStore | undefined;

/** The default store used by production call sites. Created lazily on first
 * use so SKILLFORGE_DATA_ROOT — which may come from .env loaded by the entry
 * point — is honored regardless of module import order. */
export function getDefaultStore(): SkillStore {
  defaultStoreSingleton ??= createStore();
  return defaultStoreSingleton;
}

/** Bound methods of the default store, resolving lazily (same reason as
 * getDefaultStore — SKILLFORGE_DATA_ROOT may be set by the entry point). */
export const getSkill: SkillStore["getSkill"] = (id) => getDefaultStore().getSkill(id);

/** Upper bound for a single user edit (per-file, matches the source adapters). */
export const MAX_EDIT_BYTES = 1_000_000;

/** Files the user may not edit directly. manifest.json is regenerated from
 * the package inventory on every edit — hand-editing it would be discarded. */
export function isEditablePath(path: string): boolean {
  return path !== "manifest.json";
}

export class EditError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "EditError";
  }
}

/** Re-normalize stored source using the canonical ingestion normalizer.
 * Preserves source type, adapter notes, and repository provenance. */
export function normalizeStoredSource(source: StoredSkill["source"]) {
  return normalizeSource({
    type: source.type,
    name: source.name,
    content: source.text,
    notes: source.notes ?? [],
    repository: source.repository,
  });
}

/** Map a StoredSkill back to the shape the HTTP layer returns. */
export function toResponse(s: StoredSkill) {
  return {
    id: s.id,
    skill: s.skill,
    analysis: s.analysisSummary,
    source: s.source,
    validation: s.validation,
    createdAt: s.createdAt,
  };
}

export type { SourceAnalysis };
