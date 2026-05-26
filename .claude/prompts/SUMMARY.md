# Process Summary

The Claude-Code-flavored quick reference to `@specs/PROCESS.md`. Teammates (Driver, Engineer, Specialist) read this for the process logic they need to do their job. The Lead reads `@.claude/prompts/PROCESS.md` for routing rules. Liaison reads both.

If this file conflicts with `@specs/PROCESS.md`, `@specs/PROCESS.md` wins — flag the conflict.

## Concepts

- **Product** — the software being built. Source of truth: `specs/SPEC.md` (+ `specs/modules/<MODULE>.md`).
- **Test harness** — a separate program that blackbox-tests the product. Source of truth: `specs/TEST-SPEC.md` (+ `specs/modules/TEST-<MODULE>.md`).
- **Specs** — `SPEC.md` and `TEST-SPEC.md` collectively.
- **Developer** — the human running the process. Talks only to Liaison.
- **Seed** — `specs/tmp/SEED.md`. Developer's description of work; consumed (and deleted) in Phase 2.
- **Patch** — a documented change to the existing specs/code. Lives under `specs/patches/improvements/NNNN-<short-title>.md` (IP) or `specs/patches/bugs/NNNN-<short-title>.md` (Bug).

## Core documents

All under `specs/`.

| File | Required | Edited by | Notes |
|---|---|---|---|
| `PROCESS.md` | yes | nobody | Conceptual spec; immutable. |
| `SPEC.md` | yes (after Phase 2) | Specialist (initial), Driver (refinement) | Source of truth for product behavior. |
| `TEST-SPEC.md` | yes (after Phase 5) | Specialist (initial), Driver (refinement) | Source of truth for test harness. |
| `IMPLEMENTATION.md` | optional | Specialist | Language / framework / architecture choices. |
| `GOALS.md` | optional | Developer only | Non-negotiable goals. Other agents may read but never edit without explicit Developer approval. |
| `PHILOSOPHY.md` | optional | **Liaison only** | Durable principles inferred from Developer. Other agents must not read or interpret. |
| `DEVOPS.md` | optional | Specialist | Release / merge / deploy policy. |

Module documents follow the same rules as their parent (`SPEC.md` → `specs/modules/<NAME>.md`; `TEST-SPEC.md` → `specs/modules/TEST-<NAME>.md`). All modules live in the flat `specs/modules/` directory regardless of nesting.

## Temporary documents

All under `specs/tmp/`. Created, consumed, and deleted by agents as needed.

- `SEED.md` — Developer's seed (consumed by Specialist in Phase 2).
- `SPEC-PROBLEMS.md` — blocking issues found in `SPEC.md` by a later phase. Triggers a jump back to Phase 4.
- `TEST-SPEC-PROBLEMS.md` — same, for `TEST-SPEC.md`. Triggers jump to Phase 6.
- `PATCH-PROBLEMS.md` — same, for a patch document. Triggers jump to Phase 3.
- `FIX_PLAN.md` — granular task list maintained by Engineer during the Ralph loop.
- `REVIEW.md` — Reviewer's response from the most recent `bash .claude/sdg review` invocation.

## Patch documents

Index padded to 4 digits, highest existing + 1, starting at `0001`. Short titles are unique.

Required front matter:

```yaml
---
type: improvement | bug
stage: Proposed | Accepted | Applied | Tests Specified | Tested | Implemented | Complete
test_spec_changes: true | false
base_branch: <branch this was forked from>
base_commit: <commit SHA at fork time — full SHA preferred>
---
```

Lifecycle:

- **Improvement Proposal (IP)** — `type: improvement`. Proposes changes to `SPEC.md`. Stages: Proposed → Accepted → **Applied** → Tests Specified → Tested → Implemented → Complete.
- **Bug Report** — `type: bug`. Proposes changes only to `TEST-SPEC.md` and/or test-harness code (never to `SPEC.md`). Stages: Proposed → Accepted → Tests Specified → Tested → Implemented → Complete. The Tests Specified stage is skipped when no `TEST-SPEC.md` change is needed.

IPs must not suggest `TEST-SPEC.md` changes. Bugs must not suggest `SPEC.md` changes. Both must avoid prescribing specific code or implementation details (archival material from GitHub / Linear / etc. may be quoted for context but is not authoritative).

## Actors

