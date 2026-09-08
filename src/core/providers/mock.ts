/**
 * Deterministic mock provider — the bundled demo path.
 *
 * No network, no API key, fully deterministic: the same source always yields
 * the same plan. The plan is derived purely from structural analysis of the
 * source (headings, procedures, commands, warnings), so generated skills stay
 * grounded.
 */
import type { GenerationProvider, GenerateInput } from "./types.js";
import type { SkillPlan } from "../plan.js";
import { derivePlanFromAnalysis } from "../build.js";
import { deriveCodebasePlan } from "../codebase/plan.js";
import { slugify } from "../util.js";

export class MockProvider implements GenerationProvider {
  readonly id = "mock";
  readonly offline = true;

  async generate(input: GenerateInput): Promise<SkillPlan> {
    const { analysis, source, requestedName, repository } = input;
    // Codebase mode: the repository analysis is the planning authority —
    // deterministic, evidence-grounded, oriented at coding agents.
    if (repository) {
      return deriveCodebasePlan(repository, requestedName);
    }
    const plan = derivePlanFromAnalysis(analysis);
    const description =
      plan.whenToUse.length > 0 && analysis.intro.length > 0
        ? firstSentence(analysis.intro, 500)
        : `Working knowledge for ${analysis.title}, extracted deterministically by SkillForge from "${source.originalName}".`;
    return {
      ...plan,
      name: slugify(requestedName?.trim() || analysis.title, 48),
      displayName: analysis.title.slice(0, 120),
      description: description.slice(0, 1024),
    };
  }
}

function firstSentence(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const m = flat.split(/(?<=[.!?])\s+/);
  const s = m[0] ?? flat;
  return s.length > maxChars ? s.slice(0, maxChars - 1).trimEnd() + "…" : s;
}
