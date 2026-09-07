# Production Readiness — Remediation Status

## Branch
feature/production-readiness-remediation (based on feature/production-readiness @ b6be8d3)

## Last updated
2026-09-07T07:30:00Z (final report)

## Current phase
All remediation phases complete.

## Current status
READY_FOR_PR

## Last known good commit / Last pushed commit
Final HEAD of this branch (see `git log --oneline -10`; final commit is the status-file
checkpoint). HEAD was pushed and the remote branch moved; verify with
`git status` (clean) and `git log origin/feature/production-readiness-remediation -1`.

## Baseline verification (this remediation run)
- npm ci: OK
- npm test: 166 passed, 0 failed (matches audited baseline)
- npm run typecheck / build / demo: PASS
- npm audit at baseline: 3 moderate (qs ≤ 6.15.3 via body-parser 1.20.6 / express 4.22.2)

## Completed
- Bootstrap: branch created from latest remote feature/production-readiness, pushed.
- Phase 1 — canonical metadata consistency: new `canonical-metadata-consistency` check
  (17 checks total). Fails when SKILL.md front matter `name` ≠ `skill.meta.name`, or when
  manifest `name`/`displayName`/`description`/`version`/`generator` ≠ `skill.meta`.
  Body-only edits stay valid. tests/canonical-metadata.test.ts (5 tests) covers: body-only
  edit valid; different-but-valid front-matter name fails; inconsistent manifest field fails;
  export 422 while inconsistent; repair restores validation/export; ZIP metadata consistent.
  tests/validate.test.ts fixture now uses the real `manifestFor` builder.
- Phase 2 — source notes end to end: `SourceInput.notes` (optional) → merged by
  `normalizeSource` into `NormalizedSource.notes` (which already flow into manifest.json
  `source.notes`) → pipeline emits one `source-note` event per note and puts `sourceNotes`
  on the result event → app.ts persists `source.notes` (optional field, backwards compatible)
  → UI shows notes live in the progress log and in a persisted "Source notes" panel
  (safe textContent rendering). One shared path, no per-source duplication.
  tests/source-notes.test.ts (3 tests): GitHub file-count truncation (stream + persisted),
  GitHub tree truncation note, local skipped-subdirectory note; notes never fail validation.
- Phase 3 — public-repositories-only policy: 404 error now states "SkillForge reads public
  repositories only" and never suggests a token grants private access; UI hint, README limits
  + limitations, and .env.example describe SKILLFORGE_GITHUB_TOKEN purely as a rate-limit
  raise for public repositories (api.github.com only, never sent to raw hosts). New test
  asserts the error text; token-confinement test already existed and still passes.
- Phase 4 — actual-byte total bound: `fetchRawFile` now returns ok / too_large /
  unreachable distinctly; post-fetch checks enforce maxFileBytes and maxTotalBytes against
  the real body (metadata `size` is only a pre-filter); `totalBytes` accounting includes the
  synthetic `# path` header overhead, so the combined source can never exceed the cap.
  Deterministic ordering unchanged. 2 new tests (missing + underreported sizes; per-file skip).
- Phase 5 — overall ingestion deadline: `overallTimeoutMs` (default 60 s,
  GITHUB_OVERALL_TIMEOUT_MS) drives a shared AbortSignal combined with every per-request
  timeout via `AbortSignal.any` on all api.github.com and raw requests — nothing can outlive
  the budget and no fetch dangles. Deadline aborts surface as typed
  `github_deadline_exceeded` with actionable scope advice. 2 new tests (hanging fetches +
  250 ms budget → typed error fast; sufficient budget → normal deterministic order).
- Phase 6 — dependency triage: advisories GHSA-x5fp-wj9c-mxmx + GHSA-4mjr-xmp4-gh2g
  (moderate, qs ≤ 6.15.3, transitive via body-parser 1.20.6 which pins qs 6.15.3 exactly;
  also reachable via supertest, dev-only path). `npm audit fix` cannot resolve; upgrading
  express → 5 would NOT fix it (express 5.2.1 pins qs 6.13.0, still vulnerable) and is a
  larger migration. Fix: targeted `overrides: { "qs": "^6.16.0" }` (same-major patched
  release; body-parser 2.x itself requires ^6.15.2, so 6.16.0 is in the tested line).
  Result: `npm audit` → **0 vulnerabilities**; full suite re-verified against the override.
- Phase 7 — docs reconciled: README (179 tests, 17 checks + description of the new check,
  source-notes behavior, public-only policy, 60 s deadline), ARCHITECTURE.md (17 checks),
  PROJECT_STATUS.md (state, counts, GitHub bullet), TASKS.md (new "Remediation run" section),
  .env.example (token wording).
- Phase 8 — full release audit + clean-state verification + browser verification (below).

## In progress
- (nothing)

## Remaining
- (nothing mandatory) Stretch ideas only: SSE progress/cancellation, accessibility pass,
  store management UI.

## Important decisions
- qs remediation via npm `overrides` (targeted, same-major) instead of an express 5
  migration, which would not remove the advisory.
