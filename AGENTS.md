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

The MVP should make creating a useful agent skill dramatically easier than writing one manually.

---

## 2. Primary user

An individual developer or power user who wants to teach an AI coding/automation agent how to work with:
- a framework;
- an API;
- a repository;
- documentation;
- a workflow;
- a tool.

Do not optimize the MVP for enterprise governance or organization-wide knowledge management.

---

## 3. Supported source priority

P0:
- pasted text/Markdown;
- local Markdown/text files;
- documentation URL where practical;
- bundled sample.

P1:
- GitHub repository;
- multi-page documentation;
- PDF;
- website crawling with safe limits.

P2:
- authenticated documentation;
- enterprise knowledge bases.

Do not build a web crawler platform during MVP.

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

The MVP pipeline should be explicit:

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

Do not add microservices or complex job infrastructure during MVP.

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

Editing generated text may be P1, but preview is P0.

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

P0 tests should cover:
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

Include:
- loading states;
- progress;
- warnings;
- validation errors;
- empty states.

Never show validation success if checks were skipped.

---

## 19. Scope controls

Do not add during MVP:
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

Maintain:
- `README.md`
- `PRODUCT.md`
- `ARCHITECTURE.md`
- `TASKS.md`
- `.env.example`
- docs for canonical format and exporters.

README should include:
- one-sentence value proposition;
- real screenshot/GIF when available;
- quick start;
- supported inputs/outputs;
- validation behavior;
- example generated package;
- limitations.

Do not claim integrations that are only planned.

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
