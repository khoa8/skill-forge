# SkillForge — Final Report

**Date:** 2026-09-03+ (continuation mode) · **State:** P0 + high-value P1 implemented, verified, documented.

---

## 1. What SkillForge is

A local web application that turns documentation (pasted Markdown, bundled samples, a URL, or local files) into **validated, portable AI Agent Skill packages** (ZIP). Pipeline: **Source → Analyze → Generate → Validate → Preview → Export**. The differentiators are deterministic validation, honest source grounding (line-range provenance; explicit gaps), and exporter-based portability.

## 2. Verified state (all commands re-run in this session)

| Check | Command | Result |
| --- | --- | --- |
| Typecheck / lint | `npm run typecheck` | clean (tsc --noEmit, strict mode) |
| Unit + integration + e2e tests | `npm test` | **117/117 passing** (12 files) |
| Production build | `npm run build` | emits `dist/`; `node dist/src/server/index.js` serves UI+API (verified on :8791) |
| Headless demo | `npm run demo` | 2 samples × 2 targets = 4 ZIPs generated, read back, verified non-empty with SKILL.md |
| Browser e2e | manual + in-app browser | 4-tab UI; sample/paste/local-dir generation; validation banner; file inspector with provenance; real ZIP download (e.g. 22-entry, 15.1 KB) |
| Restart persistence | generate → `pkill` → restart → GET | skill served intact from `.data/skills/` |
| Live URL source | koa README (raw md); GitHub docs page (HTML); example.org; httpbin.org/html | all produce packages passing all 16 checks; JS-rendered pages honestly rejected |
| SSRF refusal | POST url=`http://127.0.0.1:9/x` | HTTP 502 `url_private_host` before any fetch |
| Path traversal | file=`../../.zshrc`, absolute outside root, symlink escape | refused with `file_outside_root` |
| Export gate | validation-failing package | HTTP 422, export blocked in UI |

## 3. Architecture (summary)

Modular monolith, TypeScript ESM, Node ≥20. `src/core/`: types (zod canonical model), util (slug/sha256/path-safety), ingest, analyze (line-based with provenance), plan schema, build (shared package synthesis), providers (mock + OpenAI-compatible), pipeline (async-generator events), validate (16 pure checks), export (claude-code + generic, JSZip). `src/core/sources/`: url.ts (SSRF-guarded fetch), files.ts (allowlist-root file ingestion). `src/server/`: Express app (NDJSON streaming), file-backed store. `web/`: dependency-free UI. Details: `ARCHITECTURE.md`.

## 4. Verification approach (why you can trust the table above)

- Tests assert real behavior: ZIPs are read back via JSZip and compared byte-for-byte; validator mutations (tampered manifests, broken links, traversal paths, invented commands) each trigger the specific finding; provider fakes return malformed output to prove schema enforcement.
- Browser checks were performed against the real running app (in-app browser), including a download that produced a valid ZIP.
- Live URL checks ran against real public pages, not just fixtures.

## 5. Limitations (honest)

1. **Grounding check is heuristic** (token overlap) — not proof of factual correctness; generated skills need human review.
2. **Live LLM providers unverified** — `glm`/`openai` adapters are implemented and unit-tested with injected fetch; no paid key was available, so no live-endpoint claim is made.
3. **URL source is single-page, no JS rendering** — crawler-less by design; SPA pages fail honestly with `url_no_content`.
4. **GitHub repo source** is not a first-class type (URL to a raw file / local checkout cover it manually).
5. **PDF ingestion** not implemented.
6. **Evals are manual** — generated as grounding questions; SkillForge doesn't execute them.
7. **No auth/multi-user** — local tool by design (binds 127.0.0.1).
8. **Store bounds** — newest 50 skills kept on disk.

## 6. Security review notes

- File source trust boundary = `SKILLFORGE_DOCS_ROOT` (default: repo cwd). Traversal/absolute-outside/symlink-escape refused; dotfiles inside the root with allowed extensions are readable by design (documented in TASKS.md).
- URL source: protocol allowlist; private/loopback/link-local hosts refused by name *and* DNS (re-checked per redirect); credentials-in-URL refused; size/time caps; content-type allowlist; no JS execution.
- ZIP: every entry path sanitized (zip-slip refused), duplicates refused, slugified root folder.
- API: zod-validated bodies; store ids slug-validated before touching disk; 3 MB JSON body cap; no secrets in repo (`.env` gitignored, `.env.example` placeholder only).

## 7. Launch readiness assessment

**Ready for:** local single-user use; open-source release as an MVP; demoing the generate→validate→export loop with zero setup.

**Before calling it production-ready:** live LLM provider verification; GitHub-repo source type; provenance click-through UX; eval runner integration. None are blockers for the MVP's stated promise.

## 8. Recommended next 20 tasks (priority order)

1. GitHub repository source type (fetch docs tree via API, no code execution).
2. Provenance click-through: show exact source lines for each generated file in the UI.
3. Edit-in-preview before export (AGENTS.md §14 P1).
4. SSE-based progress + cancellation for remote-provider generations.
5. Live verification harness for glm/openai providers (skippable in CI without keys).
6. Codex/Cursor exporter after format verification (each with tests + honest formatBasis).
7. Eval runner integration (machine-checkable grounding evals).
8. Skill regeneration diff view.
9. Multi-file URL ingestion (bounded, same-host, opt-in).
10. PDF ingestion (text layer only).
11. Frontend build/bundle (currently dependency-free static files — fine, but minification + TS would harden it).
12. Rate limiting on generation endpoints.
13. Configurable SKILL.md section templates.
14. Per-exporter target validation profiles (run validator with `target` in the generation step).
15. Accessibility pass on the UI (focus management, ARIA live regions for progress).
16. i18n-ready strings.
17. Dark/light theme toggle.
18. Store compaction/GC UI (show disk usage, delete skills).
19. Structured logging with request ids.
20. CI workflow (typecheck + tests + build + demo on push).

## 9. Repository state

- Git: local only, 10 commits, clean tree at `ed399d2`+ (see `git log`).
- No secrets, no remote, no generated artifacts committed except the intentional `examples/exported-package/` (kept in sync with builder output this session).
- `.data/` (runtime store) and `output/` (demo ZIPs) are gitignored.

## 10. How to verify this report yourself

```bash
npm install && npm test && npm run typecheck && npm run build && npm run demo
npm run dev            # then: pick a sample → Generate → Download ZIP → unzip -l
```
