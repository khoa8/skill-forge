# SkillForge — Project Status

**Original sprint date:** 2026-09-03 (Asia/Ho_Chi_Minh)
**Current mode:** Production-readiness release **merged to `main`** (PR #1, post-merge CI green); production-hardening pass in progress on `feature/production-hardening`.
**State:** P0 complete and verified; P1 shipped; P1.5 production-readiness work and remediation complete and **merged to `main`** via PR #1 (post-merge CI run 34109540258: success). No known release blockers within the supported deployment model (local / trusted self-hosted single-user; not a hardened multi-user SaaS).

> There is no active wall-clock deadline. Do not restart P0; do not enter finalization prematurely.

## What works right now (verified)

- **P0 (regression baseline, re-verified green this session):** full no-key workflow **Source → Analyze → Generate → Validate → Preview → Export** in the browser; `npm run demo`; ZIP inspection.
- **P1 shipped:**
  - **URL source** (`src/core/sources/url.ts`): http/https only; SSRF guard (private/loopback/link-local refused by name and DNS, re-validated per redirect); ≤3 redirects; 1 MB/15 s caps; content-type allowlist; HTML→markdown-ish conversion without executing page JS; honest `url_no_content` for JS-rendered pages.
  - **Local file/directory source** (`src/core/sources/files.ts`): realpath containment inside `SKILLFORGE_DOCS_ROOT` (symlink escapes refused), extension allowlist, per-file/total size caps, depth/file-count bounds, multi-file combining with `# path` headers.
  - **File-backed store** (`src/server/store.ts`): skills persist under `.data/skills/<id>/skill.json` (atomic writes, zod-validated reads, newest-50 eviction). **Verified: skills survive a real server restart.**
  - **17 deterministic validators**: the original set plus `eval-integrity`, `provenance-integrity`, and `canonical-metadata-consistency`.
  - **UI:** five source tabs (Samples/Paste/URL/Local files/GitHub repo) with per-type validation and button states; browser-verified generation and real ZIP download.
  - **Link neutralization:** relative links inside verbatim excerpts render as paths, so exported packages never contain dangling internal references (found via live koa README; regression-tested).
- **P1.5 shipped (merged to `main` via PR #1):**
  - **CI quality gate** (`.github/workflows/ci.yml`): typecheck + test + build + demo on every push/PR, Node 20, `npm ci`, minimal permissions, concurrency cancellation.
  - **GitHub repository source** (`src/core/sources/github.ts`, `sourceType: "github"`): repo/tree URL parsing, default-branch resolution, one recursive-tree API call, docs-first ordering (README → docs/ → root → rest), extension allowlist, hard bounds (40 files / 800 KB per file / 1.4 MB total / depth 6 / 15 s per request), raw.githubusercontent.com content fetch with final-host validation, typed errors surfaced per code (invalid URL, unsupported host, not found, ref not found, no docs, rate limited 429, fetch failed 502, deadline exceeded), optional `SKILLFORGE_GITHUB_TOKEN` sent to api.github.com only (rate-limit raise for public repositories — **public repositories only**, private repos deliberately unsupported). No cloning, no code execution, submodules never followed; truncation and skipping are reported via notes that propagate to the stream, the persisted record, and the UI. Bounds are enforced on actual returned UTF-8 bytes, including the exact combined representation; overall ingestion deadline is 60 s and covers response-body reads.
  - **UI fix:** source tab bodies toggle generically. New **GitHub repo** tab with honest limits text.
  - **Provenance click-through** (`GET /api/skills/:id/provenance/excerpt`): provenance records open a dialog with the exact, line-numbered source excerpt; out-of-range requests are refused honestly (422).
  - **Edit before export** (`POST /api/skills/:id/update-file`): content edits to existing generated text files; persisted atomically; edited files are marked `userEdited` and their provenance is dropped; `manifest.json` is regenerated so hashes and source notes remain consistent; validation re-runs server-side and failing edits block export (422).
  - **Provider verification harness** (`npm run verify:provider`, `src/core/verify.ts`): one bounded generation → plan schema check → canonical build → deterministic validation with actionable, credential-free diagnostics; offline (mock) by default; tested with injected fetch; live glm/openai run not executed in this environment (no key available).
  - **Release hardening/remediation:** canonical metadata consistency, source-note propagation/persistence, public-only GitHub policy, exact final-byte bounds, response-body deadline coverage, and patched `qs@6.16.0` override with clean audit.

## Verification evidence (current release, re-verified on the hardening branch)

- `npm test` → **187/187 passing** across 19 test files.
- `npm run typecheck` clean; `npm run build` emits working `dist/`.
- `npm run demo` → 4 ZIPs verified non-empty with SKILL.md present.
- `npm audit` → **0 vulnerabilities**.
- `npm run verify:provider` passes with the offline mock provider; live GLM/OpenAI endpoints were not exercised because no credentials were available.
- Live URL fetches: koa README (markdown) and GitHub docs page (HTML) both produced valid packages; private-host fetch refused with `url_private_host`.
- Browser verification covered bundled/pasted/URL/local/GitHub sources, source-note rendering, provenance click-through, generated-file editing, validation-gated export, ZIP inspection, and persisted reload.
- GitHub source regression coverage includes URL parsing, bounds, ordering, typed error mapping, token scoping, inert-text handling, source notes, exact single/multi-file byte limits, multibyte UTF-8 accounting, and stalled response-body deadlines.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Dev server (tsx watch) at `127.0.0.1:8787` |
| `npm start` | Dev server without watch |
| `npm test` | Vitest suite (187 tests) |
| `npm run verify:provider` | One bounded provider verification (offline mock by default) |
| `npm run typecheck` / `npm run lint` | tsc --noEmit |
| `npm run build` | tsc emit to `dist/` (server runs from dist with `node dist/src/server/index.js`) |
| `npm run demo` | Headless generate→validate→export with ZIP inspection into `output/` |

## Not done / gaps (confirmed current)

- PDF ingestion.
- `glm`/`openai` providers untested against live endpoints (unit-tested with injected fetch; requires a real key).
- Grounding check is token-overlap heuristic.
- Evals are manual grounding checks; not executed by SkillForge.
- GitHub `/tree/` refs containing slashes are parsed with the first segment as the ref.

## Environment knobs

- `SKILLFORGE_DOCS_ROOT` — filesystem root for the Local-files source (default: cwd). See `.env.example`.
- `SKILLFORGE_GITHUB_TOKEN` — optional; raises the GitHub API rate limit for public GitHub sources (api.github.com only). See `.env.example`.
- `SKILLFORGE_PROVIDER` / `SKILLFORGE_API_KEY` / `SKILLFORGE_BASE_URL` / `SKILLFORGE_MODEL` — remote providers (optional).
- `PORT` / `HOST` — server binding.

## Resuming

Clone → `npm install` → `npm test` → `npm run dev`. `TASKS.md` holds the remaining backlog; `ARCHITECTURE.md` maps the modules.
