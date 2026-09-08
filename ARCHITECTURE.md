# SkillForge — Architecture

A modular monolith in TypeScript (Node.js ≥ 20 per `package.json` `engines`, ESM). No microservices, no job queue; long work is bounded and synchronous-fast for the demo path.

```
Source ──▶ ingest ──▶ analyze ──▶ provider.generate ──▶ build ──▶ validate ──▶ (UI preview)
                                                                      │
                                                        exportPackage ┴─▶ buildZip ──▶ ZIP
```

## Module map

| Module | Path | Responsibility |
| --- | --- | --- |
| Types / canonical model | `src/core/types.ts` | Zod schemas: `CanonicalSkill`, `SkillFile`, `Provenance`, `ValidationReport`, `SourceAnalysis`, … The canonical model is the only internal representation. |
| Util | `src/core/util.ts` | `slugify`, `sha256`, `safePackagePath` (traversal/absolute/normalization), `joinPackagePath`. |
| Ingestion | `src/core/ingest.ts` | Normalize raw input: line endings, HTML strip, entity decode, size bounds (≥40 chars, ≤1.5 MB), stable sha256. |
| Analysis | `src/core/analyze.ts` | Deterministic line-based markdown/text analysis: sections (exact line ranges), fenced code, shell commands (prompt-stripped), ordered procedures (≥3 steps), warnings (with wrapped continuations), constraint headings. |
| Plan schema | `src/core/plan.ts` | `PlanSchema` — the structured contract every provider must satisfy. |
| Builder | `src/core/build.ts` | Shared canonical-package synthesis: SKILL.md, references (verbatim excerpts), workflows, examples (comment-prefix only for formats that allow comments), evals, manifest with hashes; gap rendering; provenance records. |
| Providers | `src/core/providers/` | `GenerationProvider` interface; `MockProvider` (deterministic, offline); `OpenAICompatibleProvider` (GLM/OpenAI-compatible, schema-validated output, injectable fetch); `resolveProvider`. Remote responses are streamed under hard byte caps and the configured API key is redacted from all diagnostics. |
| Verify harness | `src/core/verify.ts` + `scripts/verify-provider.ts` (`npm run verify:provider`) | One bounded generation through the configured provider → plan schema check → canonical build → deterministic validation; credential-free reporting, nonzero exit on failure; injectable fetch for tests. |
| Pipeline | `src/core/pipeline.ts` | Orchestrates ingest→analyze→generate→validate as an async generator of discriminated events (stage progress with timings, typed errors, result). |
| Validator | `src/core/validate.ts` | Pure check registry of pure deterministic checks over the package (+ optional source text for grounding). Deterministic; catches its own internal errors and reports them as failures. Includes canonical-metadata-consistency (front matter / manifest identity must match `skill.meta`). |
| Exporters | `src/core/export/exporters.ts` | Vendor adapters only place vendor differences live: `claude-code`, `generic`; `EXPORT_TARGET_INFO` (with format basis); `buildZip` (sanitized entries, JSZip). |
| Samples | `src/core/samples.ts` + `src/core/samples/*.md` | Bundled demo docs (Meridian Payments API, FastForge CLI). |
| Runtime config | `src/config/env.ts` | `.env` loading (working dir, then entry-module walk-up; process environment keeps precedence; values never logged) and startup validation: provider id allowlist, non-mock provider requires `SKILLFORGE_API_KEY`, `PORT` range — all enforced before traffic is served. |
| URL source | `src/core/sources/url.ts` | SSRF-guarded single-page fetch (protocol allowlist, host refusal by name plus centralized IP classification for every address — see IP policy below; DNS resolved + validated at connection time and the socket pinned to those records — no re-resolution/rebinding gap, re-validated per redirect, one end-to-end deadline over DNS/redirects/headers/body, streaming byte cap), HTML→markdown-ish conversion. Transport (fetch-shaped or safe transport) and DNS injectable for tests. |
| IP policy | `src/core/sources/ip-policy.ts` | The single authority for "may URL ingestion connect to this address?" — a conservative public-destination policy: static blocked-CIDR tables for IPv4 (local/private/link-local/CGNAT/protocol-special/documentation/benchmark/reserved/multicast) and IPv6 (everything outside allocated global unicast 2000::/3, plus special/deprecated allocations inside it); ALL transitional/tunneled forms (IPv4-mapped, NAT64, 6to4, Teredo) are rejected outright. Strict parsing fails closed on malformed or ambiguous input. Pure functions, no I/O — deliberately not an exact IANA-registry reachability implementation. |
| File source | `src/core/sources/files.ts` | Local file/directory ingestion bounded by an allowlist root (`SKILLFORGE_DOCS_ROOT`), realpath containment (symlink escapes refused), extension/size/count/depth limits, multi-file combining. |
| GitHub source | `src/core/sources/github.ts` | Bounded documentation-tree ingestion from github.com repo/tree URLs — URL parsing/normalization, default-branch resolution, one recursive-tree API request, docs-first priority (README → docs/ → root → rest), extension allowlist, 40-file/800 KB/1.4 MB/depth-6/15 s bounds, raw-content fetch with final-host validation, typed errors, optional `SKILLFORGE_GITHUB_TOKEN` (api.github.com only). No cloning; submodules never followed; fetch injectable for tests. |
| GitHub codebase source | `src/core/sources/github-codebase.ts` | The `codebase` mode of the GitHub source — bounded repository reconnaissance for coding agents: repo metadata + one recursive-tree request, codebase-specific allowlist (source/config/test/instruction files in; binaries, generated/minified, lockfile contents, build/vendor dirs out), deterministic priority ranking with a per-top-directory diversity cap, bounded raw-content fetches (60 files/200 KB per file/1.4 MB total/depth 10, 15 s per request, 90 s overall, 10 MB tree cap), typed `codebase_*` errors. Selection is computed locally — never by the model. Fetch safety primitives are shared with the docs adapter (no duplication). |
| Codebase extraction | `src/core/codebase/extract.ts` | Pure, bounded extraction from fetched files: package.json scripts/dependencies, pyproject.toml framework evidence (regex, no TOML dependency), CI run-step commands via YAML parsing, instruction-file conventions with `path:line` evidence, testing evidence, public interfaces from manifest fields. Malformed files degrade into notes. |
| Codebase planning | `src/core/codebase/plan.ts` | Deterministic coding-agent plan from the structured repository analysis; every step/constraint/verification entry cites its inspected evidence; empty sections stay empty (honest gaps). Used by the mock provider for `github-codebase` inputs and sent to remote providers as authoritative repository context. |
| HTTP API | `src/server/app.ts` | Express app: NDJSON-streaming `/api/generate` (source types: text/sample/url/file/github, with an explicit `mode: docs \| codebase` for github sources), skill store, on-demand `/validate`, validation-gated `/export` (422 on errors), static UI. |
| Store | `src/server/store.ts` | File-backed persistence under `<data-root>/skills/<id>/skill.json` (default `.data/skills`, relocatable via `SKILLFORGE_DATA_ROOT`; injectable root for tests) — atomic writes, zod-validated reads, newest-50 eviction; survives restarts. |
| UI | `web/` | Vanilla JS/HTML/CSS. Stepper mirrors real pipeline events; file inspector with purpose + provenance; validation panel with re-run; real download via blob. |

