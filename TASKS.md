# SkillForge — Tasks

Done items are checked. Priorities follow AGENTS.md/GOAL.md ordering.

## P0 — MVP pipeline (complete, regression baseline)

- [x] Project scaffold: TypeScript ESM, Express, zod, yaml, jszip, vitest
- [x] Canonical skill model (zod-validated) + provenance records
- [x] Ingestion/normalization (line endings, HTML strip, entities, size bounds)
- [x] Deterministic line-based analyzer (sections, code, commands, procedures, warnings)
- [x] Mock provider (offline, deterministic) + shared canonical builder
- [x] Deterministic validator; real ZIP with sanitized paths; claude-code + generic exporters
- [x] HTTP API with NDJSON pipeline streaming; validation-gated export (422)
- [x] Web UI: stepper, sources, file inspector w/ provenance, validation panel, real download
- [x] Bundled samples + `npm run demo` CLI with ZIP inspection
- [x] Verified in a real browser: full no-key Source→Validate→Export workflow + download

## P1 — continuation (this session)

- [x] **URL source** with safe limits: protocol allowlist, SSRF guard (name + DNS, per-redirect), redirect cap, size/time caps, content-type allowlist, HTML→text conversion without JS execution, honest empty-content failure
- [x] **Local file/directory source**: `SKILLFORGE_DOCS_ROOT` allowlist root, realpath containment (symlink escape refused), extension allowlist, size/count/depth bounds, multi-file combining
- [x] **File-backed persistence**: `.data/skills/<id>/skill.json`, atomic writes, zod-validated reads, newest-50 eviction; verified across server restart
- [x] **Stronger validators** (14 → 16): eval-integrity, provenance-integrity
- [x] **UI for new sources**: Samples/Paste/URL/Local files tabs with per-type button states; browser-verified generation + download from a directory source
- [x] **Link neutralization** in verbatim excerpts (multi-line labels); found via live koa README, regression-tested
- [x] dist-mode static serving (`findWebDir`), MIT license, export-blocked UI dedup

## P1 — remaining backlog

- [ ] GitHub repository source as a first-class type (repo URL → docs tree via API, no code execution)
- [ ] Editing generated text in preview (P1 per AGENTS.md §14)
- [ ] Provenance UX: click a provenance record to view the exact source lines
- [ ] SSE progress for slow (remote-provider) generations with cancellation
- [ ] Additional exporter (Codex or Cursor) after verifying its documented format
- [ ] Evals compatible with an external runner (keep manual execution in-scope)

## P2 — later

- [ ] PDF ingestion
- [ ] Multi-page documentation crawl (bounded, opt-in)
- [ ] Authenticated documentation sources
- [ ] LLM-assisted (non-deterministic) quality review supplementing the deterministic validator
- [ ] Skill diffing across regenerations

## Security notes (reviewed)

- File source reads files inside the allowlist root by design — including dotfiles with allowed extensions (e.g. `.secret-notes.md`). Documented: the root is the trust boundary; set `SKILLFORGE_DOCS_ROOT` to a docs-only directory for stricter isolation.
- `.env` itself is never readable (no extension match). Traversal, absolute-outside, and symlink escapes are refused (`file_outside_root`); store ids are slug-validated before touching `.data/`.
- ZIP entries are sanitized (zip-slip refused); export body fields are schema-validated (unknown fields dropped); oversized JSON bodies rejected by the 3 MB parser limit.

## Known defects / gaps (tracked, not hidden)

- Grounding check is token-overlap heuristic; can miss paraphrased hallucinations and warn on benign rephrases.
- `glm`/`openai` providers are implemented + unit-tested with injected fetch but not exercised against live APIs (no key available in this environment).
- URL source cannot render JavaScript-heavy pages; it reports `url_no_content` instead of guessing.
