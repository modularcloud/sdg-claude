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

- [ ] **T14 — generated modules: documentation comments and navigation.**
  Extend T13 emission (SPEC 4.2): every generated node carries a documentation comment with
  the node's own text truncated to its first 1000 Unicode code points, `…` appended when
  truncated, each `*/` in emitted text written `*\/`, so editors show hover documentation;
  go-to-definition on a node reference resolves into the source `.mdx` — non-root to its
  `<S>` section, root to file start (design: declaration mapping the language service
  honors; the harness asserts via the TS language-service API, IMPLEMENTATION "Test
  harness"). Satisfies Finding 1 gap 4 (4.2).
  T13 landed the architecture in `src/core/emission.ts` (rationale in its module header):
  `NAME.xspec.ts` is a re-export shell, the runtime is `NAME.xspec.impl.js`, and every
  navigable declaration lives in `NAME.xspec.impl.d.ts` — put the JSDoc doc comments on
  those `.d.ts` declarations (hover + definitions), duplicate them textually in the
  `NAME.xspec.ts` shell (the certified doc-comment scan reads that file), and emit
  `NAME.xspec.impl.d.ts.map` + `sourceMappingURL` so the language service's source mapper
  redirects definitions into the `.mdx` (mapping works only from declaration files).
  Verify: section-4.1-4.2 moves after T17; language-service assertions are the oracle.

- [ ] **T15 — workspace write layer: atomic writes, symlink rules.**
  In `src/workspace/`: all product file writes go through one layer. Atomic observable
  writes — temp file + rename in the same directory (IMPLEMENTATION); at every moment a
  written path holds prior state or complete new content (SPEC 13.5). Plain committable
  files, stable ordering (SPEC 13.4). Symlink rules (SPEC 13.4 → 14.22): writing a derived
  file replaces whatever occupies its path, a symlink included, never writing through it; a
  durable file's path occupied by anything other than a plain file is never read/appended/
  replaced (journal → 14.13, session → corrupt 14.21); a symlink at a workspace-relative
  directory component of any write path → refuse before modifying anything, report 14.22
  (`check` reports it without writing). Satisfies Finding 2 gap 20 (13.4 write side).
  Verify: typecheck; section-13.4 moves after T17; full green needs T35 (`check`).

- [ ] **T16 — graph data store under `.xspec/`.**
  In `src/workspace/` + `src/core/`: persist graph data — requirement nodes, code locations,
  edges by kind, source ranges, all four hashes, coverage attributes, tags, and the recorded
  paths of the most recently generated derived files (SPEC 13.3) — via the canonical
  serializer (T1), byte-deterministic (SPEC 12.0), content otherwise opaque (13.3's stated
  contract: location under `.xspec/`, derived-file classification, refresh/failure/staleness
  behaviors). Provide load + compare-with-current (the staleness predicate `check` and
  refresh-on-read need, SPEC 13.3/14.10). Satisfies Finding 2 gap 19 (13.3 store).
  Verify: typecheck; section-13.3 moves after T17/T18.

- [ ] **T17 — `xspec build` end to end.**
  In `src/cli/` + `src/workspace/`, assembling T4–T16 (SPEC 12.1): load config (errors exit
  2 before source analysis, 14.14), discover, parse and validate spec + code sources
  reporting **all** independent findings (SPEC 14 preamble; masking rules), resolve the
  graph, compute hashes; on success generate TypeScript modules (13.1), emit Markdown when
  `markdown.emit` is true — `NAME.mdx` → `NAME.md`, placed per `markdown.outDir` preserving
  workspace-relative paths (SPEC 3, 7.3, 13.2) — and write graph data (13.3); regenerate
  every derived file and remove recorded derived files no longer generated (orphan removal
  via recorded paths only, 13.3/13.4); policy is NOT evaluated (SPEC 12.1, 14.12). A build
  that fails — validation errors exit 1 (findings report on stdout) or configuration error
  exit 2 — modifies nothing: every derived file and all graph data stay byte-identical
  (SPEC 12.1). Satisfies Finding 2 gap 17 (build half); makes Finding 1 gaps 1–4, 7
  observable.
  Verify: `npm run build && npm test` — expect section-12.1-12.2 (build part), 3, 13.1-13.2,
  and much of 1.x/2.x/4.x to move; run at least section-1.1-1.2, section-2.7, section-3,
  section-13.1-13.2 individually and report.

- [ ] **T18 — refresh-on-read for graph-consuming commands.**
  In `src/workspace/`: the shared pre-answer step for `ids`, `show`, `coverage`, `impact`,
  `review`, `query` (SPEC 13.3): when graph data is missing or does not match current
  sources+configuration, refresh it — writing exactly what `xspec build` would write except
  no TypeScript or Markdown is generated or removed and recorded derived-file paths are left
  unchanged — before answering; when current sources fail build validation, report the
  validation errors and exit 1 without answering and without modifying anything. `check`
  never refreshes (14.10). Satisfies Finding 2 gap 19 (refresh half).
  Verify: typecheck; observable once T19/T20 land (stale-data scenarios in section-13.3).

- [ ] **T19 — `xspec query` (all six subcommands).**
  In `src/cli/` + `src/core/` (SPEC 11): JSON-only output — a single JSON document with or
  without `--json`; `node` (identity, source range, own+subtree text, four hashes, tags,
  coverage attribute — absent for roots, incoming+outgoing edges by kind); `nodes` with
  conjunctive `--group` (spec groups only; code group name = invalid flag value exit 2),
  `--file` (T2 glob rules; outside-root pattern = invalid flag value exit 2), `--tag`,
  `--coverage` (never matches roots); `edges` with `--from`/`--to`/`--kinds` over all four
  kinds (default: no filter); `subtree` (node + descendants, document order); `ancestors`
  (proper ancestors, nearest first, ending at file root); `reachable` (nontrivial dependency
  path under `--kinds` — dependency kinds only, `contains` invalid, default all three;
  shortest witness with the SPEC 12.0 byte tie rule; equal from/to → no path). Identity
  forms: `path#id`, bare path root vs code file resolved by group, path in no group =
  unknown → exit 2. Deterministic ordering everywhere. Satisfies Finding 2 gap 15.
  Verify: section-11; large parts of section-1.x, 5.x now observable — run section-11,
  section-1.5, section-5.1-5.3, section-5.5 and report.

- [ ] **T20 — `xspec ids` and `xspec show`.**
  In `src/cli/` (SPEC 12.3, 12.4): `ids` — grouped by file (byte order of workspace-relative
  path), IDs in document order; `--tree` nesting by section structure; `--file <glob>` (T2
  rules); `--unreferenced` (no incoming dependency edges from specs or code; `contains`
  never counts); restricted listings re-nest under the nearest listed ancestor or file top
  level — the tree contains exactly the listed IDs; `--json` per 12.0. `show <node>` — the
  human report: identity, source range, own+subtree text, hashes, tags, coverage attribute
  (absent for roots), edges by kind. Satisfies Finding 2 gap 18 (ids/show half).
  Verify: section-12.3-12.5 moves (full green needs remaining commands); section-1.6-1.7,
  1.5 residuals.

- [ ] **T21 — coverage: computation and `xspec coverage`.**
  In `src/core/` + `src/cli/` (SPEC 8, 8.1, 8.2): reachability over the profile's
  `edgeKinds` between non-root participants — `direct` = single edge, `transitive` = path of
  one-plus edges; `contains` never grants coverage or appears in paths; roots never appear
  in coverage paths as boundary/intermediate/target (spec-group boundaries contribute only
  non-root nodes; root-sourced/targeted dependency edges stay ordinary edges elsewhere).
  Required set (8.1): target group restricted by `targetTags` and `targets:"leaves"`,
  excluding `coverage="none"` and roots. Output (8.2): all profiles or one named; counts of
  required/covered/uncovered/ignored; every covered/uncovered/ignored identity; one shortest
  covering path per covered node (12.0 tie rule); ignored nodes with all applicable reasons
  in the fixed order (root node, `coverage="none"`, non-leaf under leaves, lacking every
  `targetTags` tag); `--check` exits 1 on any uncovered required node; `--json` parity.
  Unknown profile name → exit 2 (12.0). Satisfies Finding 2 gaps 2–4.
  Verify: section-8; also the coverage-observed parts of earlier sections (e.g.
  section-2.5-2.6).

- [ ] **T22 — baseline reconstruction from git.**
  In `src/workspace/` (SPEC 6.3; IMPLEMENTATION: system `git` executable, read-only plumbing
  subcommands, no library, no writes): reconstruct the baseline graph from workspace content
  at a ref — sources and configuration as they stood at the ref (group membership from that
  config), journal content at the ref (absent = empty; empty is a prefix of every journal);
  apply the journal entries present now but absent at the ref, in file order, composing
  chained mappings, to map baseline→current identities; compute baseline hashes with the
  baseline journal. Fail with an actionable error naming offending entries/files — exit 2
  usage error (12.0) — when replay is ambiguous/unresolvable, when the baseline journal is
  not a prefix of the current one, or when baseline content cannot be parsed and validated
  as a workspace; baseline resolution precedes source validation (12.0). Satisfies Finding
  2 gap 5.
  Verify: typecheck; observable with T24 (impact) — section-6.3 then moves.

- [ ] **T23 — change categories (5.6).**
  In `src/core/`: pure derivation over (baseline graph, current graph, identity mapping):
  `changed` (added, deleted, or ownHash changed — structural child edits originate at the
  parent), `metadata-changed` (metadataHash), `descendant-changed` (subtreeHash changed
  because of a descendant), `upstream-changed` (effectiveHash changed via a dependency
  target's effectiveHash, or a subtree node other than itself gaining/losing/retargeting
  dependency edges). Both-sides rule: added/deleted nodes are `changed` only — no category
  through their own hashes (the sole exception, 9.2's impacted-code counting, is T24's).
  Categories are independent flags; attribution to originating nodes (`changed` or
  `metadata-changed`) exactly per the three worked cascades in SPEC 5.6 (leaf edit;
  child add/remove; `d`-target edit; coverage/tags-only edits propagate nothing). Satisfies
  Finding 1 gap 5 (5.6), Finding 2 gap 6.
  Verify: typecheck; section-5.6 moves with T24.

- [ ] **T24 — `xspec impact`.**
  In `src/cli/` + `src/core/` (SPEC 9, 9.1–9.3): `impact --base <ref>` comparing current vs
  T22 baseline with journal-mapped identities. Requirement impact = T23 categories with
  attribution (9.1). Impacted code (9.2): impact edges = union of a location's
  `references`+`embeds` edges in both graphs; one-side nodes count as subtreeHash-and-
  effectiveHash-changed; directly impacted (edge to subtreeHash-changed node) vs
  transitively impacted (effectiveHash changed, subtreeHash not); locations absent from the
  current graph reported under baseline identity. Output (9.3): grouped by category; maximal
  `descendant-changed`-only ancestor chains with identical attribution collapse to one
  entry; per impacted location one impact edge + one shortest propagation path (target →
  node whose own edit explains the change; `contains`-only steps with every-node
  subtreeHash-changed for direct, every-node effectiveHash-changed for transitive; edge and
  path minimized together per category over all qualifying edges, 12.0 byte tie rule;
  `embeds` reported over `references` when both target the chosen first node); deleted
  identities forward-mapped, duplicated as deleted+added when reused by a distinct node;
  exit 0 regardless of differences; `--json`. Satisfies Finding 2 gaps 6–8.
  Verify: section-9, section-9.3, section-5.6, section-5.4; section-6.6 (manual edits =
  delete+add) should move.

- [ ] **T25 — workspace mutual exclusion and `--test-hold`.**
  In `src/workspace/` (SPEC 13.5): mutating commands (`rename`, `move`, `review create/
  resolve/split`) are mutually exclusive per workspace — a second concurrent one fails
  promptly with a usage error (exit 2) modifying nothing; exclusivity ends when the holding
  process terminates, normally or abnormally (a terminated holder never blocks — design the
  lock accordingly, e.g. liveness-checked, not a bare lockfile); instances on different
  workspaces never interfere; all other commands run concurrently, last-write-wins, resolved
  by rebuild. `--test-hold <path>` on every mutating command: immediately after acquiring
  exclusivity and before modifying anything, create an empty file at the path with exclusive
  creation (fail if anything, symlink included, exists there → usage error, nothing
  modified), then proceed only once that file is deleted; no other behavioral change.
  Satisfies Finding 2 gap 20 (13.5).
  Verify: typecheck + manual probe with two processes; section-13.5 greens as rename/review
  land (T26, T33–T34).

- [ ] **T26 — `xspec rename`.**
  In `src/cli/` + `src/core/` + `src/workspace/` (SPEC 6.4): `rename <file> <old-id>
  <new-id>` — rewrite the ID and descendant IDs by prefix replacement; rewrite every
  reference across all configured spec and code sources (`id` attributes, `d` references,
  `text(...)` references, TS markers) as minimal in-place edits preserving quote style and
  access form, falling back per 6.4 (dot access for identifier segments, double-quoted
  computed access otherwise, double-quoted strings); type-only TS references not rewritten;
  append the mapping to the journal (T11 format; byte-deterministic, 6.1). Validation order
  (12.0 precedence): nonexistent `<file>`/old ID → usage error exit 2 before source
  validation, except an old ID inside an unparseable origin file is masked — findings
  reported, exit 1; then refuse (exit 1) when the workspace fails `build` validation; then
  validate new ID (valid, differs, no collision, structural rules hold, rewritten references
  resolve) — failures refuse exit 1. Success finishes by regenerating derived files exactly
  as `build` does (cannot fail per the precondition). Purity (SPEC 6.2): every hash
  byte-identical, no change categories against any baseline. Under T25 exclusion.
  Satisfies Finding 1 gap 6 (6.4).
  Verify: section-6.4, section-6.2 (rename part), section-6.1; SPEC 15's rename-then-
  no-impact example via section-15 later.

- [ ] **T27 — `xspec move`, file form.**
  (SPEC 6.5 first form): `move <old-file> <new-file>` relocates the source file; IDs
  unchanged, identities change only in the file part; rewrite the moved file's own import
  specifiers and other files' imports of its generated module so references resolve; rewrite
  all references workspace-wide; journal the full mapping; regenerate as rename does.
  Refusals/validation (6.5): mirror rename incl. valid-workspace precondition and
  usage-error class for nonexistent origin; refuse a destination that already exists; refuse
  a destination path that would not be a valid discovered spec source (no spec group,
  also-code-group 14.14, contains `#`, non-UTF-8, no `.mdx` → 14.19); refuse import/
  dependency cycles the move would create. Pure (6.2): no hash changes. Under T25 exclusion.
  Satisfies Finding 1 gap 6 (6.5 file form).
  Verify: section-6.5 (file-form tests), section-6.2 residuals.

- [ ] **T28 — `xspec move`, section form.**
  (SPEC 6.5 second form): `move <file>#<id> <target-file>#<new-id>` — extract the section
  subtree with the exact text rules: moved text = the construct's own characters (opening
  tag through closing tag, or self-closing tag); delete in place at origin, dropping lines
  left empty/whitespace-only purely by the deletion with their terminators (SPEC 3 rules);
  insert immediately before the target parent's closing tag (end of file for top-level
  `new-id`), followed by U+000A, preceded by U+000A when not at start of line; rewrite a
  self-closing target parent to paired form exactly as specified; create the target file if
  absent; re-identify by prefix replacement; rewrite references converting local/imported
  forms, adding imports with fresh non-colliding deterministic identifiers and removing spec
  imports whose bindings the rewrite leaves referenceless (previously-unreferenced imports
  stay); journal; regenerate; beyond the specified edits change no bytes. Additional
  refusals: exact self-move; `<new-id>` colliding with an ID remaining in the target after
  removal; missing target parent or one inside the moved subtree. Hash semantics per SPEC
  6.2 (identity mapping changes no hash; the straddling-lines nuance may make nodes
  `changed` with ordinary cascades; same-parent final re-insertion pure in effect). Under
  T25 exclusion. Satisfies Finding 1 gap 6 (6.5 section form).
  Verify: section-6.5 green; section-6.2 green.