## Key design decisions

1. **Canonical model first.** Providers only emit a small `SkillPlan`; all file synthesis happens once in `build.ts`, so grounding rules and gap handling exist in exactly one auditable place.
2. **Line-based analysis over a markdown AST.** Provenance needs exact line numbers; a custom scanner tracks fences, setext headings, and list runs directly.
3. **Determinism by construction.** Builders never embed timestamps (the pipeline stamps `meta.generatedAt` after building); manifests hash file contents. Same source ⇒ byte-identical package (enforced by test).
4. **Validation as a gate, not a suggestion.** Export re-runs the validator server-side; failing packages cannot be downloaded. The UI mirrors this (disabled export + explanation).
5. **Events, not polling.** The pipeline yields typed events; HTTP streams them as NDJSON, the CLI prints them, the UI renders them — one code path.
6. **Path safety at the boundary.** Every package path passes `safePackagePath`; the ZIP builder refuses unsafe/duplicate entries outright (zip-slip protection).

## Testing

`tests/` covers: ingestion normalization, analysis extraction, canonical build (schema-validity, determinism, verbatim references, gap marking, env-var context heuristic, link neutralization), every validator check (pass + trigger), exporters (format constraints, manifest resync), ZIP round-trips (read back via JSZip, byte comparison, zip-slip refusal, duplicate entries), providers (mock determinism; adapter: schema mismatch, no-JSON, HTTP error, network failure, unexpected shape), the URL source (SSRF guards incl. redirect re-validation, connection-time DNS validation and address pinning, end-to-end deadline over stalled bodies/redirect chains, caps, HTML conversion), the file source (containment, symlink escape, bounds, combining), runtime configuration (`.env` parsing/precedence, provider validation), the compiled production server (smoke: starts with plain node, health + static UI, misconfiguration refuses to start), persistence, the HTTP API (streaming generate, validation, gated export, all supported source types), the GitHub codebase source (eligibility/safety filtering, stack detection, deterministic ranking + diversity, bounded fetching, limits/deadlines, token-destination restrictions, inert-content handling, repository analysis — all with injected fetch), and bundled end-to-end demo tests for both samples and both targets.
