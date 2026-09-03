# GOAL.md

## Autonomous continuation mode

This repository is being developed in a resumable autonomous sprint.

Read `AGENTS.md` first. `AGENTS.md` is the repository's durable engineering contract.
Then read this file, `PROJECT_STATUS.md`, `TASKS.md`, and `ARCHITECTURE.md` before making changes.

This is a CONTINUATION of the existing repository, not a restart.

Preserve all verified working functionality unless a change is necessary to improve or repair it.

Work autonomously. Do not stop merely to ask what to do next when a safe, reasonable
next step can be inferred from `AGENTS.md`, this goal, `PROJECT_STATUS.md`, `TASKS.md`,
the repository state, and test results.

## Safety boundaries for autonomous execution

You MAY:
- read and modify files inside this repository;
- install normal project-local dependencies;
- run development servers, tests, linters, typecheckers, builds, and Playwright;
- create local fixtures, screenshots, docs, and Git commits when appropriate.

You MUST NOT:
- push to any remote;
- create a remote repository;
- deploy publicly;
- purchase anything or configure real billing;
- send email/messages;
- create external accounts;
- change system-wide settings;
- use `sudo`;
- modify SSH keys, credential stores, or files outside this repository;
- expose or commit secrets;
- delete unrelated user files;
- run destructive commands outside this repository.

If an external service or credential is unavailable, preserve/build the provider interface,
use deterministic mocks/fixtures where appropriate, document the limitation, and continue.

## Continuation and recovery rules

Before new implementation:

1. Read `AGENTS.md` completely.
2. Read this `GOAL.md` completely.
3. Read `PROJECT_STATUS.md` completely.
4. Read `TASKS.md` and `ARCHITECTURE.md`.
5. Inspect the repository structure.
6. Run `git status`.
7. Inspect recent local commits and diffs.
8. Inspect all uncommitted changes left by any interrupted model/session.
9. Run the current baseline validation commands from `PROJECT_STATUS.md`.
10. Determine what is:
   - already complete and verified;
   - partially complete;
   - unfinished;
   - blocked;
   - stale or inconsistent.

Do NOT rebuild completed P0 functionality from scratch.

Do NOT discard verified work merely because a different implementation would be preferred.

If `PROJECT_STATUS.md` conflicts with the actual repository or test results, trust current
repository evidence and update `PROJECT_STATUS.md`.

## Time discipline

There is NO fixed clock deadline in this goal.

Ignore any historical sprint cutoff, quota-expiration time, 08:40 cutoff, 09:00 deadline,
or other obsolete time-based instruction from earlier sessions.

Work based on milestones and evidence, not wall-clock time.

Continue until:
- the current goal's achievable acceptance criteria are satisfied and verified; or
- a genuine blocker prevents further safe progress; or
- the ZCode goal usage budget/session limit stops execution.

Never intentionally idle merely to consume tokens or elapsed time.

## Autonomous loop

Repeat:

1. Inspect `PROJECT_STATUS.md`, `TASKS.md`, tests, and current app behavior.
2. Confirm that previously verified P0 functionality remains green.
3. Select the highest-value unfinished task that advances this goal.
4. Implement the smallest coherent change.
5. Run targeted validation.
6. Fix failures.
7. Inspect the actual user-facing behavior when applicable.
8. Update `PROJECT_STATUS.md`.
9. Commit a logical local checkpoint when useful.
10. Continue with the next highest-value task.

Prioritize:
P0 regression safety
→ highest-value P1
→ reliability/security
→ tests
→ UX
→ documentation
→ P2 only when justified.

Do not generate large amounts of speculative code or documentation simply to consume quota.

## Recovery behavior

If a command or approach fails:
- inspect the actual error;
- attempt a reasonable repair;
- try a simpler or alternative implementation where appropriate;
- preserve working functionality;
- document a real blocker only after practical local alternatives are exhausted.

Do not repeatedly retry the same failing action without changing the approach.

## Product goal — SkillForge

Deliver the strongest possible verified, maintainable, open-source-ready version of:

> **SkillForge — Turn documentation or repositories into validated, portable AI Agent Skills.**

The main differentiator remains:

> **Generate → Inspect → Deterministically Validate → Export**

## Current baseline: preserve P0

According to the latest project status, P0 has already been implemented and verified.

Treat the following as regression requirements, not work that should be rebuilt from scratch:

A first-time user can, without a paid model key:

1. open the application;
2. choose bundled sample documentation or paste Markdown/text;
3. run the generation pipeline;
4. see a canonical generated skill package;
5. inspect generated files in the UI;
6. run deterministic validation;
7. see actionable validation results;
8. export a real ZIP;
9. inspect a package containing useful, non-empty skill artifacts.

The pipeline must continue to visibly represent:

Source → Analyze → Generate → Validate → Preview → Export

Before substantial new work, rerun baseline tests/build/demo and confirm this remains true.

If a regression is found, repair it before continuing P1.

## Quality target

The differentiator is not just generation; it is:
- portability;
- inspectability;
- deterministic validation;
- honest source grounding;
- useful exported artifacts;
- reliable developer experience.

## Primary continuation objective: P1

