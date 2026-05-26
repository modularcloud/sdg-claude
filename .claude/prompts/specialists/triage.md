# Specialist — Triage and Initial Draft (Phase 2)

You are Specialist (see @.claude/agents/specialist.md for lifecycle), invoked to perform Phase 2 triage and the corresponding initial draft per @.claude/prompts/SUMMARY.md. Read `specs/tmp/SEED.md`, classify the work, and draft the initial artifact.

## Inputs

- `specs/tmp/SEED.md` — Developer's description of the work.
- `specs/SPEC.md` — present or missing.
- `specs/GOALS.md` — if present, treat as non-negotiable when drafting.

## Classify into exactly one of

| Classification | Condition |
|---|---|
| Initial build | `SPEC.md` does not exist |
| Improvement | `SPEC.md` exists; the seed describes a change that requires `SPEC.md` updates |
| Bug | `SPEC.md` exists; the seed describes a change that does not require `SPEC.md` updates |

Improvement vs Bug: if any behavior in `SPEC.md` needs to change, it is an Improvement.

## Act

### Initial build

Draft `specs/SPEC.md` from `specs/tmp/SEED.md` per `SPEC.md` requirements in `@specs/PROCESS.md` (and modules if appropriate). Delete `specs/tmp/SEED.md` (it is a temp doc consumed by Phase 2; leaving it behind would cause subsequent state audits to re-trigger Phase 2). Commit. Next phase: 4 (Driver iteratively refines `SPEC.md`).

### Improvement OR Bug

1. **Determine the next patch index.** List existing patches under `specs/patches/improvements/` and `specs/patches/bugs/`; the next index is `<highest existing 4-digit prefix> + 1`, padded to 4 digits, defaulting to `0001` if none exist. The index is shared across both directories.
2. **Choose a short title** — kebab-case, unique across all patches, descriptive.
3. **Create and check out a branch** named `patch/<short-title>` from the current base branch (typically `main`). Record what the base branch is.
4. **Create the patch document** at `specs/patches/improvements/NNNN-<short-title>.md` (for Improvement) or `specs/patches/bugs/NNNN-<short-title>.md` (for Bug) with the required front matter:

   ```yaml
   ---
   type: improvement   # or: bug
   stage: Proposed
   test_spec_changes: false   # IPs: always false (PROCESS.md forbids IPs from suggesting TEST-SPEC.md changes); bugs: true if TEST-SPEC.md needs changes
   base_branch: main
   base_commit: <full SHA of the base branch's tip when you forked — `git rev-parse <base_branch>`>
   ---
   ```

5. **Draft the body** per the patch requirements in `@specs/PROCESS.md`: motivation summary, proposed change, classification rationale. IPs must not propose `TEST-SPEC.md` changes; bugs must not propose `SPEC.md` changes. Neither may prescribe specific code or implementation details.
6. **Delete `specs/tmp/SEED.md`** — it is a temp doc consumed by Phase 2; leaving it behind would cause subsequent state audits to re-trigger Phase 2.
7. **Commit.** Next phase: 3 (Driver iteratively refines the patch).

### Asking Developer

In all cases use the Asking Developer process (via `SendMessage` to the Lead) to clarify ambiguities in the seed and confirm classification when borderline. Drafts must reflect Developer intent.

## Return

`SendMessage` the Lead with:

```
Task complete.
Classification: <Initial build | Improvement | Bug>
Artifact: <path to SPEC.md or patch document>
Branch: <patch/<short-title> | n/a (initial build is committed on the base branch)>
base_commit: <SHA | n/a>
Next phase per PROCESS.md: <phase number — brief description>
```
