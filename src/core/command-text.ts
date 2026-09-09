/**
 * Deterministic command-phrase classification for generated text (final
 * remediation P1-3).
 *
 * One module, one semantics: the validator (deny-by-default grounding) and
 * the deterministic codebase planner (convention promotion) MUST agree on
 * what counts as a runnable-command phrase, so both import from here.
 *
 * The security model: a generated surface may present a command as runnable
 * only when that exact command came from structured repository evidence. The
 * classifier is deliberately syntax-independent — backticks, fencing, list
 * markers, and sentence position cannot move text out of instruction
 * register — and bounded: it recognizes two registers, never free-form
 * natural-language command parsing.
 */
import type { RepositoryCommand } from "./types.js";

/** Run verbs that introduce an executable instruction. */
const RUN_VERBS = "(?:run|execute|invoke|start|launch|perform|trigger)";

/**
 * Inline backtick span in planner-authored text = candidate when:
 *   (a) introduced by a run-verb ("Run", "Execute", "Invoke",
 *       "Start with", "Run:", … — bounded list, whitespace/colon tolerant), or
 *   (b) command-shaped: contains whitespace, first token a bare word
 *       (no "/", no "."). Single tokens like `UserService` and path-like
 *       spans like `src/app.ts` remain ordinary identifiers.
 */
const RUN_VERB_RE =
  /\b(?:run|execute|invoke|start|launch|perform|trigger)\b\s*[:\-]?\s*(?:with\s+|by\s+|using\s+)?(?:`|$)/i;

const PLAIN_VERB_RE =
  /^\s*(?:run|execute|invoke|start|launch|perform|trigger)\b\s*[:\-]?\s*(?:with\s+|by\s+|using\s+)?(.+)$/i;

/** Strip markdown list markers so sentence-initial verbs are detected
 * inside list items ("1. Execute make", "- Run pytest"). */
function stripListMarkers(line: string): string {
  return line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "");
}

export function isRunnableCommandSpan(
  span: string,
  lineBefore: string,
): boolean {
  const s = span.trim();
  // (a) run-verb introduced (verb must sit immediately before the span).
  if (RUN_VERB_RE.test(lineBefore)) return true;
  // (b) command-shaped: whitespace + bare first token.
  if (/\s/.test(s)) {
    const first = s.split(/\s+/)[0]!;
    return !first.includes("/") && !first.includes(".");
  }
  return false;
}

/** Plain-text candidate: first word after a sentence-initial run-verb. Backtick
 * spans immediately after the verb defer to the inline-span path (their
 * evidence check runs there). */
export function plainTextCommandCandidate(line: string): string | null {
  const stripped = stripListMarkers(line);
  const m = stripped.match(PLAIN_VERB_RE);
  if (!m) return null;
  const rest = m[1]!.trim();
  if (rest.length === 0) return null;
  if (rest.startsWith("`")) return null; // inline span handles this surface
  // Sentence bound: only the first sentence is the imperative command.
  const firstSentence = rest.split(/(?<=[.!?])\s+/)[0]!;
  // A mid-sentence backtick span is not part of the plain command words.
  const cut = firstSentence.indexOf("`");
  const plain = (cut === -1 ? firstSentence : firstSentence.slice(0, cut))
    .replace(/[.!?]+$/, "")
    .trim();
  return plain.length > 0 ? plain : null;
}

/**
 * Obligation register (final remediation P1-3): an obligation marker in the
 * same sentence as a run-verb puts the sentence into instruction register
 * REGARDLESS of sentence position — "Always run npm publish before
 * committing." is a runnable instruction even though the sentence starts
 * with "Always", not "Run". Bounded marker list; negated obligations ("do
 * not run X", "never run X") are prohibitions, not runnable instructions,
 * and stay outside the register.
 */
const OBLIGATION_REGISTER_RE =
  /\b(?:always|must|should|ensure|make sure|be sure|required|remember to|please|use this skill to|before (?:pushing|committing|merging|releasing|deploying|publishing))\b/i;

/** Command-word vocabulary for candidate phrases: no whitespace, quotes, or
 * shell characters — "npm publish" qualifies, "the deployment pipeline's"
 * does not. A sentence-ending "." is deliberately NOT part of a word so the
 * phrase cuts at the sentence boundary. */
const CMD_WORD = "[A-Za-z0-9_/@:-]+";

/** Frame words that must never be part of a captured command phrase: clause
 * prepositions/conjunctions, obligation/auxiliary verbs, and the run verbs
 * themselves ("run npm publish and deploy" → "npm publish", never "npm
 * publish and" / "before release"). */
const FRAME_WORD =
  "(?:before|after|when|whenever|while|if|with|using|via|on|in|at|and|or|then|always|must|should|ensure|make|sure|be|is|are|gets?|please|remember|required|to|run|execute|invoke|start|launch|perform|trigger)";

/** A phrase word that is not a frame word. */
const PHRASE_WORD = `(?!(?:${FRAME_WORD})\\b)${CMD_WORD}`;

/** Tail cut: the phrase ends at a clause boundary, backtick, or sentence
 * punctuation ( "." is outside CMD_WORD, so this fires reliably). */
const TAIL_CUT = "(?=[.,;:!?]|`|$)";

/** Greedy-capture escape hatch: after the phrase, optionally swallow a frame
 * word and any non-punctuation residue so a mid-phrase frame word ("run npm
 * publish **before** committing") cuts the phrase instead of failing the
 * whole match. */
const TAIL_SWALLOW = `(?:\\s+(?:${FRAME_WORD})\\b[^.,;:!\`]*)?`;

/** Words stripped from both ENDS of a captured phrase before it is
 * considered a command candidate. */
