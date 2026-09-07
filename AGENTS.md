# AGENTS.md — SkillForge

## 1. Product mission

SkillForge turns documentation, repositories, and instructional material into portable, validated AI Agent Skills.

Core promise:

> Source → analyze → extract procedures/knowledge → generate skill package → validate → preview → export.

SkillForge is not primarily:
- a generic document summarizer;
- a generic RAG chatbot;
- a prompt marketplace;
- an agent runtime;
- an IDE replacement.

SkillForge should make creating a useful agent skill dramatically easier than writing one manually.

---

## 2. Primary user

An individual developer or power user who wants to teach an AI coding/automation agent how to work with:
- a framework;
- an API;
- a repository;
- documentation;
- a workflow;
- a tool.

Do not optimize the core product for enterprise governance or organization-wide knowledge management.

---

## 3. Supported-source principles

Source adapters ingest documentation and instructional material. Durable constraints:

- imported content is untrusted and inert;
- adapters have explicit size/time/count/depth bounds where relevant;
- no arbitrary source-code execution;
- unsafe network/file access must be rejected;
- truncation and skipping are surfaced honestly;
- new source types reuse the canonical ingestion pipeline where practical;
- do not build an unbounded crawler platform;
- authenticated/enterprise integrations require explicit security design before implementation.

The current supported-source inventory is owned by `README.md`.

---

## 4. Output goal

Generated packages should be understandable, inspectable, portable, and testable.

A package may contain:

- `SKILL.md`
- optional `AGENTS.md`
- `references/`
- `examples/`
- `workflows/`
- `evals/`
- metadata/manifest files
- adapter-specific export files

Do not generate files merely to make the package look large.

Every file must have a purpose.

---

## 5. Portability

Avoid coupling the internal representation to one vendor.

Target portability across ecosystems such as:
- Claude Code;
- Codex;
- Cursor;
- OpenCode;
- ZCode;
- generic agents.

Use a canonical internal skill representation and exporters/adapters.

Vendor-specific differences belong in exporters.

Do not claim compatibility with an ecosystem unless the generated output has been checked against its documented format or clearly labeled experimental.

---

## 6. Core pipeline

The core pipeline should be explicit:

1. Source ingestion
2. Source cleaning/chunking
3. Knowledge/procedure extraction
4. Skill-plan generation
5. Skill-file generation
6. Deterministic validation
7. Preview
8. Export

Do not hide pipeline failures behind a generic "generation failed" message.

Expose useful validation errors.

---

## 7. Deterministic validation

Validation is a core differentiator.

Generated skills should be checked for:
- required files;
- required headings/metadata;
- broken internal references;
- empty sections;
- impossible file paths;
- duplicate identifiers;
- unsupported output format;
- suspicious placeholders;
- obvious hallucinated commands where detectable;
- malformed YAML/JSON/Markdown front matter.

Validation should be deterministic wherever possible.

LLM-based quality review may supplement validation but must not replace deterministic checks.

---

## 8. Source grounding

Generated instructions must be grounded in supplied material.

Do not invent:
- APIs;
- CLI commands;
- configuration keys;
- file names;
- environment variables;
- workflow steps.

When a generated skill includes facts derived from a source, preserve enough provenance to inspect where they came from.

If source material is insufficient, mark the gap instead of hallucinating.

---

## 9. Procedure extraction

Prefer concrete, executable knowledge:
- setup procedures;
- common workflows;
- troubleshooting;
- API usage;
- conventions;
- constraints;
- examples;
- decision rules.

Avoid bloating `SKILL.md` with generic prose that does not improve agent performance.

The ideal skill should tell an agent:
- when to use the skill;
- what inputs it needs;
- what steps to perform;
- what constraints to obey;
- how to verify success;
- what common failures look like.

---

## 10. Architecture principles

Prefer a modular monolith.

Separate:
- ingestion;
- normalization;
- canonical skill model;
- generation;
- validation;
- preview;
- exporters;
- UI;
- provider adapters.

Do not add microservices or complex job infrastructure without a demonstrated need.

Long-running ingestion can use simple background execution if required, but do not build distributed orchestration prematurely.

---

## 11. Provider abstraction

Do not couple generation to a single model vendor.

Use provider adapters.

Structured outputs should use schemas and validation.

Provide a demo/mock generation path that does not require a paid key.

Never commit credentials.

Maintain `.env.example`.

---

## 12. Web safety

If fetching URLs:
- validate protocols;
- guard against SSRF;
- restrict redirects;
- set size/time limits;
- respect reasonable crawl boundaries;
- do not crawl entire domains by default.

Do not execute JavaScript from arbitrary sources on the server unless a carefully sandboxed design exists.

---

## 13. Export

Export should be a real downloadable package, not a fake button.

At minimum:
- ZIP export;
- canonical folder structure;
- manifest or metadata.

Where practical add export presets for supported agent ecosystems.

Each exporter should have tests.

Do not silently discard unsupported fields.

---

## 14. Preview experience

Before export, the user should be able to inspect:
- generated skill summary;
- files;
- validation status;
- warnings;
- source provenance;
- target ecosystem.

