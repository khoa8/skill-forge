# Production Readiness — Remediation Status

## Branch
feature/production-readiness-remediation (based on feature/production-readiness @ b6be8d3)

## Last updated
2026-09-07T06:00:00Z (bootstrap + audit triage)

## Current phase
Phase 5 complete; starting Phase 7 — documentation reconciliation

## Current status
IN_PROGRESS

## Last known good commit
fix(github): bound repository ingestion latency

## Last pushed commit
b63dd00 (Phase 4)

## Baseline verification (this remediation run)
- npm ci: OK (installed cleanly)
- npm test: 166 passed, 0 failed
- npm run typecheck: PASS
- npm run build: PASS
- npm run demo: PASS (all samples validated, ZIPs inspected)
- npm audit at baseline: 3 moderate (qs advisory range 2.2.5–6.15.3 via body-parser 1.20.6 + express 4.22.2; supertest/superagent also depend on qs)

## Completed
- Bootstrap: remediation branch created from latest remote feature/production-readiness and pushed
- Phase 1: `canonical-metadata-consistency` validator added to CHECKS (17 checks total now).
  Fails when SKILL.md front matter `name` ≠ skill.meta.name, or when manifest
  name/displayName/description/version/generator ≠ skill.meta. Body-only edits remain valid.
  tests/canonical-metadata.test.ts (5 tests): unit pass/contradiction/manifest-field/body-edit
  + API flow (body edit valid → renamed front matter fails → export 422 → repair → export 200
  → ZIP metadata consistent). tests/validate.test.ts fixture now uses the real `manifestFor`
  builder (its old hand-written manifest lacked identity fields the new check compares).
  npm test: 171 passed.
- Phase 2: source notes propagate end to end. SourceInput gained optional `notes`; the file/
  URL/GitHub branches in app.ts now feed adapter notes into the pipeline input and persist
  them (store `source.notes`, optional for backwards compatibility). normalizeSource merges
  adapter notes with normalization notes → they land in manifest.json source.notes (already
  wired) and NormalizedSource-derived detail. Pipeline emits `source-note` events per note and
  includes `sourceNotes` on the result event. UI: progress log shows each note; results panel
  has a persisted "Source notes" box (safe textContent rendering, fetched from the skill API).
  tests/source-notes.test.ts (3 tests): GitHub file-count truncation (stream + persisted),
  GitHub tree truncation, local skipped subdirectory note; notes never fail validation.
- Phase 3: GitHub ingestion is now explicitly **public repositories only**. The 404 error no
  longer suggests a token grants private access (it states the public-only policy); UI hint,
  README limits + limitations, and .env.example now describe SKILLFORGE_GITHUB_TOKEN purely
  as a rate-limit raise for public repositories. Token confinement test already existed;
  new test asserts the not-found error states "public repositories only" and never suggests
  token-granted private access. Raw fetches remain unauthenticated by design.
- Phase 4: total-size bound now enforced on ACTUAL fetched bytes. fetchRawFile returns a
  distinguishable outcome (ok / too_large / unreachable) so skip notes are specific; post-fetch
  checks enforce maxFileBytes and maxTotalBytes against the real body (metadata `size` is
  only a pre-filter since it is optional and can be underreported); totalBytes accounting
  includes the synthetic `# path` header overhead so the combined source cannot exceed the cap.
  Ordering stays deterministic (docPriority + path). 2 new tests: missing/underreported metadata
  sizes with real bodies crossing the cap (stop + honest note + combined size under cap), and
  per-file underreported size skip note.
- Phase 5: hard overall ingestion budget. FetchGithubOptions.overallTimeoutMs (default 60 s,
  GITHUB_OVERALL_TIMEOUT_MS) drives a shared AbortSignal combined with each per-request timeout
  (AbortSignal.any) for every api.github.com and raw request — no fetch can outlive the budget.
  Deadline aborts surface as typed github_deadline_exceeded with actionable scope advice; raw
  fetch deadline aborts stop the loop with the same typed error (no dangling fetches, ordering
  unchanged). 2 new tests: hanging raw fetches + 250 ms budget → typed error well under the
  per-request timeout; sufficient budget → normal deterministic order.
- Phase 6 (early): npm audit triage —
  - Advisories: GHSA-x5fp-wj9c-mxmx + GHSA-4mjr-xmp4-gh2g (moderate) in qs ≤ 6.15.3, transitive via body-parser 1.20.6 (pins qs 6.15.3 exactly) under express 4.22.2; also reachable via supertest (dev).
  - `npm audit fix` cannot fix (no compatible patched release within pinned range). Upgrading to express 5 would NOT fix it either (express 5.2.1 pins qs 6.13.0, inside the vulnerable range) and would add migration risk.
  - Fix applied: targeted `overrides: { "qs": "^6.16.0" }` in package.json → qs 6.16.0 (patched release of the same major; body-parser 2.x itself requires ^6.15.2, so 6.16.0 is within the tested line).
  - Result: `npm audit` → **0 vulnerabilities**; full suite re-verified against the override (166 tests, typecheck, build, demo all green).
- Dependency commit: `chore(deps): resolve production readiness audit findings`

## In progress
- Phase 7: documentation reconciliation

## Remaining
- Phase 6: (done early — qs override; re-verify at Phase 8)
- Phase 8: full release audit + clean-state verification + browser verification + final verdict
- Phase 7: documentation reconciliation (README 148→actual count, limits, notes behavior)
- Phase 8: full release audit + clean-state verification + browser verification + final verdict

## Important decisions
- qs remediation via npm `overrides` (targeted, same-major patched release) instead of express 5 migration — express 5 does not resolve the advisory and is a larger breaking change.
- Status file carries forward the prior run's completion record only via git history; this file now tracks the remediation run exclusively.

## Files changed in current phase
- package.json (overrides), package-lock.json (qs 6.16.0), docs/PRODUCTION_READINESS_STATUS.md

## Tests run in current phase
- npm test: 179 passed (177 + 2 deadline tests), 0 failed
- npm run typecheck: pass
- npm run typecheck / build / demo: pass

## Known failures / blockers
- (none)

## Exact resume instructions
1. `git fetch origin && git switch feature/production-readiness-remediation && git pull --ff-only`
2. Read this file; compare with `git log --oneline -6`.
3. Resume at the first incomplete phase: Phase 2 (source-note propagation: adapter notes →
   pipeline events → persisted store → UI; per remediation task §Phase 2).

## Next intended action
Commit + push Phase 1, then implement source-note propagation with the required tests.