- **Developer** — Human; talks only to Liaison.
- **Lead** — Routing layer; spawns teammates, never writes substantive text, never edits files.
- **Liaison** — Subagent; sole holder of Developer chat history and `PHILOSOPHY.md`. Composes every word the Developer sees and every spawn prompt.
- **Driver** — Teammate; runs one Iterative Refinement iteration per spawn. Invokes Reviewer via `bash .claude/sdg review`.
- **Engineer** — Teammate; runs one Ralph-loop iteration per spawn (**fresh context each iteration**). Implements code.
- **Specialist** — Teammate; runs one bounded task per spawn (state audit, triage, scaffolds, repo scaffolding, release).
- **Reviewer** — External OpenAI model invoked by Driver via `bash .claude/sdg review`. No memory of prior calls.

## Iterative Refinement (Driver — Phases 3, 4, 6)

A fresh Driver is spawned per iteration; context resets between iterations.

1. Run `bash .claude/sdg review <target>` where `<target>` is `spec`, `test-spec`, or `patch <path>`. The CLI assembles the bundle (see below) and writes the response to `specs/tmp/REVIEW.md`.
2. Read `REVIEW.md`. If it contains no `critical` (non-optional) findings: perform no work, delete `REVIEW.md`, **also delete the relevant `*-PROBLEMS.md` file if this iteration was triggered by one** (see "Clearing problems files" below), commit if anything was deleted, then signal **Phase NNN complete**. The refinement loop halts.
3. If clarifying Developer intent is needed, ask via Liaison (Asking Developer flow). Liaison can read `REVIEW.md` for context.
4. Apply useful feedback. For each rejected suggestion, append a one-line note (severity + reason) under a `## Resolution notes` section near the bottom of the active patch document. Create the section if it doesn't exist. If there is no active patch document (Phase 4 initial-build SPEC refinement, or Phase 6 initial-build TEST-SPEC refinement), record rejections in the commit message instead.
5. Delete `specs/tmp/REVIEW.md`. Commit. Signal **Iteration N complete** to the Lead.

**Clearing problems files.** If Phase 4 was entered via a `specs/tmp/SPEC-PROBLEMS.md` jump-back (Phase 6 or Phase 9 logged a SPEC blocker), Phase 6 via `specs/tmp/TEST-SPEC-PROBLEMS.md` (Phase 8 or 9 logged a TEST-SPEC blocker), or Phase 3 via `specs/tmp/PATCH-PROBLEMS.md` (a later phase logged a patch blocker), the file is included in the review bundle and is consumed during refinement. When Driver halts the refinement loop (no critical findings remain), Driver MUST delete the corresponding `*-PROBLEMS.md` file before signaling `Phase NNN complete.`. Leaving it on disk would cause every subsequent review to keep including stale problems and could re-trigger jump-backs.

Driver should not look at implementation code in general. For a bug-patch iteration, Driver may inspect implementation code to verify the bug report is on the right track — without prescribing fixes.

After applying Reviewer feedback, Driver must re-run `bash .claude/sdg review <target>` to confirm no new critical findings remain before advancing the stage. The CLI does not enforce this.

Before signaling `Phase NNN complete.`, Driver must advance the active patch's `stage:` to the End Stage in `@specs/PROCESS.md` for the phase just finished (Phase 3 → `Accepted`; Phase 4 → `Applied` for an IP; Phase 6 → `Tests Specified`). Skip if there is no active patch (Phase 4 initial-build SPEC refinement, or Phase 6 initial-build TEST-SPEC refinement). The CLI does not enforce this.

**Phase 3 → Phase 8 fast path.** Per `@specs/PROCESS.md`, if at the end of Phase 3 the patch is a `type: bug` with `test_spec_changes: false`, Phases 4–7 are skipped and the next phase is Phase 8 (Engineer). In that case Driver must seed `specs/tmp/FIX_PLAN.md` with the test-harness fixes implied by the patch body before signaling `Phase 3 complete.`. The next Engineer iteration picks up that `FIX_PLAN.md` directly. In all other Phase 3 completions, Driver does not create `FIX_PLAN.md`.

**Phase 4 GOALS vs SPEC contradiction.** Per `@specs/PROCESS.md` Phase 4, if Driver discovers a contradiction between `GOALS.md` and `SPEC.md` while refining `SPEC.md`, it must be resolved by either updating `GOALS.md` or changing `SPEC.md` in a way the Developer accepts. Driver does not resolve unilaterally — `GOALS.md` requires explicit Developer approval to edit. Driver asks via Liaison and applies the chosen resolution.

### Reviewer bundle composition

`bash .claude/sdg review <target>` assembles a fixed bundle per target. Every bundle begins with built-in Reviewer instructions, then `.claude/prompts/reviewer-process-summary.md`, then any of `PROCESS.md`, `specs/PROCESS.md`, `specs/GOALS.md`, and `specs/IMPLEMENTATION.md` that exist. The target artifact (or, for `patch`, the patch document) is appended last. The CLI does **not** auto-detect an active patch from the branch name — for patch reviews, Driver passes the path explicitly. For spec / test-spec reviews, an active patch is not included as context; if the iteration needs that context, log it via the appropriate `*-PROBLEMS.md` file instead.

