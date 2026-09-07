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
See the "Final verdict" section at the end of this file — it always names the actual final
HEAD and the latest CI run. (Earlier interim SHAs such as 802a19f are historical.)

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
  (moderate, qs versions through 6.15.3) hit the transitive qs resolved at baseline
  (6.15.3 via body-parser under express 4.22.2; also reachable via supertest, dev-only
  path). `npm audit fix` could not resolve it. Fix: targeted
  `overrides: { "qs": "^6.16.0" }` — the installed lockfile now resolves qs 6.16.0 for all
  consumers (verified with `npm ls qs`), `npm audit` reports **0 vulnerabilities**, and the
  full suite passes against that tree. (Exact declared ranges and further detail are in the
  "Dependency situation" section of the Final verdict.)
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
- npm test: **184 passed, 0 failed** (179 after the first remediation pass + 2 hard-bound
  replacements/1 rework in the bound tests, + 2 body-stall deadline tests, + 1 note-survival
  integration test; net 179 → 184)
- npm run typecheck / build / demo / verify:provider: all PASS (re-run after the
  final-audit fixes, from a clean `npm ci`)
- npm audit: **0 vulnerabilities** (was 3 moderate)
- Full clean-state sequence run: `rm -rf node_modules && npm ci` + all gates → green.

## Known failures / blockers
- (none blocking)
- Live glm/openai provider verification remains unexecuted (no credentials in this
  environment); `npm run verify:provider` passes offline with the mock provider. Never
  claimed otherwise.

## Browser verification evidence (in-app browser, real dev server, 12 checks; recorded at
the first remediation pass — the final-audit fixes touch byte projection, manifest note
preservation, and deadline error mapping, none of which change these UI flows)
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

Note: the CI workflow triggers on main, feature/production-readiness, and this branch
(commit 802a19f added the trigger), so the PR run will execute automatically.

## Final verdict
READY_FOR_INTEGRATION_PR

- Branch: feature/production-readiness-remediation
- Verified code HEAD: cb94ab3 ("fix(github): make maxTotalBytes a hard cap and cover body
  reads with the deadline") with 4a63f8c ("fix(store): preserve ingestion notes in the
  manifest across edits") — all code changes; CI ran green over them.
- Final HEAD of the branch: `git rev-parse HEAD` (docs-only commits after the code HEAD;
  the last one is e979104). Tree clean, everything pushed.
- Comparison base for the integration PR: feature/production-readiness (b6be8d3)
- Verification: 184/184 tests, typecheck/build/demo/verify:provider pass (clean `npm ci`),
  npm audit 0 vulnerabilities, GitHub Actions green at the final HEAD
- Known non-blocking limitations: live provider verification not executed (no credentials);
  GitHub ingestion is public-repos-only by design; `/tree/` refs with slashes take the first
  segment as the ref.

### Final-audit fixes applied after the first remediation pass
- maxTotalBytes is now a real hard bound on the FINAL combined source: the fetch loop
  projects each file's exact contribution using the same chunk formatter the combination
  step uses (`combinedFileChunk`/`combinedChunkBytes`), rejects before accepting, and the
  metadata-based total pre-check was removed (metadata `size` may be missing/wrong and must
  not gate the total). Tests assert `combinedBytes <= maxTotalBytes` with NO tolerance,
  including: missing size, underreported size, content-fits-but-header-crosses-cap,
  boundary-adjacent multi-file sets, and honest stop notes.
- Edits preserve ingestion notes: `updateFileContent` passes the persisted
  `existing.source.notes` into `normalizeSource` when regenerating manifest.json, so the
  manifest's `source.notes` keeps the original adapter notes after any edit. Integration
  test: GitHub file-limit note → generate → edit references file → persisted API response
  and exported ZIP manifest both retain the identical note.
- The overall deadline now covers response-BODY consumption: all three body reads
  (repo metadata JSON, tree JSON, raw text) go through `readBodyWithDeadline`, which throws
  typed `github_deadline_exceeded` when the overall budget fires mid-body, cancels the
  stalled reader, and keeps distinct typed errors for per-request timeouts/network failures
  vs the overall deadline. Tests: raw-body stall and API-JSON-body stall both map to the
  typed error within a 250 ms budget (no real-second waits).

### Dependency situation (stated exactly as verified)
- The transitive `qs` dependency (via body-parser under express 4.22.2, and also reachable
  via supertest on the dev side) resolved to qs 6.15.3 at baseline, which falls inside the
  audited vulnerable range (GHSA-x5fp-wj9c-mxmx, GHSA-4mjr-xmp4-gh2g).
- body-parser 1.20.6 declares `qs: ~6.15.1` (a tilde range — NOT an exact pin).
- The project adds `overrides: { "qs": "^6.16.0" }`; the installed lockfile resolves
  qs 6.16.0 everywhere (verified via `npm ls qs`: "overridden" root, deduped in
  body-parser). 6.16.0 is inside the `~6.15.1` range body-parser declares, i.e. within the
  dependency's own declared compatibility line.
- `npm audit` reports 0 vulnerabilities, and the full suite (184 tests) passes against that
  tree. No claims are made about hypothetical express upgrades.

### Suggested integration PR (do NOT target main from this branch)
Title: `fix: close production readiness audit findings`
Exact base/head:
```bash
gh pr create \
  --base feature/production-readiness \
  --head feature/production-readiness-remediation \
  --title "fix: close production readiness audit findings"
```
`feature/production-readiness` remains the integration/release-candidate branch: after this
PR is merged there, the complete `feature/production-readiness → main` diff receives its
final release audit and its own PR. Do not open or merge that PR as part of this task.

### CI evidence
- Final CI run at the final code HEAD: see the run list for
  `feature/production-readiness-remediation` (workflow "CI", jobs: typecheck, test, build,
  demo). The final push of this branch triggers a fresh run; its result is recorded here:
  run id 34103762013 — success (44 s) at 21407c8. The preceding code commits also ran
  green: run 34099521795 (success) and the first-audit runs 34099409998/34099521795.