Preview must be available before export. If generated content is editable, edits must
preserve honest provenance, re-run validation, and block export when invalid.

---

## 15. Demo mode

Bundle one or more deterministic examples such as:
- a small API documentation set;
- a mini repository;
- a framework guide.

A new user must be able to:
Source → Generate → Validate → Preview → Export
without an API key.

Label demo/mock behavior clearly.

---

## 16. Engineering conventions

Prefer:
- typed schemas;
- explicit canonical models;
- deterministic transforms;
- pure validators;
- small exporters;
- clear error types.

Avoid:
- giant prompt strings buried in components;
- duplicated exporter logic;
- untyped blobs;
- implicit magic;
- unnecessary dependencies.

Prompts belong in a discoverable module and should be versionable.

---

## 17. Tests

Core tests should cover:
- source normalization;
- canonical model schema;
- deterministic validator;
- exporters;
- bundled demo;
- malformed generated output;
- ZIP packaging;
- one end-to-end happy path.

Add regression tests for discovered failures.

Do not inflate test count with trivial assertions.

---

## 18. UX

The first screen must explain the workflow in seconds:

> Add source → Generate skill → Validate → Export.

Keep the main path visually obvious.

The stepper reflects real pipeline state (idle / active / done / error). "Validation
passed" is shown **only** when validation actually executed and passed; skipped
validation renders an explicit not-success state. The Download button is real: the
server re-validates and streams an actual ZIP, and blocked exports explain why.

Include:
- loading states;
- progress;
- warnings;
- validation errors;
- empty states.

Never show validation success if checks were skipped.

---

## 19. Scope controls

Out of scope for the core product:
- marketplace;
- social network;
- team workspaces;
- billing;
- enterprise policy engine;
- cloud synchronization;
- agent runtime;
- autonomous browser execution;
- organization permissions.

The product generates skills. It does not need to become the system that runs every agent.

---

## 20. Documentation

The repository keeps a small set of durable documents with explicit ownership:

| Document | Owns |
| --- | --- |
| `README.md` | User-facing entrypoint: what SkillForge is, quick start, supported source/export categories, validation & grounding behavior, deployment scope/security warning, stable limitations, links to deeper docs. |
| `ARCHITECTURE.md` | Durable technical architecture: modules/boundaries, data/control flows, key design decisions, security-relevant constraints. |
| `AGENTS.md` | Durable contributor/agent contract: invariants, scope controls, security rules, testing expectations, documentation governance (this section). |
| `docs/CANONICAL_FORMAT.md` | The canonical package/manifest schema contract. |
| `docs/EXPORTERS.md` | Exporter contracts: targets, format basis, behavior, how to add one. |
| `.env.example` | Configuration contract: every runtime env var, its purpose, defaults, exposure implications. |

Transient evidence (exact test counts, test-file counts, CI run IDs, commit SHAs, branch
lifecycle, PR state, sprint/session status, remediation chronology, completed-task
archives) does **not** belong in these documents. Git history, PRs, and CI runs are the
evidence layer. Exact verification numbers go in commit messages, PR descriptions, or the
task handoff — never in durable docs.

### When to update documentation

Update a durable doc only when the change modifies a fact that document owns:

| Change type | Required durable docs review |
| --- | --- |
| User-facing workflow / supported input or output | README |
| Configuration / env change | `.env.example` (and README only if user-facing) |
| Architecture / module boundary change | ARCHITECTURE |
| Canonical package / schema semantics | docs/CANONICAL_FORMAT |
| Exporter format/target behavior | docs/EXPORTERS (+ README target list if applicable) |
| Contributor / security invariant | AGENTS |
| Tests added or fixed only | **no docs update by default** |
| Internal refactor with no contract change | **no docs update by default** |
| Bug fix restoring documented behavior | **no docs update unless the docs were wrong** |
| CI run / test-count change | **no durable docs update** |

Never advertise unimplemented features as implemented; do not create new status/report
documents (project state lives in Git/PRs/issues, not in the tree).

---

## 21. Security

- Never commit secrets.
- Sanitize filenames inside exported ZIPs.
- Prevent zip-slip/path traversal.
- Treat imported content as untrusted.
- Do not execute generated commands automatically.
- Do not execute imported repository code merely to analyze documentation.
- Bound file sizes and parsing.

---

## 22. Git rules

- Small logical commits.
- No force push.
- No remote creation or push without authorization.
- Preserve unrelated user work.
- Do not commit generated secrets or local caches.

---

## 23. Definition of done

A task is done when:
1. behavior is implemented;
2. deterministic validation is applied where relevant;
3. relevant tests were run;
4. failures were repaired;
5. UI state is honest;
6. docs match implementation.

Release candidate:
- clean setup works;
- bundled demo completes full pipeline;
- generated ZIP is valid;
- validation errors are actionable;
- build/lint/typecheck/tests pass;
- README was verified against actual commands.

---

## 24. Agent working style

Inspect before editing.

Prefer the smallest coherent implementation.

Do not spend large amounts of time generating prose before the real pipeline works.

When an optional integration is blocked:
- implement the canonical interface;
- add a mock/fixture;
- document the gap;
- continue.

Do not stop after generating files; verify that the exported package is structurally valid.
