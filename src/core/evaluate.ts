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

interface StoredEntry {
  raw: unknown;
  parsed: EvalItem | null;
}

/** Raw `id` of a stored entry that failed schema parsing, for attribution. */
function rawIdOf(raw: unknown): unknown {
  return typeof raw === "object" && raw !== null
    ? (raw as Record<string, unknown>).id
    : undefined;
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
  const discovery = sourceOk ? skillMdBody(input.skill) : null;
  const evals = parseEvals(input.skill);

  if (!sourceOk) {
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

  const expectedList = deriveEvalItems(source, analysis);
  const expectedById = new Map(expectedList.map((item) => [item.id, item]));

  // An over-limit inventory cannot be reconciled against its expected items
  // without silently dropping entries, so it fails honestly as a whole
  // instead of returning a truncated, apparently clean report.
  if (evals.items.length > MAX_EVAL_ITEMS) {
    record({
      id: "evals-item-count",
      title: "Eval specification size",
      status: "not-executable",
      message: `evals/evals.json lists ${evals.items.length} items; the evaluator compares at most ${MAX_EVAL_ITEMS}. No structured evaluation ran.`,
    });
    return { evaluatorVersion: EVALUATOR_VERSION, executed: false, counts, checks };
  }

  const stored: StoredEntry[] = evals.items.map((raw) => {
    const result = EvalItemSchema.safeParse(raw);
    return result.success ? { raw, parsed: result.data } : { raw, parsed: null };
  });
  const attributed = new Set<StoredEntry>();
  const candidatesFor = (id: string): StoredEntry[] =>
    stored.filter((entry) => (entry.parsed ? entry.parsed.id : rawIdOf(entry.raw)) === id);

  // Reconcile every source-derived expectation: the evaluator iterates the
  // trusted expected specification (re-derived from the normalized source),
  // not the stored inventory — so a missing, malformed, duplicated, or
  // divergent stored entry can never silently disappear from the report.
  for (const expected of expectedList) {
    const candidates = candidatesFor(expected.id);
    for (const candidate of candidates) attributed.add(candidate);
    if (candidates.length === 0) {
      record({
        id: expected.id,
        title: expected.prompt,
        status: "not-executable",
        message: `Expected eval "${expected.id}" is missing from evals/evals.json; the stored specification no longer represents this source-derived expectation.`,
      });
      continue;
    }
    if (candidates.some((candidate) => candidate.parsed === null)) {
      record({
        id: expected.id,
        title: expected.prompt,
        status: "not-executable",
        message: `Expected eval "${expected.id}" is present but malformed; it cannot be schema-parsed and no outcome is claimed for it.`,
      });
      continue;
    }
    if (candidates.length > 1) {
      record({
        id: expected.id,
        title: expected.prompt,
        status: "not-executable",
        message: `Expected eval "${expected.id}" appears ${candidates.length} times in evals/evals.json; a duplicated specification cannot identify one expectation.`,
      });
      continue;
    }
    const item = candidates[0]!.parsed!;
    if (expected.assertions?.[0] && !item.assertions?.[0]) {
      record({
        id: item.id,
        title: item.prompt,
        status: "not-executable",
        message: `Stored eval "${item.id}" dropped the source-derived structured assertion; without it the expectation is a manual question, not an executable check.`,
      });
      continue;
    }
    evaluateStoredItem({
      item,
      expectedItem: expectedById.get(item.id),
      skill: input.skill,
      source,
      discovery,
      expectedTopics,
      expectedProcedures,
      record,
    });
  }

  // Stored entries beyond the expected specification stay inspectable: ones
  // with assertions are verified against source allocation (unknown targets
  // fail closed), and manual ones are reported as manual.
  for (const entry of stored) {
    if (attributed.has(entry) || entry.parsed === null || expectedById.has(entry.parsed.id)) continue;
    evaluateStoredItem({
      item: entry.parsed,
      expectedItem: expectedById.get(entry.parsed.id),
      skill: input.skill,
      source,
      discovery,
      expectedTopics,
      expectedProcedures,
      record,
    });
  }

  // Malformed entries attributable to no expectation are reported once, in
  // aggregate, so corrupt inventory can never vanish silently.
  const orphaned = stored.filter((entry) => entry.parsed === null && !attributed.has(entry));
  if (orphaned.length > 0) {
    record({
      id: "evals-unparseable",
      title: "Unevaluable eval entries",
      status: "not-executable",
      message: `${orphaned.length} entr${orphaned.length === 1 ? "y" : "ies"} in evals/evals.json could not be schema-parsed and matches no source-derived expectation; no outcome is claimed for ${orphaned.length === 1 ? "it" : "them"}.`,
    });
  }

  return { evaluatorVersion: EVALUATOR_VERSION, executed: true, counts, checks };
}

type RecordCheck = (check: EvaluationCheck) => void;

interface StoredItemContext {
  item: EvalItem;
  expectedItem: EvalItem | undefined;
  skill: CanonicalSkill;
  source: NormalizedSource;
  discovery: string;
  expectedTopics: Map<string, ReturnType<typeof allocateReferences>[number]>;
  expectedProcedures: Map<string, ReturnType<typeof allocateWorkflows>[number]>;
  record: RecordCheck;
}

function evaluateStoredItem(ctx: StoredItemContext): void {
  const { item, expectedItem } = ctx;
  const assertion = item.assertions?.[0];
  if (assertion && (!expectedItem || item.prompt !== expectedItem.prompt
    || item.expect !== expectedItem.expect || item.kind !== expectedItem.kind)) {
    ctx.record({
      id: item.id,
      title: item.prompt,
      status: "not-executable",
      message: "Executable eval context differs from the source-derived specification; no pass is claimed for a changed question.",
    });
    return;
  }
  if (!assertion) {
    ctx.record({
      id: item.id,
      title: item.prompt,
      status: "not-executable",
      message: "No structured assertion; this eval is a manual grounding question and the evaluator does not execute it.",
    });
    return;
  }
  if (assertion.type === "topic-retention") {
    evaluateTopic({
      skill: ctx.skill,
      source: ctx.source,
      discovery: ctx.discovery,
      expectedTopics: ctx.expectedTopics,
      item,
      assertion,
      record: ctx.record,
    });
  } else {
    evaluateProcedure({
      skill: ctx.skill,
      source: ctx.source,
      expectedProcedures: ctx.expectedProcedures,
      item,
      assertion,
      record: ctx.record,
    });
  }
}

interface EvaluationContext {
  skill: CanonicalSkill;
  source: NormalizedSource;
  discovery: string;
  expectedTopics: Map<string, ReturnType<typeof allocateReferences>[number]>;
  item: EvalItem;
  assertion: EvalAssertion;
  record: RecordCheck;
}

interface ProcedureContext extends Omit<EvaluationContext, "discovery" | "expectedTopics"> {
  expectedProcedures: Map<string, ReturnType<typeof allocateWorkflows>[number]>;
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
  // Canonical-to-canonical comparison: the expected text is the exact body
  // the builder wrote into the reference file (shared allocation in
  // evals.ts), not the raw pre-transform source excerpt — so deterministic
  // builder transforms such as relative-link neutralization can never read
  // as degradation. Comparison windows fail honestly: if either side
  // exceeds the bound, the check is not-executable rather than a false
  // concern or an unverified pass.
  const expectedEntry = ctx.expectedTopics.get(ctx.assertion.filePath)!;
  const expectedFull = normalizeWhitespace(expectedEntry.canonicalBody);
  const actualFull = normalizeWhitespace(targetBody(target));
  if (expectedFull.length === 0) {
    ctx.record({
      id: ctx.item.id,
      title: ctx.item.prompt,
      status: "not-executable",
      filePath: target.path,
      message: `The source-derived canonical body for "${target.path}" is empty; retention cannot be evaluated.`,
      sourceLines: ctx.assertion.sourceLines,
    });
    return;
  }
  if (expectedFull.length > MAX_TOPIC_EXCERPT_CHARS || actualFull.length > MAX_TOPIC_EXCERPT_CHARS) {
    ctx.record({
      id: ctx.item.id,
      title: ctx.item.prompt,
      status: "not-executable",
      filePath: target.path,
      message: `Topic text exceeds the evaluator comparison window (${MAX_TOPIC_EXCERPT_CHARS} characters); retention was not evaluated, not passed.`,
      sourceLines: ctx.assertion.sourceLines,
    });
    return;
  }
  if (!actualFull.includes(expectedFull)) {
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
  const discoveryTokens = docTokens(expectedFull).filter((token) => ctx.discovery.toLowerCase().includes(token));
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
  const canonicalSteps = expected.canonicalSteps.slice(0, MAX_PROCEDURE_STEPS);
  for (let index = 0; index < canonicalSteps.length; index++) {
    // Canonical-to-canonical: the workflow file holds neutralized step text
    // (shared allocation in evals.ts), so compare against that — never raw
    // source text against transformed output.
    const expectedText = normalizeWhitespace(canonicalSteps[index]!).slice(0, MAX_STEP_CHARS);
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
