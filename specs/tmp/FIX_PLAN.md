# FIX_PLAN — Phase 10: build the product against specs/SPEC.md

Planned 2026-07-17 from the Phase 10 iteration-1 findings (two compliance reviews and a
verify run at HEAD 8a79d6e): the product is the Phase 8 placeholder stub — every command
exits 86 with no output; `src/core/` and `src/workspace/` are empty; `src/index.ts` exports
nothing. Every SPEC.md section (1–15) is unimplemented (Finding 1 gaps 1–7 for sections 1–7;
Finding 2 gaps 1–22 for sections 8–15 and the preamble). The harness self-tests and
certifications are green; all 60 `test/suite` files (258 tests) fail with the stub's exit-86
signature. The entire pipeline must be built; tasks below are dependency-ordered.

## Rules for every task Engineer (read before executing a task)

- Execute the **first unchecked task**, complete it, mark it `[x]`, commit
  (`sdg(phase-10): <imperative summary>`), push. Keep the spawn small: one task, done well.
  If a task is too large to finish, split it in place (replace it with smaller unchecked
  tasks, keeping citations) rather than half-doing it, and say so in your report.
- **Never modify `test/`** (the harness) — Phase 10 hard scope guard. Reading it is fine.
  Never couple product code to harness internals; build only against specs/SPEC.md.
- Technical choices are bound by specs/IMPLEMENTATION.md: TypeScript 5.x `strict`, ESM,
  `tsc`, Node LTS (>= 22); layers `src/core/` (pure, I/O-free, deterministic), `src/workspace/`
  (all I/O), `src/cli/` (parsing, dispatch, rendering, exit codes; entry
  `(argv, cwd, stdout, stderr) → exit code`, bin a trivial wrapper); remark-mdx for MDX;
  TypeScript compiler API for TS analysis and for statically parsing (never executing)
  `xspec.config.ts`; SHA-256 (`node:crypto`, hex, length-prefixed injective framing); system
  `git` via read-only plumbing only; **no CLI framework, no glob library** — in-repo argument
  parsing, glob dialect, and symlink-free walking; no other runtime deps without a
  spec-grounded reason; every validation failure carried as data with its SPEC 14 condition
  number and exit class; one canonical JSON serializer (sorted keys, stable ordering,
  trailing newline) for stored data, sessions, and `--json`; code implementing a numbered
  SPEC rule cites the section in a comment; Prettier default config (`npm run format`).
- Build/test knowledge lives in AGENTS.md (record anything new you learn there — build/lint/
  run facts only). Key commands: `npm ci`; `npm run build` (product → `dist/`, bin
  `dist/cli/bin.js`); `npm run typecheck`; full suite `npm test` (build first); one file:
  `npx vitest run --config test/vitest.config.ts --project suite test/suite/<file>.test.ts`;
  harness-only `npm run test:self`; format check `npm run format:check`. System `git` must be
  on PATH for tests.
- Verification notes below name the suite files a task moves. Early foundation tasks are
  verified by `npm run build` + `npm run typecheck` and by targeted manual CLI probes; most
  suite files only turn fully green once the commands they observe through exist (many
  section-1–5 tests observe via `query`/`show`/`coverage`/`impact`/`review`). "Moves" means
  fewer failures in that file, not necessarily green. Report honestly which tests pass.
- Later VERIFY runs of the ralph loop append new tasks here. Append only — never discard or
  reorder existing tasks; never edit `test/` to make a test pass.

## Tasks

- [ ] **T39 — green sweep: SPEC sections 8–13 suite files.**
  Run section-8, 9, 9.3, 10.*, 11, 12.*, 13.*; fix all residual product defects. Closes
  Finding 2 gaps 2–20.
  Verify: all those files green; list any that are not, with diagnosis.

- [ ] **T40 — full-suite green: example, properties, E-6, CI.**
  Run `npm test` in full: section-15 (the SPEC 15 worked example end to end, rename-then-
  no-impact included), section-16-p1…p10 (TEST-SPEC 16 property tests, fixed seed set),
  e6-exchange-writer, and everything else; fix residual product defects until the suite is
  green locally. Then `npm run format` (commit any formatting), push, and confirm all three
  CI checks on PR #1 pass — harness self, full Linux suite, and the Windows E-6 leg
  (byte-identity against the Linux exchange artifact per AGENTS.md). Confirm `git diff
  --stat origin/main... -- test/` shows no harness changes from Phase 10. Closes Finding 2
  gap 22 and the verify run's red determination.
  Verify: `npm test` exit 0 locally; CI all green at the pushed HEAD.
