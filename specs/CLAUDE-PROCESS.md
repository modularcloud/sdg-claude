# CLAUDE-PROCESS.md — Running SDG in Claude Code

This document binds the harness-agnostic process in [PROCESS.md](PROCESS.md) to Claude Code (web or CLI). PROCESS.md defines *what* happens; this file defines only *how* it executes with Claude Code primitives: subagents, forked subagents, SendMessage continuation, git, and `gh`. If the two documents ever conflict, PROCESS.md wins. The complete list of sanctioned mechanical adaptations is in §10 — everything else follows PROCESS.md to the letter.

Like PROCESS.md, this file must not be modified by agents running the process.

## 1. Prerequisites

- A git repository with a GitHub remote, push access, and GitHub Actions enabled.
- Authenticated GitHub access for PRs, review comments, and CI status — the `gh` CLI where available, or an equivalent GitHub integration (e.g., the built-in GitHub integration on Claude Code web).
- A Claude Code environment supporting: subagents, **forked** subagents — via `subagent_type: "fork"` where the harness registry offers that type, or via an untyped spawn on harnesses honoring `CLAUDE_CODE_FORK_SUBAGENT=1` (the scaffold's settings set it); either way the spawn must inherit the conversation history — and **SendMessage** continuation of a previously spawned agent with its context intact. If forks or SendMessage are unavailable, halt and tell Developer this environment cannot run the process as specified. (Claude Teammates is a legacy fallback for long-lived agent threads; with SendMessage continuation it is unnecessary.)
- A sandboxed or disposable execution environment (Claude Code web/cloud, a container, or a VM). `.claude/settings.json` ships with `permissions.defaultMode: "bypassPermissions"`: the process runs long and unattended, and a wrongly-restricted permission set that silently stalls an agent is a worse failure here than broad permissions in a sandbox. Developers running on an unsandboxed machine should change that setting deliberately.

## 2. Role bindings

| PROCESS.md actor | Claude Code binding | Context & memory |
|---|---|---|
| Developer | The human in the Claude Code chat | — |
| — (Orchestrator) | The main conversation thread | Dumb process-stepper; owns no content work (§3) |
| Liaison | **Forked** subagent, prompt: `"Read .claude/prompts/sdg-liaison.md and act as Liaison. <episode input>"` — use `subagent_type: "fork"` if the registry offers it, else an untyped spawn (the scaffold sets `CLAUDE_CODE_FORK_SUBAGENT=1`, making untyped spawns fork). Liaison self-verifies inheritance and ERRORs if history is absent | Inherits full chat history at spawn time; sole reader/editor of `specs/PHILOSOPHY.md` |
| Reviewer | `sdg-reviewer` agent | Fresh, one-shot; writes `specs/tmp/REVIEW.md` itself |
| Driver | `sdg-driver` agent | Fresh per refinement iteration; pausable/continuable in-thread |
| Engineer | `sdg-engineer` agent | Fresh per ralph-loop mission; never asks Developer |
| Specialist | `sdg-specialist` agent | Fresh per mission; pausable/continuable in-thread |

The Orchestrator is not a PROCESS.md actor. It exists because Claude Code needs one thread to hold the chat and spawn agents; it contributes no judgment of its own.

Liaison forks are spawned **fresh for each question episode** (a fork snapshots chat history at spawn time, so a stale fork would miss newer messages) and are continued with SendMessage only *within* an episode. No other actor is ever forked — Reviewer, Driver, Engineer, and Specialist must not see chat history.

**Mission files.** The four agent definitions carry only the role-invariant contract — identity, lifecycle, outcome protocol, permitted edits. The phase- and target-specific procedure lives in mission files under `.claude/prompts/<actor>/`, and every spawn prompt for `sdg-reviewer`, `sdg-driver`, `sdg-engineer`, or `sdg-specialist` names exactly one of them; the agent reads it before doing anything else, and a spawn without one fails fast with `OUTCOME: ERROR`. Mission files state purpose (process position, downstream consumers, governing PROCESS.md sections), goals, constraints, and output contracts — not methods — and contain only the delta for their context, never restated role or PROCESS.md rules; §§6–8 are the single map of phase → (agent, mission file, parameters).

No agent may edit `.claude/` (agents, prompts, settings) — the harness configuration is part of the scaffold, immutable like PROCESS.md itself. One exception: `.claude/sdg-config.md` and the variant files under `.claude/prompts/modes/` are Developer-owned configuration, which Liaison alone may edit, and only on explicit Developer instruction.

Model and reasoning effort are tuned per agent via the `model:` (`sonnet` | `opus` | `haiku` | `fable` | a full model ID | `inherit`) and `effort:` (`low` | `medium` | `high` | `xhigh` | `max`) frontmatter keys in `.claude/agents/`. Shipped defaults: every agent runs on `fable`; Reviewer at `effort: max`; Driver, Engineer, and Specialist at `effort: high`. The Orchestrator and Liaison have no frontmatter — they run at the session model and effort, which `.claude/settings.json` pins to Fable and requests max effort for (`effortLevel` caps at `xhigh` in settings files, so max is additionally requested via `env.CLAUDE_CODE_EFFORT_LEVEL`; `xhigh` is the guaranteed floor). Liaison is a fork, and forks always inherit the session model — it cannot be tuned independently of the main thread. Developers without Fable access should downgrade these defaults.

## 3. The Orchestrator contract

The main thread MUST NOT:

- read or edit the contents of specs, modules, patches, problems files, code, or `specs/PHILOSOPHY.md`;
- draft, review, summarize, or paraphrase process content (relaying verbatim is fine);
- answer any Developer question itself beyond §5's process-state pings — Liaison answers;
- narrate its mechanics to Developer: no phase numbers, no actor or agent names, no spawn/relay/SendMessage play-by-play, no internal file names, no previews of what happens next — to Developer the process presents as a black box;
- make any judgment call that PROCESS.md assigns to an actor.

The main thread MAY:

- read `specs/PROCESS.md` and this file (its own instruction manual);
- perform existence-level checks to drive control flow (`ls specs/tmp/`, `test -f`, listing `specs/modules/` filenames);
- spawn agents, continue them with SendMessage, and act on their `OUTCOME:` lines;
- pipe one agent's output verbatim into another agent's spawn prompt;
- post Liaison `ASK DEVELOPER` / `REPLY` blocks to Developer verbatim, plus at most rare one-sentence status notes in plain product language ("Drafting the specification", "Building the test harness", "Running the test suite") — never process vocabulary, and never one per step;
- answer pure process-state pings from Developer ("ready?", "how's it going?", a bare "continue") with a one-line plain-language reply from its own bookkeeping — never anything touching content or intent.

Turn discipline: run continuously through the phases. A returned agent or a completed phase is never a stopping point — take the next runbook action in the same turn; never announce what you will do next and stop. End the turn only when an ASK is pending with Developer, or the process is complete/idle. Do not stop to report progress or ask permission to continue.

## 4. Agent protocol

Every agent ends every turn with a final `OUTCOME:` line:

| Line | Who | Meaning |
|---|---|---|
| `OUTCOME: DONE — <summary>` | any | Mission complete |
| `OUTCOME: HALT` | Driver | Refinement converged; loop ends |
| `OUTCOME: APPLIED — <summary>` | Driver | One round of feedback applied |
| `OUTCOME: TASK_REMOVED — <task>` | Engineer | Task was already implemented properly and was removed (an invalid task exits as `DONE — plan amended`) |
| `OUTCOME: QUESTION` | Driver, Specialist (never Engineer, never Reviewer) | Paused on a Developer-intent question; body contains a `QUESTION FOR DEVELOPER` block |
| `OUTCOME: PROBLEM — <problems-file>` | Driver, Engineer, Specialist | Blocking spec problem logged; Orchestrator jumps per §8 |
| `OUTCOME: ASK` / `OUTCOME: ANSWER — …` / `OUTCOME: REPLY — …` | Liaison | See §5 |
| `OUTCOME: ERROR — <what>` | any mission-file agent | Malformed spawn (e.g., no mission file named); the Orchestrator corrects the spawn prompt and re-spawns fresh |

A `QUESTION FOR DEVELOPER` block contains the question(s) plus a short mechanical description of what the agent is doing and why the answer changes the outcome.

**Pause and continue.** An agent returning `OUTCOME: QUESTION` is *waiting, not finished*. After the answer is obtained (§5), the Orchestrator continues **the same agent** with `SendMessage("ANSWER: <answer>")` and the agent proceeds with its context intact. Never restart a paused agent to deliver an answer, and never spawn a replacement while one is waiting.

**Infrastructure failure recovery.** Agents sometimes die without a final `OUTCOME:` line — API errors, stream stalls, harness kills. That is a mechanical event, not a process event, and waiting on a dead agent deadlocks the process. On a failure notification, or on prolonged silence with no way to confirm liveness: resume the same agent once via SendMessage ("you were interrupted by an infrastructure failure — pick up where you left off and finish with your OUTCOME line"). If it cannot be resumed or dies again, spawn a fresh agent with the identical mission and parameters — safe by design, since durable work lives in committed files and every mission re-verifies from disk. Three failures of the same spawn is a stall: run a Liaison consult episode.

## 5. Asking Developer — Claude binding

PROCESS.md §Asking Developer, implemented as:

1. Agent X pauses with `OUTCOME: QUESTION`.
2. The Orchestrator spawns a **fresh Liaison fork**, passing verbatim: X's `QUESTION FOR DEVELOPER` block, X's role and current phase, and pointers Liaison may read for context (`specs/tmp/REVIEW.md` during refinement, the active patch, relevant specs).
3. Liaison attempts to answer on Developer's behalf from chat history, `specs/PHILOSOPHY.md`, and the relevant documents — with the decision rights of the liaison mode selected in `.claude/sdg-config.md` (Liaison reads only the active variant under `.claude/prompts/modes/liaison/`).
   - Confident → returns `OUTCOME: ANSWER — <answer>` — never for approval-gated matters: anything PROCESS.md gates on explicit Developer approval always goes to Developer.
   - Not confident → returns `OUTCOME: ASK` with an `ASK DEVELOPER:` block phrased for Developer.
4. The Orchestrator posts the `ASK DEVELOPER:` block content to Developer **verbatim** and ends the turn. When Developer replies, the Orchestrator relays the reply to the same Liaison fork via SendMessage. Follow-up rounds repeat 3–4; multi-round exchanges are normal.
5. Before finalizing, Liaison distills durable principles from Developer's answers into `specs/PHILOSOPHY.md` (its exclusive file) and commits.
6. Liaison returns `OUTCOME: ANSWER — …`; the Orchestrator sends `ANSWER: …` to agent X via SendMessage, and X resumes.

"Whatever you recommend" from Developer means Liaison forms the recommendation itself (not agent X). Engineer never enters this pipeline — Engineer-blocking issues are always problems files (§8).

### Routing Developer messages

- **A pure process-state ping** (readiness check, "what phase are we in", a bare "continue") answerable entirely from the Orchestrator's own bookkeeping → one-line mechanical reply; no Liaison spawn. Anything carrying substantive content or intent takes the routes below.
- **An ASK is pending** → relay the message verbatim to that Liaison episode via SendMessage; continue the pipeline above. Liaison decides whether the message answers the open question or is an interruption: open questions are never dropped — if the message is something else, Liaison handles it and re-surfaces the question in the same turn, reading genuinely ambiguous messages as answers first. A single Liaison message may carry both a directive and a re-surfaced `ASK DEVELOPER:` block — the Orchestrator executes the directive and posts the ASK.
- **No pending ASK** (process active or idle) → spawn a fresh Liaison fork to interpret the message. Liaison returns one of:
  - `OUTCOME: REPLY — …` with a `REPLY:` block — the Orchestrator posts it verbatim (status questions, "what is this project?", small talk);
  - `OUTCOME: ANSWER — directive: <instruction>` — a mechanical directive the Orchestrator obeys (e.g. "treat this message as a new seed, run Phase 1", "stop current work", "resume").
- **Session start** → run Phase 0 first, then route the first message as above.

## 6. Iterative Refinement — Claude binding

One refinement (a target plus the reason it is being refined) runs as:

```
i = 0
loop:
  i += 1
  if i > 12: run a Liaison episode ("refinement of <target> is not converging after 12
             iterations: <evidence>. How should we proceed?") and follow the answer.
  1. Spawn sdg-reviewer with: its mission file (table below), target, phase, reason, and
     the bundle paths. Reviewer writes specs/tmp/REVIEW.md (overwriting any prior one),
     commits and pushes it, and returns severity counts — the Orchestrator's convergence
     evidence for the escalation valve.
  2. Spawn a fresh sdg-driver with: its mission file (table below), target, phase, bundle
     paths, and any patch-stage flip it must perform on HALT (per §8).
  3. On the Driver's outcome:
     - HALT     → refinement complete (Driver already deleted REVIEW.md). Exit loop.
     - APPLIED  → next iteration.
     - QUESTION → run §5, SendMessage the ANSWER to the same Driver, keep waiting for its
                  next outcome.
     - PROBLEM  → jump phases per §8. Exit loop.
```

**Reviewer bundles.** Paths passed by the Orchestrator; the target itself plus all of its modules are always included. Per PROCESS.md: "SPEC.md" means `specs/SPEC.md` plus all spec modules, "TEST-SPEC.md" means `specs/TEST-SPEC.md` plus all test modules, and "CERTIFICATIONS.md" includes all certification modules.

| Review target | Reviewer / Driver missions | Bundle |
|---|---|---|
| SPEC.md | `reviewer/spec.md` / `driver/spec.md` | `specs/IMPLEMENTATION.md` (if exists), `specs/GOALS.md`, relevant IP (if applicable), `specs/tmp/SPEC-PROBLEMS.md` (if exists) |
| TEST-SPEC.md | `reviewer/test-spec.md` / `driver/test-spec.md` | SPEC.md, `specs/IMPLEMENTATION.md`, relevant Bug Report (if applicable), `specs/tmp/TEST-SPEC-PROBLEMS.md` (if exists) |
| CERTIFICATIONS.md | `reviewer/certifications.md` / `driver/certifications.md` | SPEC.md, TEST-SPEC.md, `specs/IMPLEMENTATION.md`, relevant Bug Report (if applicable), `specs/tmp/CERTIFICATIONS-PROBLEMS.md` (if exists) |
| IP | `reviewer/ip.md` / `driver/patch.md` | `specs/GOALS.md`, SPEC.md, `specs/tmp/PATCH-PROBLEMS.md` (if exists) |
| Bug Report | `reviewer/bug.md` / `driver/patch.md` | SPEC.md, TEST-SPEC.md, CERTIFICATIONS.md, `specs/tmp/PATCH-PROBLEMS.md` (if exists) |

The "instructions and stable process summary" required by PROCESS.md live in the `sdg-reviewer` agent definition and its mission file (mission paths above are relative to `.claude/prompts/`); the Orchestrator's spawn prompt adds only the mission file, target, phase, reason, and bundle paths.

When a refinement was entered *because of a problems file*, the refinement is not complete while that file exists: the Driver deletes it once every logged problem is resolved (possibly across several iterations), and only then may it HALT.

## 7. Ralph Loop — Claude binding (Phases 9 and 10)

**Engineering mode.** `.claude/sdg-config.md` selects how Phases 9–10 execute. `ralph` (default) is the remainder of this section. `workflow` replaces the remainder of this section with `.claude/prompts/modes/engineering/workflow.md` — when selected, read that file instead and skip the rest of §7. PROCESS.md's Ralph Loop note authorizes the substitution; the completion standard is identical.

Claude Code subagents cannot spawn subagents, so the Engineer iteration from PROCESS.md executes as an Orchestrator-driven sequence in which every step needing its own context is a fresh agent. The union of steps per iteration matches PROCESS.md's Iteration Flow exactly; no judgment moves into the Orchestrator.

Goal scope per phase:

- **Phase 9** — harness adherence to `TEST-SPEC.md` + `CERTIFICATIONS.md`. All harness self-tests and certifications must pass; product tests may fail; product code must not be touched.
- **Phase 10** — product adherence to `SPEC.md`. **All** tests must pass; the test harness must not be modified.

```
loop:
  if specs/tmp/FIX_PLAN.md does not exist:
      A. Compliance determination — spawn in parallel:
         - sdg-specialists (mission specialist/compliance-review.md): one per spec,
           test, and certification module in scope, plus one for the core document(s).
           A moduleless project still gets at least two reviewers with complementary
           scopes — PROCESS.md requires multiple reviewing subagents. Each returns
           COMPLIANT or a list of gaps with citations
         - one sdg-engineer (mission engineer/verify.md): run the full test suite
           required at this phase locally, and report CI status on the PR
      B. If every reviewer returned COMPLIANT and required tests/CI are green:
           run the Code Review Sub-Flow (below)
         If VERIFY reported pending CI (and nothing else is red):
           re-spawn the VERIFY mission once checks settle — never plan from a non-finding.
         else:
           spawn sdg-engineer (mission engineer/plan.md) with all findings piped
           verbatim → it writes specs/tmp/FIX_PLAN.md, commits, pushes. Iteration ends.
  else:
      spawn sdg-engineer (mission engineer/task.md): execute exactly one task from FIX_PLAN.md
      (research whether already implemented → remove | implement | amend plan),
      commit, push. Iteration ends.
  on OUTCOME: PROBLEM — <file> → jump per §8 and exit the loop.
  Stall guard: 3 consecutive iterations with no new commits and no FIX_PLAN.md change →
  Liaison episode ("ralph loop stalled: <evidence> — how should we proceed?").
```

**Code Review Sub-Flow** (runs only once full spec compliance is met):

1. Spawn sdg-specialist (mission `specialist/code-review-triage.md`): fetch all unresolved review comments on the PR, evaluate each, and post a brief rationale reply on rejected ones. For a large comment set the Orchestrator may split the comments across parallel triage Specialists.
2. Accepted comments remain → sdg-engineer (mission `engineer/plan.md`) appends them to `specs/tmp/FIX_PLAN.md`; the ralph loop continues (they are implemented in later iterations, whose TASK missions resolve each comment's thread on completion).
3. `clean` and no `FIX_PLAN.md` → the triage Specialist has performed the phase's stage flip and committed; the ralph loop exits.

## 8. Phase runbook

Phase 0 runs at the start of **every** session. Paths: core docs in `specs/`, temp docs in `specs/tmp/`, patches in `specs/patches/`.

**Jump rules.** Whenever an agent returns `OUTCOME: PROBLEM`, or Phase 0 finds problems files, jump to the phase for the most upstream problems file present and re-descend through the phases from there:

| Problems file | Jump to |
|---|---|
| `specs/tmp/PATCH-PROBLEMS.md` | Phase 3 |
| `specs/tmp/SPEC-PROBLEMS.md` | Phase 4 |
| `specs/tmp/TEST-SPEC-PROBLEMS.md` | Phase 6 |
| `specs/tmp/CERTIFICATIONS-PROBLEMS.md` | Phase 7 |

**Stage tracking.** Patch documents carry a `Stage:` line near the top. The agent performing a phase's final action flips it as part of its last commit, as instructed in its spawn prompt — the Orchestrator never edits files. Start/end stages per phase are defined in PROCESS.md.

- **Phase 0 — Audit.** Spawn sdg-specialist (mission `specialist/audit.md`): pull the active branch, inventory the workspace, and classify it into **exactly one state** — first matching row wins; any others are noted as anomalies:

  | State | Trigger | Resume |
  |---|---|---|
  | Not bootstrapped | `specs/PROCESS.md`, this file, or any of the `.claude/agents/` / `.claude/prompts/` files missing | Return `not-bootstrapped`; the Orchestrator relays the audit report to a Liaison episode, and Liaison informs Developer; halt |
  | Refinement reverted | Any `specs/tmp/*-PROBLEMS.md` exists | The phase for the most upstream problems file (jump table above) |
  | Refinement in flight | `specs/tmp/REVIEW.md` exists (its header names the target) | The refinement phase for that target — patch → 3, SPEC.md → 4, TEST-SPEC.md → 6, CERTIFICATIONS.md → 7; the stale REVIEW.md is deleted and a fresh review starts the resumed iteration |
  | Active patch | A patch in `specs/patches/` has a `Stage:` other than Complete | By stage — Proposed → 3; Accepted → IP: 4, Bug: 6, 7, or 9 per the route stated in the patch (an Accepted bug routed to 9 with no `FIX_PLAN.md` lost Phase 3's closing step — resume Phase 3); Applied → 6 (through 5 if `IMPLEMENTATION.md`/`TEST-SPEC.md` are missing); Tests Specified → 9 (through 8 if scaffolding is missing); Tested → 10; Implemented → 11 |
  | Ready for triage | `specs/tmp/SEED.md` exists | Phase 2 |
  | Initial build in flight | No seed, no active patch, initial build incomplete | No `SPEC.md` → Phase 1; `SPEC.md` but no `TEST-SPEC.md` → 5; `TEST-SPEC.md` but no `CERTIFICATIONS.md` → 7; harness incomplete → 9 (through 8 if needed); harness green but product not → 10 |
  | Complete / idle | Specs exist; no seed, no active patch, no temp files | Return `idle`; route the Developer's message per §5 |

  Audit rules: work exists only on its branch until Phase 11 — if the current checkout shows no state, check remote `patch/*` and `sdg/initial-build` branches before classifying, and classify from the newest such branch. If several patches are non-Complete, the most recently modified one is the active patch — flag the rest. Verify the checked-out branch matches the active patch (`patch/<short-title>`); flag mismatches rather than fixing them. Flag unpaired modules (a `MODULE.md` without its `TEST-MODULE.md`, or vice versa), uncommitted changes, and unexpected `specs/tmp/` files. An interrupted iteration needs no special handling beyond the table — the resumed phase re-verifies from files, and a crash that left no `REVIEW.md` behind is treated as converged (downstream problems files catch what slips). Return `RESUME AT: phase <n> | not-bootstrapped | idle` with the active patch's path, type, stage, and (for Accepted bugs) route, plus a short state summary listing every anomaly. The Orchestrator hands the anomaly list — and any `not-bootstrapped` report — to a Liaison episode rather than acting on it or dropping it.
- **Phase 1 — Seed.** A readiness ping while awaiting the seed gets the Orchestrator's mechanical reply ("ready — send the seed"); the intake fork spawns when seed content arrives. Spawn a Liaison fork (SEED INTAKE): if the Developer's message(s) already contain the seed, confirm scope (ASK only if genuinely unclear), write `specs/tmp/SEED.md` on Developer's behalf, commit and push. If no seed exists, ASK for one.
- **Phase 2 — Triage & draft.** Spawn sdg-specialist (mission `specialist/triage.md`). Initial build: draft `specs/SPEC.md` (+ modules) and `specs/GOALS.md` (GOALS.md commits only after explicit Developer approval via QUESTION), create branch `sdg/initial-build`, commit, push, open a PR, delete `SEED.md` (consumed); then jump to Phase 4. Patch: create branch `patch/<short-title>`, draft the patch document (`Stage: Proposed`), commit, push, open a PR, delete `SEED.md`. Ambiguities in both cases → QUESTION (§5).
- **Phase 3 — Refine the patch.** §6 with target = the patch (IP or Bug bundle). The Driver may reclassify IP↔Bug (update the document; keep the index). On HALT: `Stage: Accepted`, and the Driver's report carries a `ROUTE:` line. Routing after: IP → Phase 4. Bug needing `TEST-SPEC.md` changes → Phase 6; only `CERTIFICATIONS.md` changes → Phase 7; neither → the Driver has seeded `specs/tmp/FIX_PLAN.md` with the harness fixes as part of its HALT commit → Phase 9.
- **Phase 4 — Refine SPEC.md.** §6, target SPEC.md (on the initial build, refinement starts from Specialist's draft). GOALS.md↔SPEC.md contradictions are resolved through a QUESTION episode; `specs/GOALS.md` changes only with explicit Developer approval. Driver finds the problem is in the patch → `PATCH-PROBLEMS.md` → Phase 3. On HALT (IP flow only): `Stage: Applied` — never for a bug reached via jump-back; `Applied` is an IP-only stage.
- **Phase 5 — Missing docs.** If `specs/IMPLEMENTATION.md` is missing: sdg-specialist (mission `specialist/draft-implementation.md`). If `specs/TEST-SPEC.md` is missing: sdg-specialist (mission `specialist/draft-test-spec.md`). Commit each.
- **Phase 6 — Refine TEST-SPEC.md.** §6. Problem in SPEC.md → `SPEC-PROBLEMS.md` → Phase 4.
- **Phase 7 — Certifications.** Spawn sdg-specialist (mission `specialist/certification-draft.md`) unconditionally — the mission is an idempotent end-state and may conclude nothing is needed. Then §6, target CERTIFICATIONS.md. Problems → jump table. On HALT: `Stage: Tests Specified`.
- **Phase 8 — Scaffolding.** sdg-specialist (mission `specialist/scaffold.md`) updates project scaffolding per the four documents: monorepo if the stack supports it, product and harness as distinct programs, GitHub Actions CI running the TEST-SPEC-required tests on the PR.
- **Phase 9 — Ralph: test harness.** §7. On exit: `Stage: Tested`.
- **Phase 10 — Ralph: product.** §7. On exit: `Stage: Implemented`.
- **Phase 11 — Release.** sdg-specialist (mission `specialist/devops.md`) follows `specs/DEVOPS.md` (merge, release, deploy, post-update actions). Unclear or missing → QUESTION first; afterwards Specialist updates DEVOPS.md so the situation is covered next time, then acts. On completion: `Stage: Complete`.

## 9. Git, GitHub, and CI conventions

- **Branches:** `sdg/initial-build` for the initial build; `patch/<short-title>` for patches (per PROCESS.md). A PR is opened at the first push and anchors CI and the Code Review Sub-Flow.
- **Commits:** `sdg(phase-N): <imperative summary>` (Liaison uses `sdg(liaison): …`). Every agent commits only what its mission touched and always pushes before finishing — temp documents included: all `specs/tmp/` state (REVIEW.md, FIX_PLAN.md, problems files) lives in git, so any session can die anywhere and resume without loss.
- **CI:** GitHub Actions, wired in Phase 8; status read through whatever GitHub access the environment provides (`gh` locally, the built-in integration on web). Green CI is part of spec compliance (PROCESS.md Ralph Loop note 2). Local-only tests are marked per TEST-SPEC.md and excluded from CI — never silently skipped.
- **Merging** happens only in Phase 11, per DEVOPS.md.

## 10. State discipline and sanctioned adaptations

**State.** Sessions are ephemeral (especially in Claude Code web). Every piece of durable state must live in files and git: the specs, patches (with `Stage:`), problems files, `specs/tmp/` docs, `PHILOSOPHY.md`, and the branch/PR/CI state. Chat history exists only within one session and only Liaison reads it — anything durable Liaison learns goes into `PHILOSOPHY.md` immediately. In-flight agent threads die with the session: after an interruption, Phase 0 resumes from files and the interrupted iteration is simply redone (a stale `REVIEW.md` is deleted; a half-done FIX_PLAN task is re-verified by the next Engineer).

**Sanctioned adaptations** — the complete list of deltas from PROCESS.md:

1. An Orchestrator role exists: the main thread steps the process mechanically and holds no content role.
2. Liaison runs as a forked subagent (for chat-history access) and cannot address Developer directly; the Orchestrator relays `ASK DEVELOPER` / `REPLY` blocks verbatim, one fresh fork per episode.
3. Reviewer writes `specs/tmp/REVIEW.md` itself rather than its response being saved by another party — and commits and pushes it, so every temp document is tracked and refinement state survives ephemeral sessions.
4. Paused agents (`OUTCOME: QUESTION`) are continued in-thread via SendMessage — never re-spawned mid-iteration.
5. Engineer-iteration steps requiring subagents are hoisted: compliance panels, verify runs, and plan writing are separate fresh agents sequenced by the Orchestrator; the per-task Engineer researches inline within its own context.
6. Driver deletes `specs/tmp/REVIEW.md` before finishing every iteration, including on HALT.
7. Stage flips are executed by the agent performing the phase's final action, as instructed at spawn.
8. Gap-fills where PROCESS.md is silent: the initial build runs on branch `sdg/initial-build`; PRs are opened at first push; `specs/GOALS.md` is drafted during the initial build's Phase 2 with explicit Developer approval; `SEED.md` is deleted once consumed by Phase 2.
9. Reviewer is excluded from the Asking Developer process (PROCESS.md permits any non-Engineer agent to ask); its ambiguity findings route through the Driver instead.
10. Two convergence valves exist that PROCESS.md does not define: the §6 twelve-iteration escalation and the §7 stall guard — both consult Developer through Liaison rather than halting silently.
11. The Code Review Sub-Flow operates on unresolved PR comments: a comment's thread is resolved either at rejection (with rationale) or when its implementing TASK completes, making resolved state the durable record of "reviewed".
12. Stage flips happen only at phase ends; stages are not rewound on backward jumps — problems files, which outrank stages at Phase 0, govern resume until refinement completes and the End-Stage flip restores consistency. On the Phase 3 `ROUTE: neither` path, the Driver seeds `FIX_PLAN.md` itself (PROCESS.md leaves the actor unnamed).
13. The Orchestrator answers pure process-state pings (readiness, current phase, a bare "continue") with one-line mechanical replies from its own bookkeeping — a narrow carve-out from Liaison's ownership of Developer communication; anything touching content or intent still goes to Liaison.
14. `.claude/sdg-config.md` selects behavior variants by pointer (Liaison mode; the Phases 9–10 engineering binding). Readers load only the selected variant file — configuration resolves at read time, never as conditional instructions inside prompts. The `engineering: workflow` variant substitutes PROCESS.md's ralph loop under PROCESS.md's own Ralph Loop note, holding the identical completion standard.
