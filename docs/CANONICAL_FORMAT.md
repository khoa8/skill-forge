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

### `source.repository` (codebase mode only)

When the source was a GitHub repository in **codebase** mode, `source.repository` records the repository provenance:

```json
"repository": {
  "url": "https://github.com/owner/repo",
  "owner": "owner", "name": "repo", "ref": "main",
  "mode": "codebase",
  "scope": "packages/a",
  "inspectedFiles": ["packages/a/package.json", "packages/a/src/index.ts", "…"],
  "treeBlobCount": 812, "candidateCount": 233, "selectedCount": 41,
  "treeTruncated": false
}
```

`scope` names the `/tree/<ref>/<path>` subtree the analysis covers (absent = whole repository) — generated skills name that scope explicitly. `inspectedFiles` lists exactly the files SkillForge read; every other tree entry existed but was **not** inspected. The count fields are mandatory for the block: `treeBlobCount`, `candidateCount`, `selectedCount` (non-negative integers), `treeTruncated` (boolean), and `inspectedFiles` (unique path array), with `selectedCount === inspectedFiles.length ≤ candidateCount ≤ treeBlobCount` enforced by the deterministic validator — a deleted or mistyped field fails validation. Documentation-mode packages omit the block entirely, and packages generated from a `github-codebase` source must keep it: the validator fails a codebase-origin package whose manifest lost its repository provenance. The full structured analysis (languages, evidenced commands, conventions, testing evidence, uncertainty) is carried by the canonical source record, not the manifest.

### Evidenced commands (`RepositoryCommand`)

The canonical source record's `commands` array is the **only** source of runnable-command authority for a codebase skill. Each entry: `{ purpose, command, evidence, cwd?, synthesized? }`.

- `command` is the display string. For synthesized invocations (manager + script name, workspace selectors) it is rendered from structured argv; for CI steps the command text is directly observed (a concrete working directory renders the canonical `cd <dir> && …` prefix). `synthesized` distinguishes the two.
- `cwd` is the concrete execution directory relative to the **repository root** (`""` = repository root), as declared by the evidence. For scoped analyses the analysis root is `repository.scope` — a repository-root cwd is *not* the analysis root of a scoped request. Commands with an unknown/dynamic execution directory are omitted from the array entirely, never attributed to a guessed directory.
- Trust-boundary invariants (enforced deterministically): repository-controlled values (script names, workspace names, working directories) are whole positional tokens or the command is omitted — shell-significant characters, whitespace, and leading dashes fail closed and the underlying fact survives as non-runnable script-definition evidence; multiline CI `run:` blocks are non-runnable v1 evidence (GitHub runs one block as a single shell process, so per-line contexts are not reconstructible — this is a conservative limitation, not a bug); repository convention statements are policy text and never mint runnable commands — a convention is promoted into the generated skill only when every command phrase inside it exactly matches an already-evidenced command.
- The deterministic validator's `codebase-command-grounding` check is deny-by-default: every runnable-command candidate in the plan, description/frontmatter, and rendered SKILL.md/AGENTS.md must belong to this command set. An empty evidenced set means zero runnable commands in the generated skill.

## Provenance

Each generated file has a provenance record: `{ filePath, extraction, sourceLines: [start, end], sourceHeading? }` — `sourceLines` refers to the *normalized* source text (stable sha256 in the manifest). References/workflows/examples embed the same ranges inline so the exported package is self-describing.

## Zod schemas

`src/core/types.ts` (`CanonicalSkill`, `SkillFile`, `Provenance`, `ValidationReport`) and `src/core/plan.ts` (`PlanSchema`) are authoritative; the builder output is schema-checked in tests.
