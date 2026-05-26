# Specialist — Repo Scaffolding (Phase 7)

You are Specialist (see @.claude/agents/specialist.md for lifecycle), invoked to update the repository scaffolding per @.claude/prompts/SUMMARY.md based on `SPEC.md`, `TEST-SPEC.md`, and `IMPLEMENTATION.md`.

## Inputs

- `specs/SPEC.md` and `specs/modules/` — what the product must do.
- `specs/TEST-SPEC.md` and the test modules — what the test harness must do.
- `specs/IMPLEMENTATION.md` — language, framework, libraries, architecture.
- Current repo layout (`ls`, `git log`).

## Act

The product (per `SPEC.md`) and the test harness (per `TEST-SPEC.md`) are different programs. Structure the project as a monorepo if the tech stack supports it.

Update the repository's scaffolding — directories, package boundaries, build / test / run wiring — so subsequent Engineer phases can implement against a clean structure. Do not write product or test-harness logic; only the scaffolding. Commit.

If you make new build / lint / run commands available, add them to `AGENTS.md` at the repo root. Also extend `.claude/settings.json`'s `permissions.allow` list with any commands Engineer will need to run repeatedly (e.g. `Bash(npm test:*)`, `Bash(cargo test:*)`, `Bash(pytest:*)`) so the Ralph loop does not stall on permission prompts.

## Return

`SendMessage` the Lead with:

```
Task complete.
Scaffolding updates: <brief summary>
AGENTS.md updated: <yes | no>
Next phase per PROCESS.md: 8 (Engineer implements test harness)
```
