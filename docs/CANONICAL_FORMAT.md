# The SkillForge canonical skill format (v1)

The canonical package is the single internal representation. Everything a user inspects, validates, or exports derives from it.

## Structure

```
<skill-id>/
├── SKILL.md          # required — YAML front matter + instruction sections
├── manifest.json     # required — source identity, gaps, file inventory
├── references/       # optional — verbatim source excerpts (provenance header + footer)
├── workflows/        # optional — documented procedures (≥3 ordered steps in source)
├── examples/         # optional — verbatim fenced code blocks (≥3 lines)
├── evals/            # optional — deterministic grounding checks (manual execution)
└── AGENTS.md         # optional — added by the generic exporter
```

Files exist only when the source warrants them; every file carries a `purpose`, and the validator fails empty/ceremonial files.

## SKILL.md

```markdown
---
name: meridian-payments-api      # lowercase-hyphen slug, ≤64 chars
description: "One paragraph…"    # ≤1024 chars recommended
---

# Display Name

> Generation/provenance banner

## When to use this skill
## Inputs required
## Workflow
## Constraints
## Verification
## Common pitfalls
## References                    # relative links into references/ (checked by validator)
```

Any section the source cannot answer renders an explicit gap note instead of invented content; gaps are also listed in `manifest.json`.

## manifest.json (`skillforge.manifest/1`)

```json
{
  "schema": "skillforge.manifest/1",
  "name": "…", "displayName": "…", "description": "…",
  "version": "0.1.0",
  "generator": "mock",
  "source": { "name": "…", "sha256": "…", "lineCount": 125, "notes": [] },
  "gaps": ["…"],
  "files": [{ "path": "…", "bytes": 123, "sha256": "…" }]
}
```

`files` lists every file except the manifest itself. Exporters may add `exportNotes` when they change the package (e.g. the generic exporter adds `AGENTS.md` and re-lists it).

## Provenance

Each generated file has a provenance record: `{ filePath, extraction, sourceLines: [start, end], sourceHeading? }` — `sourceLines` refers to the *normalized* source text (stable sha256 in the manifest). References/workflows/examples embed the same ranges inline so the exported package is self-describing.

## Zod schemas

`src/core/types.ts` (`CanonicalSkill`, `SkillFile`, `Provenance`, `ValidationReport`) and `src/core/plan.ts` (`PlanSchema`) are authoritative; the builder output is schema-checked in tests.
