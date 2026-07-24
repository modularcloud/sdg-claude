# FIX_PLAN — Phase 10

Source: Phase 10 compliance panel (2026-07-24). Reviewer for SPEC sections 8–15 found exactly one
gap; the sections 1–7 reviewer returned COMPLIANT and the verify run is fully green (485/485
locally, all three CI jobs green at 88b6b40). Tasks execute in order; each task ends with the full
suite green.

Hard constraints for every task:

- The test harness under `test/` is FROZEN, as are `specs/TEST-SPEC.md` and `specs/CERTIFICATIONS.md`.
  No task may touch them.
- All currently green tests (485/485; CI jobs harness-self, full suite, Windows E-6) must stay green
  after each task. Build first (`npm run build`), then `npm test`; see `AGENTS.md`.
- Branch `sdg/initial-build`, commits `sdg(phase-10): <imperative summary>`, ordinary commits only
  (never rewrite pushed history), push after each task.

## The gap being fixed (panel finding, condensed)

SPEC 10.4 requires that wherever review compares or matches recorded nodes — invalidation; item
matching, decomposition matching, and the at-most-one invariant (10.1, 10.5); `split` (10.7) —
requirement nodes compare as canonical identities (5.4), never as reference spellings. The product
instead stores forward-mapped identity *spellings* (`src/core/review.ts` header "identity policy")
and compares them byte-wise. The header's premise — "two items with the same kind and canonical
scope always store byte-identical scope spellings" — has a false converse: two canonically
*distinct* nodes can come to share one spelling when a spelling vacated by a **manual deletion**
(6.6, no journal entry) is later **recaptured by a journaled rename**.

Reproduction (all owning commands / ordinary edits, each step exits 0 today):

1. Workspace with top-level sections `a` and `b` in `specs/S.mdx`; `xspec build`.
2. `xspec review create --strategy audit --name s` (items for the root, `a`, and `b`).
3. Edit the source deleting section `b` (a 6.6 deletion); `xspec build`.
4. `xspec rename specs/S.mdx a b` (legal — `b` no longer exists; journal gains one entry).
5. `xspec review resolve s item-2 --status no-change`.

