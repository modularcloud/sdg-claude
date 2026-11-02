# sdg-claude

A Claude-native implementation of **Spec-Driven Generation (SDG)** — a structured process for building software by maintaining a master specification and letting AI generate everything else: the spec, the test spec, the certifications, the test harness, and the product. Humans answer clarifying questions to remove ambiguity; they do not write code or specs by hand.

This repository is the **template**: [`scaffold/`](scaffold/) holds the files installed into a project. Once installed, every Claude Code session in that project runs the SDG process automatically — no commands to learn, no CLI. You chat; the process does the rest.

## How it works

- [`scaffold/specs/PROCESS.md`](scaffold/specs/PROCESS.md) — the harness-agnostic process specification (authoritative, immutable).
- [`scaffold/specs/CLAUDE-PROCESS.md`](scaffold/specs/CLAUDE-PROCESS.md) — how the process binds to Claude Code: the main thread is a "dumb" Orchestrator that only steps through phases; a forked **Liaison** subagent owns all Developer communication and `specs/PHILOSOPHY.md`; **Reviewer**, **Driver**, **Engineer**, and **Specialist** run as fresh-context subagents driven by per-phase mission prompts in `.claude/prompts/`.
- [`scaffold/CLAUDE.md`](scaffold/CLAUDE.md) — marks the project as SDG-governed, end to end, all or nothing.
- [`scaffold/.claude/sdg-config.md`](scaffold/.claude/sdg-config.md) — project configuration by pointer; agents load only the selected variant, and you switch by editing the file or just saying so in chat. **liaison-mode**: `cto` (default — Liaison makes every technical choice, including technical details of the product's own spec, surfacing only questions of product intent) or `pm` (defers major technical choices to you). **engineering**: `ralph` (default) or `workflow` (a dynamic-workflows-native build for the engineering phases, holding the same completion standard — requires the Workflow tool). **observer**: `none` (default) or `tracker` (streams phase/iteration status and plain-language summaries to a dashboard endpoint via `SDG_OBSERVER_URL`; fail-open). Custom variants: add a self-contained file under `.claude/prompts/modes/` and point a key at it.

Defaults: every agent inherits the session model — Claude **Fable**, set once in `.claude/settings.json` (change it there, or with `/model`) — at `max` effort for the session, Liaison, and Reviewer, `high` elsewhere. `settings.json` also sets `bypassPermissions`: this is built to run unattended in a sandboxed or cloud environment (Claude Code web, a container, a VM). Adjust `settings.json` if that doesn't describe your machine.

## Bootstrap a project

Use the **sdg-bootstrap skill** (in [`sdg-bootstrap/`](sdg-bootstrap/)) — share it with Claude and ask it to set up SDG in your project. Or do it manually:

```sh
# in your new project directory
npx degit modularcloud/sdg-claude/scaffold .sdg-tmp
rsync -a .sdg-tmp/ ./ && rm -rf .sdg-tmp
```

Then make sure the project is a git repository with a GitHub remote and Actions enabled, open Claude Code in it, and describe what you want to build.

**Requirements:** Claude Code (desktop, CLI, or web) with access to Claude Fable; `git` plus authenticated GitHub access (the `gh` CLI locally; the built-in GitHub integration on web); a GitHub repository with Actions enabled; a sandboxed/disposable environment (see above).

### Running on Claude Code web

- **Set `CLAUDE_CODE_FORK_SUBAGENT=1` in the repository's environment configuration** on claude.ai/code (the same place you'd set API keys). Forked subagents are how Liaison inherits your conversation; the scaffold's `.claude/settings.json` also sets this variable, but the platform-level channel is the reliable one — without it, Liaison cannot fork and the process halts at Phase 1 by design.
- The web sandbox has no `gh` CLI; that's fine — the built-in GitHub integration covers branches, PRs, review comments, and CI status, and the process prompts are tool-agnostic about which is used.

## Layout

```
scaffold/                          installed into projects
  CLAUDE.md                        project charter; its Orchestrator sections address the main thread only
  specs/
    PROCESS.md                     the SDG process (owner-maintained)
    CLAUDE-PROCESS.md              Claude Code bindings, protocols, phase runbook
    PHILOSOPHY.md                  Liaison-only memory of Developer principles
    GOALS.md                       conservative tripwire goals (Developer-approved edits only)
    tmp/  patches/                 process working files
  .claude/
    settings.json                  session model, effort, permissions, and env defaults
    sdg-config.md                  configuration pointers: liaison-mode, engineering, observer
    agents/                        sdg-reviewer, sdg-driver, sdg-engineer, sdg-specialist
    prompts/
      sdg-liaison.md               Liaison charter
      reviewer/ driver/ engineer/ specialist/   per-phase mission prompts
      modes/                       configurable variants: liaison/, engineering/, observers/
    workflows/sdg-build.js         engineering workflow script (engineering: workflow)
sdg-bootstrap/SKILL.md             the bootstrap skill
CLAUDE.md                          maintainer notes for this template repository
```

## License

MIT
