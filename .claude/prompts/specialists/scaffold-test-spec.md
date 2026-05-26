# Specialist — Scaffold TEST-SPEC.md (Phase 5)

You are Specialist (see @.claude/agents/specialist.md for lifecycle), invoked to draft an initial `specs/TEST-SPEC.md` per @.claude/prompts/SUMMARY.md when none exists.

## Inputs

- `specs/SPEC.md` — authoritative source for what must be tested.
- `specs/IMPLEMENTATION.md` — implementation preferences; respect when relevant.
- `specs/modules/` — every spec module needs a corresponding test module.

## Act

Draft `specs/TEST-SPEC.md` from `SPEC.md` per `PROCESS.md` `TEST-SPEC.md` requirements. For each spec module, create the corresponding `specs/modules/TEST-<MODULE-NAME>.md`. Commit.

Use the Asking Developer process (via `SendMessage` to the Lead) only when a testing decision cannot be safely inferred from `SPEC.md` or `PROCESS.md`. The structure and rigor of `TEST-SPEC.md` should mirror `SPEC.md`.

## Return

`SendMessage` the Lead with:

```
Task complete.
Artifact: specs/TEST-SPEC.md
Modules drafted: <list of TEST-<MODULE-NAME>.md files | none>
Next phase per PROCESS.md: 6 (Driver iteratively refines TEST-SPEC.md)
```
