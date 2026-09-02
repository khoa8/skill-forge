# SkillForge — Project Status

**Sprint date:** 2026-09-03 (Asia/Ho_Chi_Minh). **State: P0 complete, verified.**

## What works right now (verified)

- `npm install && npm run dev` → UI at http://127.0.0.1:8787; full no-key workflow **Source → Analyze → Generate → Validate → Preview → Export** verified in a real browser (sample selection, pipeline stepper, file inspector with provenance, validation panel, real ZIP download).
- `npm run demo` → headless end-to-end: both bundled samples, both export targets, ZIPs read back and inspected (non-empty, SKILL.md present).
- `npm test` → **81/81 passing**; `npm run typecheck` (tsc) clean.
- Deterministic validation: 14 checks; export endpoint refuses packages with errors (HTTP 422).

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Dev server (tsx watch) at `127.0.0.1:8787` |
| `npm start` | Dev server without watch |
| `npm test` | Vitest suite (81 tests) |
| `npm run typecheck` / `npm run lint` | tsc --noEmit |
| `npm run build` | tsc emit to `dist/` |
| `npm run demo` | Headless generate→validate→export with ZIP inspection into `output/` |

## Verification evidence (from this sprint)

- Browser: generation from bundled sample streams 4 stage events with timings; validation banner "passed — 14 deterministic checks"; file inspector shows purpose + provenance; download produced `meridian-payments-api-claude-code.zip` (10.4 KB, 16 entries).
- Demo CLI: 4 ZIPs (2 samples × 2 targets) verified non-empty with SKILL.md present.
- Tests cover malformed model output, provider HTTP/network failures, zip-slip refusal, manifest tampering, broken links/JSON/front matter, placeholder and empty-file detection.

## Not done / gaps

- URL / GitHub / PDF sources (interfaces preserved in TASKS.md; not implemented).
- `glm`/`openai` providers untested against live endpoints (unit-tested with injected fetch).
- In-memory skill store (restart loses skills; bounded at 50).

## Resuming

Clone → `npm install` → `npm test` → `npm run dev`. Read `TASKS.md` for the prioritized backlog and `ARCHITECTURE.md` for the module map.