- [ ] **T29 — review sessions and items: model and storage.**
  In `src/core/` + `src/workspace/` (SPEC 10.1–10.3): sessions at
  `.xspec/reviews/<name>.json`, plain deterministic files via the canonical serializer;
  name charset `A–Z a–z 0–9 . _ -`, no leading `.`, else usage error; names case-sensitive
  with the create-time ASCII-case-insensitive collision rule; only validly-named
  `<name>.json` plain files directly under `.xspec/reviews/` are sessions — everything else
  ignored by every command. Item model (10.2): `id`, `kind`, `scope`, `context`, `reason`,
  `origin`, `baseline` (fixed at entry: baseline-graph values for baseline sessions,
  current-graph values for audit/coverage), `current` (written at creation, rewritten at
  resolve), `status`, optional `note`, `blockedBy`; items enter `unresolved`. Statuses
  (10.3): the five statuses; resolved = `updated`/`no-change`/`skipped`; blocked while any
  blocker unresolved; `invalidated` blockers re-block. Corruption detection (10.1 → 14.21):
  non-plain file, unparseable, or violating any listed invariant (fields well-formed,
  statuses valid, unique item ids, `blockedBy` closed and acyclic, at-most-one item per
  kind+scope, well-formed recorded parameters/decompositions) — corrupt: `review`
  subcommands naming it report and exit 1 modifying nothing. Satisfies Finding 2 gaps 9–10.
  Verify: typecheck; section-10.1, 10.2-10.3 move with T33.

