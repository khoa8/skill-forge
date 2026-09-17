import type {
  CanonicalSkill,
  EvalAssertion,
  EvalItem,
  EvaluationCheck,
  EvaluationReport,
  NormalizedSource,
  Provenance,
  SkillFile,
} from "./types.js";
import { EvalItem as EvalItemSchema } from "./types.js";
import { allocateReferences, allocateWorkflows, deriveEvalItems } from "./evals.js";
import { analyzeSource } from "./analyze.js";
import { sha256 } from "./util.js";

export const EVALUATOR_VERSION = "1.0.0";

const MAX_SOURCE_BYTES = 1_500_000;
const MAX_SOURCE_LINES = 30_000;
const MAX_SOURCE_LINE_CHARS = 16_384;
const MAX_PACKAGE_FILES = 128;
const MAX_FILE_BYTES = 1_500_000;
const MAX_PACKAGE_BYTES = 8_000_000;
const MAX_PROVENANCE = 256;
const MAX_EVALS_JSON_BYTES = 128_000;
const MAX_EVAL_ITEMS = 64;
const MAX_TOPIC_EXCERPT_CHARS = 20_000;
const MAX_PROCEDURE_STEPS = 24;
const MAX_STEP_CHARS = 4_000;
const MAX_STEP_LENGTH_DELTA = 400;
const MAX_PROCEDURE_LINE_SPAN = 2_000;

const TOPIC_DISCOVERY_TOKENS = 3;

function normalizedLines(source: NormalizedSource): string[] | null {
  if (Buffer.byteLength(source.text, "utf8") > MAX_SOURCE_BYTES) return null;
  const lines = source.text.split("\n");
  if (lines.length > MAX_SOURCE_LINES) return null;
  if (lines.some((line) => line.length > MAX_SOURCE_LINE_CHARS)) return null;
  return lines;
}

function excerptForRange(lines: string[], start: number, end: number): string {
  const lo = Math.max(1, start);
  const hi = Math.min(lines.length, end);
  return lines.slice(lo - 1, hi).join("\n");
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function docTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3);
}

function evalsFile(skill: CanonicalSkill): SkillFile | null {
  return skill.files.find((file) => file.path === "evals/evals.json") ?? null;
}

function parseEvals(skill: CanonicalSkill): { items: unknown[] } | null {
  const file = evalsFile(skill);
  if (!file) return null;
  if (Buffer.byteLength(file.content, "utf8") > MAX_EVALS_JSON_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.content);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.schema !== "skillforge.evals/1") return null;
  if (!Array.isArray(record.items)) return null;
  return record as { items: unknown[] };
}

function provenanceFor(skill: CanonicalSkill, filePath: string): Provenance | null {
  const records = provenanceRecordsBounded(skill);
  const record = records.get(filePath);
  return records.size <= MAX_PROVENANCE && skill.provenance.filter((p) => p.filePath === filePath).length === 1
    ? (record ?? null)
    : null;
}

function provenanceRecordsBounded(skill: CanonicalSkill): Map<string, Provenance> {
  const bounded = skill.provenance.slice(0, MAX_PROVENANCE);
  return new Map(bounded.map((p) => [p.filePath, p]));
}

function isUserEdited(file: SkillFile): boolean {
  return file.userEdited === true;
}

function fileFor(skill: CanonicalSkill, path: string): SkillFile | null {
  const files = skill.files.slice(0, MAX_PACKAGE_FILES);
  const matches = files.filter((file) => file.path === path);
  if (matches.length !== 1) return null;
  return matches[0]!;
}

function targetBody(target: SkillFile): string {
  const split = target.content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  return split ? split[2]! : target.content;
}

function skillMdBody(skill: CanonicalSkill): string | null {
  const skillMd = fileFor(skill, "SKILL.md");
  return skillMd ? targetBody(skillMd) : null;
}

