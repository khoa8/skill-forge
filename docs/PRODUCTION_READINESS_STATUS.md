# Production Readiness — Status

## Branch
feature/production-readiness

## Last updated
2026-09-07T05:05:00Z (final report)

## Current phase
All mandatory phases (0–6) complete. No stretch goals attempted.

## Current status
DONE (with honestly recorded limits — see Known failures / blockers)

## Last known good commit
See `git log --oneline -12`; the final commit is the "docs: finalize production readiness report" checkpoint on top of the feature commit sequence below.

## Last pushed commit
Same as last known good commit — HEAD was pushed (verify with `git status` / `git log origin/feature/production-readiness -1`).

## Baseline verification (Phase 0)
- npm install: OK
- npm test: PASS — 12 files, 117 tests (matched the documented baseline exactly)
- npm run typecheck / build / demo: PASS
- No discrepancies between docs and actual behavior were found at baseline.

## Completed
- Phase 0: feature/production-readiness created from main (25c4376) and pushed; status file created; baseline verified.
- Phase 1: `.github/workflows/ci.yml` — typecheck + test + build + demo on every push (main + feature branch) and PR; Node 20; `npm ci`; `contents: read`; concurrency cancellation; no secrets. YAML validated locally; runs observed green on GitHub Actions (multiple runs, e.g. run id 34060607678).
- Phase 2 (A/B/C): first-class GitHub repository source.
  - `src/core/sources/github.ts`: repo/tree URL parsing + normalization, default-branch resolution, one recursive-tree API request, docs-first deterministic ordering (root README → docs-like dirs → root files → rest), extension allowlist (shared with the file adapter), hard bounds (40 files / 800 KB per file / 1.4 MB total / depth 6 / 15 s per request), raw.githubusercontent.com content fetch with final-host validation, typed errors (github_invalid_url, github_unsupported_host, github_not_found, github_ref_not_found, github_no_docs, github_rate_limited, github_fetch_failed), optional `SKILLFORGE_GITHUB_TOKEN` sent to api.github.com only. No cloning; submodules never followed; repository content is inert text only; truncation is reported in notes, never silent.
  - API: `sourceType: "github"` with `repo` field; typed error→status mapping (400/404/422/429/502); unified `PIPELINE_SOURCE_TYPE` mapping; `SourceType` extended with "github".
  - UI: "GitHub repo" tab with honest limits text; fixed a pre-existing bug where tab bodies toggled non-generically (URL and Local files panels never became visible).
  - Live smoke: `fetchGithubSource("https://github.com/koajs/koa")` → default branch master resolved, 22 docs files, 311 KB, ~9 s.
