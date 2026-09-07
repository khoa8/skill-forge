# SkillForge

**Turn documentation, text, or repositories into validated, portable AI Agent Skills.**

SkillForge is not a summarizer or a chatbot. It runs an explicit pipeline — **Source → Analyze → Generate → Validate → Preview → Export** — and its differentiator is deterministic validation and honest source grounding: generated files retain source provenance, verbatim references, workflows, and examples carry exact source line ranges, and gaps are marked instead of invented.

![SkillForge generating and validating a skill from a bundled sample](docs/screenshot-results.png)

## Quick start (no API key required)

```bash
npm install
npm run dev          # open http://127.0.0.1:8787
```

Then: **pick a source (bundled sample, pasted Markdown, a URL, local files, or a public GitHub repository) → Generate skill → inspect files → Download ZIP.** The bundled demo provider runs fully offline; no paid key is ever needed for the demo workflow.

Verify the same flow headlessly:

```bash
npm run demo         # generate → validate → export both samples, inspect the ZIPs
npm test             # Vitest suite incl. end-to-end Source → Export
```

Pull requests and pushes to `main` run the repository CI quality gate defined in `.github/workflows/ci.yml` (that workflow is the single source of truth for which checks run).

## Production run (compiled)

```bash
npm ci
npm run build
npm prune --omit=dev   # dev tooling (tsx, TypeScript, Vitest) is not needed to serve
npm start              # node dist/server/index.js — no dev dependencies required
```

`npm run dev` remains the developer/watch workflow (tsx watch with auto-reload). The production server resolves the static UI and the documented `.env` file relative to its install location, so it can be started from any working directory.

### Configuration (.env)

`cp .env.example .env` and edit — `.env` values are loaded automatically by `npm run dev`, `npm start`, and `npm run verify:provider`. Variables already present in the shell/process environment take precedence over `.env` values, and `.env` values are never logged. Before serving traffic the provider configuration is validated: an unsupported `SKILLFORGE_PROVIDER` fails startup, and a non-mock provider without `SKILLFORGE_API_KEY` refuses to start (rather than serving a health endpoint that looks healthy while every generation is guaranteed to fail). With no `.env` at all the server runs the offline mock provider.

## Deployment scope (read before binding beyond loopback)

SkillForge is built for **local / trusted self-hosted use**. It has **no built-in authentication, authorization, or tenant isolation**: anyone who can reach the server can generate skills, read stored skills (including their full sources), edit generated files, and export packages. The default `HOST=127.0.0.1` binding restricts it to your machine. Binding to a non-loopback address (e.g. `HOST=0.0.0.0`) exposes the unauthenticated service to your network — SkillForge prints a startup warning for that case, which you can only silence by explicitly setting `SKILLFORGE_ACKNOWLEDGE_EXPOSURE=1`. Putting the server on the public Internet as a multi-user service is not a supported configuration without adding an external authentication/isolation layer in front of it.

## Sources

| Type | How | Notes |
| --- | --- | --- |
| Bundled samples | Pick a card | Offline, deterministic; two docs covering API and CLI material. |
| Pasted Markdown/text | Paste tab | Any instructional Markdown; HTML stripped, entities decoded. |
| URL | URL tab | Single-page http(s) fetch with safety limits (below). |
| Local files | Local files tab | File or directory under the allowed root (`SKILLFORGE_DOCS_ROOT`, default: the workspace). |
| GitHub repository | GitHub repo tab | Bounded docs-tree fetch via the GitHub API (below). |

**URL safety limits:** http/https only; hosts that are private/loopback/link-local by name are refused, and connections are pinned to DNS records that were resolved and validated as public at connection time (closing the DNS re-resolution/rebinding gap between validation and use — the check is re-run for every redirect target); max 3 redirects; 1 MB cap; one 15 s end-to-end deadline covering DNS, redirects, connection, and body streaming (a stalled response fails with `url_deadline_exceeded`, HTTP 504, instead of hanging); only text-like content types; page JavaScript is never executed (JS-rendered pages are reported as empty rather than guessed at).

**Local file safety:** `SKILLFORGE_DOCS_ROOT` is the filesystem trust boundary — paths must resolve inside it (symlink escapes refused); extension allowlist (`.md`, `.txt`, `.rst`, …); per-file 800 KB / combined 1.4 MB caps; max 40 files, depth 6; no code execution. Documentation-like files inside the root are readable **including dotfiles** with allowed extensions (e.g. `.secret-notes.md`); use a docs-only root if the workspace holds sensitive Markdown.