function topicMatchesExcerpt(sectionText: string, excerpt: string): boolean {
  const sectionTokens = new Set(docTokens(sectionText));
  if (sectionTokens.size === 0) return false;
  const excerptTokens = docTokens(excerpt);
  let hits = 0;
  for (const token of excerptTokens) {
    if (sectionTokens.has(token)) hits += 1;
  }
  return hits >= TOPIC_DISCOVERY_TOKENS;
}

function verifiedProvenance(
  skill: CanonicalSkill,
  filePath: string,
  source: NormalizedSource,
): Provenance | null {
  const record = provenanceFor(skill, filePath);
  if (!record) return null;
  if (record.sourceLines[0] < 1 || record.sourceLines[1] < record.sourceLines[0]) return null;
  if (record.sourceLines[1] > source.lineCount) return null;
  return record;
}

function evalItemsBounded(items: unknown[]): EvalItem[] {
  const out: EvalItem[] = [];
  for (const item of items.slice(0, MAX_EVAL_ITEMS)) {
    const result = EvalItemSchema.safeParse(item);
    if (!result.success) continue;
    out.push(result.data);
  }
  return out;
}

export function evaluateSkill(input: {
  skill: CanonicalSkill;
  source: NormalizedSource;
}): EvaluationReport {
  const checks: EvaluationCheck[] = [];
  const counts = { passed: 0, concern: 0, notExecutable: 0 };
  const record = (check: EvaluationCheck) => {
    checks.push(check);
    if (check.status === "pass") counts.passed += 1;
    else if (check.status === "concern") counts.concern += 1;
    else counts.notExecutable += 1;
  };

  const source = input.source;
  const sourceOk = normalizedLines(source) !== null && sha256(source.text) === source.sha256;
  const lines = sourceOk ? normalizedLines(source)! : null;
  const discovery = lines ? skillMdBody(input.skill) : null;
  const evals = parseEvals(input.skill);

  if (!lines) {
    record({
      id: "evaluator-bounds",
      title: "Source identity and bounds",
      status: "not-executable",
      message: "Source exceeds evaluation bounds or fails its own sha256 identity check; evaluation was skipped, not passed.",
    });
    return { evaluatorVersion: EVALUATOR_VERSION, executed: false, counts, checks };
  }
  if (!evals) {
    record({
      id: "evals-json",
      title: "Eval specification file",
      status: "not-executable",
      message: "evals/evals.json is missing, oversized, malformed, or has an unknown schema; no structured evaluation ran.",
    });
    return { evaluatorVersion: EVALUATOR_VERSION, executed: false, counts, checks };
  }
  if (!discovery) {
    record({
      id: "skill-md",
      title: "SKILL.md discoverability",
      status: "not-executable",
      message: "SKILL.md is missing or duplicated; topic retention and discoverability cannot be evaluated.",
    });
    return { evaluatorVersion: EVALUATOR_VERSION, executed: false, counts, checks };
  }

  const packageBytes = input.skill.files
    .slice(0, MAX_PACKAGE_FILES)
    .reduce((total, file) => total + Buffer.byteLength(file.content, "utf8"), 0);
  const filesBounded = input.skill.files.length <= MAX_PACKAGE_FILES
    && input.skill.files.every((file) => Buffer.byteLength(file.content, "utf8") <= MAX_FILE_BYTES);
  const provenanceBounded = input.skill.provenance.length <= MAX_PROVENANCE;
  if (!filesBounded || !provenanceBounded || packageBytes > MAX_PACKAGE_BYTES) {
    record({
      id: "package-bounds",
      title: "Package bounds",
      status: "not-executable",
      message: "Package exceeds evaluation bounds (files, size, or provenance count); evaluation was skipped, not passed.",
    });
    return { evaluatorVersion: EVALUATOR_VERSION, executed: false, counts, checks };
  }

  const analysis = analyzeSource(source);
  const expectedTopics = new Map(allocateReferences(analysis).map((entry) => [entry.path, entry]));
  const expectedProcedures = source.sourceType === "github-codebase"
    ? new Map<string, never>()
    : new Map(allocateWorkflows(analysis).map((entry) => [entry.path, entry]));

  const expectedItems = new Map(deriveEvalItems(source, analysis).map((item) => [item.id, item]));
  for (const item of evalItemsBounded(evals.items)) {
    const assertion = item.assertions?.[0];
    const expectedItem = expectedItems.get(item.id);
    if (assertion && (!expectedItem || item.prompt !== expectedItem.prompt
      || item.expect !== expectedItem.expect || item.kind !== expectedItem.kind)) {
      record({
        id: item.id,
        title: item.prompt,
        status: "not-executable",
        message: "Executable eval context differs from the source-derived specification; no pass is claimed for a changed question.",
      });
      continue;
    }
    if (!assertion) {
      record({
        id: item.id,
        title: item.prompt,
        status: "not-executable",
        message: "No structured assertion; this eval is a manual grounding question and the evaluator does not execute it.",
      });
      continue;
    }
    if (assertion.type === "topic-retention") {
      evaluateTopic({ skill: input.skill, source, lines, discovery, expectedTopics, item, assertion, record });
    } else {
      evaluateProcedure({ skill: input.skill, source, lines, expectedProcedures, item, assertion, record });
    }
  }

  return { evaluatorVersion: EVALUATOR_VERSION, executed: true, counts, checks };
}

