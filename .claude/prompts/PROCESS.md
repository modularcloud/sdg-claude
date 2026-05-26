How to run @specs/PROCESS.md inside Claude Code (local CLI and Web). This file only describes the Claude-Code-specific mapping. `PROCESS.md` defines what each actor does.

## Actor mapping

| `PROCESS.md` actor | Claude Code primitive |
| --- | --- |
| Developer | The human at the Claude Code session. |
| Lead session | Acts as the router. Dispatches Liaison for every decision, spawns teammates, relays Liaison-composed text to Developer. Reads no substantive file content, edits nothing, composes no Developer-facing text. |
| Liaison | Built-in `general-purpose` subagent invoked with `CLAUDE_CODE_FORK_SUBAGENT=1` so it inherits the lead's full conversation. One-shot per dispatch. Returns a single Action (spawn teammate / emit text / ask Developer / no-op) for the lead to execute. |
| Driver | Teammate (`.claude/agents/driver.md`). One iteration per spawn. Persists within the iteration so a mid-iteration Developer round-trip preserves Reviewer context. Invokes Reviewer via the `sdg` CLI. |
| Engineer | Teammate (`.claude/agents/engineer.md`). One Ralph-loop **iteration** per spawn. Persists within the iteration so subagent fan-out preserves state; context resets between iterations. May fan out to its own subagents. |
| Specialist | Teammate (`.claude/agents/specialist.md`). One bounded task per spawn (state audit, triage + initial draft, IMPLEMENTATION.md / TEST-SPEC.md drafts, repo scaffolding, release). Persists within the task so it can ask the Developer via Liaison without losing context. |
| Reviewer | Not a Claude Code actor. External model invoked by Driver via `bash .claude/sdg review`. |

Only the lead spawns teammates. Teammates may spawn their own subagents but not other teammates.

## Why teammates for Driver, Engineer, and Specialist

`PROCESS.md` requires that Driver and Engineer reset context between iterations, and that Specialist tasks not bloat the context of the thread that spawned them. But *within* a single iteration or task, an actor may need to ask the Developer or fan out work — and a subagent would lose the surrounding context at every handoff. Teammate lifecycle scoped to one iteration (Driver, Engineer) or one task (Specialist) gives them persistence where they need it and resets at the natural boundary.

Liaison has no such mid-task persistence requirement, so it runs as a one-shot subagent.

## Communication

| Channel | Use |
| --- | --- |
| `SendMessage` | Teammate ↔ lead. Developer questions, completion signals, blocked signals. |
| Subagent return | Liaison → lead. One Action. |
| Disk | Source-of-truth files, Resolution notes in the active patch document, problems files, `FIX_PLAN.md`, `git log`. |

Every Developer message and every teammate question for the Developer goes through Liaison. The lead never composes Developer-facing text.

## Reviewer via the `sdg` CLI

Driver invokes Reviewer via `bash .claude/sdg review <target>`. The CLI assembles a fixed bundle per target (see `@.claude/prompts/SUMMARY.md` for the composition table), invokes the `openai` CLI, and writes the response to `specs/tmp/REVIEW.md`. The CLI does not track state — Driver is responsible for re-running review after applying feedback and for cleaning up `REVIEW.md` when done.

The CLI surface is narrow: `sdg review <spec|test-spec|patch> [patch-path]` and `sdg version`. There is no `bootstrap`, `doctor`, or `patch upstream-status` subcommand — bootstrap is handled by `degit` and environment health is the Developer's responsibility.

Model and reasoning effort default to `gpt-5` / `high`. Override per-invocation with the `--model` / `--effort` flags or by exporting `SDG_REVIEW_MODEL` / `SDG_REVIEW_EFFORT`. `.claude/settings.json` sets `SDG_REVIEW_SUMMARY` so the CLI finds `.claude/prompts/reviewer-process-summary.md`.

## Settings

`.claude/settings.json` enables agent teams (via the `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` env var), sets the default model, and pre-approves common `git` / `gh` / `openai` / `sdg` commands so teammates do not stall on permission prompts. Per-teammate reasoning effort lives in each agent file's front matter (`effort: max` in `driver.md` / `engineer.md` / `specialist.md`), not in `settings.json`. Project-specific build and test commands are not pre-approved by default; Phase 7 scaffolding (or any later phase) may extend `.claude/settings.json` with the build / lint / test commands appropriate to the chosen stack.

Required environment:

- `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` — enables Driver, Engineer, and Specialist as teammates.
- `CLAUDE_CODE_FORK_SUBAGENT=1` — makes the built-in `general-purpose` subagent fork the conversation. Liaison relies on this to inherit Developer ↔ lead history.

Conventional defaults: `model: claude-opus-4-7` (in `settings.json`); `effort: max` per teammate (in each agent file's front matter). Reviewer defaults are baked into `.claude/sdg`; override via `SDG_REVIEW_MODEL` / `SDG_REVIEW_EFFORT` env vars or per-invocation flags.

## Bootstrap

A fresh project is bootstrapped via `npx degit modularcloud/sdg-claude` in the project root, which drops in `CLAUDE.md`, `.claude/`, and `specs/PROCESS.md`. The Developer is then responsible for: exporting `OPENAI_API_KEY`; ensuring the `openai` CLI is on PATH (Homebrew `brew install openai/tools/openai`, or `go install github.com/openai/openai-cli/cmd/openai@latest`); and creating any further directories the workflow needs (`specs/tmp/`, `specs/patches/improvements/`, `specs/patches/bugs/`, `specs/modules/`). Teammates create these on demand as the workflow progresses.

## Claude Code Web

In-process teammate mode is the only option in Web (split-pane via tmux/iTerm2 is not available). Web containers keep teammates running while the Developer is disconnected, so long Ralph loops and release work survive across disconnects. If a session dies, the lead's next dispatch of Liaison reconstructs state from disk and re-spawns the appropriate actor; `PROCESS.md`'s commit-per-iteration discipline bounds worst-case lost progress to one iteration.

## File layout

```
CLAUDE.md                       ← lead's operating instructions (router)
AGENTS.md                       ← repo-root build/lint/run commands (Specialist creates in Phase 7 scaffolding; Engineer appends in Phase 8/9 iterations)
specs/
  PROCESS.md                    ← Spec-Driven Generation (authoritative)
.claude/
  sdg                           ← minimal SDG reviewer CLI (bash)
  agents/
    driver.md
    engineer.md
    specialist.md
  prompts/
    PROCESS.md                  ← this file (Claude Code variant of PROCESS.md)
    SUMMARY.md                  ← short reference summary of specs/PROCESS.md
    liaison.md
    reviewer-process-summary.md ← Reviewer prompt header (read by `sdg review`)
    specialists/
      state-audit.md             ← Phase 0
      triage.md                  ← Phase 2 (triage + initial draft)
      scaffold-implementation.md ← Phase 5
      scaffold-test-spec.md      ← Phase 5
      repo-scaffolding.md        ← Phase 7
      release.md                 ← Phase 10
  settings.json
```
