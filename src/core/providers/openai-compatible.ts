/**
 * OpenAI-compatible chat-completions provider adapter (works for GLM and any
 * compatible endpoint). Used only when explicitly configured; the bundled
 * demo never needs it.
 *
 * The adapter requests a strict JSON response and validates it against
 * PlanSchema before returning — malformed model output fails with an
 * actionable error instead of flowing into the package.
 */
import { PlanSchema, type SkillPlan } from "../plan.js";
import { ProviderError, type GenerationProvider, type GenerateInput } from "./types.js";
import { slugify, redactSecret } from "../util.js";
import { readBodyCapped, decodeUtf8, BodyTooLargeError } from "../sources/body.js";

export interface OpenAICompatibleOptions {
  id?: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Hard caps on provider response bodies, enforced WHILE the body streams
 * (shared reader, same one the source adapters use). A timeout bounds elapsed
 * time, not memory, so a misbehaving endpoint streaming an unbounded body
 * must be refused mid-read instead of buffered to completion.
 *
 * - Success bodies: legitimate chat-completions responses carrying a SkillForge
 *   plan are a few KB; 10 MB is far above anything real while still bounding
 *   memory.
 * - Non-2xx diagnostic bodies: only a 500-char slice is ever attached to the
 *   error, so a much smaller cap suffices; hints are preserved either way.
 */
const MAX_PROVIDER_RESPONSE_BYTES = 10_000_000;
const MAX_PROVIDER_ERROR_BYTES = 256_000;

const SYSTEM_PROMPT = `You are a skill planner for SkillForge. You convert documentation into a plan for an AI agent skill.
Respond with ONLY a JSON object matching this TypeScript type:

interface SkillPlan {
  name?: string;          // lowercase-hyphenated slug, max 48 chars
  displayName?: string;
  description?: string;   // one paragraph, max 1024 chars
  whenToUse: string[];    // concrete situations where the skill applies
  inputs: string[];       // required configuration/tokens/args, grounded in the source
  steps: string[];        // ordered workflow steps grounded in the source
  constraints: string[];  // explicit warnings/limits found in the source
  verification: string[]; // how to verify success (commands or checks from the source)
  pitfalls: string[];     // common failures documented in the source
}

Rules:
- Ground every entry in the provided source. Never invent APIs, commands, flags, or env vars.
- When the source lacks an answer, leave that array short or empty.
- Keep entries short and imperative.`;

export class OpenAICompatibleProvider implements GenerationProvider {
  readonly id: string;
  readonly offline = false;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: OpenAICompatibleOptions) {
    this.id = opts.id ?? "openai-compatible";
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.model = opts.model;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  async generate(input: GenerateInput): Promise<SkillPlan> {
    // Codebase mode: the bounded repository analysis is authoritative for
    // repository facts (commands, conventions, structure) — send it so the
    // model never has to guess from concatenated source alone.
    const repositoryContext = input.repository
      ? [
          "",
          "Repository analysis (bounded, evidence-backed; authoritative for repository facts):",
          "```json",
          truncate(JSON.stringify(input.repository), 20_000),
          "```",
        ]
      : [];
    const userPrompt = [
      `Source name: ${input.source.originalName}`,
      input.requestedName ? `Preferred skill name: ${input.requestedName}` : "",
      ...repositoryContext,
      "",
      "Source document:",
      "```",
      truncate(input.source.text, 60_000),
      "```",
    ]
      .filter(Boolean)
      .join("\n");

    // The provider timeout and the caller's cancellation (e.g. HTTP client
    // disconnect) both abort the in-flight request: whichever fires first.
    const signal = input.signal
      ? AbortSignal.any([AbortSignal.timeout(this.timeoutMs), input.signal])
      : AbortSignal.timeout(this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.2,
        }),
        signal,
      });
    } catch (err) {
      // Transport errors can embed request material (custom network stacks may
      // include headers); sanitize before the text leaves the provider.
      const raw = err instanceof Error ? err.message : String(err);
      throw new ProviderError(
        `Provider request failed: ${redactSecret(raw, this.apiKey)}`,
        "provider_request_failed",
      );
    }

    if (!response.ok) {
      // Non-2xx bodies are diagnostics: stream them under a small cap so a
      // misbehaving endpoint cannot push unbounded data into memory, and keep
      // the bounded detail + remediation hints. A hostile or misconfigured
      // endpoint may echo the API key — redact every occurrence before the
      // body text is attached to the error.
      let body = "";
      try {
        body = decodeUtf8(await readBodyCapped(response, MAX_PROVIDER_ERROR_BYTES, signal));
      } catch (err) {
        if (err instanceof BodyTooLargeError) {
          body = "(error body exceeded the diagnostic size cap and was discarded)";
        } else {
          body = "";
        }
      }
      throw new ProviderError(
        `Provider returned HTTP ${response.status} ${response.statusText}. Check the API key, base URL, and model name.`,
        "provider_http_error",
        redactSecret(body, this.apiKey).slice(0, 500),
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(
        decodeUtf8(await readBodyCapped(response, MAX_PROVIDER_RESPONSE_BYTES, signal)),
      );
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        throw new ProviderError(
          `Provider response body exceeded the ${MAX_PROVIDER_RESPONSE_BYTES} byte limit and was discarded mid-read. The endpoint is misbehaving or the model returned an unbounded response.`,
          "provider_response_too_large",
        );
      }
      if (signal.aborted) {
        throw new ProviderError(
          "Provider request was aborted before the response body finished reading.",
          "provider_request_failed",
        );
      }
      throw new ProviderError("Provider returned a non-JSON response body.", "provider_bad_json");
    }

    const content = extractMessageContent(payload);
    if (content === null) {
      // Detail is remote-controlled data: serialize and redact before it can
      // carry the configured key anywhere.
      throw new ProviderError(
        "Provider response did not contain a chat message with text content.",
        "provider_unexpected_shape",
        redactSecret(JSON.stringify(payload), this.apiKey),
      );
    }

    const rawJson = extractJsonObject(content);
    if (rawJson === null) {
      throw new ProviderError(
        "Provider message did not contain a JSON object. Re-run generation or try a different model.",
        "provider_no_json",
        redactSecret(content, this.apiKey).slice(0, 500),
      );
    }

    const parsed = PlanSchema.safeParse(rawJson);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      throw new ProviderError(
        `Model output did not match the skill plan schema: ${issues}`,
        "provider_schema_mismatch",
        redactSecret(JSON.stringify(rawJson), this.apiKey),
      );
    }

    const plan = parsed.data;
    return {
      ...plan,
      name: slugify(plan.name?.trim() || input.analysis.title, 48),
    };
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + "\n…(truncated)";
}

function extractMessageContent(payload: unknown): string | null {
  const choices = (payload as { choices?: unknown })?.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = (choices[0] as { message?: { content?: unknown } })?.message;
  const content = message?.content;
  if (typeof content === "string" && content.length > 0) return content;
  return null;
}

/** Extract the first balanced JSON object from a possibly chatty response. */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}