Continue from the existing prioritized backlog rather than restarting P0.

Prioritize these high-value P1 areas, while checking `TASKS.md` and actual repository state
before assuming they are still unfinished:

1. canonical internal skill schema quality and maintainability;
2. exporter/adapters for at least 2 target agent ecosystems, with real validation;
3. GitHub/local repository source support;
4. URL/documentation source support with safe limits;
5. stronger deterministic validators;
6. provenance/source references;
7. sample packages and executable fixtures;
8. polished README with a real exported example;
9. persistence improvements if they materially improve the product;
10. live provider integration verification only when credentials/configuration are safely available.

Current known gaps from the latest project status should be investigated, not blindly assumed:
- URL / GitHub / PDF sources were not implemented;
- live `glm` / `openai` endpoints were not verified;
- the skill store was in-memory and bounded.

Use repository evidence to confirm whether these gaps still exist before acting on them.

## Source and package integrity

Generated instructions must remain grounded in supplied source material.

Do not invent:
- APIs;
- CLI commands;
- configuration keys;
- paths;
- environment variables;
- workflow steps.

When information is unavailable, preserve uncertainty.

Generated packages should contain useful artifacts only.

Do not generate ceremonial empty files.

## Validation remains a core requirement

Maintain and improve deterministic validation where valuable.

Validate where applicable:
- required files;
- required headings/metadata;
- empty sections;
- malformed YAML/JSON/front matter;
- invalid file references;
- path traversal;
- broken internal references;
- duplicate IDs;
- unsupported target format;
- obvious placeholders;
- malformed packages;
- manifest/package inconsistencies.

LLM review may supplement deterministic validation but must never replace it.

Never display or report validation success when relevant checks were skipped.

## Portability architecture

Use a canonical internal skill representation.

Vendor-specific formats should remain exporters/adapters rather than separate duplicated
generation pipelines.

Do not claim compatibility unless the output is actually supported and tested.

## Provider behavior

If an LLM is needed:
- use provider abstraction;
- GLM may be a provider but not an architectural dependency;
- retain deterministic mock/demo generation;
- validate model-generated structured output.

Do not require a paid key for the bundled demo.

Do not expose or commit credentials.

## Scope controls

Do NOT build unless explicitly requested later:
- marketplace;
- team workspace;
- agent runtime;
- billing;
- enterprise governance;
- social features;
- complex general-purpose web crawler;
- unrelated infrastructure.

Do not replace the modular MVP with microservices or unnecessary infrastructure.

## Tests and verification

Preserve the existing verified baseline and expand tests when new behavior is added.

Prioritize tests for:
- normalization;
- canonical skill schema;
- generation output validation;
- deterministic validator;
- exporters;
- ZIP generation;
- path safety;
- malformed model output;
- bundled demo;
- provider failures;
- source adapters added during P1;
- provenance behavior;
- end-to-end Source → Export flow.

Run all applicable:
- `npm test`;
- `npm run typecheck`;
- `npm run lint`;
- `npm run build`;
- `npm run demo`;
- Playwright/browser validation when available or appropriate.

Never claim a check passed unless it was actually run.

When fixing a real defect, add a regression test when practical.

## UX

A user should understand in seconds:

> Give SkillForge a source and receive a validated portable Agent Skill.

Inspect the real running UI when changing user-facing behavior.

Repair:
- broken flows;
- dead controls;
- weak loading/error states;
- misleading validation state;
- confusing source selection;
- bad responsive behavior;
- unusable exported-artifact inspection.

Never provide a fake Download button.

Screenshots must come from the real running application.

## Documentation

Keep these synchronized with reality:
- `README.md`
- `PRODUCT.md`
- `ARCHITECTURE.md`
- `TASKS.md`
- `PROJECT_STATUS.md`
- `.env.example`
- `FINAL_REPORT.md`
- relevant docs/examples.

Do not advertise unimplemented features as implemented.

## Finalization

When the achievable continuation objectives are complete, perform a release audit.

Before stopping:
- run all applicable lint/typecheck/test/build/demo/e2e checks;
- verify the bundled no-key workflow;
- verify all newly added source/export paths;
- inspect exported ZIP contents;
- inspect the main UI;
- remove obvious debug artifacts;
- ensure README claims match reality;
- update `PROJECT_STATUS.md`;
- create/update `FINAL_REPORT.md` with exact validation results and next steps.

## Final audit perspectives

Review as:
- senior engineer;
- QA engineer;
- security reviewer;
- first-time developer;
- open-source maintainer;
- skeptical GitHub user.

Fix meaningful problems rather than merely listing them.

## Completion criteria

Do not declare this continuation complete merely because one P1 feature was added.

Completion requires:

1. existing verified P0 remains green;
2. highest-value achievable P1 work selected from current repository evidence is implemented;
3. new behavior is validated and tested;
4. the real Source → Analyze → Generate → Validate → Preview → Export flow still works;
5. documentation and project status match reality;
6. no obsolete time deadline is used to force premature finalization;
7. `FINAL_REPORT.md` clearly records what is verified, incomplete, blocked, and recommended next.

When all important achievable work is complete, stop cleanly.
Do not invent unnecessary features simply to keep the goal running.
