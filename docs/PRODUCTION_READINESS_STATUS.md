# Production Readiness — Status

## Branch
feature/production-readiness

## Last updated
2026-09-07T04:05:00Z (baseline verified)

## Current phase
Phase 2 checkpoint A complete; starting checkpoint B (API integration)

## Current status
IN_PROGRESS

## Last known good commit
(see git log — checkpoint A commit)

## Last pushed commit
c4fa069 (CI workflow)

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

## In progress
- Phase 2B: API integration (sourceType=github) + integration tests

## Remaining
- Phase 2 remaining: API integration (B), UI + docs (C)
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
- tests/github-source.test.ts (new)

## Tests run in current phase
- npm test: 141 passed (117 baseline + 24 new GitHub source tests), 0 failed
- npm run typecheck: pass after each stage

## Known failures / blockers
- (none)

## Exact resume instructions
1. `git fetch origin && git switch feature/production-readiness && git pull --ff-only`
2. Read this file; compare with `git log --oneline -10`.
3. Resume at the first incomplete acceptance criterion of the current phase per the task file.

## Next intended action
Commit + push bootstrap checkpoint, then implement Phase 1 (.github/workflows/ci.yml).
