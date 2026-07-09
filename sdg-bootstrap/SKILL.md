---
name: sdg-bootstrap
description: Bootstrap a project for Spec-Driven Generation (SDG) by installing the sdg-claude scaffold from GitHub. Use this whenever the user wants to set up, initialize, install, or scaffold SDG — or mentions "spec-driven generation", "sdg-claude", or "the SDG process" — in a new or existing project, including when they share this skill or the modularcloud/sdg-claude repo and say "set this up", "start a project with this", or "make this project spec-driven". After bootstrapping, the project is governed end to end by the SDG process.
---

# SDG Bootstrap

Spec-Driven Generation builds software from a master specification: AI generates and iteratively refines the spec, test spec, certifications, test harness, and product, while the human (Developer) only answers clarifying questions. Bootstrapping installs the scaffold that makes every Claude Code session in this project run that process automatically — after this, there is no other way of working in the project, and no command to remember: the Developer just chats.

## 1. Confirm the target

The current working directory must be the intended project root. A new or empty directory is the ideal case; an existing project works too, with one hard rule: if `CLAUDE.md`, `.claude/`, or `specs/` already exist here, stop and get the user's explicit confirmation before overwriting anything — SDG replaces these wholesale, and clobbering someone's existing setup silently is unrecoverable.

## 2. Install the scaffold

Fetch the template and copy in everything except the files that belong only to the template repository:

```sh
npx degit modularcloud/sdg-claude .sdg-tmp   # or: git clone --depth 1 https://github.com/modularcloud/sdg-claude .sdg-tmp && rm -rf .sdg-tmp/.git
rsync -a --exclude README.md --exclude LICENSE --exclude sdg-bootstrap .sdg-tmp/ ./
rm -rf .sdg-tmp
```

The exclusions matter: `README.md` and `LICENSE` describe and license the *template* (copying LICENSE in would MIT-license the user's product without them deciding that), and `sdg-bootstrap/` is this skill — a bootstrap skill inside an already-bootstrapped project invites accidental re-scaffolding.

## 3. Verify the inventory

Confirm all of this landed — the process's Phase 0 audit refuses to run on a partial scaffold:

- `CLAUDE.md`
- `specs/PROCESS.md`, `specs/CLAUDE-PROCESS.md`, `specs/PHILOSOPHY.md`, `specs/GOALS.md`, `specs/tmp/`, `specs/patches/`
- `.claude/settings.json`
- `.claude/agents/` — `sdg-reviewer.md`, `sdg-driver.md`, `sdg-engineer.md`, `sdg-specialist.md`
- `.claude/prompts/` — `sdg-liaison.md`, `liaison-mode.md`, plus the `reviewer/`, `driver/`, `engineer/`, `specialist/` mission directories

Anything missing → re-fetch rather than hand-writing it.

## 4. Wire up git and GitHub

The process requires a GitHub repository with push access and Actions enabled (agents branch, open PRs, and read CI status throughout).

- `git init -b main` if this isn't a repository yet; commit the scaffold as `sdg: bootstrap scaffold`.
- Verify GitHub access — `gh auth status` where the CLI exists; on Claude Code web, the built-in GitHub integration substitutes for `gh` throughout the process. If there is no GitHub remote, ask the user for a repo name and visibility, then create and push it (e.g., `gh repo create <name> --source . --push` plus `--private`/`--public` per their answer).
- Actions is on by default for new repos; the process itself creates the CI workflows later (Phase 8), so nothing to configure now.

## 5. Check the fit

Two defaults are opinionated; surface them rather than silently proceeding if they don't fit:

- **Model.** The scaffold pins Claude Fable at max/high effort (`.claude/settings.json` and each agent's frontmatter). If this account lacks Fable access, downgrade `model:`/`effort:` there before starting — otherwise every agent spawn fails.
- **Permissions.** `settings.json` sets `bypassPermissions`, because the process runs long and unattended and a stalled permission prompt is its worst failure mode. That assumes a sandboxed or disposable environment (Claude Code web/cloud, a container, a VM). If this is someone's primary machine, tell them and let them decide before continuing.
- **Web.** If the project will run on Claude Code web, tell the user to add `CLAUDE_CODE_FORK_SUBAGENT=1` to the repository's environment configuration on claude.ai/code. The scaffold's `settings.json` also sets it, but the platform-level variable is the reliable channel — without forked subagents, Liaison cannot inherit the conversation and the process halts at Phase 1 by design.

## 6. Hand off to the process

If this session started before the scaffold existed, the new `CLAUDE.md` was never auto-loaded — so read it now and do what it says: adopt the Orchestrator role, read the two process documents, and run Phase 0. Then ask the Developer what they want to build (the seed). From this point the SDG process owns all work in the repository — no ad-hoc edits, no freelance analysis, ever.
