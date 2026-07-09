# xspec Specification

xspec is a requirement-traceability tool for specifications written in MDX.

An xspec source file is an MDX document in which requirement sections are marked with `<S>` or `<Spec>` tags. xspec compiles these documents into strongly typed TypeScript modules and optional pure Markdown output, and builds a project-wide dependency graph. The graph is used to validate references and structure, enforce dependency policy, measure coverage, analyze the impact of changes, manage staged review work, and answer ad-hoc queries.

xspec is organized as three layers. Each layer depends only on the layers beneath it.

```txt
1  sections, embedding, Markdown compilation
2  workspace graph, generated TypeScript modules, code references
3  coverage, policy, impact, review, query
```

The complete interface to xspec consists of: the `xspec` command-line executable, the `xspec.config.ts` project configuration, the source-file syntax, the generated TypeScript modules, and the files xspec writes to the workspace. Every behavior in this specification is observable through these surfaces.

xspec performs no network access. xspec reads git data only where explicitly stated and never performs git write operations.

## 1. Core Concepts

### 1.1 Requirement section

A requirement section is a part of an MDX document wrapped in `<S>` or `<Spec>`. The two tag names are equivalent; `<S>` is the preferred short form.

```mdx
<S id="login">
The product supports login.
</S>
```

### 1.2 Implicit root

Every xspec source file has an implicit root section. The root section:

* does not have an `id`
* represents the entire document
* is the default export of the generated TypeScript module
* is identified by the source file path alone (1.5)
* is never a coverage target (8.3)

### 1.3 Requirement IDs

Every non-root section MUST have an `id`. IDs are structural paths: a dot indicates nesting, and a child section's ID MUST equal its parent's ID plus `"."` plus exactly one additional segment. A top-level section's ID is exactly one segment. Consequently, every ID level corresponds to an actual section in the document; IDs that skip levels are invalid.

```mdx
<S id="login">
Login behavior.

<S id="login.validCredentials">
A user with valid credentials can log in.
</S>
</S>
```

`<S id="validCredentials">` nested inside `login`, `<S id="login.validCredentials">` nested inside `account`, and a top-level `<S id="auth.login">` (when no `auth` section encloses it) are all invalid.

IDs MUST be unique within a source file.

### 1.4 ID segments and tags

Each ID segment:

* MUST be non-empty
* MUST NOT contain `"."`
* MUST NOT contain control characters or whitespace
* MUST NOT be `"$"`, `"__proto__"`, `"prototype"`, `"constructor"`, or `"then"`

Identifier-friendly camelCase segments are recommended for clean TypeScript property access, but no naming style is enforced beyond the rules above. Segments that are not valid TypeScript identifiers are accessed with bracket notation in generated modules.

A tag (3.8) follows the same rules as an ID segment, except that tags MAY contain `"."`.

### 1.5 Node identity

A requirement node is identified by its source file path plus its requirement ID, written `path#id`. The root node of a file is identified by the path alone. File paths in identities, outputs, and stored data are always workspace-relative.

### 1.6 Own text and subtree text

Every requirement node has two text values:

* own text: the node's compiled Markdown content, excluding nested section subtrees
* subtree text: the node's own text plus the subtree text of its children, in document order

`text(...)` always returns subtree text. This distinction drives hashing (5.5) and change categories (5.6).

## 2. Source Syntax

### 2.1 Imports

xspec source files import nothing from xspec; `<S>`, `<Spec>`, and `text` are provided by the compiler. The only imports permitted in an xspec source file are other spec modules:

```mdx
import BASE from "./BASE.xspec"
```

Import cycles among spec source files are invalid, even when no requirement-level dependency cycle exists.

### 2.2 Dependency prop

The `d` prop declares that one requirement depends on another. It accepts a single reference or an array, where each reference is either a static property chain rooted at an imported spec module (external form) or a string literal naming an ID in the same file (local form). The two forms MAY be mixed in one array.

```mdx
<S id="derived" d={[BASE.auth.login, "local.requirement"]}>
Derived behavior.
</S>
```

The `d` prop records a `depends` edge, does not render into Markdown output, and does not imply semantic correctness. It is interpreted by the graph, policy, coverage, impact, and review features.

### 2.3 Embedding requirement text

