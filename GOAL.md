# GOAL.md

## Autonomous sprint mode

This repository is being developed in an unattended, time-limited sprint.

Read `AGENTS.md` first. `AGENTS.md` is the repository's durable engineering contract.
Then read this file and use it as the current execution goal.

Work autonomously. Do not stop merely to ask what to do next when a safe, reasonable
next step can be inferred from `AGENTS.md`, this goal, the repository state, and test results.

### Safety boundaries for unattended execution

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

If an external service or credential is unavailable, build a provider interface plus a
deterministic demo/mock path and continue.

### Time discipline

The sprint target is to use the remaining unattended window efficiently.

If local clock access is available:
- continue implementation and repair work until approximately 08:40 Asia/Ho_Chi_Minh;
- at ~08:40 stop starting major new features;
- use the final period for tests, build, UX inspection, cleanup, docs, screenshots, and final report;
- aim to leave the repository in a clean, resumable state before 09:00.

If clock access is unavailable, use milestone completion rather than waiting.

Never intentionally idle just to consume tokens.

### Autonomous loop

Repeat until the completion conditions are met or the sprint window ends:

1. Inspect `PROJECT_STATUS.md`, `TASKS.md`, tests, and current app behavior.
2. Select the highest-value unfinished P0 item.
3. Implement it.
4. Run targeted validation.
5. Fix failures.
6. Inspect the actual user-facing behavior.
7. Update `PROJECT_STATUS.md`.
8. Commit a logical local checkpoint when useful.
9. Continue with the next highest-value item.

When P0 is genuinely complete, continue with high-value P1 work.
Only do P2 work when P0 and important P1 work are stable.

Do not generate large amounts of speculative code or documentation simply to consume quota.

### Recovery behavior

If a command or approach fails:
- inspect the error;
- attempt a reasonable repair;
- try an alternative implementation when appropriate;
- document a real blocker only after practical local alternatives are exhausted.

Do not repeatedly retry the same failing action without changing the approach.

### Finalization

Before stopping:
- run all applicable lint/typecheck/test/build/e2e checks;
- verify the bundled demo;
- inspect the main UI;
- remove obvious debug artifacts;
- ensure README claims match reality;
- update `PROJECT_STATUS.md`;
- create/update `FINAL_REPORT.md` with exact validation results and next steps.


## Product goal — SkillForge

Deliver the strongest possible runnable MVP of:

> **SkillForge — Turn documentation or repositories into validated, portable AI Agent Skills.**

### P0 success criteria

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

The pipeline must visibly represent:

Source → Analyze → Generate → Validate → Preview → Export

### Quality target

The differentiator is not just generation; it is:
- portability;
- inspectability;
- deterministic validation;
- honest source grounding.

### High-value P1 after P0

Prioritize:
1. canonical internal skill schema;
2. exporter/adapters for at least 2 target agent ecosystems;
3. GitHub/local repository source;
4. URL/documentation source with safe limits;
5. stronger validators;
6. provenance/source references;
7. sample packages and executable fixtures;
8. polished README with a real exported example.

Do NOT build a marketplace, agent runtime, team workspace, or billing system.
