# SkillForge — Architecture

A modular monolith in TypeScript (Node 22, ESM). No microservices, no job queue; long work is bounded and synchronous-fast for the demo path.

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
| Providers | `src/core/providers/` | `GenerationProvider` interface; `MockProvider` (deterministic, offline); `OpenAICompatibleProvider` (GLM/OpenAI-compatible, schema-validated output, injectable fetch); `resolveProvider`. |
| Pipeline | `src/core/pipeline.ts` | Orchestrates ingest→analyze→generate→validate as an async generator of discriminated events (stage progress with timings, typed errors, result). |
| Validator | `src/core/validate.ts` | Pure check registry (14 checks) over the package (+ optional source text for grounding). Deterministic; catches its own internal errors and reports them as failures. |
| Exporters | `src/core/export/exporters.ts` | Vendor adapters only place vendor differences live: `claude-code`, `generic`; `EXPORT_TARGET_INFO` (with format basis); `buildZip` (sanitized entries, JSZip). |
| Samples | `src/core/samples.ts` + `src/core/samples/*.md` | Bundled demo docs (Meridian Payments API, FastForge CLI). |
| URL source | `src/core/sources/url.ts` | P1: SSRF-guarded single-page fetch (protocol allowlist, DNS-based private-host refusal re-checked per redirect, size/time caps), HTML→markdown-ish conversion. Fetch/DNS injectable for tests. |
| File source | `src/core/sources/files.ts` | P1: local file/directory ingestion bounded by an allowlist root (`SKILLFORGE_DOCS_ROOT`), realpath containment (symlink escapes refused), extension/size/count/depth limits, multi-file combining. |
| GitHub source | `src/core/sources/github.ts` | P1.5: bounded documentation-tree ingestion from github.com repo/tree URLs — URL parsing/normalization, default-branch resolution, one recursive-tree API request, docs-first priority (README → docs/ → root → rest), extension allowlist, 40-file/800 KB/1.4 MB/depth-6/15 s bounds, raw-content fetch with final-host validation, typed errors, optional `SKILLFORGE_GITHUB_TOKEN` (api.github.com only). No cloning; submodules never followed; fetch injectable for tests. |
| HTTP API | `src/server/app.ts` | Express app: NDJSON-streaming `/api/generate` (source types: text/sample/url/file/github), skill store, on-demand `/validate`, validation-gated `/export` (422 on errors), static UI. |
| Store | `src/server/store.ts` | P1: file-backed persistence under `.data/skills/<id>/skill.json` — atomic writes, zod-validated reads, newest-50 eviction; survives restarts. |
| UI | `web/` | Vanilla JS/HTML/CSS. Stepper mirrors real pipeline events; file inspector with purpose + provenance; validation panel with re-run; real download via blob. |

## Key design decisions

1. **Canonical model first.** Providers only emit a small `SkillPlan`; all file synthesis happens once in `build.ts`, so grounding rules and gap handling exist in exactly one auditable place.
2. **Line-based analysis over a markdown AST.** Provenance needs exact line numbers; a custom scanner tracks fences, setext headings, and list runs directly.
3. **Determinism by construction.** Builders never embed timestamps (the pipeline stamps `meta.generatedAt` after building); manifests hash file contents. Same source ⇒ byte-identical package (enforced by test).
4. **Validation as a gate, not a suggestion.** Export re-runs the validator server-side; failing packages cannot be downloaded. The UI mirrors this (disabled export + explanation).
5. **Events, not polling.** The pipeline yields typed events; HTTP streams them as NDJSON, the CLI prints them, the UI renders them — one code path.
6. **Path safety at the boundary.** Every package path passes `safePackagePath`; the ZIP builder refuses unsafe/duplicate entries outright (zip-slip protection).

## Testing

`tests/` covers: ingestion normalization, analysis extraction, canonical build (schema-validity, determinism, verbatim references, gap marking, env-var context heuristic, link neutralization), every validator check (pass + trigger), exporters (format constraints, manifest resync), ZIP round-trips (read back via JSZip, byte comparison, zip-slip refusal, duplicate entries), providers (mock determinism; adapter: schema mismatch, no-JSON, HTTP error, network failure, unexpected shape), the URL source (SSRF guards incl. redirect re-validation, caps, HTML conversion), the file source (containment, symlink escape, bounds, combining), persistence, the HTTP API (streaming generate, validation, gated export, P1 source types), and bundled end-to-end demo tests for both samples and both targets.