**GitHub source limits:** `https://github.com/<owner>/<repo>` (or a `/tree/<ref>/<path>` URL) only; **public repositories only** — private repositories are deliberately not fetched. Documentation-like files (`.md`, `.txt`, `.rst`, … — the same allowlist as local files) are read through the GitHub API and raw content endpoints; max 40 files / 800 KB per file / 1.4 MB total / depth 6; overall ingestion deadline of 60 s; submodules are never followed; nothing is cloned, executed, or installed. Repos are read docs-first (root README, then `docs/`-like directories). Unauthenticated GitHub API access is rate-limited to 60 requests/hour per IP — `SKILLFORGE_GITHUB_TOKEN` in `.env` only raises that rate limit for public repositories (it is sent to api.github.com only and never grants private-repo access). Truncation is honest: skipped/omitted files are listed as notes in the generation log and the results panel.

## What it does

| Stage | Behavior |
| --- | --- |
| **Source** | One of the five input types above. Adapter notes — truncation, skipped files, followed redirects — are surfaced per-note in the generation log, in a "Source notes" panel, and persisted with the skill; skipping is never silent. |
| **Analyze** | Deterministic line-based extraction: sections, fenced code, shell commands, ordered procedures (≥3 steps), warnings, constraint statements. Every extraction keeps exact source line numbers. |
| **Generate** | A provider turns the analysis into a validated skill plan; a shared builder produces the canonical package. The default provider is deterministic and offline; an OpenAI-compatible adapter (GLM, etc.) is available via env config. |
| **Validate** | A fixed registry of deterministic checks (see below). Warnings don't block export; errors do. The UI never claims success for skipped validation. |
| **Preview** | Inspect every generated file with its purpose and provenance before exporting. Provenance records are clickable and show the exact source lines (verbatim, never reconstructed). Generated files can be edited in place before export: edits are persisted, marked `user-edited` (their source provenance is dropped honestly), manifest hashes are resynchronized, and deterministic validation re-runs — failing edits block export. Generated skills persist on disk (`.data/skills/`) and survive server restarts. |
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

Validation is deterministic — same package in, same report out, no model calls. The checks: required files; safe & unique paths (zip-slip/traversal); well-formed YAML front matter; valid `name` slug and `description`; canonical metadata consistency (SKILL.md front matter `name` and the manifest's `name`/`displayName`/`description`/`version`/`generator` must equal the canonical metadata — body text is editable, package identity is not); no empty sections; resolving internal links; parseable JSON; manifest↔package consistency; no placeholder text (`TODO`, `FIXME`, …); no empty files; duplicate IDs; eval integrity (unique ids, usable prompt/expectation, known kinds); provenance integrity (every file traceable, valid line ranges; user-edited files are honestly reported as no longer source-derived); SKILL.md size; unsupported export targets; and command grounding (shell commands in generated files must trace back to the source — unverifiable grounding is reported as *not verified*, never as passed).

The report states `passed`, `executed`, per-check status, file locations, and actionable messages. Warnings (e.g. placeholders, untraceable commands) do not block export; errors do — the export endpoint re-runs validation and refuses failing packages.

## Providers

- `mock` (default): deterministic, offline, no key. Same source ⇒ byte-identical package.
- `glm` / `openai`: OpenAI-compatible chat-completions adapters. Model output must parse against the skill-plan schema; malformed output fails with an actionable error instead of entering the package. Configure via `.env` (see `.env.example`). The adapters are covered by deterministic tests with injected transport; actual compatibility depends on the configured endpoint and model — use `npm run verify:provider` with your credentials to validate a live configuration.

### Verifying a provider

```bash
npm run verify:provider
```

Runs one small bounded generation through the configured provider (`SKILLFORGE_PROVIDER`, `SKILLFORGE_API_KEY`, optional `SKILLFORGE_BASE_URL` / `SKILLFORGE_MODEL`), schema-checks the plan, builds the canonical package, and runs deterministic validation — exiting nonzero on failure with actionable diagnostics. The API key is never printed. Without any configuration it verifies the offline demo provider, so the harness itself needs no key. The harness is covered by deterministic tests with injected transport.

## Limitations

- URL ingestion is single-page and supports server-rendered text/HTML: no crawling, no page-JavaScript execution; JS-only pages may return `url_no_content` (an honest failure, never an empty skill).
- The grounding check is heuristic (token overlap), not proof of correctness; review generated skills.
- GitHub source reads **public repositories' documentation only** (private repositories are deliberately unsupported); refs with slashes in `/tree/` URLs take the first segment as the ref; API rate limits apply as described above.
- The `glm`/`openai` providers require you to supply a key; live compatibility is not guaranteed by the test suite — validate your configuration with `npm run verify:provider`.
- Evals are generated as manual grounding checks; SkillForge does not execute them.
- PDF ingestion is not implemented.
- SkillForge has no built-in authentication; see the deployment scope above before binding beyond loopback.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the module map, [docs/CANONICAL_FORMAT.md](docs/CANONICAL_FORMAT.md) for the package format, and [docs/EXPORTERS.md](docs/EXPORTERS.md) for exporter contracts.
