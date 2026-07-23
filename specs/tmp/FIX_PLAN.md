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

- [ ] **T33 — review commands: `create`, `list`, `status`, `show`, `export`.**
  In `src/cli/` (SPEC 10.7): `create` requires exactly one of `--base <ref>` (path-blocks),
  `--strategy audit`, `--coverage <profile>` — none/multiple/other strategy = usage error;
  records fully resolved creation parameters (resolved commit identity; profile definition
  with group names replaced by configured glob lists and kind; nothing for audit); later
  generator runs use recorded parameters while discovery follows current config; refuses an
  existing session name (case-insensitively per 10.1) exit 1; unresolvable baseline → 6.3
  usage error exit 2, nothing modified. `list`: every session in byte order with name,
  strategy, item counts by stored status (no read-time invalidation); corrupt sessions
  reported by name as corrupt; exit 1 when any is corrupt, else 0. `status <name>`: items in
  item order with id, kind, scope, status, blocked state, plus totals. `show <name>
  <item-id>`: every 10.2 field plus the same self-contained text payload as `next --json`.
  `export <name>`: the entire session as a single JSON document (its only output form):
  name, strategy, recorded parameters and decompositions, every item in order with all
  fields, blocked state, text payload, read-time invalidation applied. Unknown session/item
  in any review command = usage error exit 2. Mutating ones under T25 exclusion. Satisfies
  Finding 2 gap 14 (first half).
  Verify: section-10.1, 10.2-10.3, 10.7-i move; run and report.

- [ ] **T34 — review commands: `next`, `split`, `resolve`.**
  In `src/cli/` + `src/core/` (SPEC 10.7): `next <name>` — first item in item order needing
  review (`unresolved`/`invalidated`) and unblocked; when none, report fully resolved, exit
  0, JSON payload with no item. `next --json` self-contained payload: every scope/context/
  origin node under current identity and presence, source ranges for present requirement
  nodes; baseline+current hashes; text per kind — scope: subtree text (subtree-coherence),
  subtree text (uncovered-requirement), own text (parent-/dependency-/metadata-consistency),
  none for code-impact scopes; context: own text for ancestor-chain contexts, subtree text
  otherwise; origin: before/after own text (before from `baseline`, after from current);
  absent-node text from the most recent graph state containing it among the item's baseline
  and mutating-subcommand derivations, else absent with no text. `split <name> <item-id>`:
  decompose a subtree-coherence item with children into per-child subtree-coherence items +
  the scope root's parent-consistency item blocked by them; existing kind+scope items are
  reused keeping id/status/state; new items inherit the original's `blockedBy`; blockers of
  the original now block the whole decomposition; original removed, id never reused;
  decomposition recorded durably and governing re-derivation; refuse other kinds or childless
  scope roots. `resolve <name> <item-id> --status updated|no-change|skipped [--note]`: sets
  status, records current relevant state (T30); works on any unblocked item (re-resolving
  invalidated/resolved items); refuses blocked items; other status values, unknown
  session/item = usage error; `--status updated` triggers re-derivation (T31). Satisfies
  Finding 2 gap 14 (second half).
  Verify: section-10.7-i, 10.7-ii, 10.4, 10.5, 10.6 — run all six review files and report.

- [ ] **T35 — `xspec check` and policy evaluation.**
  In `src/cli/` + `src/core/` (SPEC 12.2): all build validations without accepting stale
  outputs, never refreshing (13.3), plus: staleness — generated files content-identical to
  what current sources+config generate, no recorded derived file at a no-longer-generated
  path (14.10, check-only, names the file, instructs rebuilding); reference resolution and
  staticness; TS spec references; dependency and import cycles; journal well-formed and
  replayable with no conflicting mappings (14.13); review-session integrity (14.21, without
  modifying); symlink findings reported without writing (14.22); policy evaluation (SPEC
  7.5): `forbidden` (edge source matches `from` and target matches `to` = violation) and
  `allowedOnly` (edge whose source matches `from` and target does not match `to` =
  violation) over the rule's kinds, selectors by group/files (T2 captures)/tags, violations
  reported with rule name + offending edge — by `check` only (14.12), exit 1 on any finding.
  Configuration validity stays a usage error, not a finding. Satisfies Finding 2 gap 17
  (check half); Finding 1 gap 7 (7.5 evaluation).
  Verify: section-12.1-12.2, section-7.4-7.5; section-13.3, 13.4, 6.1 residuals.

- [ ] **T36 — SPEC 12.0 conventions sweep.**
  Run section-12.0-i, section-12.0-ii, section-12.3-12.5 and fix every remaining global-
  convention gap across all commands (SPEC 12.0): `--json` single-document rule and exit-2
  empty stdout; report/stdout vs diagnostic/stderr split; `--config` everywhere; flag
  repetition and non-UTF-8 argument usage errors; workspace-relative interpretation of
  node/file arguments vs cwd-relative `--config`/`--test-hold`; byte-wise case-sensitive
  comparisons; byte-determinism of all output/files (run-twice identical); the shortest-path
  byte tie rule wherever paths are reported; exact exit-code partition memberships; the
  precedence rules (rename/move existence checks and baseline resolution before source
  validation; unparseable-origin masking → exit 1). Satisfies Finding 2 gaps 16 and 18.
  Verify: those three files green (or every remaining failure explained in the report).

- [ ] **T37 — SPEC 14 validation-errors sweep.**
  Run section-14 and fix residuals: all 22 conditions detected with actionable file/
  location/correction content; several present conditions all reported, not only the first;
  masking exactly as specified (14.20 masks a file's internal conditions, references into it
  report as 14.5–14.7; 14.1 masks 14.2 for immediate children; 14.14 precedes all source
  analysis); the per-command reporting matrix (14.10 and 14.12 check-only; 14.21 check +
  review subcommands + list, never build; 14.22 refuse-before-modify, check reports without
  writing). Satisfies Finding 2 gap 21.
  Verify: section-14 green (or every remaining failure explained).

- [ ] **T38 — green sweep: SPEC sections 1–7 suite files.**
  Run every section-1.x, 2.x, 3, 4.x, 5.x, 6.x, 7* suite file; fix all residual product
  defects they diagnose (product code only — never `test/`). Closes Finding 1 gaps 1–7.
  Verify: all those files green; list any that are not, with diagnosis, in the report.

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