Observed today: step 5 persists both the renamed node's item (canonical identity `(a, start)`) and
the deleted node's item (canonical identity `(b, start)`) under the single spelling
`specs/S.mdx#b`; the next read's byte-wise kind+scope duplicate check reports
`corrupt review session "s"` (14.21), every `review` subcommand naming `s` and `review list` exit
1, `check` reports 14.21 with correction text falsely blaming external modification, and every
recorded status is lost. Additionally, even before step 5, the deleted node `b`'s item is presented
and state-computed against the distinct recaptured node (presence `true` via spelling lookup in
`recordedNodeState`), so a resolution recorded on the deletion item before the rename is spuriously
invalidated by the pure rename alone — contradicting SPEC 10.4 ("an identity mapping from a
journaled rename or move duplicates no item, discards no status, and by itself invalidates
nothing") and 14.21/10.1 (corruption denotes external damage; the invariant list's violations "can
only enter by external modification").

## Design fixed by this plan

The product already implements SPEC 5.4 canonical identities correctly for hashing:
`Journal.canonicalIdentity(spelling)` in `src/core/journal.ts` returns the eternal, rename-stable
`CanonicalIdentity` `{identity, position}` (chain-start identity plus the journal position ending
the backward walk). Review must store, compare, and judge recorded nodes by that canonical
identity, deriving current spellings only for presentation. Governing facts (all provable from
SPEC 5.4/6.3 and `journal.ts`):

- A node's canonical identity never changes as the journal grows. The canonical identity of "the
  node that bore spelling S when the journal had L entries" is
  `Journal(entries[0..L]).canonicalIdentity(S)`.
- The current spelling of canonical `C = (id, pos)` is `Journal(entries[pos..]).mapForward(id)` —
  exactly SPEC 10.4's "the recorded identity mapped forward through the journal (6.3)".
- `C` still *resolves* through the journal iff the round trip holds:
  `fullJournal.canonicalIdentity(currentSpellingOf(C))` equals `C`. It fails exactly when a later
  entry recaptured the spelling for a different chain (SPEC 10.4 "its identity ceases to resolve
  through the journal"). A node is *present* iff its canonical identity resolves AND the current
  graph holds a requirement node (or code location) at the resulting spelling.
- Distinct canonical identities may share a forward-mapped spelling (the gap's scenario); one
  canonical identity never denotes two nodes. So canonical pairs — not spellings — are the only
  sound storage/matching key. (Caveat unchanged by this plan: a manual delete followed by a manual
  re-add of the same ID reuses the old chain — SPEC 6.6 treats that as deletion plus addition
  distinguished by hashes, not identity; no journal record exists to separate them.)

Frozen-harness latitude, verified by reading the harness (do not re-verify by editing tests; these
are facts about what `test/` observes):

- The stored session file's concrete shape is the product's (SPEC 10.1 fixes information, not
  shape). The only shape coupling is `test/helpers/adapters/session-staging.ts` (`SESSION_SHAPE`):
  the stored document must keep a top-level `creationParameters` member and an `items` array of
  objects each carrying `id` (non-empty string), `status` (string), and `blockedBy` (array). Keep
  those keys with today's names and meanings. `stageDuplicateItemEntry` clones a whole item entry —
  under canonical storage the clone still shares kind + canonical scope, so the staged
  "two items same kind and scope node" and "duplicate item ids" corrupt states (T10.1-4) keep
  reporting corrupt. Other T10.1 facts to preserve: the file parses as one JSON document, is
  byte-deterministic for identical fixtures, and reads never rewrite it.
- Presented JSON output is decoded by `test/helpers/adapters/review.ts`: `scope`/`context`/`origin`
  entries are `{node, present, text?, sourceRange?}` (sourceRange forbidden when absent);
  `baseline`/`current` are passed through whole and asserted value-blind — string-leaf searches for
  hash values captured at specific moments plus whole-member canonical-JSON stability across reads
  of the same moment (e.g. T10.2-2, T10.2-4). Therefore: keep the presented `baseline`/`current`
  member byte-identical to today's form (`{"nodes": {"<current spelling>": {present, hashes}}}`)
  whenever no two recorded nodes of that state share a forward-mapped spelling — i.e. in every
  scenario an existing test stages. Human output (`renderItemHuman`, `compactStateHuman`) likewise
  keeps today's spellings in those scenarios.
- `test/suite/registry/section-10.4.ts` T10.4-4 already covers the mirror case (rename `a -> b`,
  then a *new* section reintroduces `a` — a fresh canonical chain per 5.4: old item keeps id and
  resolved status under scope `b`, new `a` enters as a distinct unresolved item). The canonical
  design must keep all its arms green.

---

Canonical-identity plumbing (was T41, completed): `src/core/journal.ts` now exports `canonicalAt`,
`currentSpellingOf`, `resolvesCurrently`, and the injective key codec
`encodeCanonicalIdentity`/`parseCanonicalIdentity` (`<canonical decimal position>:<identity>`,
parser splitting at the first `:`, rejecting anything not of that exact form). `Journal.canonicalIdentity`
and `Journal.mapForward` take optional prefix-length/start-position bounds, so no per-node prefix or
suffix `Journal` is ever built on hot paths.

Canonical storage and matching (was T42, completed at the commit carrying this note): every stored
node reference — item `scope`, `context[]`, `origin[]`, the keys of `baseline.nodes`/`current.nodes`
and `baselineTexts`/`derivedTexts`, each decomposition's `scope` — is the canonical key encoding;
`journalLength` was kept as the write-moment bound (parse rejects any reference that does not parse
as `<position>:<identity>` with non-empty identity, or whose position exceeds `journalLength`;
mutating subcommands advance `journalLength` to the current journal entry count on every write). The
at-most-one invariant compares canonical encodings byte-wise (`src/core/review.ts`
`checkSessionInvariants` + `checkCanonicalReferences`). The forward-spelling rewrite is gone
(`journalSuffixMapper`/`mapSessionIdentitiesForward`/`mapItemIdentitiesForward`/`mapRecordedState`/
`mapTextTable` deleted; reads and mutators consume the stored session as-is). Facts T43 needs:

- The codec seam lives in `src/core/review-state.ts`: `canonicalKeyOfCurrent`, `parseReference`,
  `spellingOfReference`, and `presentRecordedState` (presented `baseline`/`current` keep spelling
  keys unless two canonically distinct recorded nodes of that one state share a forward-mapped
  spelling; then the whole state keeps its stored canonical keys — deterministic, nothing dropped).
  `ReviewStateInputs` gained `journal`; the old `scopeSubtreeIdentities` is now
  `scopeSubtreeReferences` (canonical keys out, full-journal canonicalization of graph members);
  `recordedNodeState` still judges presence by spelling lookup — exactly what T43 item 1 replaces
  with `resolvesCurrently` + graph lookup.
- The generator seam is `canonicalizeGeneration` (`src/core/review-derive.ts`): generator files are
  untouched and stay spelling-space; the seam canonicalizes items, blocker refs (resolved through
  the generated items, current-graph-first on spelling collisions), the wrapped
  `DecompositionContentSource` (canonical refs in, decoded to spellings for the inner builder), and
  the per-location impact-target map. A deleted baseline node canonicalizes as
  `canonicalAt(journal, baselineJournalLength, baselineIdentity)`. `CurrentDerivationSide` gained
  `journal`; `BaselineDerivationSide` replaced `replay` with `journal` + `journalLength` (the
  baseline prefix length), and `computeBaselineRecordedState` keys subtree members via
  `canonicalAt` — T43 item 2's "align its keys" is done; confirm no spelling lookup remains.
- Ordering (`sortItemsPathBlocks`, `sortItemsByFileThenDocument`, `compareByDocumentOrder`) takes
  the journal and ranks by each scope's derived current spelling; the absent tie-break is spelling
  bytes then item id — T43 item 5 re-judges *presence* (document position only for a canonically
  resolving scope), not the key shape.
- Verified: full suite 485/485 green, typecheck, format; the panel reproduction (steps 1–5) all
  exit 0, every subsequent read and `check` exit 0 with both items distinct and no status lost —
  plus a second mutating subcommand and re-read staying clean. Presence/invalidation are still
  spelling-judged (the reproduction's deletion item currently presents `present: true` under the
  recaptured spelling) — that is T43's work, not a regression.

## T43 — Judge presence, state, and invalidation canonically

**Satisfies:** SPEC 10.4 — "a node is absent when it is deleted or its identity ceases to resolve
through the journal"; "an identity mapping from a journaled rename or move … by itself invalidates
nothing — only hash, presence, or context-set changes invalidate"; SPEC 10.5/10.7 ordering and
`split` over current identities and presence.

Replace every spelling-lookup presence/state judgment with canonical resolution
(`resolvesCurrently` + graph lookup at the derived spelling):

1. `recordedNodeState` and `computeRecordedState` in
   `/home/user/sdg-claude/src/core/review-state.ts`: a recorded node whose canonical identity no
   longer resolves is absent (explicit absent marker) even when its forward-mapped spelling is
   borne by a different node; hashes are read only for a resolving, present node.
   `scopeSubtreeIdentities` contributes descendants only when the scope root canonically resolves
   to a current node; otherwise the root alone.
2. `computeBaselineRecordedState` in `review-derive.ts`: already resolves via per-side
   `baselineIdentity`; align its keys with the canonical keying of T42 and confirm no spelling
   lookup remains.
3. Read payloads in `/home/user/sdg-claude/src/cli/commands/review-session.ts` (`nodeStateJson`,
   `originEntryJson` after-side): presence and text/sourceRange come from canonical resolution —
   a dangling recorded node is presented absent (no sourceRange; absent-node text provenance rule
   of 10.7 unchanged), even though its presented spelling matches a live node.
4. `splitItemDecomposition` and decomposition expansion: the scope root's children (and the
   childless refusal) are judged on the canonically resolved node.
5. Item ordering (`sortItemsPathBlocks`, `sortItemsByFileThenDocument`): a scope has a document
   position only when it canonically resolves to a present node; a dangling scope takes the
   absent branch (identity bytes, then item id) — SPEC 10.5's present-before-absent rule over
   10.4 presence.

Net effect on the finding's second observation: a resolution recorded on the deletion item before
the rename stays resolved after the rename (recorded absent, still absent — no presence change, no
hash change, no context change), and the recaptured node's own item is unaffected. T10.4-4's
reintroduction arm must stay green (fresh chain ⇒ distinct item; old item keeps status under its
mapped spelling).

Verify: full suite green, typecheck, format; re-run the T42 manual reproduction plus the
pre-rename-resolve variant (resolve the deletion item, then rename, then confirm `status`/`show`
report it still resolved and nothing invalidated by the rename alone). Commit and push.

## T44 — End-to-end verification: reproduction scenarios, full suite, CI

**Satisfies:** closure of the panel finding against SPEC 10.4/10.1/14.21/5.4; the plan's
stay-green constraint.

1. Fresh `npm ci` + `npm run build`. Script the finding's exact reproduction in a scratch
   workspace (outside the repo) and assert, recording exit codes and key output:
   - Steps 1–5 all exit 0.
   - After step 5: `review status s`, `review next s --json`, `review show s <each item>`,
     `review export s --json`, `review list` all exit 0; `check` reports no condition-21 finding;
     no output claims the session corrupt.
   - The session holds distinct items for the renamed node (presented scope `specs/S.mdx#b`,
     present) and the deleted node (presented under its forward-mapped spelling, absent); the
     step-5 resolution's status is reported; no status was discarded.
   - Variant A (spurious-invalidation regression): resolve the deletion item *before* the rename;
     after the rename alone it is still reported resolved (not `invalidated`).
   - Variant B (persistence round-trip): after step 5 run a second mutating subcommand (e.g.
     resolve another unblocked item) and re-read — still exit 0, still no corruption.
2. Run the full local gates: `npm run typecheck`, `npm run format:check`, `npm test` (all 485,
   E-6 writer included when `XSPEC_E6_EXCHANGE_DIR` is set per AGENTS.md), `npm run test:self`.
3. Record in `AGENTS.md` any *build/lint/run* knowledge newly learned (nothing else belongs
   there); skip if none.
4. Commit, push, then confirm all three CI jobs (harness-self Linux, full suite Linux,
   Windows E-6) succeed at the pushed HEAD (`gh run list`/`gh run watch`). If a job fails,
   diagnose and fix within this task's scope (product code only), commit, push, re-confirm.

---

Completion of T42–T44 closes the panel's Gap 1. No spec-problems entries are needed: SPEC 5.4,
10.1, 10.4, and 14.21 are consistent and implementable as specified; the product deviated.