`{text(...)}` embeds the target's subtree text into the compiled Markdown output and records an `embeds` edge from the containing section to the target. The argument follows the same external/local duality as `d`: node form for imported modules, string form for local IDs.

```mdx
<S id="summary">
As specified:

{text(BASE.auth.login)}
{text("local.requirement")}
</S>
```

### 2.4 Static argument rule

The argument to `text(...)` and every reference in `d` MUST be a static string literal or a static property chain rooted at an imported spec module. Dynamic expressions are invalid (14.8).

### 2.5 Coverage attribute

By default, every non-root requirement node is coverage-required. A node can be excluded:

```mdx
<S id="metadata.author" coverage="none">
Authored by the project owner.
</S>
```

The only defined values are `required` (default) and `none`. `coverage="none"` means the node is ignored as a target in coverage profiles; it can still be depended on, still appears in impact reports, and its descendants retain their own coverage behavior.

### 2.6 Tags

The `tags` prop attaches labels to a requirement node:

```mdx
<S id="auth.lockout" tags="negative temporal">
Repeated failed logins lock the account.
</S>
```

`tags` is a space-separated list. Duplicate tags collapse. Tags are recorded in the graph, do not render into Markdown output, are not inherited by descendants, and are usable in coverage target filters (7.4) and policy selectors (7.5).

## 3. Markdown Compilation

When enabled (7.3), each source file compiles to a pure Markdown file. The output:

* removes spec module imports
* removes `<S>` / `<Spec>` tags
* removes xspec-only props (`d`, `coverage`, `tags`)
* replaces each `text(...)` expression with the target's compiled subtree text, fully expanded
* preserves all other Markdown content and author whitespace

`<S>` and `<Spec>` are transparent annotations: they divide the source into requirement nodes but are not rendered as visible markup. Authors are responsible for normal Markdown spacing; for example, `<S id="a">Example:</S><S id="b">1. A</S>` strips to `Example:1. A`.

## 4. Generated TypeScript Modules

For each source file `NAME.mdx`, xspec generates a TypeScript module imported as:

```ts
import SPEC, { text } from "./NAME.xspec"
```

The generated module MUST begin with a header identifying it as generated by xspec from its source file. Manual edits to generated files are invalid; staleness is detected by `xspec check` (14.10).

### 4.1 Node skeleton

The default export is the root node. Each node exposes its child sections as readonly properties named by ID segment, carries no requirement text as values, and is an opaque token: the only supported operations are child property access and passing the node to `text()`. A missing requirement path is a TypeScript type error against the generated module.

### 4.2 Documentation and navigation

Every generated node MUST carry a documentation comment containing the node's own text, truncated at a deterministic limit, so editors show hover documentation. The generated module MUST include declaration maps such that go-to-definition on a node reference resolves to the corresponding `<S>` section in the source `.mdx` file.

### 4.3 text

`text(node)` returns the node's subtree text as a `string` and records an `embeds` edge from the calling code location to the node. Requirement text is reachable at runtime only through the `text` export: a consumer that never imports `text` obtains no requirement text from the module.

The string form of `text(...)` is MDX-only; TypeScript usage is always the node form.

### 4.4 Module branding

Node types are branded per generated module. Passing a node from one module to the `text` export of another is a TypeScript type error, and at runtime MUST throw an error identifying both the node's module and the called module. When consuming multiple spec modules in one file, the `text` exports are aliased on import.

### 4.5 Dependency markers

In TypeScript files, a bare requirement reference as an expression statement is a dependency marker:

```ts
function printHello() {
  SPEC.print.hello
  console.log("Hello")
}
```

A marker records a `references` edge from the enclosing code location to the node. At runtime, an unstripped marker is a harmless property read; markers MUST be valid with no additional tooling installed. A bare reference to the root node records a `references` edge to the root node only; because roots are never coverage targets, a root marker grants no coverage, but it makes the code location impacted by any change in the document (9.3).

### 4.6 Code location attribution

xspec attributes a TypeScript reference to the nearest enclosing named code unit when one can be identified, and otherwise to the file.

## 5. Workspace Graph

xspec builds a project-wide graph from the configured spec and code groups.

### 5.1 Node kinds

The graph contains requirement nodes and code locations.

### 5.2 Edge kinds

* `contains`: parent section → child section (document structure)
* `depends`: declared by the `d` prop
* `embeds`: created by `{text(...)}` in MDX and `text(...)` in TypeScript
* `references`: created by a bare TypeScript reference