const STRIP_WORDS = new Set(
  ("before after when whenever while if with using via on in at and or then " +
    "always must should ensure make sure be is are get gets please remember " +
    "required to run execute invoke start launch perform trigger").split(" "),
);

function stripFrameWords(phrase: string): string {
  let words = phrase.split(/\s+/);
  while (words.length > 0 && STRIP_WORDS.has(words[0]!.toLowerCase())) words = words.slice(1);
  while (words.length > 0 && STRIP_WORDS.has(words[words.length - 1]!.toLowerCase())) words = words.slice(0, -1);
  return words.join(" ");
}

/**
 * Command-phrase candidates inside ONE line of obligation-register text.
 * Three bounded voices — each yields a MULTI-TOKEN phrase (e.g.
 * "npm publish", "make test"): a single generic noun after a verb ("run
 * tests", "run migrations") is ordinary developer prose, and treating it as
 * a command would make legitimate conventions false positives. Single-token
 * real commands remain covered by the sentence-initial imperative path
 * ("Run pytest", "Execute make"), which is instruction register by position.
 *  - active:       "Always run npm publish …"            → "npm publish"
 *  - instrumental: "Tests must be run with npm publish." → "npm publish"
 *  - passive:      "Ensure npm publish is run …"         → "npm publish"
 * Frame words never enter a phrase; mid-sentence backtick spans defer to the
 * inline-span path. Sentence bound: only the first sentence.
 */
export function obligationCommandCandidates(line: string): string[] {
  const stripped = stripListMarkers(line);
  const sentence = (stripped.split(/(?<=[.!?])\s+/)[0] ?? "").trim();
  if (sentence.length === 0) return [];
  if (!OBLIGATION_REGISTER_RE.test(sentence)) return [];
  if (!new RegExp(`\\b${RUN_VERBS}\\b`, "i").test(sentence)) return [];
  const out = new Set<string>();
  // Passive: "<phrase> is/are/be run …" → the phrase BEFORE the verb.
  const passive = new RegExp(
    `\\b(${PHRASE_WORD}(?:\\s+${PHRASE_WORD})+)\\s+(?:is|are|be|gets?)\\s+${RUN_VERBS}\\b`,
    "gi",
  );
  for (const m of sentence.matchAll(passive)) {
    const cleaned = stripFrameWords(m[1]!.trim());
    if (cleaned.includes(" ")) out.add(cleaned);
  }
  // Instrumental: "run with/using/via <phrase>".
  const instrumental = new RegExp(
    `\\b${RUN_VERBS}\\b\\s+(?:with|using|via)\\s+(${PHRASE_WORD}(?:\\s+${PHRASE_WORD})*)${TAIL_SWALLOW}${TAIL_CUT}`,
    "gi",
  );
  for (const m of sentence.matchAll(instrumental)) {
    const cleaned = stripFrameWords(m[1]!.trim());
    if (cleaned.includes(" ")) out.add(cleaned);
  }
  // Active: "<verb> <phrase> …" — the phrase's first word must not itself be
  // a frame word ("run the tests", "run before release" are prose).
  const active = new RegExp(
    `\\b${RUN_VERBS}\\b\\s+(${PHRASE_WORD}(?:\\s+${PHRASE_WORD})*)${TAIL_SWALLOW}${TAIL_CUT}`,
    "gi",
  );
  for (const m of sentence.matchAll(active)) {
    const cleaned = stripFrameWords(m[1]!.trim());
    if (cleaned.includes(" ")) out.add(cleaned);
  }
  return [...out].filter((c) => c.length > 0);
}

/**
 * All runnable-command candidates in one line of generated text — the union
 * the validator checks against the evidenced set and the planner uses to
 * decide whether a repository convention may be promoted. Backticked spans
 * that classify as runnable + sentence-initial imperatives + obligation-
 * register phrases.
 */
export function runnableCommandCandidates(line: string): string[] {
  const out: string[] = [];
  const stripped = stripListMarkers(line);
  // Inline backtick spans (spans immediately after a run-verb are
  // verb-introduced; others must be command-shaped).
  let cursor = stripped;
  while (cursor.length > 0) {
    const m = cursor.match(/`([^`]+)`/);
    if (!m || m.index === undefined) break;
    if (isRunnableCommandSpan(m[1]!, cursor.slice(0, m.index))) {
      out.push(m[1]!.trim());
    }
    cursor = cursor.slice(m.index + m[0].length);
  }
  const plain = plainTextCommandCandidate(stripped);
  if (plain !== null) out.push(plain);
  out.push(...obligationCommandCandidates(stripped));
  return out.filter((c) => c.length > 0);
}

/**
 * Convention promotion rule (final remediation P1-3): a repository
 * convention statement carries NO runnable command authority of its own. It
 * may be promoted into planner constraints only when EVERY runnable-command
 * phrase inside it exactly matches an already-grounded RepositoryCommand
 * (option 2 — link to structured evidence); otherwise the statement stays
 * repository policy text in the analysis record and is omitted from the
 * plan (option 3 — fail closed). Nothing is rewritten or quoted into a
 * "safe" variant.
 */
export function conventionStatementIsGrounded(
  statement: string,
  evidencedCommands: ReadonlySet<string>,
): boolean {
  const lines = statement.split("\n");
  return lines.every((line) => {
    const candidates = runnableCommandCandidates(line);
    return candidates.every((c) => evidencedCommands.has(c));
  });
}

/** Convenience: the evidenced-command string set for a command list. */
export function evidencedCommandSet(commands: readonly RepositoryCommand[]): Set<string> {
  return new Set(commands.map((c) => c.command));
}
