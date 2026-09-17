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
├── evals/            # optional — source-derived grounding checks; structured assertions (advisory deterministic evaluation) + manual questions
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
  "files": [{ "path": "…", "bytes": 123, "sha256": "…", "userEdited": true }]
}
```

`files` lists every file except the manifest itself. When a file is edited by the user before export, its entry records `"userEdited": true` (unmodified files omit the field or set it to `false`). User-edited files have their provenance records removed honestly, and generator-authored header banners are qualified. Validation accepts this intentional absence; retaining source provenance on a user-edited file is an error. Exporters may add `exportNotes` when they change the package (e.g. the generic exporter adds `AGENTS.md` and re-lists it).

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

The canonical source record's `commands` array stores observational command facts extracted from inspected repository files. Representable commands within supported metadata length bounds are stored literally without truncation or synthetic reconstruction; facts exceeding representation limits are omitted rather than truncated, with such omissions reported in `uncertainty`. `RepositoryCommand` is a discriminated union:

- `RepositoryPackageScript`: `{ kind: "package-script", purpose, name, command, evidence }`. Literal script definitions observed in manifests (e.g. `package.json`).
- `RepositoryCiRun`: `{ kind: "ci-run", purpose, command, evidence, cwd? }`. Literal `run:` steps observed in CI workflows. `cwd` is the concrete execution directory relative to the repository root (`""` = repository root) when statically declared; dynamic or unknown directories leave `cwd` undefined without dropping the command fact.

Commands are recorded as inspection facts only, never elevated into executable instructions, synthetic package-manager/workspace commands, or authoritative agent policy. Safe structural orientation directs agents to inspect manifests and CI configuration before selecting commands.

## Provenance

Each generated file has a provenance record: `{ filePath, extraction, sourceLines: [start, end], sourceHeading? }` — `sourceLines` refers to the *normalized* source text (stable sha256 in the manifest). References/workflows/examples embed the same ranges inline so the exported package is self-describing.

## evals/evals.json (`skillforge.evals/1`)

Eval items extend the original manual format with an optional structured assertion (backward compatible: items without `assertions` remain manual questions):

```json
{
  "schema": "skillforge.evals/1",
  "items": [
    {
      "id": "eval-1",
      "kind": "grounding",
      "prompt": "Does the skill retain and expose the source topic \"Authentication\"?",
      "expect": "references/authentication.md retains the source excerpt and is discoverable from SKILL.md (source lines 8–21).",
      "assertions": [
        { "type": "topic-retention", "filePath": "references/authentication.md", "sourceSha256": "<normalized source sha256>", "sourceLines": [8, 21] }
      ]
    },
    {
      "id": "eval-7",
      "kind": "procedure",
      "prompt": "Does the skill retain the ordered \"Refunding a payment\" procedure?",
      "expect": "workflows/refunding-a-payment.md retains all 4 source steps in order and is discoverable from SKILL.md; text comparison only, not execution.",
      "assertions": [
        { "type": "procedure-fidelity", "filePath": "workflows/refunding-a-payment.md", "sourceSha256": "…", "sourceLines": [62, 65] }
      ]
    }
  ]
}
```

- `topic-retention`: the target file exists, is not user-edited, carries verifiable provenance, retains the source excerpt text for the cited lines (whitespace-normalized containment), and the topic remains discoverable from `SKILL.md` body text.
- `procedure-fidelity`: the workflow file retains all source-derived ordered steps as text (inert comparison — nothing is ever executed).
- Assertions cite `sourceSha256` + `sourceLines`; the evaluator re-derives the expected specification from the normalized source and treats a mismatching, modified, malformed, unknown, or oversized specification as **not-executable**, never as a pass. Command-grounding evals stay manual by design.
- Evaluation is bounded (source/package/eval-size caps), deterministic, offline, and advisory: the report (`EvaluationReport` in `src/core/types.ts`) has per-check `pass` / `concern` / `not-executable` statuses with no aggregate quality score. Export gating is exclusively deterministic validation. The full structured repository analysis (codebase mode) is not part of the package; codebase-mode evals cover only selected source references.

## Zod schemas

`src/core/types.ts` (`CanonicalSkill`, `SkillFile`, `Provenance`, `ValidationReport`, `EvaluationReport`) and `src/core/plan.ts` (`PlanSchema`) are authoritative; the builder output is schema-checked in tests.
