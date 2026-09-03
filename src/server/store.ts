/**
 * File-backed skill store.
 *
 * Generated skills persist under .data/skills/<id>/ as canonical JSON
 * (skill + validation + source), so a server restart keeps the user's
 * generated packages. Bounded: newest MAX_STORED entries are kept, oldest
 * evicted. Writes are atomic (tmp file + rename). IDs are validated before
 * touching the filesystem (they are generated slugs, but never trust input).
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { z } from "zod";
import { CanonicalSkill, SourceAnalysis, ValidationReport, SourceType } from "../core/types.js";

export const MAX_STORED = 50;
const ROOT = join(process.cwd(), ".data", "skills");

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
  }),
  validation: ValidationReport,
});
export type StoredSkill = z.infer<typeof StoredSkillSchema>;

const STORE_VERSION = 1;

function skillDir(id: string): string {
  // Defense in depth: id must be a plain slug — no slashes, dots, or escapes.
  if (!/^[a-z0-9-]{1,80}$/.test(id)) {
    throw new Error(`Refusing to use unsafe skill id "${id}" in the store.`);
  }
  return join(ROOT, basename(id));
}

export async function saveSkill(entry: {
  id: string;
  skill: StoredSkill["skill"];
  analysis: StoredSkill["analysisSummary"];
  source: StoredSkill["source"];
  validation: ValidationReport;
  createdAt: string;
}): Promise<void> {
  await mkdir(ROOT, { recursive: true });
  const { analysis, ...rest } = entry;
  const payload = { storeVersion: STORE_VERSION, ...rest, analysisSummary: analysis };
  // Evict oldest when over capacity.
  const ids = await listIds();
  while (ids.length >= MAX_STORED) {
    const oldest = ids[ids.length - 1]!; // listIds returns newest-first
    if (oldest === entry.id) break;
    await rm(skillDir(oldest), { recursive: true, force: true });
    ids.pop();
  }
  const dir = skillDir(entry.id);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, "skill.json.tmp");
  await writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
  await rename(tmp, join(dir, "skill.json"));
}

export async function getSkill(id: string): Promise<StoredSkill | undefined> {
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
    const entries = await readdir(ROOT);
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

export async function listSkills(): Promise<
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

export async function updateValidation(id: string, validation: ValidationReport): Promise<void> {
  const existing = await getSkill(id);
  if (!existing) return;
  existing.validation = validation;
  const tmp = join(skillDir(id), "skill.json.tmp");
  await writeFile(tmp, JSON.stringify({ storeVersion: STORE_VERSION, ...existing }, null, 2), "utf8");
  await rename(tmp, join(skillDir(id), "skill.json"));
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
