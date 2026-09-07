# SkillForge — Tasks

Done items are checked. Priorities follow AGENTS.md/GOAL.md ordering.

## P0 — MVP pipeline (complete, regression baseline)

- [x] Project scaffold: TypeScript ESM, Express, zod, yaml, jszip, vitest
- [x] Canonical skill model (zod-validated) + provenance records
- [x] Ingestion/normalization (line endings, HTML strip, entities, size bounds)
- [x] Deterministic line-based analyzer (sections, code, commands, procedures, warnings)
- [x] Mock provider (offline, deterministic) + shared canonical builder
- [x] Deterministic validator; real ZIP with sanitized paths; claude-code + generic exporters
- [x] HTTP API with NDJSON pipeline streaming; validation-gated export (422)
- [x] Web UI: stepper, sources, file inspector w/ provenance, validation panel, real download
- [x] Bundled samples + `npm run demo` CLI with ZIP inspection
- [x] Verified in a real browser: full no-key Source→Validate→Export workflow + download

## P1 — continuation (this session)

- [x] **URL source** with safe limits: protocol allowlist, SSRF guard (name + DNS, per-redirect), redirect cap, size/time caps, content-type allowlist, HTML→text conversion without JS execution, honest empty-content failure
- [x] **Local file/directory source**: `SKILLFORGE_DOCS_ROOT` allowlist root, realpath containment (symlink escape refused), extension allowlist, size/count/depth bounds, multi-file combining
- [x] **File-backed persistence**: `.data/skills/<id>/skill.json`, atomic writes, zod-validated reads, newest-50 eviction; verified across server restart
- [x] **Stronger validators** (14 → 16): eval-integrity, provenance-integrity
- [x] **UI for new sources**: Samples/Paste/URL/Local files tabs with per-type button states; browser-verified generation + download from a directory source
- [x] **Link neutralization** in verbatim excerpts (multi-line labels); found via live koa README, regression-tested
- [x] dist-mode static serving (`findWebDir`), MIT license, export-blocked UI dedup

## P1.5 — production readiness run (feature/production-readiness)

- [x] GitHub Actions CI quality gate (`npm run typecheck` / `test` / `build` / `demo` on every push/PR)
- [x] **GitHub repository source**: `src/core/sources/github.ts` — repo/tree URL parsing, default-branch resolution, single recursive-tree request, docs-first priority ordering, extension allowlist, 40-file/800 KB-per-file/1.4 MB-total/depth-6 bounds enforced on actual fetched bytes, 15 s per request + 60 s overall deadline (typed `github_deadline_exceeded`), raw.githubusercontent.com content fetch with final-host validation, typed errors (invalid URL, unsupported host, not found, ref not found, no docs, rate limited, fetch failed, deadline exceeded), **public repositories only** — optional `SKILLFORGE_GITHUB_TOKEN` is a rate-limit raise for public repos (api.github.com only), submodules never followed, no cloning/execution; 34 new tests (unit + API)
- [x] UI fix: source tab bodies now toggle generically (URL/Local files panels had stayed hidden)
- [x] **Provenance click-through**: `GET /api/skills/:id/provenance/excerpt` returns the exact
  normalized-source lines a record references (deterministic re-normalization, bounded ranges with
  clearly-labeled partial excerpts, honest 422 on out-of-range); UI provenance records open a dialog
  with the verbatim, line-numbered excerpt labeled "verbatim, not generated"
- [x] **Edit before export**: `POST /api/skills/:id/update-file` — content-only edits to existing
  text files (manifest.json excluded), 1 MB per-file bound, atomic store write, file marked
  `userEdited` with its provenance records dropped (honest: no longer claimed as source-derived),
  manifest.json regenerated via shared `manifestFor` so hashes never drift, deterministic
  validation re-run before the new state is served; export gate re-validates, so failing edits
  cannot be downloaded (422); store tmp writes use unique names (concurrent-write hardening)
- [x] **Provider verification harness**: `npm run verify:provider` (`src/core/verify.ts` +
  `scripts/verify-provider.ts`) — env-configured provider, one bounded generation, plan schema
  re-check, canonical build, deterministic validation, credential-free reporting, nonzero exit
  on failure; offline by default (mock), tested with injected fetch; live glm/openai run not
  executed (no key in this environment — recorded honestly in docs)

