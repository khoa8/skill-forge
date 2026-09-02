# SkillForge — Tasks

Done items are checked. Priorities follow AGENTS.md/GOAL.md ordering.

## P0 — MVP pipeline (complete)

- [x] Project scaffold: TypeScript ESM, Express, zod, yaml, marked, jszip, vitest
- [x] Canonical skill model (zod-validated) + provenance records
- [x] Ingestion/normalization (line endings, HTML strip, entities, size bounds)
- [x] Deterministic line-based analyzer (sections, code, commands, procedures, warnings)
- [x] Mock provider (offline, deterministic) + shared canonical builder
- [x] Deterministic validator (14 checks, honest skipped state)
- [x] Exporters: claude-code + generic; real ZIP with sanitized paths
- [x] HTTP API with NDJSON pipeline streaming; validation-gated export (422)
- [x] Web UI: stepper, sample/text sources, file inspector w/ provenance, validation panel, real download
- [x] Bundled samples (Meridian Payments API, FastForge CLI) + `npm run demo` CLI with ZIP inspection
- [x] Tests: 81 passing (unit + API + e2e demo + zip round-trip + path safety + provider failures)
- [x] Verified in a real browser: full no-key Source→Validate→Export workflow + download

## P1 — next highest value

- [ ] File upload source (local .md/.txt) beyond paste
- [ ] URL source with safe limits (protocol allowlist, SSRF guard, size/time caps, no-crawl-by-default)
- [ ] GitHub repository source (docs/ + README ingestion; no code execution)
- [ ] Editing generated text in preview (P1 per AGENTS.md §14)
- [ ] Persistence for generated skills (file-backed store) instead of in-memory
- [ ] Additional exporter: Codex/Cursor adapter after verifying their documented formats
- [ ] Evals: machine-readable format compatible with a runner (keep manual execution)
- [ ] Provenance UX: click a provenance record to view the exact source lines
- [ ] Progress streaming via SSE for slow (remote-provider) generations with cancellation

## P2 — later

- [ ] PDF ingestion
- [ ] Multi-page documentation source
- [ ] Authenticated documentation sources
- [ ] LLM-assisted (non-deterministic) quality review supplementing the deterministic validator
- [ ] Skill diffing across regenerations

## Known defects / gaps (tracked, not hidden)

- Grounding check is token-overlap heuristic; can miss paraphrased hallucinations and can warn on benign rephrases.
- `glm`/`openai` providers are implemented + unit-tested with injected fetch but not exercised against live APIs in this repo.
- No pagination/refresh safety: page reload clears UI state (skills remain fetchable by id until eviction/restart).