| Target | Trailing target-specific content |
|---|---|
| `spec` | `SPEC-PROBLEMS.md` (if exists); `SPEC.md`; non-`TEST-` modules in `specs/modules/`. |
| `test-spec` | `SPEC.md` and non-`TEST-` modules (as context); `TEST-SPEC-PROBLEMS.md` (if exists); `TEST-SPEC.md`; `TEST-*` modules. |
| `patch <path>` | `SPEC.md` and non-`TEST-` modules (as context); `TEST-SPEC.md` and `TEST-*` modules (as context); `PATCH-PROBLEMS.md` (if exists); the patch document. |

## Ralph Loop (Engineer — Phases 8 and 9)

A fresh Engineer is spawned per iteration; context resets between iterations. Within a single iteration Engineer may fan out to `general-purpose` subagents.

For each iteration:

1. Read `SPEC.md`, `TEST-SPEC.md`, `IMPLEMENTATION.md`, and the goal you were given in the spawn prompt.
2. Read `specs/tmp/FIX_PLAN.md` if it exists.
3. **If `FIX_PLAN.md` does not exist:**
   - Use subagents to determine if the implementation is in full spec compliance (subjective audit + all relevant tests passing locally and in CI). For Phase 8, "all relevant tests" means test-harness self-tests. For Phase 9, **all** tests.
   - If compliant: run the Code Review Sub-Flow (below) — this finishes the iteration and exits the Ralph loop.
   - If not compliant: write granular tasks to `specs/tmp/FIX_PLAN.md` to close the gap, commit, and finish the iteration.
