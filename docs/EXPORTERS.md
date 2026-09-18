# Exporters

Exporters are the only place vendor-specific format differences live (AGENTS.md §5). The generation pipeline never branches per vendor.

## Supported targets

| Target | Label | Layout | Format basis |
| --- | --- | --- | --- |
| `claude-code` | Claude Code | `<skill-id>/SKILL.md` with `name` + `description` YAML front matter, plus canonical supporting files (`references/`, `workflows/`, `examples/`, `evals/`, `manifest.json`) | Local Claude Code skill packaging (`.claude/skills/` layouts). SkillForge exports only canonical-valid v1 packages — intentionally a stricter subset of what Claude Code loads locally (Claude Code permits `name`/`description` to be optional). Extension frontmatter fields are preserved; only local constraints (`compatibility` string ≤500 chars, reserved `synced` folder) are enforced. claude.ai upload / Skills API compatibility is not claimed. Structure verified by this repo's tests. |
| `generic` | Generic (AGENTS.md) | Same as canonical plus a root `AGENTS.md` orientation wrapper | The AGENTS.md convention: a root markdown instruction file any agent can read. The wrapper orients agents toward the authoritative `SKILL.md` and canonical package files. Verified by this repo's tests. |
| `openai-codex` | OpenAI Codex | Canonical skill folder with root `SKILL.md` and all supporting files unchanged | [OpenAI Build skills](https://learn.chatgpt.com/docs/build-skills) and the [official skill-creator validator](https://github.com/openai/skills/blob/main/skills/.system/skill-creator/scripts/quick_validate.py). Structure covered by repository tests; runtime behavior not verified. |

**Honesty rule:** we claim only what is tested. All exporters are covered by unit + end-to-end tests (structure, front-matter constraints, manifest resync, ZIP round-trip). Package-structure tests do not guarantee runtime behavior inside Claude Code or other agent runtimes; validate compatibility in the target runtime.

## Claude Code contract

`claude-code` targets local Claude Code skill packaging (personal `~/.claude/skills/` and project `.claude/skills/` layouts). SkillForge exports only packages that already satisfy SkillForge canonical v1, so its output is intentionally a stricter subset of the local Claude Code format. Claude Code itself permits some frontmatter fields to be optional; SkillForge canonical v1 still requires its canonical `name` and `description` — those are SkillForge requirements, not claims about Claude Code.

- **Canonical validity is a precondition.** A package that fails canonical validation (missing `SKILL.md`, frontmatter, `name`, `description`, or metadata consistency) cannot be exported to `claude-code`. The exporter never backfills or repairs identity; it fails closed.
- **Canonical rules stay canonical.** The lowercase-hyphen slug and length rules on `name`, and the description-length guidance, are enforced by canonical validation for every target — never described as Claude Code requirements.
- **Extension fields are preserved.** User-authored Claude Code fields (e.g. `when_to_use`, `argument-hint`, `arguments`, `disable-model-invocation`, `user-invocable`, `allowed-tools`, `disallowed-tools`, `model`, `effort`, `context`, `agent`, `background`, `hooks`, `paths`, `shell`, `metadata`) pass through export unchanged. No closed upload allowlist is applied.
- **Target-specific constraints (additive only):** `compatibility`, when present, must be a string of at most 500 characters (Claude Code accepts the field but does not act on it); the resulting skill folder must not be `synced` in any capitalization (reserved for skills synced from claude.ai).
- **Not claimed:** claude.ai upload / Skills API / `package_skill.py` compatibility. Those paths restrict frontmatter to six fields (`name`, `description`, `license`, `compatibility`, `metadata`, `allowed-tools`) and impose their own limits; this target does not enforce them.

## Codex contract

The exporter parses YAML and requires a non-empty name matching canonical identity: 1–64 lowercase letters/digits with single internal hyphens. Description must be a non-empty string, at most 1024 characters after trimming, with no angle brackets. The optional front matter keys accepted by OpenAI’s skill-creator validator are `license`, `allowed-tools`, and `metadata`; unknown keys and malformed/duplicate-key YAML fail closed. This is an authoring-format check, not a claim about every Codex loader version.

Valid files are preserved byte-for-byte, including custom descriptions, body edits, optional metadata, manifest inventory/hashes, provenance, and `userEdited` flags. No normalization or manifest regeneration is needed because the exporter does not transform files. Incompatible metadata returns an actionable export error (HTTP 422).

`agents/openai.yaml` is supported but optional in OpenAI’s documentation. SkillForge does not synthesize it: display metadata is unnecessary for this export, and no dependencies, invocation policies, or prompts are inferred. The shared ZIP builder supplies a safe skill folder root; the ZIP is a downloadable directory package, not an installation or publishing action.

## Behavior details

- **Edited-file provenance:** Generic orientation describes supporting material without claiming every file is verbatim; consult per-file provenance and manifest `userEdited` flags.
- **Manifest resync:** when an exporter adds files (e.g. `AGENTS.md`), it regenerates `manifest.json` so the inventory stays consistent — exported packages still pass deterministic validation.
- **ZIP safety:** every entry passes `safePackagePath`; traversal/absolute/duplicate entries abort the export with `ExportError`. Root folder is the slugified skill id.
- **Unsupported targets:** `exportPackage(skill, "bogus")` throws `export_target_unsupported` with the supported list; the HTTP API returns 400 with `supported: [...]`.
- **Validation gate:** the export endpoint re-runs deterministic validation (`validatePackage`) on the transformed package before packaging; packages with errors are refused with HTTP 422 before any ZIP bytes are produced, returning the validation report in the JSON response body. Successful ZIP responses carry a validation summary in the `x-skillforge-validation` header.

## Adding an exporter

1. Add the target id to `ExportTarget` (types.ts) and a function in `src/core/export/exporters.ts`.
2. Register it in `EXPORTERS` and document it in `EXPORT_TARGET_INFO` with a real `formatBasis`.
3. Add tests: structure, front matter constraints, manifest resync, ZIP round-trip.
4. Only then list it in the UI (the UI reads `EXPORT_TARGET_INFO`, so this is automatic).