- [ ] **T30 — review invalidation: relevant hashes and read-time recompute.**
  In `src/core/` (SPEC 10.4): the per-kind relevant-hash table (subtree-coherence:
  subtreeHash+metadataHash of each scope node; parent-consistency: ownHash+metadataHash of
  scope, subtreeHash of each context node; dependency-consistency: ownHash+metadataHash of
  scope, subtreeHash of each upstream context target; metadata-consistency: metadataHash;
  code-impact: subtreeHash+effectiveHash of each impact-edge target; uncovered-requirement:
  subtreeHash+metadataHash). Resolve records current relevant hashes and per-node presence
  (absent = explicit marker). Invalidation: recorded state differs from the current graph —
  a hash changed, presence flipped either way, or the context set changed (current context
  set = the strategy generators re-run with recorded creation parameters and recorded
  decompositions against the current workspace, computed without persisting); an item no
  longer generated keeps its recorded context set; already-absent nodes staying absent do
  not invalidate. All comparisons by canonical identity (journaled renames/moves invalidate
  nothing, duplicate nothing, discard nothing); reads present recorded nodes forward-mapped
  through the journal; validity recomputed on every read (`status`/`next`/`show`/`export`),
  never persisted — sessions change only through mutating subcommands. Satisfies Finding 2
  gap 11.
  Verify: typecheck; section-10.4 moves with T33–T34.

