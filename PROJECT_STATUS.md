# SkillForge — Project Status

**Original sprint date:** 2026-09-03 (Asia/Ho_Chi_Minh)
**Current mode:** Continuation (P1)
**State:** P0 complete and verified; P1 continuation in progress — URL/file sources, persistence, stronger validators shipped and verified.

> There is no active wall-clock deadline. Do not restart P0; do not enter finalization prematurely.

## What works right now (verified)

- **P0 (regression baseline, re-verified green this session):** full no-key workflow **Source → Analyze → Generate → Validate → Preview → Export** in the browser; `npm run demo`; ZIP inspection.
- **P1 shipped this continuation:**
  - **URL source** (`src/core/sources/url.ts`): http/https only; SSRF guard (private/loopback/link-local refused by name and DNS, re-validated per redirect); ≤3 redirects; 1 MB/15 s caps; content-type allowlist; HTML→markdown-ish conversion without executing page JS; honest `url_no_content` for JS-rendered pages.
  - **Local file/directory source** (`src/core/sources/files.ts`): realpath containment inside `SKILLFORGE_DOCS_ROOT` (symlink escapes refused), extension allowlist, per-file/total size caps, depth/file-count bounds, multi-file combining with `# path` headers.
  - **File-backed store** (`src/server/store.ts`): skills persist under `.data/skills/<id>/skill.json` (atomic writes, zod-validated reads, newest-50 eviction). **Verified: skills survive a real server restart.**
  - **16 deterministic validators** (was 14): added `eval-integrity` and `provenance-integrity`.
  - **UI:** four source tabs (Samples/Paste/URL/Local files) with per-type validation and button states; browser-verified local-dir generation (22-file skill) and real ZIP download.
  - **Link neutralization:** relative links inside verbatim excerpts render as paths, so exported packages never contain dangling internal references (found via live koa README; regression-tested).

## Verification evidence (this continuation)

- `npm test` → **117/117 passing** (was 81; +36 for sources/persistence/validators/link fix).
- `npm run typecheck` clean; `npm run build` emits working `dist/` (server boots from dist, serves UI+API).
- `npm run demo` → 4 ZIPs verified non-empty with SKILL.md present.
- Live URL fetches: koa README (markdown) and GitHub docs page (HTML) both produced packages passing all 16 checks; `example.org` and `httpbin.org/html` verified; private-host fetch refused with `url_private_host` (502).
- Browser: 4-tab UI verified; local-dir source generated + downloaded `src-core-samples-fastforge-cli-md-claude-code.zip` (15.1 KB, 22 entries).
- Restart persistence: skill generated before `pkill` was served intact after restart.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Dev server (tsx watch) at `127.0.0.1:8787` |
| `npm start` | Dev server without watch |
| `npm test` | Vitest suite (117 tests) |
| `npm run typecheck` / `npm run lint` | tsc --noEmit |
| `npm run build` | tsc emit to `dist/` (server runs from dist with `node dist/src/server/index.js`) |
| `npm run demo` | Headless generate→validate→export with ZIP inspection into `output/` |

## Not done / gaps (confirmed current)

- GitHub repository source as a first-class type (URL/local cover it manually).
- PDF ingestion.
- `glm`/`openai` providers untested against live endpoints (unit-tested with injected fetch; requires a real key).
- Grounding check is token-overlap heuristic.
- Evals are manual grounding checks; not executed by SkillForge.

## Environment knobs

- `SKILLFORGE_DOCS_ROOT` — filesystem root for the Local-files source (default: cwd). See `.env.example`.
- `SKILLFORGE_PROVIDER` / `SKILLFORGE_API_KEY` / `SKILLFORGE_BASE_URL` / `SKILLFORGE_MODEL` — remote providers (optional).
- `PORT` / `HOST` — server binding.

## Resuming

Clone → `npm install` → `npm test` → `npm run dev`. `TASKS.md` holds the remaining backlog; `ARCHITECTURE.md` maps the modules (see `src/core/sources/` for the P1 adapters).
