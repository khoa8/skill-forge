# Production Readiness — Status

## Branch
feature/production-readiness

## Last updated
2026-09-07T04:05:00Z (baseline verified)

## Current phase
Phase 5 complete; starting Phase 6 — release hardening, docs reconciliation, full verification

## Current status
IN_PROGRESS

## Last known good commit
(see git log — Phase 5 commit)

## Last pushed commit
20ecfdb (Phase 4)

## Phase 1 verification (CI)
- .github/workflows/ci.yml added: pull_request + push (main, feature/production-readiness); Node 20; npm ci; typecheck/test/build/demo; permissions contents:read; concurrency cancel-in-progress; no secrets.
- YAML validated locally by parsing with the project `yaml` dependency (triggers/permissions/steps correct).
- Local equivalents of all four CI commands verified green in Phase 0 baseline.
- gh CLI is authenticated; Actions run will be inspected after push.

## Baseline verification
- npm install: OK (audit warnings only, no vulnerabilities blocking)
- npm test: PASS — 12 files, 117 tests passed, 0 failed (~1.5s)
- npm run typecheck: PASS (exit 0)
- npm run build: PASS (exit 0)
- npm run demo: PASS — both samples generated, 16-check validation passed, ZIPs exported and inspected (claude-code + generic exporters)
- Matches documented baseline (117 tests) exactly; no discrepancies found.

## Completed
- Phase 0: feature/production-readiness created from main (25c4376) and pushed
- Phase 0: status file created
- Phase 0: baseline verified (all four commands green)
- Phase 1: CI workflow added and YAML-validated; pushed for Actions run
- Phase 2A: src/core/sources/github.ts (bounded GitHub docs ingestion: URL parsing,
  default-branch resolution, tree fetch, extension/priority filtering, file/total/depth
  bounds, raw-content fetch with host validation, typed errors, optional token env var);
  SourceType extended with "github"; tests/github-source.test.ts (24 tests, all green)
- Phase 2B: API integration — GenerateBody sourceType+github and `repo` field, typed
  error→status mapping (400/404/422/429/502), unified PIPELINE_SOURCE_TYPE mapping;
  tests/api-github.test.ts (7 tests)
- Phase 2C: UI GitHub repo tab + generic tab-body toggling (fixes pre-existing bug where
  URL/Local-files panels never became visible); docs updated (README, ARCHITECTURE,
  TASKS, PROJECT_STATUS, .env.example); live smoke test vs koajs/koa passed
  (default branch master, 22 files, 311 KB, 9.2 s)
- Phase 3: provenance click-through — GET /api/skills/:id/provenance/excerpt returns the
  exact normalized-source lines a record references (deterministic re-normalization of the
  stored source, zod-validated query, 200-line cap, honest out-of-range 422); UI renders
  every provenance record as a clickable button opening a <dialog> with line-numbered
  verbatim excerpt + "verbatim, not generated" label; failures shown honestly (never
  fabricated). tests/provenance-excerpt.test.ts (6 tests). Browser-verified click-through
  from sample and pasted sources (line numbers match: 1–124 of 124; 1–18 of 18).
  Note: a stale dev server from a previous session held port 8787 and was killed.
- Phase 4: edit-before-export — POST /api/skills/:id/update-file (content-only edits,
  manifest.json excluded, 1 MB bound → 413, atomic write); file marked userEdited with
  provenance dropped (honest policy); manifest regenerated via extracted shared
  build.ts manifestFor() so hashes match; validation re-runs before serving; export gate
  blocks failing edits (422). UI: Edit/Save/Cancel, dirty state, user-edited markers,
  validation re-render. Fixed latent store race (unique tmp names). 5 new tests
  (tests/edit-before-export.test.ts) + full-suite stability confirmed (3 runs).
  Browser-verified: edit → save → user-edited markers → validation re-rendered (1 honest
  warning) → export still offered. Found+fixed JS syntax error caught by browser check.

## In progress
- Phase 5: provider verification harness — DONE:
  src/core/verify.ts (verifyProvider: bounded sample → normalize → analyze → provider.generate
  → PlanSchema re-check → buildCanonicalSkill → validatePackage; credential-free structured
  result) + scripts/verify-provider.ts CLI (env config, never prints the key, nonzero exit on
  failure) + `npm run verify:provider`. 6 tests with injected fetch (ok response, 401,
  schema-invalid plan, network error, offline mock). Offline CLI run verified: VERIFIED, exit 0.
  LIVE VERIFICATION NOT EXECUTED: no SKILLFORGE_API_KEY in this environment, no .env file;
  recorded honestly per task §7.

## Remaining
- Phase 3: provenance click-through UX
- Phase 4: edit generated files before export
- Phase 5: provider verification harness
- Phase 6: release hardening + docs reconciliation + full verification

## Important decisions
- GitHub adapter requests api.github.com (repo meta + one recursive tree call) and
  raw.githubusercontent.com for contents (avoids API rate limits for content; final
  URL host is validated). Optional SKILLFORGE_GITHUB_TOKEN is sent to api.github.com only.
- Bounds: 40 files / 800 KB per file / 1.4 MB total / depth 6 / 15 s per request —
  aligned with the local-file adapter. Truncation is honest (notes surfaced to the UI).
- WHATWG URL parsing normalizes dot-segments; unsafe paths from the API tree
  (../, absolute, backslash, submodules) are skipped with notes.
- Following the task-file checkpoint protocol; only the feature branch is used.

## Files changed in current phase
- docs/PRODUCTION_READINESS_STATUS.md
- .github/workflows/ci.yml
- src/core/types.ts (SourceType + "github")
- src/core/sources/files.ts (exported TEXT_EXTENSIONS)
- src/core/sources/github.ts (new)
- src/server/store.ts (updateFileContent/EditError, unique tmp names)
- src/server/app.ts (github sourceType, error mapping, unified type mapping, provenance
  excerpt endpoint, update-file endpoint)
- src/core/build.ts (extracted shared manifestFor)
- src/core/types.ts (SourceType + "github"; SkillFile.userEdited)
- tests/github-source.test.ts, tests/api-github.test.ts, tests/provenance-excerpt.test.ts,
  tests/edit-before-export.test.ts (new)
- web/index.html, web/app.js, web/styles.css (GitHub tab, generic tab toggling, provenance
  modal, edit mode)
- README.md, ARCHITECTURE.md, TASKS.md, PROJECT_STATUS.md, .env.example

## Tests run in current phase
- npm test: 165 passed (159 after Phase 4 + 6 verify-provider harness tests), 0 failed
- npm run typecheck / build / demo: pass after each checkpoint
- npm run verify:provider: exit 0 (offline mock, VERIFIED)
- Live smoke: fetchGithubSource("https://github.com/koajs/koa") → 22 files, 311 KB, OK
- Browser: provenance click-through verified from sample and paste sources; edit flow verified

## Known failures / blockers
- Live provider verification (glm/openai) NOT executed — no API key available in this
  environment. Harness fully tested offline with injected fetch. To run live:
  set SKILLFORGE_PROVIDER/SKILLFORGE_API_KEY (+ optional BASE_URL/MODEL) and `npm run verify:provider`.

## Exact resume instructions
1. `git fetch origin && git switch feature/production-readiness && git pull --ff-only`
2. Read this file; compare with `git log --oneline -10`.
3. Resume at the first incomplete acceptance criterion of the current phase per the task file.

## Next intended action
Commit + push Phase 5, then run Phase 6 (full diff audit, docs reconciliation, clean
dependency verification, browser smoke test across all five source types, final status).