## Remediation run (feature/production-readiness-remediation)

- [x] `canonical-metadata-consistency` validator: SKILL.md front matter `name` and manifest
  `name`/`displayName`/`description`/`version`/`generator` must equal `skill.meta` — body text
  is editable, canonical package identity is not; contradictions fail validation (and export)
- [x] Source-note propagation: adapter notes (truncation, skipped files, redirects) flow through
  `SourceInput.notes` → `NormalizedSource.notes` → manifest, per-note `source-note` pipeline
  events, persisted `source.notes`, and a "Source notes" panel in the UI (safe text rendering)
- [x] GitHub ingestion is public-repositories-only: 404 errors and docs no longer imply
  `SKILLFORGE_GITHUB_TOKEN` enables private-repo access (it only raises the public-repo
  api.github.com rate limit)
- [x] GitHub total-size bound enforced on actual fetched bytes (metadata `size` is only a
  pre-filter); combined source cannot exceed the cap; skip notes state real sizes
- [x] GitHub ingestion bounded by an overall 60 s deadline (AbortController combined with
  per-request timeouts; typed `github_deadline_exceeded`)
- [x] Dependency advisories resolved: `overrides: { "qs": "^6.16.0" }` → `npm audit` reports
  0 vulnerabilities (express 5 would NOT have fixed it — it pins vulnerable qs 6.13.0)
- [x] Docs reconciled: validator count (17), test count (179), public-only GitHub policy,
  notes behavior, ingestion deadline, dependency status

## P1 — remaining backlog

- [x] GitHub repository source as a first-class type (repo URL → docs tree via API, no code execution)
- [x] Editing generated text in preview (P1 per AGENTS.md §14)
- [x] Provenance UX: click a provenance record to view the exact source lines
- [ ] SSE progress for slow (remote-provider) generations with cancellation
- [ ] Additional exporter (Codex or Cursor) after verifying its documented format
- [ ] Evals compatible with an external runner (keep manual execution in-scope)

## P2 — later

- [ ] PDF ingestion
- [ ] Multi-page documentation crawl (bounded, opt-in)
- [ ] Authenticated documentation sources
- [ ] LLM-assisted (non-deterministic) quality review supplementing the deterministic validator
- [ ] Skill diffing across regenerations

## Security notes (reviewed)

- File source reads files inside the allowlist root by design — including dotfiles with allowed extensions (e.g. `.secret-notes.md`). Documented: the root is the trust boundary; set `SKILLFORGE_DOCS_ROOT` to a docs-only directory for stricter isolation.
- `.env` itself is never readable (no extension match). Traversal, absolute-outside, and symlink escapes are refused (`file_outside_root`); store ids are slug-validated before touching `.data/`.
- ZIP entries are sanitized (zip-slip refused); export body fields are schema-validated (unknown fields dropped); oversized JSON bodies rejected by the 3 MB parser limit.

## Known defects / gaps (tracked, not hidden)

- Grounding check is token-overlap heuristic; can miss paraphrased hallucinations and warn on benign rephrases.
- `glm`/`openai` providers are implemented + unit-tested with injected fetch but not exercised against live APIs (no key available in this environment).
- URL source cannot render JavaScript-heavy pages; it reports `url_no_content` instead of guessing.

## Production hardening run (feature/production-hardening, post-merge)

- [x] Streaming byte caps: URL and GitHub raw bodies enforce their caps WHILE streaming
  (`src/core/sources/body.ts`) — oversized/content-length-lying responses are torn down
  mid-read instead of buffered to completion; api.github.com JSON bounded at 10 MB
- [x] Terminal Express error handler: malformed JSON → 400 JSON, oversized → 413 JSON,
  unknown → generic 500; no stack traces or error internals to clients
- [x] NDJSON disconnect guard: generation stops when the client leaves; EPIPE/ECONNRESET
  after disconnect cannot raise unhandled stream errors
- [x] Non-loopback binding warning: `HOST` beyond loopback prints an explicit
  no-authentication warning (silenced only by `SKILLFORGE_ACKNOWLEDGE_EXPOSURE=1`);
  deployment model documented (local / trusted self-hosted; not a multi-user SaaS)
- [x] CI strengthened: offline provider verification pinned to the mock provider, strict
  `npm audit` gate (fails on low-severity advisories or above)
