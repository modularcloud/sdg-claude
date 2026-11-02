# SDG configuration

Developer-owned. Selects which variant of each configurable behavior this project runs. Readers follow the pointer and load **only** the selected variant file — inactive variants are never read, so no agent ever carries conditional instructions for modes it isn't in. Edit this file directly, or say so in chat: agents may edit it (and the variant files under `.claude/prompts/modes/`) only on explicit Developer instruction, with Liaison as the usual scribe.

- **liaison-mode: cto**
  Liaison's decision rights when answering on Developer's behalf. Variants in `.claude/prompts/modes/liaison/`: `cto` (Developer is the product/business lead; Liaison makes the technical choices) or `pm` (Developer is the technical lead; major technical choices go to them).

- **engineering: ralph**
  How Phases 9–10 execute. `ralph` (default; PROCESS.md's harness-agnostic loop, bound in CLAUDE-PROCESS.md §7) or `workflow` (`.claude/prompts/modes/engineering/workflow.md`; a dynamic-workflows-native build — requires the Workflow tool in the running environment). Either way the completion standard is identical: full compliance review, all tests and checks green locally and in CI, code review resolved, red-green separation intact.

- **observer: none**
  Optional progress telemetry. `none` (default — nothing loads, nothing emits) or `tracker` (`.claude/prompts/modes/observers/tracker.md` — streams status events and plain-language summaries to the dashboard endpoint in `SDG_OBSERVER_URL`; strictly fail-open, never blocks the process).

To add a custom variant: write a new self-contained file in the matching `modes/` directory (its reader sees only that file) and point the key at its name.