`depends`, `embeds`, and `references` are the dependency edge kinds; an edge of these kinds means the source depends on the target. `contains` is structural. Each feature states which kinds it interprets.

### 5.3 Cycles

Dependency-edge cycles are invalid. `xspec check` MUST detect and report cycles in the combined graph of `contains`, `depends`, and `embeds` edges over requirement nodes, including the full cycle path. In particular, a section MUST NOT depend on or embed its own ancestor, because text expansion and effectiveHash recurse through both children and dependency targets.

### 5.4 Reference canonicalization

For hashing and identity purposes, every reference (`d` targets, `text(...)` targets) is treated as its target's canonical identity, resolved through the journal (6). Reference spellings never enter any hash.

### 5.5 Hashes

Each requirement node has four hashes, all deterministic for identical input:

* ownHash: hash of the node's own text, with each embedded `text(...)` expression hashed as its target's canonical identity rather than its expanded text
* subtreeHash: hash of (ownHash, child subtreeHashes in document order)
* effectiveHash: hash of (ownHash, child effectiveHashes in document order, sorted effectiveHashes of the node's dependency-edge targets)
* metadataHash: hash of (the node's direct dependency target set as sorted canonical identities, its coverage attribute, its sorted tags)

Properties: subtreeHash changes if and only if an edit occurred somewhere in the node's subtree text; effectiveHash additionally changes when any transitive dependency target changes; metadataHash changes if and only if the node's own dependency declarations, coverage attribute, or tags change. Editing an embedded target therefore surfaces at the embedding node as `upstream-changed`, not `changed`, while `text(...)` output remains fully expanded.

### 5.6 Change categories

Relative to a baseline, each requirement node receives zero or more categories:

* changed: the node was added or deleted, or its ownHash changed
* metadata-changed: the node's metadataHash changed
* descendant-changed: the node's subtreeHash changed because of a change in a descendant
* upstream-changed: the node's effectiveHash changed because of a change in a dependency target

Categories are independent flags; a node MAY carry several. Every category MUST be attributed to its originating changed nodes. For a single edit to a leaf: the leaf is `changed`; every ancestor is `descendant-changed` attributed to the leaf; sibling subtrees receive no category; dependents of any node on that path are `upstream-changed`.

## 6. Identity Continuity

### 6.1 The journal

xspec maintains a journal at `.xspec/journal`: a plain-text, append-only file with one entry per line, where each entry is a self-contained record of a rename or move operation and the identity mapping it produced. The journal is written only by `xspec rename` and `xspec move`. It is a durable record, not derived state (13.4): it cannot be regenerated from source and MUST never be modified or deleted by other commands.

### 6.2 Identity guarantee

A pure rename or move — one that changes only identities and reference spellings — MUST produce no change categories and no hash changes anywhere in the workspace, relative to any baseline, because references hash by journal-resolved canonical identity (5.4).

### 6.3 Baseline resolution

When a command takes a baseline git ref, the baseline graph is reconstructed from the workspace content at that ref. The journal entries present in the current journal but absent from the journal content at the baseline ref are applied, in file order, to map baseline identities to current identities; chained mappings compose. Git history itself provides the ordering; journal entries contain no timestamps. If replay produces an ambiguous or unresolvable mapping, the command MUST fail with an actionable error naming the offending entries.

### 6.4 Rename

```sh
xspec rename <file> <old-id> <new-id>
```

Renames a requirement ID, rewrites descendant IDs by prefix replacement, rewrites every reference to the affected identities across all configured spec and code sources (`id` attributes, `d` references, `text(...)` references, TypeScript markers), and appends the mapping to the journal. Validation MUST confirm: the old ID exists; the new ID is valid; the new ID collides with no existing ID; structural parent rules remain satisfied; all rewritten references resolve.

### 6.5 Move

```sh
xspec move <old-file> <new-file>
xspec move <file>#<id> <target-file>#<new-id>
```

The first form relocates an entire source file; IDs are unchanged and every node's identity changes only in its file part. The second form extracts a section subtree: the section and its descendants are removed from the origin, inserted as the last child of the target parent (or at the end of the file for a top-level `new-id`), and re-identified by prefix replacement of `<id>` with `<new-id>`. The target file is created if absent. In both forms, all references across the workspace are rewritten to resolve to the new identities, converting between local and imported forms and adding or removing spec module imports as needed, and the full mapping is appended to the journal.

Move validation mirrors rename validation and additionally MUST refuse any move that would create an import cycle among spec source files or a dependency cycle.

### 6.6 Manual restructuring

Renames or moves performed by editing files directly, without the commands, produce no journal entries and are treated as deletions plus additions.

## 7. Project Configuration

xspec projects are configured by `xspec.config.ts`, a TypeScript module whose default export is produced by `defineConfig`:

```ts
import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    product: ["specs/product/**/*.mdx"],
    tests: ["specs/tests/**/*.mdx"]
  },
  code: {
    app: ["src/**/*.ts", "src/**/*.tsx"],
    tests: ["test/**/*.ts", "test/**/*.tsx"]
  },
  markdown: { emit: true },
  coverage: [
    {
      name: "product-tested",
      target: "product",
      boundary: "tests",
      mode: "direct"
    }
  ],
  policy: [
    {
      name: "product-depends-on-nothing",
      type: "forbidden",
      from: { group: "product" },
      to: { group: "tests" }
    }
  ]
})
```

Every command locates the configuration by upward search for `xspec.config.ts` from the working directory, or uses the path given by the global `--config <path>` option. All configured paths and globs resolve relative to the configuration file's directory, which is the workspace root. Discovery of source files is controlled exclusively by configuration; imports resolve references between files but never add files to the workspace.

### 7.1 `specs`

Named groups of xspec source files, each a list of globs. A file MAY belong to multiple groups.

### 7.2 `code`

Named groups of TypeScript source files, each a list of globs. Code groups serve as coverage boundaries and as the population for impacted-code reporting.

### 7.3 `markdown`

`markdown.emit` (boolean) controls whether pure Markdown files are emitted. `markdown.outDir` (optional path) redirects emitted files into a directory, preserving workspace-relative paths; the default emits next to each source file.

### 7.4 `coverage`

Named coverage profiles. Each profile has:

* `name`: unique profile name
* `target`: spec group whose requirements must be covered
* `targetTags`: optional list of tags; when present, the target set is restricted to nodes carrying at least one listed tag
* `targets`: `"leaves"` (default) or `"all"`; `"leaves"` restricts the target set to nodes with no children
* `boundary`: spec or code group that counts as the coverage boundary
* `boundaryKind`: `"spec"` or `"code"`; MUST be inferred when the group name is unambiguous and MUST be required when ambiguous
* `mode`: `"direct"` or `"transitive"`
* `edgeKinds`: optional subset of `["depends", "embeds", "references"]`; defaults to all three

### 7.5 `policy`

Named policy rules constraining which dependency edges may exist. Each rule has:

* `name`: unique rule name
* `type`: `"forbidden"` or `"allowedOnly"`
* `from`, `to`: selectors
* `kinds`: optional subset of the dependency edge kinds; defaults to all three

A selector matches nodes (or code locations) by exactly one of: `{ group: <name> }`, `{ files: <glob> }`, or `{ tags: [<tag>, ...] }` (at least one listed tag). In `files` selectors, the `from` pattern MAY contain capture wildcards `$1`…`$9`, each matching a single path segment or name fragment, and the `to` pattern MAY reference them; a `to` containing captures matches only targets whose expansion agrees with the captured values.

Semantics, evaluated over dependency edges of the rule's kinds:

* `forbidden`: any edge whose source matches `from` and whose target matches `to` is a violation.
* `allowedOnly`: every edge whose source matches `from` MUST have a target matching `to`; each edge that does not is a violation.

Violations are reported by `xspec check` with the rule name and the offending edge, and cause exit code 1.

## 8. Coverage

Coverage is graph reachability over dependency edges, not proof of semantic correctness. A target requirement is covered for a profile when a permitted path exists from a boundary node to it: in `direct` mode a single edge, in `transitive` mode a path of one or more edges, using only the profile's `edgeKinds`. `contains` edges never grant coverage and never appear in coverage paths.

### 8.1 Required set

A profile's required nodes are the nodes of the `target` group, restricted by `targetTags` when present and to leaves when `targets` is `"leaves"`, excluding nodes marked `coverage="none"` and always excluding root nodes.

### 8.2 Output

`xspec coverage` runs all profiles; `xspec coverage <name>` runs one. The report includes: counts of required, covered, uncovered, and ignored nodes; the identity of every covered, uncovered, and ignored node; and for each covered node at least one covering path. With `--check`, the command exits 1 if any required node is uncovered. JSON output MUST be available and MUST contain the same information.

## 9. Impact Analysis

```sh
xspec impact --base <git-ref>
```

Impact compares the current workspace graph against the baseline graph reconstructed at the given git ref, with identities mapped through the journal (6.3).

### 9.1 Requirement impact

Requirement-level impact is the change categories of 5.6, each attributed to its originating nodes.

### 9.2 Impacted code

* directly impacted: the code location has a `references` or `embeds` edge to a node whose subtreeHash changed
* transitively impacted: the code location has a `references` or `embeds` edge to a node whose effectiveHash changed but whose subtreeHash did not

### 9.3 Output

Output is grouped by category, with ancestor chains collapsed alongside their attribution, followed by directly and transitively impacted code with the edge and path that make each impacted. `impact` is informational: it exits 0 whether or not differences exist. JSON output MUST be available.

## 10. Review

Review turns graph results into a staged checklist. xspec separates the review mechanism (sessions, items, statuses, blocking, invalidation — defined here) from review strategies (the functions that derive items from graph results). Two built-in strategies exist: `path-blocks` and `audit`.

### 10.1 Sessions

A review session is stored at `.xspec/reviews/<session-name>.json` as a plain, deterministic file. A session is a durable task ledger for a specific graph state (13.4), not a source of requirement identity.

### 10.2 Items

A review item contains: `id` (unique within the session), `kind` (assigned by the strategy), `scope` (the requirement nodes or code locations under review), `context` (nodes whose text frames the review), `reason`, `origin` (the originating changed nodes, when applicable), `baseline` and `current` (the relevant hashes), `status`, optional `note`, and `blockedBy` (item IDs that must resolve first). Items MUST carry enough baseline identity and baseline text that they remain actionable after the referenced nodes are edited, moved, or deleted.

### 10.3 Statuses

* `unresolved`: still needs review
* `updated`: reviewed; source was changed
* `no-change`: reviewed; intentionally left unchanged
* `skipped`: intentionally deferred or ignored
* `invalidated`: previously resolved, but relevant state changed afterward

### 10.4 Relevant hashes and invalidation

The relevant hashes per built-in item kind are:

* `subtree-coherence`: subtreeHash and metadataHash of each scope node
* `parent-consistency`: ownHash and metadataHash of the scope node; subtreeHash of each context branch
* `dependency-consistency`: ownHash and metadataHash of the scope node; subtreeHash of each upstream target in context
* `metadata-consistency`: metadataHash of the scope node
* `code-impact`: subtreeHash and effectiveHash of each node the scoped code location references or embeds
* `uncovered-requirement`: subtreeHash and metadataHash of the scope node

A resolved item becomes `invalidated` when any relevant hash differs from the value recorded at resolution, or when any scope, context, or origin node is deleted or its identity ceases to resolve through the journal. Items added during a session follow the same rule. Item validity is recomputed against the current graph whenever a session is read (`status`, `next`, `show`, `export`); a stale resolution is never reported as resolved and a stale item is never served by `next`.

### 10.5 Built-in strategy: path-blocks

`path-blocks` is the default strategy for baseline-based sessions. For each `changed` node N, skipping nodes that have a `changed` ancestor:

1. one `subtree-coherence` item — scope: N and all descendants, reviewed as a single block
2. one `parent-consistency` item per ancestor A on the path to the root — scope: A's own text; context: the changed branches beneath A; when multiple changed nodes share A, A receives a single item against the union of changed branches, and its `blockedBy` is the set of items directly beneath it across all of those branches

For metadata and dependency impact:

1. one `metadata-consistency` item per `metadata-changed` node — context: the added and removed dependency targets and changed attributes
2. one `dependency-consistency` item per `upstream-changed` node — context: its changed upstream targets
3. one `code-impact` item per impacted code location

Ordering is deepest first; a `parent-consistency` item is blocked until every item beneath it resolves. When an item resolves with status `updated`, `path-blocks` derives new items for the resulting edits, including a `subtree-coherence` item for any node whose own text changed; this is the only path through which sibling subtrees enter a session.

### 10.6 Built-in strategy: audit

`audit` creates one `subtree-coherence` item per requirement node, in document order, with the node's ancestor chain as context. It requires no baseline and reviews the entire workspace.

### 10.7 Commands

```sh
xspec review create --base <ref> --name <name>            # path-blocks
xspec review create --strategy audit --name <name>
xspec review create --coverage <profile> --name <name>    # one uncovered-requirement item per uncovered node
xspec review list
xspec review status <name>
xspec review next <name> [--json]
xspec review show <name> <item-id>
xspec review split <name> <item-id>
xspec review resolve <name> <item-id> --status <status> [--note <text>]
xspec review export <name> --json
```

`next` returns the first unresolved, unblocked, valid item. With `--json`, the payload MUST be self-contained: scope text, context text, origin before/after text, source ranges, and hashes, so the item can be acted on without further reads.

`split` decomposes a `subtree-coherence` item into one `subtree-coherence` item per child plus one own-text item for the node itself. The new items inherit the original's incoming blocks; every item that was blocked by the original becomes blocked by all of the new items; the original item is closed.

`resolve` sets the status and records the current relevant hashes.

## 11. Query

`xspec query` gives scripts and agents set-level, JSON-only access to the graph:

```sh
xspec query node <path#id>
xspec query nodes [--group <g>] [--file <glob>] [--tag <t>] [--coverage required|none]
xspec query edges [--from <path#id>] [--to <path#id>] [--kind <kind>]
xspec query subtree <path#id>
xspec query ancestors <path#id>
xspec query reachable --from <path#id> --to <path#id> [--kinds <kinds>]
```

`node` returns identity, source range, own and subtree text, all four hashes, tags, coverage attribute, and incoming and outgoing edges by kind. `nodes` filters combine conjunctively. `reachable` reports whether a dependency path exists under the given kinds and, when one does, one shortest witness path. All results use stable, deterministic ordering.

## 12. Commands

### 12.0 Global conventions

* Every command supports `--json`, emitting a single JSON document. Where this specification defines report content, the JSON form MUST contain the same information.
* Every command supports `--config <path>` (7).
* All output, generated files, and stored data are byte-deterministic for identical input: no wall-clock values, no randomness, no absolute paths, no environment-dependent content.
* Exit codes: `0` — success, including informational findings (`ids`, `show`, `impact`, `query`, `coverage` without `--check`); `1` — validation failures and check-mode findings (`build` on invalid sources, `check`, `coverage --check`, refused `rename`/`move`); `2` — usage or configuration errors (unknown commands, flags, profiles, sessions, or groups; missing or invalid configuration; a baseline ref that cannot be read).

### 12.1 `xspec build`

Parses configured sources; validates section structure, IDs, tags, and references; resolves dependencies; generates TypeScript modules and declaration maps; optionally emits Markdown; and writes graph data. Rebuilding regenerates every derived file (13.4).

### 12.2 `xspec check`

Performs all build validations without accepting stale outputs, and additionally verifies: generated files are up to date with their sources; all dependency and text references resolve and are static; all TypeScript spec references resolve; no dependency cycles and no spec import cycles exist; the journal is well-formed and replayable with no conflicting mappings; configured coverage profiles and policy rules are valid; no policy violations exist; review sessions are not internally corrupt. Exits 1 on any finding.

### 12.3 `xspec ids`

Lists requirement IDs grouped by file. Supports `--tree`, `--file <path>`, `--json`, and `--unreferenced`, which lists requirement nodes with no incoming dependency edges from specs or code (`contains` does not count). Unreferenced is not the same as uncovered: a node may be referenced yet uncovered by a given profile.

### 12.4 `xspec show`

```sh
xspec show <path#id>
```

Prints one requirement for human reading: ID, source range, own and subtree text, hashes, and edges by kind. `query node` is the machine-facing equivalent.

### 12.5 `xspec coverage`, `xspec impact`, `xspec review`, `xspec query`, `xspec rename`, `xspec move`

As specified in sections 8, 9, 10, 11, and 6.

## 13. Workspace Files

### 13.1 Generated TypeScript

`NAME.mdx` generates `NAME.xspec.ts` plus declaration maps, with a generated-file header (4).

### 13.2 Markdown output

`NAME.mdx` emits `NAME.md` when enabled, pure Markdown with xspec annotations removed and embedded text resolved (3), placed per `markdown.outDir` (7.3).

### 13.3 Graph data

xspec maintains graph data under `.xspec/`, containing requirement nodes, code locations, edges by kind, source ranges, all four hashes, coverage attributes, and tags. Graph data serves `check`, `ids`, `show`, `coverage`, `impact`, `review`, and `query`.

### 13.4 Derived and durable files

Every file xspec writes is a plain file suitable for committing, written with stable ordering and sorted keys. Files are classified:

* Derived: generated TypeScript modules, declaration maps, emitted Markdown, and graph data. Derived files are fully reproducible from sources and configuration via `xspec build`; a conflicted, corrupted, or deleted derived file is correctly resolved by rebuilding.
* Durable: the journal (6.1) and review sessions (10.1). Durable files record operations and resolutions; they are not reproducible, are never regenerated, and MUST NOT be modified except by their owning commands. They are line-oriented or stably keyed so that concurrent additions merge textually; `xspec check` validates their integrity and reports unresolvable states.

### 13.5 Concurrency and isolation

All state is workspace-local; instances operating on different workspaces MUST NOT interfere with each other. Within one workspace, every file write is atomic (a complete file appears or the old content remains); concurrent commands may interleave with last-write-wins per file, and any resulting derived-file inconsistency is resolved by rerunning `xspec build`.

## 14. Validation Errors

`xspec build` and `xspec check` MUST report actionable errors that identify the file, location, and correction. The defined error conditions:

1. Missing ID: a non-root section without `id`.
2. Invalid structural ID: a child ID that does not equal the parent ID plus one segment, including IDs that skip levels; the error states the expected form.
3. Duplicate ID within a file.
4. Invalid segment or tag: violation of 1.4.
5. Unknown dependency: a `d` reference that does not resolve.
6. Unknown text target: a `text(...)` reference that does not resolve.
7. Unknown TypeScript reference: a marker or `text` call that does not resolve; this is also a type error against the generated module.
8. Non-static argument: a dynamic `d` or `text(...)` argument.
9. Cycle: a dependency cycle (with the full path) or a spec import cycle.
10. Stale generated output: a generated file older than its source; the error names the file and instructs rebuilding.
11. Cross-module text call: reported at runtime per 4.4 and as a type error.
12. Policy violation: rule name plus offending edge.
13. Journal error: malformed, conflicting, or unreplayable entries, naming the lines.
14. Configuration error: unknown groups, ambiguous `boundaryKind`, invalid profile or rule shapes, unknown names passed to commands.

## 15. Example

```mdx
// specs/SPEC.mdx
<S id="print">
Print behavior.

<S id="print.hello" tags="critical">
Print hello.
</S>
</S>
```

```mdx
// specs/DERIVED.mdx
import SPEC from "./SPEC.xspec"

<S id="derived">
Derived behavior.

<S id="derived.hello" d={SPEC.print.hello}>
Derived hello behavior.
</S>
</S>
```

```ts
// src/hello.ts
import DERIVED from "../specs/DERIVED.xspec"

export function hello() {
  DERIVED.derived.hello
  console.log("Hello")
}
```

Graph:

```txt
specs/SPEC.mdx#print            contains    specs/SPEC.mdx#print.hello
specs/DERIVED.mdx#derived       contains    specs/DERIVED.mdx#derived.hello
specs/DERIVED.mdx#derived.hello depends     specs/SPEC.mdx#print.hello
src/hello.ts#hello              references  specs/DERIVED.mdx#derived.hello
```

The path `hello → derived.hello → print.hello` satisfies a transitive coverage profile targeting `print.hello`. If the text of `print.hello` is edited: `print.hello` is `changed`; `print` and the SPEC root are `descendant-changed` via `print.hello`; `derived.hello` and `derived` are `upstream-changed`; `hello.ts#hello` is transitively impacted. A default `path-blocks` session for this change contains a `subtree-coherence` item for `print.hello`, a `parent-consistency` item for `print` blocked by it, a `dependency-consistency` item for `derived.hello`, and a `code-impact` item for `hello.ts#hello`. If `print.hello` is instead renamed with `xspec rename`, the journal records the mapping and an impact run against the pre-rename baseline reports no changes.