- Canonical-identity policy: users may edit body text; identity fields (front matter name,
  manifest identity) must match `skill.meta` — contradictions are validation errors, not
  warnings, and therefore block export.
- Source notes use one shared channel (adapter → SourceInput.notes → NormalizedSource.notes)
  instead of per-source plumbing; persisted `source.notes` is optional so previously stored
  skills still load.
- Deadline implemented with a shared AbortSignal + AbortSignal.any, not a redesign.

## Files changed (remediation, aggregate)
package.json + package-lock.json (qs override), src/core/validate.ts (new check),
src/core/types.ts + ingest.ts + pipeline.ts, src/server/app.ts + store.ts (notes),
src/core/sources/github.ts (policy + byte bounds + deadline),
web/app.js + index.html + styles.css (notes rendering, policy hint),
tests/canonical-metadata.test.ts, tests/source-notes.test.ts, tests/github-source.test.ts,
tests/validate.test.ts, README/ARCHITECTURE/PROJECT_STATUS/TASKS/.env.example,
docs/PRODUCTION_READINESS_STATUS.md.

## Tests run (final numbers)
- npm test: **179 passed, 0 failed** (166 baseline + 5 canonical-metadata + 3 source-notes
  + 1 public-only policy + 2 actual-byte bound + 2 deadline)
- npm run typecheck / build / demo / verify:provider: all PASS
- npm audit: **0 vulnerabilities** (was 3 moderate)
- Full clean-state sequence run: `rm -rf node_modules && npm ci` + all gates → green.

## Known failures / blockers
- (none blocking)
- Live glm/openai provider verification remains unexecuted (no credentials in this
  environment); `npm run verify:provider` passes offline with the mock provider. Never
  claimed otherwise.

## Browser verification evidence (in-app browser, real dev server, 12 checks)
1. Bundled sample: generated, "Validation passed — 17 deterministic checks, 0 warning(s)".
2. Pasted text: generated, validation passed (17 checks).
3. URL source (raw koa History.md): generated, validation passed (17 checks).
4. Local file source (docs/CANONICAL_FORMAT.md): generated, 29 checks / 13 warnings passed.
5. Public GitHub repo (koajs/koa): generated from 22 files, validation passed (17 checks).
6. Source notes visible: per-note progress lines ("Read 22 documentation file(s) from
   koajs/koa@master.", HTML-strip note) AND persisted "Source notes" panel rendered.
7. Provenance click-through: dialog opened with exact lines "175–177 of 8419".
8. Body edit: saved, "user-edited" marker shown, validation re-rendered (1 honest warning).
9. Inconsistent front matter (`name: totally-different-skill`): validation failed with
   1 error and export buttons switched to "Export blocked (validation errors)".
10. Repair (restore `name: readme-md`): validation passed, "Download ZIP" offered again.
11. ZIP (exported via API, 25 entries): front matter `name: readme-md`, manifest
    `name: readme-md`, displayName/generator consistent, 24 files listed, source notes
    present in manifest.source.notes.
12. Persisted reload: `source.notes` retained, `userEdited: ["SKILL.md"]` retained,
    front matter `name` == meta `name` == `readme-md`, validation passed.

## Exact resume instructions
1. `git fetch origin && git switch feature/production-readiness-remediation && git pull --ff-only`
2. `npm ci && npm test && npm run typecheck && npm run build && npm run demo && npm run verify:provider && npm audit`
3. Open the PR (instructions below). Do not merge automatically.

## Final verdict
READY_FOR_PR

- Branch: feature/production-readiness-remediation
- HEAD: see `git log -1` (pushed; tree clean)
- Comparison base: feature/production-readiness (b6be8d3); eventual target: main
- Verification: 179/179 tests, typecheck/build/demo/verify:provider pass, npm audit 0
  vulnerabilities, GitHub Actions green on the branch, 12-point browser verification recorded above
- Known non-blocking limitations: live provider verification not executed (no credentials);
  GitHub ingestion is public-repos-only by design; `/tree/` refs with slashes take the first
  segment as the ref.

### Suggested PR
Title: `fix: close production readiness audit findings`
Body (sketch):
- Adds `canonical-metadata-consistency` validation (identity edits can no longer pass
  validation or export; body edits remain free).
- Propagates source-ingestion notes (truncation/skips/redirects) through the pipeline,
  persistence, manifest, and UI — skipping is never silent.
- Makes GitHub support claims accurate: public repositories only; the optional token is
  documented solely as a rate-limit raise and stays confined to api.github.com.
- Enforces GitHub total-size bounds on actual fetched bytes and adds a hard 60 s overall
  ingestion deadline (typed `github_deadline_exceeded`).
- Resolves all npm audit advisories via a targeted qs override (0 vulnerabilities).
- Docs reconciled with behavior; 179 tests, all gates + clean-state verification green.

Exact PR-opening instructions:
1. `gh pr create --base main --head feature/production-readiness-remediation --title "fix: close production readiness audit findings" --body-file <(the sketch above, expanded as needed)`
   (or open via the GitHub UI comparing `feature/production-readiness-remediation` → `main`).
2. Leave merging to a human; CI must be green on the PR before merge.
