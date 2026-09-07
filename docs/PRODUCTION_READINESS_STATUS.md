# Production Readiness — Final Release Status

## Branch

Released to `main` via PR #1.

Historical path (for the record — the remediation branch was fast-forwarded into
`feature/production-readiness` after independent audit, then merged):

```text
feature/production-readiness-remediation
        ↓ fast-forwarded
feature/production-readiness
        ↓ PR #1 (merged 2026-09-07, post-merge CI run 34109540258: success)
main
```

## Last updated

2026-09-07 — reconciled to the merged state (PR #1 complete; release no longer pending).

## Current phase

Released. Production-readiness implementation, remediation, PR review, and merge are complete.
Post-merge CI on `main` is green.

## Current status

`RELEASED_TO_MAIN`

## Release PR (historical record)

- PR: #1 — `feat: production readiness release` — **merged**
- Base: `main`
- Head: `feature/production-readiness`
- Merge commit: `8094b2d` (`feat: production readiness release (#1)`)

## Final verification baseline

At the audited release-candidate code HEAD:

- `npm ci`: PASS
- `npm test`: **187 passed, 0 failed** across 19 test files
- `npm run typecheck`: PASS
- `npm run build`: PASS
- `npm run demo`: PASS
- `npm run verify:provider`: PASS with the offline mock provider
- `npm audit`: **0 vulnerabilities**
- deterministic validation: **17 checks**

Live GLM/OpenAI provider verification was not executed because credentials were unavailable. No live-provider compatibility claim is made beyond unit/injected-fetch coverage.

## Production-readiness work completed

### CI

`.github/workflows/ci.yml` runs the quality gate on pushes and pull requests:

- `npm ci`
- typecheck
- tests
- build
- demo

The workflow uses minimal read permissions, bounded runtime, and concurrency cancellation.

### GitHub documentation source

GitHub repository ingestion is implemented as a bounded, documentation-only source:

- public repositories only
- `github.com` repo/tree URLs only
- no cloning, installation, or execution
- submodules are never followed
- docs-first deterministic ordering
- max 40 files
- max 800 KB per file
- max 1.4 MB final combined UTF-8 source
- max path depth 6
- 15 s per-request timeout
- 60 s overall ingestion deadline, including response-body reads
- optional `SKILLFORGE_GITHUB_TOKEN` is sent only to `api.github.com` and only raises rate limits for public repositories

The final total-byte bound uses the same combined representation for projection and returned content, including single-file input, synthetic path headers, separators, trailing-whitespace normalization, and multibyte UTF-8 accounting.

### Source notes

Adapter notes such as truncation and skipped-file information propagate through:

`adapter → SourceInput.notes → normalized source → pipeline events/result → persisted skill → UI → manifest.json`

They remain preserved after generated-file edits and in exported ZIP manifests.

### Exact-line provenance

Generated provenance records can be opened through the API/UI to inspect the exact persisted source lines. Invalid ranges fail honestly instead of reconstructing guessed source text.

### Generated-file editing

Existing generated text files can be edited before export:

- edits persist atomically
- edited files are marked `userEdited`
- source provenance for edited files is removed honestly
- `manifest.json` is regenerated
- hashes remain synchronized
- source notes remain preserved
- validation re-runs before the changed state is served
- invalid edits block export until repaired

### Canonical metadata consistency

The validator now enforces canonical package identity:

- `SKILL.md` front-matter `name` must match canonical skill metadata
- manifest identity fields must match canonical metadata
- body-only edits remain allowed
- inconsistent identity blocks export
- repairing the identity restores export eligibility

### Provider verification harness

`npm run verify:provider` performs one bounded generation through the configured provider, validates the returned plan schema, builds the canonical package, and runs deterministic validation. Diagnostics do not expose API keys.

### Dependency remediation

The baseline dependency tree resolved vulnerable `qs@6.15.3` through transitive consumers.

`body-parser@1.20.6` declares `qs: ~6.15.1`. The project intentionally applies a pinned security override:

```json
"overrides": {
  "qs": "6.16.0"
}
```

`6.16.0` is outside body-parser's declared `~6.15.1` tilde range. This is a deliberate security override, not a claim of declared-range compatibility. The installed tree is validated by the full application suite and `npm audit` reports 0 vulnerabilities.

## Regression coverage

The current suite covers, among other release-critical cases:

- canonical metadata mismatch and repair/export flow
- source-note propagation and persistence
- source notes surviving edits/exported manifest regeneration
- GitHub URL parsing and host safety
- public-only repository policy
- token confinement to `api.github.com`
- inert treatment of imported repository text
- file-count, depth, per-file, and total-byte limits
- missing and underreported GitHub metadata sizes
- exact multi-file header/separator byte accounting
- single-file trailing-whitespace total-cap regression
- multibyte UTF-8 byte accounting
- overall deadline on stalled fetches
- overall deadline on stalled raw response bodies
- overall deadline on stalled API JSON bodies
- typed `github_deadline_exceeded` behavior
- generated-file edits, manifest hashes, validation gating, and ZIP export
- exact-line provenance excerpts
- provider verification harness behavior

## Browser verification

The production-readiness run exercised:

1. bundled sample generation
2. pasted text
3. URL source
4. local files
5. public GitHub repository source
6. source-note rendering and persistence
7. provenance click-through
8. generated-file editing
9. canonical metadata failure and export blocking
10. canonical metadata repair and export restoration
11. ZIP inspection
12. persisted reload

## Known non-blocking limitations

- live GLM/OpenAI provider verification was not executed
- GitHub ingestion supports public repositories only
- `/tree/` refs containing slashes use the first path segment as the ref
- grounding is heuristic token overlap, not proof of correctness
- generated evals are manual grounding checks and are not executed by SkillForge
- PDF ingestion is not implemented
- no built-in multi-user authentication or tenant isolation (local / trusted
  self-hosted deployment model; non-loopback binds print an explicit warning)

## Final release flow (completed)

The release path was:

```text
feature/production-readiness-remediation
        ↓ fast-forwarded
feature/production-readiness
        ↓ PR #1 — merged to main (2026-09-07)
main
```

The release is merged; there is no pending integration step. Post-merge CI on `main`
(run 34109540258) is green. Remaining work items are product backlog (see `TASKS.md`),
not release blockers.

## Post-release hardening pass (feature/production-hardening)

An independent audit of the production-critical boundaries followed the merge. Confirmed
defects were fixed with regression coverage:

1. **Streaming byte caps on response bodies** — URL pages and GitHub raw files are read
   with the byte cap enforced *while* the body streams (`src/core/sources/body.ts`);
   oversized or content-length-lying responses are torn down mid-read instead of being
   buffered to completion first. api.github.com JSON bodies carry a generous 10 MB cap.
   Deadline and exact final-size guarantees are preserved (the abort signal is raced into
   the reader).
2. **Terminal Express error handler** — malformed JSON bodies return 400 JSON, oversized
   bodies return 413 JSON, unexpected errors return a generic 500; stack traces and error
   internals never reach the client (previously the default Express handler leaked them in
   development mode).
3. **NDJSON disconnect guard** — generation stops when the client disconnects, and
   EPIPE/ECONNRESET after disconnect can no longer raise unhandled stream errors.
4. **Non-loopback binding warning** — binding `HOST` to a non-loopback address prints an
   explicit no-authentication warning at startup (silenced only by
   `SKILLFORGE_ACKNOWLEDGE_EXPOSURE=1`); the supported model is documented as local /
   trusted self-hosted use, not an Internet-facing multi-user SaaS.

CI additionally enforces `npm run verify:provider` (pinned to the offline mock provider —
CI can never reach a paid provider) and a strict `npm audit` gate (fails on any advisory
at low severity or above).
