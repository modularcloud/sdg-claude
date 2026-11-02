# sdg-claude — template repository

This repository is the **source of the SDG scaffold**, not an SDG project. Do not run the SDG process here: sessions in this repo are maintenance sessions, improving the scaffold with its owner.

- `scaffold/` is exactly the file set installed into projects (`npx degit modularcloud/sdg-claude/scaffold`). Its `CLAUDE.md` addresses a project's Orchestrator, not you.
- `README.md`, `LICENSE`, and `sdg-bootstrap/` (the bootstrap skill) belong to the template repo only.

## Invariants to preserve when editing the scaffold

- `scaffold/specs/PROCESS.md` is the owner's harness-agnostic process: change it only on explicit instruction, and minimally. Claude-specific behavior belongs in `scaffold/specs/CLAUDE-PROCESS.md`, whose §10 must remain a true and complete list of deltas from PROCESS.md.
- Agent definitions carry only role-invariant contracts. Mission files under `.claude/prompts/<actor>/` state purpose, goals, constraints, and output contracts — not methods — and point at PROCESS.md sections rather than restating them.
- Configuration resolves by pointer: `.claude/sdg-config.md` selects a variant file under `.claude/prompts/modes/`, and only the selected variant is ever loaded. No mode conditionals inside prompts.
- A project's main thread is a dumb Orchestrator; Developer-facing words come from Liaison; to the Developer, the process is a black box.
- Durable state lives in files and git — sessions are ephemeral.

## Shipping changes

Commit and push to `main`. Existing projects receive scaffold changes only when their template-owned files are re-synced from `scaffold/` — never overwrite a project's `GOALS.md`, `PHILOSOPHY.md`, specs, or `sdg-config.md` values.