- [ ] **T31 — path-blocks strategy.**
  In `src/core/` (SPEC 10.5): for each `changed` node without a `changed` ancestor: one
  `subtree-coherence` item (scope: node+descendants; context: ancestor chain; origin:
  `changed` nodes in scope); one `parent-consistency` item per non-root ancestor (scope: A;
  context: A's child on each changed branch; origin: the branches' `changed` nodes; single
  item per A with union of branches; `blockedBy` = per branch the child's subtree-coherence
  item when the child is the branch's changed node else the child's parent-consistency
  item). Plus: one `metadata-consistency` item per `metadata-changed` node (context:
  added+removed `d` targets; coverage/tags changes in `reason`); one `dependency-consistency`
  item per node with a dependency edge to a both-sides target whose effectiveHash changed
  (context: those targets; origin: their changes' originating nodes); one `code-impact` item
  per impacted location (context: impact-edge targets making it impacted, added/deleted
  included; origin: their originating nodes). Total order exactly per 10.5: requirement
  items by scope depth deepest first, kind order subtree-coherence → metadata-consistency →
  dependency-consistency → parent-consistency, file path, document order (present scope
  nodes first in document order; absent ones by identity then item id); code-impact last by
  location identity. Re-derivation on resolve-with-`updated` under the five rules (kind+
  scope matching keeps id/status/recorded state; recorded decompositions replayed
  recursively, never re-adding decomposed items; no-longer-generated items remain with
  `blockedBy`; new items with current state in order; `blockedBy` recomputed with decomposed
  references replaced by their decompositions). Satisfies Finding 2 gap 12.
  Verify: typecheck; section-10.5 moves with T33–T34; SPEC 15's four-item session is the
  acceptance example (section-15).

- [ ] **T32 — audit strategy and coverage sessions.**
  In `src/core/`: `audit` (SPEC 10.6) — one `subtree-coherence` item per requirement node,
  roots included; context: ancestor chain; origin empty; scope: node+descendants; order:
  file path (byte order) then document order; `blockedBy`: the child sections' items (after
  split, their decompositions) so review is bottom-up; no baseline. Coverage sessions (SPEC
  10.7): one `uncovered-requirement` item per uncovered required node of the recorded
  profile — scope: the node; context: ancestor chain; origin and `blockedBy` empty; ordered
  by file path then document order. Satisfies Finding 2 gaps 13 and part of 14.
  Verify: typecheck; section-10.6 and coverage-session tests in 10.7 move with T33.

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
