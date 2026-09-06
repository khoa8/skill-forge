# SkillForge — Project Status

**Original sprint date:** 2026-09-03 (Asia/Ho_Chi_Minh)
**Current mode:** Continuation (P1.5 — production readiness run on `feature/production-readiness`)
**State:** P0 complete and verified; P1 shipped; P1.5 in progress — CI gate and the first-class GitHub repository source shipped and verified.

> There is no active wall-clock deadline. Do not restart P0; do not enter finalization prematurely.

## What works right now (verified)

- **P0 (regression baseline, re-verified green this session):** full no-key workflow **Source → Analyze → Generate → Validate → Preview → Export** in the browser; `npm run demo`; ZIP inspection.
- **P1 shipped:**
  - **URL source** (`src/core/sources/url.ts`): http/https only; SSRF guard (private/loopback/link-local refused by name and DNS, re-validated per redirect); ≤3 redirects; 1 MB/15 s caps; content-type allowlist; HTML→markdown-ish conversion without executing page JS; honest `url_no_content` for JS-rendered pages.
  - **Local file/directory source** (`src/core/sources/files.ts`): realpath containment inside `SKILLFORGE_DOCS_ROOT` (symlink escapes refused), extension allowlist, per-file/total size caps, depth/file-count bounds, multi-file combining with `# path` headers.
  - **File-backed store** (`src/server/store.ts`): skills persist under `.data/skills/<id>/skill.json` (atomic writes, zod-validated reads, newest-50 eviction). **Verified: skills survive a real server restart.**
  - **16 deterministic validators** (was 14): added `eval-integrity` and `provenance-integrity`.
  - **UI:** four source tabs (Samples/Paste/URL/Local files) with per-type validation and button states; browser-verified local-dir generation (22-file skill) and real ZIP download.
  - **Link neutralization:** relative links inside verbatim excerpts render as paths, so exported packages never contain dangling internal references (found via live koa README; regression-tested).
- **P1.5 shipped this run (feature/production-readiness):**
  - **CI quality gate** (`.github/workflows/ci.yml`): typecheck + test + build + demo on every push/PR, Node 20, `npm ci`, minimal permissions, concurrency cancellation.
  - **GitHub repository source** (`src/core/sources/github.ts`, `sourceType: "github"`): repo/tree URL parsing, default-branch resolution, one recursive-tree API call, docs-first ordering (README → docs/ → root → rest), extension allowlist, hard bounds (40 files / 800 KB per file / 1.4 MB total / depth 6 / 15 s per request), raw.githubusercontent.com content fetch with final-host validation, typed errors surfaced per code (invalid URL, unsupported host, not found, ref not found, no docs, rate limited 429, fetch failed 502), optional `SKILLFORGE_GITHUB_TOKEN` sent to api.github.com only. No cloning, no code execution, submodules never followed; truncation is reported in notes, never silent.
  - **UI fix:** source tab bodies toggle generically — the URL and Local files panels previously stayed hidden when their tab was selected. New **GitHub repo** tab with honest limits text.

## Verification evidence (this continuation)

- `npm test` → **148/148 passing** (117 P1 baseline; +31 for the GitHub source unit + API tests).
- `npm run typecheck` clean; `npm run build` emits working `dist/`.
- `npm run demo` → 4 ZIPs verified non-empty with SKILL.md present.
- Live URL fetches: koa README (markdown) and GitHub docs page (HTML) both produced packages passing all 16 checks; `example.org` and `httpbin.org/html` verified; private-host fetch refused with `url_private_host` (502).
- Browser: 4-tab UI verified; local-dir source generated + downloaded `src-core-samples-fastforge-cli-md-claude-code.zip` (15.1 KB, 22 entries).
- Restart persistence: skill generated before `pkill` was served intact after restart.
- GitHub source: 24 adapter tests + 7 API tests with injected fetch (URL parsing, bounds, ordering, error mapping, token scoping, inert-text handling).

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Dev server (tsx watch) at `127.0.0.1:8787` |
| `npm start` | Dev server without watch |
| `npm test` | Vitest suite (148 tests) |
| `npm run typecheck` / `npm run lint` | tsc --noEmit |
| `npm run build` | tsc emit to `dist/` (server runs from dist with `node dist/src/server/index.js`) |
| `npm run demo` | Headless generate→validate→export with ZIP inspection into `output/` |

## Not done / gaps (confirmed current)

- PDF ingestion.
- `glm`/`openai` providers untested against live endpoints (unit-tested with injected fetch; requires a real key).
- Grounding check is token-overlap heuristic.
- Evals are manual grounding checks; not executed by SkillForge.
- Editing generated text in preview, and provenance click-through, are the next planned features (see `docs/PRODUCTION_READINESS_STATUS.md`).

## Environment knobs

- `SKILLFORGE_DOCS_ROOT` — filesystem root for the Local-files source (default: cwd). See `.env.example`.
- `SKILLFORGE_GITHUB_TOKEN` — optional; raises the GitHub API rate limit for the GitHub source (api.github.com only). See `.env.example`.
- `SKILLFORGE_PROVIDER` / `SKILLFORGE_API_KEY` / `SKILLFORGE_BASE_URL` / `SKILLFORGE_MODEL` — remote providers (optional).
- `PORT` / `HOST` — server binding.

## Resuming

Clone → `npm install` → `npm test` → `npm run dev`. `TASKS.md` holds the remaining backlog; `ARCHITECTURE.md` maps the modules (see `src/core/sources/` for the P1 adapters).
