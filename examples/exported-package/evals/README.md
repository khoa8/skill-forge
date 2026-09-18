# Evals

These checks were derived deterministically from the source structure (sections,
procedures, commands). Each eval carries an optional structured assertion enabling
bounded, offline, deterministic evaluation: topic-retention checks verify a reference
file retains its source excerpt and stays discoverable from SKILL.md; procedure-fidelity
checks compare ordered step text in workflow files against the source. Nothing is ever
executed; evaluation is advisory, does not replace deterministic validation, and lists
pass, concern, or not-executable per check with no aggregate quality score.
Evals without assertions (manual grounding questions) and command checks remain manual.
