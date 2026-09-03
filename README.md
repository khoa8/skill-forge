# SkillForge

**Turn documentation, text, or repositories into validated, portable AI Agent Skills.**

SkillForge is not a summarizer or a chatbot. It runs an explicit pipeline — **Source → Analyze → Generate → Validate → Preview → Export** — and its differentiator is deterministic validation and honest source grounding: every generated claim carries line-range provenance, and gaps are marked instead of invented.

![SkillForge generating and validating a skill from a bundled sample](docs/screenshot-results.png)

## Quick start (no API key required)

```bash
npm install
npm run dev          # open http://127.0.0.1:8787
```

Then: **pick a source (bundled sample, pasted Markdown, a URL, or local files) → Generate skill → inspect files → Download ZIP.** The bundled demo provider runs fully offline; no paid key is ever needed for the demo workflow.

Verify the same flow headlessly:

```bash
npm run demo         # generate → validate → export both samples, inspect the ZIPs
npm test             # 117 tests incl. end-to-end Source → Export
```

## Sources

| Type | How | Notes |
| --- | --- | --- |
| Bundled samples | Pick a card | Offline, deterministic; two docs covering API and CLI material. |
| Pasted Markdown/text | Paste tab | Any instructional Markdown; HTML stripped, entities decoded. |
| URL | URL tab | Single-page http(s) fetch with safety limits (below). |
| Local files | Local files tab | File or directory under the allowed root (`SKILLFORGE_DOCS_ROOT`, default: the workspace). |

**URL safety limits:** http/https only; hosts that are private/loopback/link-local by name *or* DNS resolution are refused (SSRF guard, re-checked on every redirect); max 3 redirects; 1 MB / 15 s caps; only text-like content types; page JavaScript is never executed (JS-rendered pages are reported as empty rather than guessed at).

**Local file safety:** paths must resolve inside the allowed root (symlink escapes refused); extension allowlist (`.md`, `.txt`, `.rst`, …); per-file 800 KB / combined 1.4 MB caps; max 40 files, depth 6; no code execution.

## What it does

| Stage | Behavior |
| --- | --- |
| **Source** | One of the four input types above. |
| **Analyze** | Deterministic line-based extraction: sections, fenced code, shell commands, ordered procedures (≥3 steps), warnings, constraint statements. Every extraction keeps exact source line numbers. |
| **Generate** | A provider turns the analysis into a validated skill plan; a shared builder produces the canonical package. The default provider is deterministic and offline; an OpenAI-compatible adapter (GLM, etc.) is available via env config. |
| **Validate** | 16 deterministic checks (see below). Warnings don't block export; errors do. The UI never claims success for skipped validation. |
| **Preview** | Inspect every generated file with its purpose and provenance before exporting. Generated skills persist on disk (`.data/skills/`) and survive server restarts. |
| **Export** | Real ZIP downloads for **Claude Code** and **Generic (AGENTS.md)** targets. The server re-validates and refuses (HTTP 422) packages with errors. |

## Generated package

A typical export looks like [examples/exported-package/](examples/exported-package/):

```
meridian-payments-api/
├── SKILL.md              # front matter (name, description) + when-to-use, inputs, workflow, constraints, verification, pitfalls
├── AGENTS.md             # (generic target) orientation wrapper for any agent
├── references/           # verbatim source excerpts with line-range provenance
├── workflows/            # multi-step procedures detected in the source
├── examples/             # verbatim code blocks from the source
├── evals/                # deterministic, source-derived grounding checks (manual)
└── manifest.json         # source identity (sha256), gap list, file inventory with hashes
```

Every file has a recorded purpose; ceremonial empty files are a validation error. Relative links inside verbatim excerpts are shown as paths (`` `docs/x.md` ``) instead of dangling links.

## Validation behavior

Validation is deterministic — same package in, same report out, no model calls. The 16 checks: required files; safe & unique paths (zip-slip/traversal); well-formed YAML front matter; valid `name` slug and `description`; no empty sections; resolving internal links; parseable JSON; manifest↔package consistency; no placeholder text (`TODO`, `FIXME`, …); no empty files; duplicate IDs; eval integrity (unique ids, usable prompt/expectation, known kinds); provenance integrity (every file traceable, valid line ranges); SKILL.md size; unsupported export targets; and command grounding (shell commands in generated files must trace back to the source — unverifiable grounding is reported as *not verified*, never as passed).

The report states `passed`, `executed`, per-check status, file locations, and actionable messages. Warnings (e.g. placeholders, untraceable commands) do not block export; errors do — the export endpoint re-runs validation and refuses failing packages.

## Providers

- `mock` (default): deterministic, offline, no key. Same source ⇒ byte-identical package.
- `glm` / `openai`: OpenAI-compatible chat-completions adapters. Model output must parse against the skill-plan schema; malformed output fails with an actionable error instead of entering the package. Configure via `.env` (see `.env.example`). These adapters are implemented and unit-tested with injected fetch, but not exercised against a paid API in this repo — no compatibility claims beyond that.

## Verified with live sources

The URL source has been exercised against real pages during development: a raw GitHub README (markdown, passed all checks) and a GitHub docs HTML page (converted, passed all checks). JS-rendered single-page apps are honestly rejected (`url_no_content`) instead of producing empty skills.

## Limitations

- URL ingestion is single-page: no crawling, no JS rendering (documented honest failure instead).
- The grounding check is heuristic (token overlap), not proof of correctness; review generated skills.
- GitHub repository ingestion as a first-class source type is not implemented (paste/URL/local cover the same need manually).
- The `glm`/`openai` providers require you to supply a key and have not been run against live endpoints here.
- Evals are generated as manual grounding checks; SkillForge does not execute them.
- PDF ingestion is not implemented.

See [PRODUCT.md](PRODUCT.md) for scope and [ARCHITECTURE.md](ARCHITECTURE.md) for the module map.