4. **If `FIX_PLAN.md` exists:** pick a single task and work on it for the rest of the iteration.
5. Use subagents to research whether the picked task is already implemented correctly. If yes: remove the task from `FIX_PLAN.md`, commit, finish the iteration.
6. Otherwise: implement the task. If you discover the task itself is wrong (impossible, misguided, contradicts spec), remove it, add replacement tasks if needed, commit, finish the iteration.
7. When the implementation attempt is complete (success or partial), commit, finish the iteration.
8. When the last task is removed from `FIX_PLAN.md`, delete the file.
9. If you learn new build / lint / run commands during the iteration, add them to `AGENTS.md` at the repo root (create the file on first write; read it at the start of each iteration if it exists, since prior iterations may have recorded commands you'll need). Add nothing else to `AGENTS.md`.
10. Before signaling `Phase NNN complete.`, advance the active patch's `stage:` (Phase 8 → `Tested`; Phase 9 → `Implemented`). Editing the `stage:` line is the only patch-document change Engineer is permitted; skip if there is no active patch.

"Finish the iteration" = commit and push the iteration's changes, then end the spawn. The next iteration begins with a fresh Engineer.

Engineer must not ask the Developer mid-iteration. If Engineer needs Developer input, it logs a blocking problem to the appropriate `-PROBLEMS.md` file (see Identifying Spec Problems below) and ends the iteration; a later iteration or phase will resolve it.

### Code Review Sub-Flow

Run only when full spec compliance is reached. Code review may not be set up; if so, this trivially finishes and exits the loop.

1. Read all open code-review comments on the PR via `gh`.
2. Reject misguided comments inline (reply on the PR with a brief reason).
3. Add tasks for all non-rejected comments to `FIX_PLAN.md`. Commit. Finish the iteration. (The next iteration picks up the new tasks via the regular flow.)
4. Once there are no remaining non-rejected comments AND no `FIX_PLAN.md` AND full spec compliance: commit, exit the Ralph loop.

## Identifying Spec Problems

If a later phase discovers a blocking issue in a previously-finalized document, log it and halt. The system reverts to a refinement phase to resolve.

| Problem in | Logged to | Jump to |
|---|---|---|
| `SPEC.md` | `specs/tmp/SPEC-PROBLEMS.md` | Phase 4 |
| `TEST-SPEC.md` | `specs/tmp/TEST-SPEC-PROBLEMS.md` | Phase 6 |
| Patch (IP or bug) | `specs/tmp/PATCH-PROBLEMS.md` | Phase 3 |

**Blocking** means one of:
1. Contradictions in the requirements.
2. Impossible or untestable requirements.
3. Anything else that prevents test or implementation work from proceeding.

Ambiguities, factual errors, and other issues are NOT blocking unless they make the work impossible.

**Resuming after a jump-back.** When a jump-back refinement halts (Driver signals `Phase NNN complete.` with the `*-PROBLEMS.md` file deleted), Liaison resumes at the phase that originally logged the problem — not by re-running every intermediate phase. Concretely:

- Jump-back into Phase 4 from Phase 6 → resume at Phase 6 (skip Phase 5; `IMPLEMENTATION.md` / `TEST-SPEC.md` already exist).
- Jump-back into Phase 4 from Phase 9 → resume at Phase 9 (skip Phases 5–8; harness and product trees already exist).
- Jump-back into Phase 6 from Phase 8 → resume at Phase 8.
- Jump-back into Phase 6 from Phase 9 → resume at Phase 9.
- Jump-back into Phase 3 from any later phase → resume at the originating phase if the patch body was only refined (no reclassification); if the patch was reclassified or substantively changed in a way that invalidates downstream artifacts, resume at the earliest invalidated phase. Liaison decides per situation, asking the Developer if unclear.

Liaison infers the originating phase from disk state (which artifacts already exist, what `stage:` the active patch is at) plus chat history. If unsure, `Action: ask`.

## Asking Developer

Driver and Specialist may ask Developer via Liaison. Engineer must not (see Ralph Loop above).

From the asking teammate's perspective:

1. `SendMessage` the Lead: `Question for Developer: <Q>. Context: <minimal>.`
2. Wait. The reply arrives as a `SendMessage`. Continue the task.

The Lead and Liaison handle everything between — Liaison may answer from chat history or `PHILOSOPHY.md` without bothering the Developer, may ask the Developer directly, may add a durable principle to `PHILOSOPHY.md`, etc. From the teammate's view it just looks like a question-and-answer round-trip.

If the Developer responds with something like "whatever you recommend" or "your call," Liaison makes the call — the question doesn't bounce back unanswered.

## Phase reference

| Phase | Actor (task prompt) | Inputs | Output | Patch-stage transition |
|---|---|---|---|---|
| 0 | Specialist (`state-audit.md`) | repo + git state | next-phase recommendation | none |
| 1 | Liaison | Developer chat | `specs/tmp/SEED.md` | none |
| 2 | Specialist (`triage.md`) | `specs/tmp/SEED.md`, `SPEC.md`?, `GOALS.md`? | initial `SPEC.md` OR initial patch document on a `patch/<title>` branch (and `SEED.md` deleted) | n/a → Proposed (for patches) |
| 3 | Driver | active patch | refined patch | Proposed → Accepted |
| 4 | Driver | `SPEC.md`, IP (if any) | refined `SPEC.md` | Accepted → Applied (IPs) |
| 5 | Specialist (`scaffold-implementation.md`, `scaffold-test-spec.md`) | `SPEC.md`, `GOALS.md`? | `IMPLEMENTATION.md` and/or `TEST-SPEC.md` (only what's missing) | none |
| 6 | Driver | `TEST-SPEC.md`, bug (if any) | refined `TEST-SPEC.md` | IP: Applied → Tests Specified; Bug: Accepted → Tests Specified |
| 7 | Specialist (`repo-scaffolding.md`) | all specs | repo structure (no logic) | none |
| 8 | Engineer (Ralph loop) | `TEST-SPEC.md`, `IMPLEMENTATION.md` | test-harness implementation; harness self-tests pass | Tests Specified → Tested (or Accepted → Tested for bugs without `TEST-SPEC.md` changes) |
| 9 | Engineer (Ralph loop) | `SPEC.md`, harness | product implementation; all tests pass | Tested → Implemented |
| 10 | Specialist (`release.md`) | `DEVOPS.md`, git state | release / merge / deploy | Implemented → Complete |

Reclassification: during Phase 3 refinement, a patch may be reclassified IP↔Bug. The body, `type:` front-matter field, and (if appropriate) the patch's directory must all be updated to match. Reviewer will flag mismatches.

## Key invariants

- Commit at the end of every iteration / task. Uncommitted work disappears when a teammate is dismissed.
- Front matter is agent-owned. The CLI never reads or writes it.
- `PROCESS.md` (in `specs/`) is immutable.
- `PHILOSOPHY.md` is Liaison-only; other agents must not infer answers from it.
- `GOALS.md` requires Developer approval to edit.
- The Lead never reads substantive file content, edits anything, or composes Developer-facing text.
- All Developer-facing text comes from Liaison.
- Driver, Engineer, and Specialist reset context between iterations / tasks. They persist *within* one iteration / task so mid-task subagent fan-out and Asking-Developer round-trips don't lose state.