type RecordCheck = (check: EvaluationCheck) => void;

interface EvaluationContext {
  skill: CanonicalSkill;
  source: NormalizedSource;
  lines: string[];
  discovery: string;
  expectedTopics: Map<string, { section: { startLine: number; endLine: number; text: string; heading: string }; body: string; path: string }>;
  item: EvalItem;
  assertion: EvalAssertion;
  record: RecordCheck;
}

interface ProcedureContext extends Omit<EvaluationContext, "discovery" | "expectedTopics"> {
  expectedProcedures: Map<string, { proc: { title: string; line: number; steps: { text: string; line: number }[] }; path: string }>;
}

function evidenceMismatch(ctx: EvaluationContext | ProcedureContext): string | null {
  if (ctx.assertion.sourceSha256 !== ctx.source.sha256) {
    return `Assertion cites source sha256 "${ctx.assertion.sourceSha256}" but the actual source is "${ctx.source.sha256}"; the eval does not describe this source.`;
  }
  const expected = ctx.assertion.type === "topic-retention"
    ? (ctx as EvaluationContext).expectedTopics.get(ctx.assertion.filePath)
    : (ctx as ProcedureContext).expectedProcedures.get(ctx.assertion.filePath);
  if (!expected) {
    return `Assertion cites "${ctx.assertion.filePath}", which the source allocation does not produce; the specification does not match this source.`;
  }
  const [start, end] = ctx.assertion.sourceLines;
  const expectedStart = ctx.assertion.type === "topic-retention"
    ? (ctx as EvaluationContext).expectedTopics.get(ctx.assertion.filePath)!.section.startLine
    : (ctx as ProcedureContext).expectedProcedures.get(ctx.assertion.filePath)!.proc.line;
  const expectedEnd = ctx.assertion.type === "topic-retention"
    ? (ctx as EvaluationContext).expectedTopics.get(ctx.assertion.filePath)!.section.endLine
    : (ctx as ProcedureContext).expectedProcedures.get(ctx.assertion.filePath)!.proc.steps[(ctx as ProcedureContext).expectedProcedures.get(ctx.assertion.filePath)!.proc.steps.length - 1]!.line;
  if (start !== expectedStart || end !== expectedEnd) {
    return `Assertion cites source lines ${start}–${end} but the source-derived allocation for "${ctx.assertion.filePath}" is ${expectedStart}–${expectedEnd}.`;
  }
  return null;
}