- Phase 3: provenance click-through. `GET /api/skills/:id/provenance/excerpt` returns the exact normalized-source lines a provenance record references (the stored raw source is re-normalized with the same deterministic function the pipeline used, so line numbers match exactly). Zod-validated query; ranges wider than 200 lines return a clearly-labeled partial excerpt (`partial: true`, `requestedEnd`, `excerptLimit`); a start beyond the source is refused honestly (422 `provenance_out_of_range`). UI: every provenance record is a button opening a native `<dialog>` with the verbatim, line-numbered excerpt and a "verbatim, not generated" label; failures are shown, never fabricated.
- Phase 4: edit generated files before export. `POST /api/skills/:id/update-file` (zod-validated body): content-only edits to existing text files (manifest.json excluded), 1 MB per-file bound (413 `edit_too_large`), atomic store write; the file is marked `userEdited` and its provenance records are dropped (honest policy: edited content is no longer claimed as source-derived; the validator's provenance-integrity check reports a warning, which does not block export); `manifest.json` regenerated via the shared `manifestFor` builder (extracted in build.ts, also used at build time) so hashes never drift; deterministic validation re-runs before the new state is served; the export gate re-validates server-side, so failing edits cannot be downloaded (422). UI: Edit/Save/Cancel, dirty-state hint, "user-edited" markers (✎ in list, meta text, badge), validation re-render after save.
  - Latent bug fixed during this phase: store tmp filenames were fixed (`skill.json.tmp`) and could collide under concurrent writes; they are now unique per write.
- Phase 5: provider verification harness. `src/core/verify.ts` + `scripts/verify-provider.ts` + `npm run verify:provider`. Env-configured (SKILLFORGE_PROVIDER / SKILLFORGE_API_KEY / SKILLFORGE_BASE_URL / SKILLFORGE_MODEL); one small bounded generation (≤6 KB sample) → plan schema re-check → canonical build → deterministic validation; credential-free reporting (key never printed or returned); nonzero exit on failure with actionable diagnostics; offline mock run needs no key. 6 tests with injected fetch.
- Phase 6: full diff audit against main (no secrets, no debug logs, no temp fixtures, no unbounded remote requests, no path-traversal or repo-code execution, no duplicate pipeline logic, schema validation on all new endpoints, no lying UI states); docs reconciled (README, ARCHITECTURE, TASKS, PROJECT_STATUS, .env.example); clean-dependency verification (`npm ci` + all gates) green; browser smoke test of all five source types + provenance click-through (wide partial + narrow exact) + edit + revalidation + ZIP export/inspection (24 entries, valid front matter, manifest present).

## In progress
- (nothing)

## Remaining
- Stretch goals (not attempted): SSE progress + cancellation; accessibility pass; store management UI.
- Live glm/openai provider verification (blocked on credentials, see below).

## Important decisions
- GitHub adapter uses api.github.com for metadata/tree (1–2 requests) and raw.githubusercontent.com for contents (no API rate-limit cost); final URL host validated; optional token only on api.github.com.
- Edit provenance policy: mark the file `userEdited`, drop its provenance records, surface a warning via provenance-integrity; provenance for unedited files is untouched.
- Provenance excerpts are always re-derived by re-normalizing the stored source with the pipeline's own deterministic function — never stored separately, never reconstructed client-side.
- `manifestFor` extracted into build.ts and shared by build and the edit path, so manifest hash resync cannot drift from the builder.
- WHATWG URL parsing normalizes dot-segments, so URL-level `../` traversal cannot survive; unsafe paths arriving from the GitHub API tree (../, absolute, backslash, submodules) are skipped with notes.
- Only the feature branch was used; main untouched; no force-push.

## Files changed in current phase (Phase 6)
- docs/PRODUCTION_READINESS_STATUS.md, TASKS.md (partial-excerpt wording), plus audit-only review of the whole branch diff.

## Tests run in current phase (final numbers)
- npm test: **166 passed, 0 failed** (117 baseline + 24 GitHub source + 7 GitHub API + 7 provenance excerpt + 5 edit-before-export + 6 verify-provider harness)
- npm run typecheck: clean
- npm run build: clean
- npm run demo: all samples validated + ZIPs inspected
- npm run verify:provider: exit 0 (offline mock, VERIFIED)
- Full sequence re-run after `npm ci` (clean dependency state): all green.
- Browser smoke (in-app browser, real server): all five source types generated and validated; provenance modal shows exact lines (e.g. 175–177 of 8419) and labeled partial excerpts for whole-source ranges; edit → save → user-edited markers → validation re-rendered → export still offered; ZIP exported via API and inspected (24 entries).

## Known failures / blockers
- **Live provider verification NOT executed**: no `SKILLFORGE_API_KEY` and no `.env` file exist in this environment. Per task §7 the harness was tested offline with injected fetch instead, and this gap is recorded honestly here and in README/PROJECT_STATUS. To run live: set SKILLFORGE_PROVIDER=glm|openai and SKILLFORGE_API_KEY (optionally BASE_URL/MODEL), then `npm run verify:provider`.
- Minor naming quirk (pre-existing behavior, not a regression): a GitHub-sourced skill's id derives from the source title (e.g. koa's README produced id `readme-md`); a follow-up could pass `requestedName` from the UI for repo sources.

## Exact resume instructions
1. `git fetch origin && git switch feature/production-readiness && git pull --ff-only`
2. `npm ci && npm test && npm run typecheck && npm run build && npm run demo`
3. Read `git log --oneline -12` and compare with this file; trust the repo over any chat context.
4. If continuing: open a PR from feature/production-readiness into main, or pick a stretch goal (§9 of the task file) and follow the same checkpoint protocol.

## Next intended action
Open a pull request from feature/production-readiness into main (all mandatory phases green, CI passing).
