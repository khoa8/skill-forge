import type { EvalItem, NormalizedSource, SourceAnalysis } from "./types.js";
import { slugify } from "./util.js";

export function allocateReferences(analysis: SourceAnalysis) {
  const sections = analysis.sections.some((s) => s.level === 2 && s.endLine > s.startLine)
    ? analysis.sections.filter((s) => s.level === 2) : analysis.sections.filter((s) => s.level === 1);
  const used = new Set<string>();
  return sections.slice(0, 12).flatMap((section) => {
    const body = section.text.split("\n").slice(1).join("\n").trim();
    if (body.length < 20) return [];
    const path = allocatePath(`references/${section.id}`, used);
    return [{ section, body, path }];
  });
}

function allocatePath(base: string, used: Set<string>): string {
  let path = `${base}.md`;
  let n = 2;
  while (used.has(path)) path = `${base}-${n++}.md`;
  used.add(path);
  return path;
}

export function allocateWorkflows(analysis: SourceAnalysis) {
  const used = new Set<string>();
  return analysis.procedures.slice(0, 8).map((proc) => ({ proc, path: allocatePath(`workflows/${slugify(proc.title)}`, used) }));
}

export function neutralizeRelativeLinks(markdown: string): string {
  return markdown.replace(/\[([^\]]*)\]\(([^)\n]+)\)/g, (match, label: string, target: string) => {
    const t = target.trim();
    if (/^[a-z]+:/i.test(t) || t.startsWith("#") || t.startsWith("/")) return match;
    return `${label.replace(/\s+/g, " ")} \`${t}\``.trim();
  });
}

export function deriveEvalItems(source: NormalizedSource, analysis: SourceAnalysis): EvalItem[] {
  const items: EvalItem[] = [];
  for (const { section, path } of allocateReferences(analysis).slice(0, 6)) {
    items.push({
      id: `eval-${items.length + 1}`,
      kind: "grounding",
      prompt: `Does the skill retain and expose the source topic "${section.heading}"?`,
      expect: `${path} retains the source excerpt and is discoverable from SKILL.md (source lines ${section.startLine}–${section.endLine}).`,
      assertions: [{ type: "topic-retention", filePath: path, sourceSha256: source.sha256, sourceLines: [section.startLine, section.endLine] }],
    });
  }
  if (source.sourceType !== "github-codebase") {
    for (const { proc, path } of allocateWorkflows(analysis).slice(0, 4)) {
      items.push({
        id: `eval-${items.length + 1}`,
        kind: "procedure",
        prompt: `Does the skill retain the ordered "${proc.title}" procedure?`,
        expect: `${path} retains all ${proc.steps.length} source steps in order and is discoverable from SKILL.md; text comparison only, not execution.`,
        assertions: [{ type: "procedure-fidelity", filePath: path, sourceSha256: source.sha256, sourceLines: [proc.line, proc.steps[proc.steps.length - 1]!.line] }],
      });
    }
    if (analysis.commands.length > 0) {
      items.push({
        id: `eval-${items.length + 1}`,
        kind: "grounding",
        prompt: "Do any commands in the skill appear in the source?",
        expect: `Commands must be traceable to the source (detected ${analysis.commands.length} command lines).`,
      });
    }
  }
  return items;
}
