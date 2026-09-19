/**
 * Deterministic mock provider — the bundled demo path.
 *
 * No network, no API key, fully deterministic: the same source always yields
 * the same plan. The plan is derived purely from structural analysis of the
 * source (headings, procedures, commands, warnings), so generated skills stay
 * grounded.
 */
import type { GenerationProvider, GenerateInput } from "./types.js";
import type { ProviderProposal } from "../plan-catalog.js";
import { catalogFromPlan } from "../plan-catalog.js";
import { derivePlanFromAnalysis } from "../build.js";
import { deriveCodebasePlan } from "../codebase/plan.js";
import { slugify } from "../util.js";

export class MockProvider implements GenerationProvider {
  readonly id = "mock";
  readonly offline = true;

  async generate(input: GenerateInput): Promise<ProviderProposal> {
    const { analysis, requestedName, repository } = input;
    // Same contract as remote providers: return selections over the
    // deterministic grounded catalog — no privileged bypass. The mock
    // deterministically selects every catalog atom in order, so resolution
    // reproduces the trusted deterministic plan exactly.
    const catalog =
      input.catalog ??
      catalogFromPlan(
        repository
          ? deriveCodebasePlan(repository, requestedName)
          : derivePlanFromAnalysis(analysis),
      );
    const selections = {
      whenToUse: catalog.bySection.whenToUse.map((a) => a.id),
      inputs: catalog.bySection.inputs.map((a) => a.id),
      steps: catalog.bySection.steps.map((a) => a.id),
      constraints: catalog.bySection.constraints.map((a) => a.id),
      verification: catalog.bySection.verification.map((a) => a.id),
      pitfalls: catalog.bySection.pitfalls.map((a) => a.id),
    };
    if (repository) {
      return {
        name: slugify(requestedName?.trim() || `${repository.repository.owner}-${repository.repository.name}`, 48),
        displayName: `${repository.repository.owner}/${repository.repository.name} — coding agent guide`.slice(0, 120),
        selections,
      };
    }
    return {
      name: slugify(requestedName?.trim() || analysis.title, 48),
      displayName: analysis.title.slice(0, 120),
      selections,
    };
  }
}
