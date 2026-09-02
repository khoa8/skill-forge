# SkillForge — Product

## Mission

SkillForge turns documentation, repositories, and instructional material into portable, validated AI Agent Skills.

Core promise:

> Source → analyze → extract procedures/knowledge → generate skill package → validate → preview → export.

SkillForge is **not**: a generic summarizer, a RAG chatbot, a prompt marketplace, an agent runtime, or an IDE.

## Primary user

An individual developer or power user who wants to teach an AI coding/automation agent how to work with a framework, API, repository, documentation set, or workflow. The MVP is not optimized for enterprise governance.

## The differentiator

Generation alone is commoditized. SkillForge's value is the loop:

1. **Inspectable generation** — every extracted item carries source line ranges; the UI shows provenance per file.
2. **Deterministic validation** — 14 checks that always run the same way; findings are actionable (file + line + fix hint).
3. **Honest grounding** — generated skills quote or excerpt the source; when the source cannot answer a standard section (inputs, constraints, verification, pitfalls), the skill marks a gap instead of inventing content.
4. **Portability** — one canonical internal representation; vendor formats are exporters, not pipelines.

## Scope

**In scope (MVP):** text/Markdown sources, bundled samples, mock provider, deterministic validator, canonical package, claude-code + generic exporters, ZIP download, web UI.

**Out of scope (per AGENTS.md §19):** marketplace, social features, team workspaces, billing, enterprise policy, cloud sync, agent runtime, autonomous browser execution, complex web crawler.

## Roadmap priorities

P0 (done): generation pipeline → deterministic validation → real ZIP export → reliability → tests → UX.
P1 (next): canonical schema hardening, exporter expansion, GitHub/URL sources, provenance UX, sample packages.
P2: authenticated documentation, enterprise knowledge bases.

## UX contract

- The first screen explains the workflow in seconds: *Add source → Generate skill → Validate → Export*.
- The stepper always reflects real pipeline state (idle / active / done / error).
- "Validation passed" is shown **only** when validation actually executed and passed. Skipped validation renders an explicit not-success state.
- The Download button is real: the server re-validates and streams an actual ZIP; blocked exports explain why.
