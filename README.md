# sdg-claude

A [Spec-Driven Generation](specs/PROCESS.md) (SDG) implementation for [Claude Code](https://claude.com/claude-code).

SDG is a structured process for building software by maintaining a master specification and using AI to generate code that implements it. Humans answer clarifying questions to remove ambiguity; the specs, tests, and product are all generated and refined automatically.

This repo packages the Claude Code primitives — `CLAUDE.md`, agents, prompts, settings, and a narrow reviewer CLI — needed to run that process in a fresh project.

## Bootstrap

In a new (or existing) project directory:

```sh
npx degit modularcloud/sdg-claude
```

That drops in:

- `CLAUDE.md` — the Lead's routing instructions
- `.claude/` — agents, prompts, settings, and the `sdg` reviewer CLI
- `specs/PROCESS.md` — the authoritative SDG process specification

## Requirements

- [`openai` CLI](https://developers.openai.com/api/docs/libraries/openai-cli) on `PATH` (Homebrew: `brew install openai/tools/openai`; or `go install github.com/openai/openai-cli/cmd/openai@latest`)
- `OPENAI_API_KEY` exported in your shell
- `git`
- `gh` (optional, for release / code-review flows)

## Usage

Open Claude Code in the project directory and the Lead picks up the SDG flow. The first interaction will gather a seed describing what you want to build; the rest is automated and only loops you in when clarification is needed.

For details on the process, read [`specs/PROCESS.md`](specs/PROCESS.md). For Claude Code specifics, read [`.claude/prompts/PROCESS.md`](.claude/prompts/PROCESS.md).

## The `sdg` reviewer CLI

`.claude/sdg` is a narrow bash CLI that assembles a fixed prompt bundle and invokes the `openai` CLI to produce a critical review of the spec, test spec, or a patch document.

```sh
bash .claude/sdg review spec
bash .claude/sdg review test-spec
bash .claude/sdg review patch specs/patches/improvements/0001-example.md
bash .claude/sdg review spec --dry-run    # print the bundle without calling OpenAI
```

Driver invokes it during Iterative Refinement; you generally won't run it by hand.

Model and effort default to `gpt-5` / `high`; override with `--model` / `--effort` flags or `SDG_REVIEW_MODEL` / `SDG_REVIEW_EFFORT` env vars.

## License

MIT
