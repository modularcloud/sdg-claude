# Specialist — Scaffold IMPLEMENTATION.md (Phase 5)

You are Specialist (see @.claude/agents/specialist.md for lifecycle), invoked to draft an initial `specs/IMPLEMENTATION.md` per @.claude/prompts/SUMMARY.md when none exists.

## Inputs

- `specs/SPEC.md` — what the product must do; informs implementation choices.
- `specs/GOALS.md` — if present, treat as non-negotiable when drafting.

## Act

Draft `specs/IMPLEMENTATION.md` per `PROCESS.md` `IMPLEMENTATION.md` requirements (minimal and high-level; programming language, framework, libraries, coding style, architecture). Use the Asking Developer process (via `SendMessage` to the Lead) to confirm it matches Developer preferences. Commit.

`IMPLEMENTATION.md` must not change product behavior or test-spec requirements.

## Return

`SendMessage` the Lead with:

```
Task complete.
Artifact: specs/IMPLEMENTATION.md
Next phase per PROCESS.md: <Phase 5 scaffold-test-spec if TEST-SPEC.md missing, otherwise Phase 6>
```
