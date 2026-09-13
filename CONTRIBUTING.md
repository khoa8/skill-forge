# Contributing to SkillForge

SkillForge turns bounded source material into inspectable, validated, portable
AI Agent Skills. Contributions should improve that workflow. Proposals for a
marketplace, hosted multi-tenant service, billing, team workspaces, or an agent
runtime may be declined because they fall outside the project's scope.

## Local development

Use Node.js 20 or later and npm. From the repository root:

```bash
npm ci
npm run dev
```

Open `http://127.0.0.1:8787`. The bundled mock provider needs no API key. See the
[README](README.md) for source options, configuration, and deployment limits.
Keep credentials in your local `.env`, never in tracked files or reports.

## Making a change

Read [AGENTS.md](AGENTS.md) for contributor and security invariants, then work
on a feature branch with small, coherent commits. Describe the concrete problem
and resulting behavior. Include a regression test for a bug; exercise relevant
boundaries for changes to ingestion, validation, persistence, or export.

Imported content must remain inert and bounded. Do not execute imported code or
generated commands to analyze it. Preserve source provenance, honest validation
state, and server-side export validation. Changes to security boundaries or
authenticated integrations need an explicit design discussion before implementation.

Run checks appropriate to the change. For example:

```bash
npm run typecheck
npm run build
npm test -- tests/exporters.test.ts
npm run docs:check
```

Choose test files for the behavior you changed; the exporter test above is an
example. Build before tests that exercise the compiled runtime. `npm run demo`
checks both bundled samples through generation, validation, and ZIP export.
Use `SKILLFORGE_PROVIDER=mock npm run verify:provider` for offline provider
verification. Live provider checks are optional and use your own credentials;
never include keys or private source material in their output reports.

You do not need to run every CI job locally for every change. Report the exact
commands you ran and any failures or checks you skipped. The
[CI workflow](.github/workflows/ci.yml) owns the full merge/release checks;
local focused checks do not replace successful PR CI or independent review.

## Documentation and pull requests

Update only the documents whose contracts changed. [AGENTS.md](AGENTS.md)
defines ownership and update rules; [ARCHITECTURE.md](ARCHITECTURE.md),
[the canonical format](docs/CANONICAL_FORMAT.md),
[exporter contracts](docs/EXPORTERS.md), and [.env.example](.env.example)
provide the corresponding technical details. Keep test counts, CI run evidence,
and review history in the PR rather than durable documentation.

In your PR, explain the outcome, scope, affected contracts, security impact,
and validation performed. Include screenshots for UI changes when they help
reviewers; remove private paths, account details, and source material first.
Keep unrelated changes separate and respond to review findings with focused fixes.

## Bug reports and proposals

For non-security bugs, include the SkillForge revision, Node.js version, operating
system, reproduction steps, and expected versus actual behavior. Prefer a small
synthetic example or bundled sample. Remove credentials and personal or
proprietary material from logs, screenshots, documents, and repository links.

For feature proposals, explain how the change helps create a useful agent skill
and why existing source or export options do not meet the need.

Do not disclose suspected vulnerabilities, exploit details, or secrets in public
issues or PRs. Security reports need a private maintainer channel.
