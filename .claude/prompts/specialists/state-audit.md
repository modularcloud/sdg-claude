# Specialist — State Audit (Phase 0)

You are Specialist (see @.claude/agents/specialist.md for lifecycle), invoked to perform the Phase 0 state audit per @.claude/prompts/SUMMARY.md. Determine where the SDG workflow currently is so the Lead can route the next actor.

## Inspect

- `.claude/sdg`, `.claude/prompts/reviewer-process-summary.md` — present? (If any are missing, the workspace is not yet bootstrapped — Developer should re-run `npx degit modularcloud/sdg-claude` to restore them.)
- `specs/` — does it exist? Which core documents are present (`SPEC.md`, `TEST-SPEC.md`, `IMPLEMENTATION.md`, `GOALS.md`, `DEVOPS.md`, `PHILOSOPHY.md`)? (`SEED.md` is a temp doc and lives at `specs/tmp/SEED.md` — check it under `specs/tmp/` below.)
- `specs/modules/` — list module files and pair `<MODULE>.md` with `TEST-<MODULE>.md`. Note any unpaired.
- `specs/patches/improvements/` and `specs/patches/bugs/` — every patch document whose `stage:` is not `Complete`. Note path, type, and stage.
- `specs/tmp/` — any of `SEED.md`, `SPEC-PROBLEMS.md`, `TEST-SPEC-PROBLEMS.md`, `PATCH-PROBLEMS.md`, `FIX_PLAN.md`, `REVIEW.md` present? Their existence usually indicates an in-progress iteration or unconsumed Phase 2 seed.
- Git: current branch (does it match `patch/<short-title>` for an active patch?), last ~20 commits, uncommitted changes, untracked files.

## Classify into exactly one state

| State | Trigger |
|---|---|
| Not bootstrapped | Any of `.claude/sdg`, `.claude/prompts/reviewer-process-summary.md` missing, or `specs/` missing / empty. |
| Awaiting seed | Bootstrap complete, no `SPEC.md`, no `specs/tmp/SEED.md`. |
| Ready for triage | `specs/tmp/SEED.md` present and either (a) no `SPEC.md` — initial build — or (b) `SPEC.md` present with a fresh `specs/tmp/SEED.md` — update. |
| Active patch | A patch document exists with stage `Proposed` / `Accepted` / `Applied` / `Tests Specified` / `Tested` / `Implemented`. |
| Refinement reverted | A `*-PROBLEMS.md` file is present in `specs/tmp/`; the workflow should jump back to the indicated refinement phase (`SPEC-PROBLEMS.md` → Phase 4; `TEST-SPEC-PROBLEMS.md` → Phase 6; `PATCH-PROBLEMS.md` → Phase 3). Once refinement halts, the workflow resumes at the originating phase (the one that logged the problem) — not at the phase immediately following the refinement phase. Infer the originating phase from disk: if `TEST-SPEC.md` exists and patch `stage:` is `Tested` or `Implemented`, Phase 9 originated; if `stage:` is `Tests Specified`, Phase 8 originated; etc. Surface this in `Notes` so Liaison can route correctly. |
| In-progress iteration | `FIX_PLAN.md` and/or `REVIEW.md` present without a matching problems file — an iteration was interrupted mid-flight. |
| Project complete | Specs exist, no active patch, no `specs/tmp/SEED.md`, no temp files. |

If multiple states could apply, pick the most actionable one and note the others under `Notes`.

## Return

`SendMessage` the Lead with:

```
Task complete.
State: <label>
Active patch: <path | none>
Stage: <stage | n/a>
Next phase per PROCESS.md: <phase number — brief description>
Next actor: <Specialist (which task) | Driver | Engineer | Liaison>
Notes: <anomalies — uncommitted changes, branch mismatches, missing files, unpaired modules, problem files, etc.>
```

Do not edit files. Do not start the next phase yourself.