function evaluateTopic(ctx: EvaluationContext): void {
  const mismatch = evidenceMismatch(ctx);
  if (mismatch) {
    ctx.record({
      id: ctx.item.id,
      title: ctx.item.prompt,
      status: "not-executable",
      filePath: ctx.assertion.filePath,
      message: mismatch,
      sourceLines: ctx.assertion.sourceLines,
    });
    return;
  }
  const target = fileFor(ctx.skill, ctx.assertion.filePath);
  if (!target) {
    ctx.record({
      id: ctx.item.id,
      title: ctx.item.prompt,
      status: "concern",
      filePath: ctx.assertion.filePath,
      message: `Target file "${ctx.assertion.filePath}" is missing from the package; the source topic may no longer be retained.`,
      sourceLines: ctx.assertion.sourceLines,
    });
    return;
  }
  if (isUserEdited(target)) {
    ctx.record({
      id: ctx.item.id,
      title: ctx.item.prompt,
      status: "concern",
      filePath: target.path,
      message: `Target file "${target.path}" is user-edited; an edited artifact cannot pass as source-grounded.`,
      sourceLines: ctx.assertion.sourceLines,
    });
    return;
  }
  const provenance = verifiedProvenance(ctx.skill, target.path, ctx.source);
  if (!provenance) {
    ctx.record({
      id: ctx.item.id,
      title: ctx.item.prompt,
      status: "concern",
      filePath: target.path,
      message: `Target file "${target.path}" has no single verifiable provenance record for the cited source lines.`,
      sourceLines: ctx.assertion.sourceLines,
    });
    return;
  }
  const expectedExcerpt = normalizeWhitespace(excerptForRange(ctx.lines, ctx.assertion.sourceLines[0]! + 1, ctx.assertion.sourceLines[1]!).slice(0, MAX_TOPIC_EXCERPT_CHARS));
  const actualBody = normalizeWhitespace(targetBody(target).slice(0, MAX_TOPIC_EXCERPT_CHARS));
  if (expectedExcerpt.length === 0 || !actualBody.includes(expectedExcerpt)) {
    ctx.record({
      id: ctx.item.id,
      title: ctx.item.prompt,
      status: "concern",
      filePath: target.path,
      message: `Target file "${target.path}" does not retain the source excerpt for lines ${ctx.assertion.sourceLines[0]}–${ctx.assertion.sourceLines[1]}.`,
      sourceLines: ctx.assertion.sourceLines,
    });
    return;
  }
  const discoveryTokens = docTokens(expectedExcerpt).filter((token) => ctx.discovery.toLowerCase().includes(token));
  const uniqueDiscoveryTokens = new Set(discoveryTokens);
  if (uniqueDiscoveryTokens.size < TOPIC_DISCOVERY_TOKENS) {
    ctx.record({
      id: ctx.item.id,
      title: ctx.item.prompt,
      status: "concern",
      filePath: target.path,
      message: `The retained excerpt is discoverable from SKILL.md only via ${uniqueDiscoveryTokens.size} of ${TOPIC_DISCOVERY_TOKENS} required tokens; discovery is too weak.`,
      sourceLines: ctx.assertion.sourceLines,
    });
    return;
  }
  ctx.record({
    id: ctx.item.id,
    title: ctx.item.prompt,
    status: "pass",
    filePath: target.path,
    message: `Retains the source excerpt (lines ${ctx.assertion.sourceLines[0]}–${ctx.assertion.sourceLines[1]}) and is discoverable from SKILL.md.`,
    sourceLines: ctx.assertion.sourceLines,
  });
}

