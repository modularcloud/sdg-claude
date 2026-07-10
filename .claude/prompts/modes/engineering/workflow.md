# Engineering mode — workflow (Phases 9–10 binding)

Selected via `engineering: workflow` in `.claude/sdg-config.md`; replaces the ralph binding in CLAUDE-PROCESS.md §7. Authorized by PROCESS.md's Ralph Loop note. The completion standard is identical and enforced in code: the build cannot exit `success` until every compliance panelist returns COMPLIANT, the full required test suite and CI are green, and code review is resolved — with stage flips performed by the triage Specialist exactly as in ralph mode.

**Prerequisite:** the dynamic-workflows tool (Workflow). If it is not available in this environment, halt and tell Developer to run in an environment that has it or switch `engineering` back to `ralph`.

**Invocation** — one run per phase; phase 9 and phase 10 are always separate runs, and the red-green wall between harness and product lives in the sdg-engineer scope guards the workflow's agents inherit:

- Workflow `scriptPath`: `.claude/workflows/sdg-build.js`
- `args`: `{ "phase": 9|10, "modules": [<specs/modules filenames in scope — an existence listing>], "patchFixes": "<verbatim fix list from the Phase 3 Driver's ROUTE: neither report, when on that path>", "stageFlip": "<Tested | Implemented | none, per §8>" }`

**Exit handling** — the run returns a structured status; the Orchestrator acts by the same rules as everywhere else:

- `success` → the phase is complete (stage already flipped); proceed per §8.
- `problem` + file → jump per the §8 table.
- `question` + block → run §5; then re-invoke (same session: `resumeFromRunId` for a warm resume; otherwise fresh — Decompose re-derives remaining work from specs vs code, which is also how a dead session resumes).
- `stalled` + evidence → Liaison consult episode (§5).
- The run itself dying is an infrastructure event: apply §4 recovery at the workflow level (resume the run; a second death → fresh invocation).

**Inside the run** (the script is the authority): Decompose derives self-contained work units from specs-vs-code — `FIX_PLAN.md` is not used in this mode; the run journal and structured returns carry loop state. Shared-core units build sequentially; disjoint units build in parallel isolated worktrees; an integration step merges and pushes. The converge loop alternates compliance panels plus full verification with gap-fix agents until the standard holds, and the review gate triages PR comments, fixes accepted ones, and re-converges before exiting clean.
