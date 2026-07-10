# xspec Certifications

This document specifies the fixture products that certify selected tests of `specs/TEST-SPEC.md` under the certification protocol of TEST-SPEC.md §17 (C-1, C-2). A **conformer** conforms to `specs/SPEC.md` within its stated scope, with the simplest behavior that does so. A **violator** is its conformer with exactly one specified behavioral deviation. A test is **certified** when it passes against the conformer and fails against each violator that targets it. Fixtures are implemented as part of the test harness and are driven through the identical blackbox surfaces as the product (C-2: an executable/workspace binding and nothing else); this document describes them only in terms of SPEC.md's interfaces, contracts, seams, and observability features and prescribes no implementation details.

Selection is deliberately incomplete (PROCESS.md). A fixture exists here only where a vacuous pass is an elevated risk: negative and absence-of-effect tests whose staging or byte-compare wiring could silently miss the behavior under test, temporal behavior, tests routed through the `--test-hold` seam (SPEC.md 13.5), and the reachability of property tests' generated inputs. No Bug Report exists, so no fixture is justified empirically. Every test not named in an in-scope set below is deliberately uncertified (see Exclusions). There are no spec modules, so there are no module certification files.

Each conformer entry states its **scope** — the SPEC.md behaviors and command surface it implements and the workspace shapes it accepts — and its **in-scope tests**: the named subset (C-1) the certification runner executes against the conformer and each of its violators. Every in-scope test passes against the conformer. Each violator entry states its scope (its conformer's), its single deviation, the tests it certifies, and its expected failures: exactly the certified tests fail against it, and every other in-scope test passes.

## CONF-CORE — operational core: exclusion seam, journal, durable files, review reads

**Scope.** Workspaces with one configured spec group of `.mdx` sources without imports, embeddings, `d` props, or tags; no `code`, `markdown`, `coverage`, or `policy` keys; no git. Command surface: `build`; the read commands of 13.3 behaving per 12.0 over such workspaces (`check` with no findings on valid state, `ids`, `show`, `query`, `coverage` reporting zero profiles, the `review` read subcommands; `impact --base` without git is the exit-2 unreadable-baseline case of 6.3/12.0); `rename` and file-form `move` with journal append (6.1, 6.2 as staged by the in-scope tests); `review` with the `audit` strategy (10.6) through `create`, `resolve`, `split`, and the read subcommands, including read-time invalidation over the recorded state of 10.4. Contracts under certification: 6.1 journal form and write discipline, 10.4 read discipline, 13.4 durable-file protection, and 13.5 in full, `--test-hold` seam included. Content of derived files beyond path, byte-determinism, write discipline, and atomic visibility is out of scope.

**In-scope tests:** T6.1-1, T6.1-2, T10.4-5, T13.4-5, T13.5-1, T13.5-2, T13.5-3, T13.5-4, T13.5-5.

**Justification.** Every 13.5 test routes through the one seam SPEC.md declares and asserts temporal behavior — contention, kill timing, write visibility — where a mis-choreographed harness passes against any product. T6.1-1, T13.4-5, and T10.4-5 are absence-of-effect assertions (byte-compares around commands), the suite's largest vacuous-pass surface: a mispositioned snapshot passes forever.

### VIOL-CORE-NOLOCK

* **Scope:** CONF-CORE.
* **Deviation:** Mutating commands do not exclude one another. The hold file is still created before any modification and honored, but a second mutating command started while another runs or is held is not refused: it proceeds normally instead of failing with the usage error of 13.5/12.0.
* **Certifies:** T13.5-2.
* **Expected failures:** exactly T13.5-2 (the second command succeeds and modifies the workspace while the first is held). All other in-scope tests pass: T13.5-1, T13.5-3, and T13.5-5 each drive a single mutating command; T13.5-4's concurrent commands are non-mutating; the journal, durable-file, and review-read tests involve no concurrent mutators.

### VIOL-CORE-EARLYWRITE

* **Scope:** CONF-CORE.
* **Deviation:** A mutating command performs its workspace modifications before creating the hold file: it acquires exclusivity, completes the operation's writes (journal append included), then creates the hold file, waits for its deletion, and exits normally.
* **Certifies:** T13.5-1, T13.5-4.
* **Expected failures:** exactly T13.5-1 (the workspace is not byte-identical while held; modification precedes the hold) and T13.5-4 (read commands run while a command is held observe the operation's result, not the prior state). All other in-scope tests pass: exclusivity is still acquired first, so T13.5-2's excluded command still fails without modifying anything; a kill at the held point leaves the completed, consistent operation, so T13.5-3's subsequent command still succeeds; writes remain atomic (T13.5-5); journal content, append-only form, and determinism are unchanged (T6.1-1, T6.1-2); durable-file and session-read discipline are unchanged (T13.4-5, T10.4-5).

### VIOL-CORE-STALELOCK

* **Scope:** CONF-CORE.
* **Deviation:** Workspace exclusivity is not released by abnormal termination: after a mutating command's process is killed, every later mutating command in that workspace is refused with the usage error of 13.5/12.0. Normal completion still releases.
* **Certifies:** T13.5-3.
* **Expected failures:** exactly T13.5-3 (the subsequent mutating command after a kill is refused instead of succeeding). All other in-scope tests pass: no other in-scope test kills a mutating command, and normal completion behaves as the conformer.

### VIOL-CORE-PARTIALWRITE

* **Scope:** CONF-CORE.
* **Deviation:** Derived-file writes are not atomic in their observable effect: while a derived file is being written, its path holds a strict prefix of the new content for a sustained interval — long relative to a concurrent reader's polling cadence — before the complete content appears. Durable files are unaffected.
* **Certifies:** T13.5-5.
* **Expected failures:** exactly T13.5-5 (the polling reader observes a partial file). All other in-scope tests pass: they observe derived files only after commands complete (T13.5-4's final `build` comparison included), and journal, session, and exclusion behavior are unchanged.

### VIOL-CORE-CHATTYREADS

* **Scope:** CONF-CORE.
* **Deviation:** `build` and the read commands modify the journal: each such invocation that is not refused as a usage or configuration error (exit 2) appends one fixed line to `.xspec/journal`, creating the file when absent. Mutating commands, and the entries `rename`/`move` append, are unchanged.
* **Certifies:** T6.1-1, T13.4-5.
* **Expected failures:** exactly T6.1-1 (a journal file exists after `build` in a fresh workspace; the byte-compares around `build`, `check`, `coverage`, `impact`, `review`, and `query` observe modification) and T13.4-5 (its journal byte-compares under `build` and read commands fail). All other in-scope tests pass: T6.1-2 compares the entries of the same operation on identical workspace states, which remain byte-identical; T10.4-5 byte-compares the session file, which is untouched; the 13.5 tests assert hold, exclusion, and derived-file behavior, not journal bytes, and T13.5-2's byte-compare covers the refused mutating command, which appends nothing.
* **Note:** this violator certifies the compare-around-command machinery that the suite's other never-modifies assertions (T12.0-11, T12.1-4, T13.3-3, T6.4-3, T6.5-4) reuse.

### VIOL-CORE-PERSISTREADS

* **Scope:** CONF-CORE.
* **Deviation:** Review reads persist read-time invalidation: when `status`, `next`, `show`, or `export` computes that a resolved item's recorded state differs from the current graph (10.4), it rewrites that item's stored status to `invalidated` in the session file. Reads over sessions with no stale resolution write nothing.
* **Certifies:** T10.4-5.
* **Expected failures:** exactly T10.4-5 (the session file is not byte-identical across a read that computes invalidation). All other in-scope tests pass: T13.4-5's session byte-compares run `build` and reads over sessions whose resolutions are not stale (staleness under reads is T10.4-5's fixture, per TEST-SPEC.md), and no other in-scope test reads a session with a stale resolution.

## CONF-VALID — segment and tag validity

**Scope.** Single-file, single-spec-group workspaces of sections carrying `id` and `tags` props; no imports, embeddings, `d` props, code groups, `markdown`, `coverage`, `policy`, or git. Command surface: `build` with the error reporting of 14 for conditions 14.1–14.4 (file, location, condition identity, exit codes per 12.0) and `query node`/`query nodes` reporting identity, tags, and metadataHash. Contracts under certification: 1.3, 1.4 (with the exact character classes of SPEC.md 1.4), 2.6 tag splitting, and the masking rule of 14.2.

**In-scope tests:** T1.3-1, T1.3-2, T1.3-3, T1.3-4, T1.3-5, T1.3-6, T1.4-1, T1.4-2, T1.4-4, T2.6-1, T2.6-2, P-1.

**Justification.** The 1.4 matrix is the suite's most staging-fragile negative surface: its fixtures place control characters, exotic whitespace, and boundary code points inside source bytes, where a staging accident yields a different error (14.20) and the assertion of failure passes vacuously against a product that never validates 1.4. P-1's value rests entirely on its generator reaching those classes — the criterion-(a) reachability case.

### VIOL-VALID-CTRL

* **Scope:** CONF-VALID.
* **Deviation:** The control-character rule of 1.4 is not enforced for code points outside the whitespace class: segments and tags containing U+0000–U+0008, U+000E–U+001F, or U+007F are accepted as valid. Whitespace characters (U+0009–U+000D, U+0020) remain rejected in segments, and tag splitting is unchanged.
* **Certifies:** T1.4-1, T1.4-4, P-1.
* **Expected failures:** exactly T1.4-1 (its control-character representative arms U+0000, U+001F, U+007F build instead of failing 14.4), T1.4-4 (its control-character tag arms U+0000, U+007F build), and P-1 (generated segments/tags in the non-whitespace control class are accepted where 1.4 rejects them). All other in-scope tests pass: no other in-scope test stages non-whitespace control characters, and structural, duplicate, whitespace, forbidden-name, boundary-class, and tag-splitting behavior are unchanged.

### VIOL-VALID-WIDE

* **Scope:** CONF-VALID.
* **Deviation:** U+00A0, U+0085, and U+2028 are treated as whitespace for 1.4 validity: a segment or tag containing any of them is rejected with 14.4. Tag splitting and all other classifications are unchanged.
* **Certifies:** T1.4-2, T1.4-4, P-1.
* **Expected failures:** exactly T1.4-2 (segments containing the three code points fail instead of building), T1.4-4 (its boundary arm — the same character classes applied to tags — fails), and P-1 (generated values containing the three code points are rejected where 1.4 accepts them). All other in-scope tests pass: T1.4-1 stages none of the three code points, and T2.6-1/T2.6-2 split only on the true whitespace characters of 1.4.

## CONF-MD — Markdown compilation

**Scope.** Spec-group workspaces of `.mdx` sources with imports (2.1, valid forms as staged), same-file and cross-file `text(...)` embeddings (2.3), MDX comments, and mixed line terminators; `markdown` absent, `{ emit: false }`, and `{ emit: true }` with default emission next to each source (13.2); no code groups, `coverage`, `policy`, or git. Command surface: `build` with byte-exact Markdown output per 3, and `query node` reporting own and subtree text (1.6, defined through the rules of 3). Contracts under certification: 3 in full — removal, replacement, the line-drop rule, line terminators — and the emission scope of 7.3.

**In-scope tests:** T3-1, T3-2, T3-3, T3-4, T3-5, T3-6, P-2, P-3.

**Justification.** The line-drop rule is the subtlest pure contract in SPEC.md, and its discriminating fixtures depend on exact exotic bytes (boundary code points, lone-CR terminators) that tooling silently normalizes — a corrupted fixture passes vacuously in both directions. P-2's oracle is trusted by the property suite (S-6 checks its vectors; certification checks that generated documents actually reach the discriminating classes and that the property fails when the product deviates).

### VIOL-MD-CLASS

* **Scope:** CONF-MD.
* **Deviation:** The line-drop rule classifies U+00A0, U+0085, and U+2028 as whitespace when deciding whether a line is left empty or whitespace-only — consistently in Markdown output and, through 1.6, in own and subtree text. A line left holding only those code points after removals is dropped with its terminator.
* **Certifies:** T3-3, P-2.
* **Expected failures:** exactly T3-3 (its class-boundary arms: lines left holding only U+00A0, U+0085, or U+2028 are dropped instead of kept) and P-2 (the oracle keeps such lines; generated content weighted toward the boundary code points reaches the divergence). All other in-scope tests pass: their fixtures stage none of the three code points on removal-affected lines, and P-3 compares the product's text values to its own compiled output, which the consistent deviation keeps equal.

### VIOL-MD-CR

* **Scope:** CONF-MD.
* **Deviation:** A lone U+000D is not recognized as a line terminator by the line model of 3 — consistently in Markdown output and, through 1.6, in own and subtree text. CRLF and lone U+000A remain terminators; a lone U+000D is an ordinary in-line character.
* **Certifies:** T3-4, P-2.
* **Expected failures:** exactly T3-4 (its lone-CR arms: line boundaries, and therefore the drop rule's line extents, diverge byte-wise) and P-2 (generated documents over mixed terminators reach lone-CR lines where the oracle diverges). All other in-scope tests pass: their fixtures use terminators the deviation leaves recognized, and P-3's internal consistency is preserved as in VIOL-MD-CLASS.

## CONF-DISC — configuration-driven discovery

**Scope.** Workspaces of trivial single-section `.mdx` sources whose file and directory names carry glob-significant bytes; one or more spec groups with the glob grammar of 7; symbolic links present in the tree; no code groups, `markdown`, `coverage`, `policy`, or git. Command surface: `build` and `ids` (12.3) as the observation of the discovered set, and the configuration-error behavior of 14.14/12.0 for patterns resolving outside the workspace root. Contracts under certification: glob semantics of 7 — `*`, `?`, `**`, byte-wise case-sensitive matching, dot-segment rule, every other character a literal — and discovery's refusal to follow symbolic links.

**In-scope tests:** T7-4, T7-5.

**Justification.** Both tests assert non-discovery — negative observations that pass vacuously when the staged names (bracket-bearing, multi-byte, dot-prefixed, link-mediated) never reach the matcher at all. They are also the canonical stock-dependency hazard: a product delegating to a common glob or filesystem-walking dialect satisfies every positive arm while violating the negative ones.

### VIOL-DISC-DIALECT

* **Scope:** CONF-DISC.
* **Deviation:** Glob patterns are interpreted in a common dialect in which `[` `]` bracket expressions and `{` `}` brace alternations are active metacharacters, instead of the literals 7 requires. `*`, `?`, `**`, case sensitivity, and the dot-segment rule are unchanged.
* **Certifies:** T7-4.
* **Expected failures:** exactly T7-4 (its literal-metacharacter arms: `a[1].mdx` matches `a1.mdx` and fails to match the file named `a[1].mdx`; `b{a,c}.mdx` matches `ba.mdx`/`bc.mdx` and not the literal name). T7-5 passes: its patterns carry no bracket or brace characters.

### VIOL-DISC-SYMLINK

* **Scope:** CONF-DISC.
* **Deviation:** Discovery follows symbolic links to existing files: a symbolic link to an existing file, at a workspace-relative path a spec-group glob matches, is discovered as a source (read through the link). Broken links remain ignored, and symbolic links to directories remain untraversed.
* **Certifies:** T7-5.
* **Expected failures:** exactly T7-5 (its file-link arms: a symlinked file matched by a glob is discovered, and workspace-external content behind such a link enters the discovered set). T7-4 passes: its fixtures stage no symbolic links. The broken-link and directory-link restrictions keep the ignored-links and cycle arms conforming, so T7-5 fails by assertion, not by hang.

## Exclusions

Considered against the selection criteria and deliberately left uncertified; each may be revisited under criterion (b) on an empirically demonstrated miss.

* **P-4, P-5, P-6** (hash laws, rename/move purity, baseline replay): a conformer passing their anchor tests requires substantially the whole graph, identity, and baseline engine — a near-complete second product — while the anchors themselves are positive, byte-asserted fixtures whose failure modes are loud, not vacuous.
* **P-7**: its capture half requires policy machinery out of any lean scope; the glob half's staging hazard is certified through CONF-DISC on T7-4.
* **P-8, P-9, P-10**: P-8 sweeps every command, exceeding any narrow conformer scope; P-9 asserts consistency invariants anchored by the deterministic 10.x fixtures; P-10's single-mutator schedules and kill accounting admit no deviation with an unambiguous expected-failure set — its reader half shares T13.5-5's polling machinery, certified via VIOL-CORE-PARTIALWRITE, and its seam choreography is certified via the CONF-CORE lock violators.
* **Section 4 consumer-side and type-level tests**: their vacuous-pass hazard lives in the TypeScript tooling driver, which S-4 self-tests against a known non-xspec fixture; a conformer would need the full generated-module contract (skeleton, branding, documentation, navigation).
* **T10.1-4 session-corruption arms**: the per-arm precision hazard is real, but the recorded-creation-parameters arm requires a baseline or coverage session, dragging git or coverage machinery into an otherwise lean scope.
* **The remaining negative matrices (2.4, 2.7, 4.x imports and markers, 6.4/6.5 refusals, 7.x configuration validation, 12.0 usage errors)** and the remaining absence-of-effect sweeps (T12.0-11, T12.1-4, T13.3-3): they share the double-invalidity and compare-around structures certified representatively through CONF-VALID and VIOL-CORE-CHATTYREADS; certifying each would be completeness, which this document must not pursue.
