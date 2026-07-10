# sdg-claude

A Claude-native implementation of **Spec-Driven Generation (SDG)** — a structured process for building software by maintaining a master specification and letting AI generate everything else: the spec, the test spec, the certifications, the test harness, and the product. Humans answer clarifying questions to remove ambiguity; they do not write code or specs by hand.

This repository is the **template**. Dropped into a project, it makes every Claude Code session in that project run the SDG process automatically — no commands to learn, no CLI. You chat; the process does the rest.

## How it works

- [`specs/PROCESS.md`](specs/PROCESS.md) — the harness-agnostic process specification (authoritative, immutable).
- [`specs/CLAUDE-PROCESS.md`](specs/CLAUDE-PROCESS.md) — how the process binds to Claude Code: the main thread is a "dumb" Orchestrator that only steps through phases; a forked **Liaison** subagent owns all Developer communication and `specs/PHILOSOPHY.md`; **Reviewer**, **Driver**, **Engineer**, and **Specialist** run as fresh-context subagents driven by per-phase mission prompts in `.claude/prompts/`.
- [`CLAUDE.md`](CLAUDE.md) — marks the project as SDG-governed, end to end, all or nothing.
- [`.claude/sdg-config.md`](.claude/sdg-config.md) — project configuration by pointer; agents load only the selected variant, and you switch by editing the file or just saying so in chat. **liaison-mode**: `cto` (default — Liaison makes every technical choice, including technical details of the product's own spec, surfacing only questions of product intent) or `pm` (defers major technical choices to you). **engineering**: `ralph` (default) or `workflow` (a dynamic-workflows-native build for the engineering phases, holding the same completion standard — requires the Workflow tool). Custom variants: add a self-contained file under `.claude/prompts/modes/` and point a key at it.

Defaults: every agent runs Claude **Fable** (`max` effort for the session/Liaison/Reviewer, `high` elsewhere), and `.claude/settings.json` sets `bypassPermissions` — this is built to run unattended in a sandboxed or cloud environment (Claude Code web, a container, a VM). Adjust `settings.json` if that doesn't describe your machine.

## Bootstrap a project

Use the **sdg-bootstrap skill** (in [`sdg-bootstrap/`](sdg-bootstrap/)) — share it with Claude and ask it to set up SDG in your project. Or do it manually:

```sh
# in your new project directory
npx degit modularcloud/sdg-claude sdg-tmp
rsync -a --exclude README.md --exclude LICENSE --exclude sdg-bootstrap sdg-tmp/ ./ && rm -rf sdg-tmp
```

Then make sure the project is a git repository with a GitHub remote and Actions enabled, open Claude Code in it, and describe what you want to build.

**Requirements:** Claude Code (desktop, CLI, or web) with access to Claude Fable; `git` plus authenticated GitHub access (the `gh` CLI locally; the built-in GitHub integration on web); a GitHub repository with Actions enabled; a sandboxed/disposable environment (see above).

### Running on Claude Code web

- **Set `CLAUDE_CODE_FORK_SUBAGENT=1` in the repository's environment configuration** on claude.ai/code (the same place you'd set API keys). Forked subagents are how Liaison inherits your conversation; the scaffold's `.claude/settings.json` also sets this variable, but the platform-level channel is the reliable one — without it, Liaison cannot fork and the process halts at Phase 1 by design.
- The web sandbox has no `gh` CLI; that's fine — the built-in GitHub integration covers branches, PRs, review comments, and CI status, and the process prompts are tool-agnostic about which is used.

## Layout

```
CLAUDE.md                      Orchestrator charter — auto-loads every session
specs/
  PROCESS.md                   the SDG process (never modified)
  CLAUDE-PROCESS.md            Claude Code bindings, protocols, phase runbook
  PHILOSOPHY.md                Liaison-only memory of Developer principles
  GOALS.md                     non-negotiable goals (Developer-approved edits only)
  tmp/  patches/               process working files
.claude/
  settings.json                model, effort, permissions defaults
  agents/                      sdg-reviewer, sdg-driver, sdg-engineer, sdg-specialist
  prompts/                     Liaison charter + per-phase mission prompts
sdg-bootstrap/                 the bootstrap skill (not copied into projects)
```

## License

MIT
