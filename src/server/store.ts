/**
 * In-memory skill store. The MVP keeps generated skills for the lifetime of
 * the process (bounded); persistence is deliberately out of scope. Documented
 * as a limitation in README/ARCHITECTURE.
 */
import type { CanonicalSkill, SourceAnalysis, SourceInput, ValidationReport } from "../core/types.js";

export interface StoredSkill {
  id: string;
  skill: CanonicalSkill;
  analysis: SourceAnalysis;
  validation: ValidationReport;
  sourceInput: SourceInput;
  sourceText: string;
  createdAt: string;
}

const MAX_STORED = 50;
const store = new Map<string, StoredSkill>();

export function saveSkill(entry: StoredSkill): void {
  // Evict the oldest entries when over capacity.
  while (store.size >= MAX_STORED) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
  store.set(entry.id, entry);
}

export function getSkill(id: string): StoredSkill | undefined {
  return store.get(id);
}

export function listSkills(): { id: string; name: string; description: string; generator: string; createdAt: string; validationPassed: boolean; fileCount: number }[] {
  return [...store.values()]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((s) => ({
      id: s.id,
      name: s.skill.meta.displayName,
      description: s.skill.meta.description,
      generator: s.skill.meta.generator,
      createdAt: s.createdAt,
      validationPassed: s.validation.passed,
      fileCount: s.skill.files.length,
    }));
}

export function updateValidation(id: string, validation: ValidationReport): void {
  const existing = store.get(id);
  if (existing) existing.validation = validation;
}