function evaluateProcedure(ctx: ProcedureContext): void {
  const mismatch = evidenceMismatch(ctx);
  if (mismatch) {
    ctx.record({
      id: ctx.item.id,
      title: ctx.item.prompt,
      status: "not-executable",
      filePath: ctx.assertion.filePath,
      message: mismatch,
      sourceLines: ctx.assertion.sourceLines,
    });
    return;
  }
  const target = fileFor(ctx.skill, ctx.assertion.filePath);
  if (!target) {
    ctx.record({
      id: ctx.item.id,
      title: ctx.item.prompt,
      status: "concern",
      filePath: ctx.assertion.filePath,
      message: `Target file "${ctx.assertion.filePath}" is missing from the package; the source procedure may no longer be retained.`,
      sourceLines: ctx.assertion.sourceLines,
    });
    return;
  }
  if (isUserEdited(target)) {
    ctx.record({
      id: ctx.item.id,
      title: ctx.item.prompt,
      status: "concern",
      filePath: target.path,
      message: `Target file "${target.path}" is user-edited; an edited artifact cannot pass as source-grounded.`,
      sourceLines: ctx.assertion.sourceLines,
    });
    return;
  }
  const provenance = verifiedProvenance(ctx.skill, target.path, ctx.source);
  if (!provenance) {
    ctx.record({
      id: ctx.item.id,
      title: ctx.item.prompt,
      status: "concern",
      filePath: target.path,
      message: `Target file "${target.path}" has no single verifiable provenance record for the cited source lines.`,
      sourceLines: ctx.assertion.sourceLines,
    });
    return;
  }
  const expected = (ctx as ProcedureContext).expectedProcedures.get(ctx.assertion.filePath)!;
  const stepCount = expected.proc.steps.length;
  if (stepCount > MAX_PROCEDURE_STEPS) {
    ctx.record({
      id: ctx.item.id,
      title: ctx.item.prompt,
      status: "not-executable",
      filePath: target.path,
      message: `Procedure has ${stepCount} steps; the evaluator compares at most ${MAX_PROCEDURE_STEPS}.`,
      sourceLines: ctx.assertion.sourceLines,
    });
    return;
  }
  const body = targetBody(target);
  if (ctx.assertion.sourceLines[1]! - ctx.assertion.sourceLines[0]! > MAX_PROCEDURE_LINE_SPAN) {
    ctx.record({
      id: ctx.item.id,
      title: ctx.item.prompt,
      status: "not-executable",
      filePath: target.path,
      message: `Procedure spans ${ctx.assertion.sourceLines[1]! - ctx.assertion.sourceLines[0]!} source lines; the evaluator compares at most ${MAX_PROCEDURE_LINE_SPAN}.`,
      sourceLines: ctx.assertion.sourceLines,
    });
    return;
  }
  const orderedSteps = [...body.matchAll(/^\s*\d+[.)]\s+(.+)$/gm)].map((m) => m[1]!.trim());
  if (orderedSteps.length < expected.proc.steps.length) {
    ctx.record({
      id: ctx.item.id,
      title: ctx.item.prompt,
      status: "concern",
      filePath: target.path,
      message: `Target lists ${orderedSteps.length} ordered steps; the source procedure has ${expected.proc.steps.length}.`,
      sourceLines: ctx.assertion.sourceLines,
    });
    return;
  }
  let fidelity = 0;
  for (const step of expected.proc.steps.slice(0, MAX_PROCEDURE_STEPS)) {
    const expectedText = normalizeWhitespace(step.text).slice(0, MAX_STEP_CHARS);
    const found = orderedSteps
      .slice(fidelity)
      .findIndex((candidate) => Math.abs(candidate.length - expectedText.length) <= MAX_STEP_LENGTH_DELTA && normalizeWhitespace(candidate).includes(expectedText));
    if (found === -1) break;
    fidelity += found + 1;
  }
  if (fidelity < expected.proc.steps.length) {
    ctx.record({
      id: ctx.item.id,
      title: ctx.item.prompt,
      status: "concern",
      filePath: target.path,
      message: `Only ${fidelity} of ${expected.proc.steps.length} source steps appear in order in the target (inert text comparison, nothing executed).`,
      sourceLines: ctx.assertion.sourceLines,
    });
    return;
  }
  ctx.record({
    id: ctx.item.id,
    title: ctx.item.prompt,
    status: "pass",
    filePath: target.path,
    message: `All ${expected.proc.steps.length} source steps appear in order (inert text comparison; nothing executed).`,
    sourceLines: ctx.assertion.sourceLines,
  });
}
