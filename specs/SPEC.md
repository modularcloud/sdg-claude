# xspec Specification

xspec is a requirement-traceability tool for specifications written in MDX.

An xspec source file is an MDX document in which requirement sections are marked with `<S>` or `<Spec>` tags. xspec compiles these documents into strongly typed TypeScript modules and optional pure Markdown output, and builds a project-wide dependency graph. The graph is used to validate references and structure, enforce dependency policy, measure coverage, analyze the impact of changes, manage staged review work, and answer ad-hoc queries.

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
* is never a coverage target (8.1)

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
* MUST NOT contain `"#"`
* MUST NOT contain control characters or whitespace
* MUST NOT be `"$"`, `"__proto__"`, `"prototype"`, `"constructor"`, or `"then"`

Here and throughout this specification, whitespace means exactly the characters U+0009 (tab), U+000A (line feed), U+000B (vertical tab), U+000C (form feed), U+000D (carriage return), and U+0020 (space), and control characters means exactly U+0000–U+001F and U+007F; no other code point (U+00A0, U+0085, and U+2028 included) belongs to either class. Tag splitting (2.6) and line dropping (3) use these same definitions.

Identifier-friendly camelCase segments are recommended for clean TypeScript property access, but no naming style is enforced beyond the rules above. Segments that are not valid TypeScript identifiers are accessed with bracket notation (2.4) in generated modules.

A tag (2.6) follows the same rules as an ID segment, except that tags MAY contain `"."`.

### 1.5 Node identity

A requirement node is identified by its source file path plus its requirement ID, written `path#id`. The root node of a file is identified by the path alone. File paths in identities, outputs, and stored data are always workspace-relative and always use `/` as the path separator, on every platform. A discovered source file whose path contains `#` is invalid (14.19), so the `#` in an identity is unambiguous.

### 1.6 Own text, subtree text, and own content

Every requirement node has two text values, defined by the removal and replacement rules of Markdown compilation (3), which apply whether or not Markdown emission is enabled:

* subtree text: the section construct's contribution to its file's compiled Markdown output (for the root, the entire output). Each child contributes its subtree text at the position it occupies in the source — interleaved with the node's own contribution in document order, not appended after it.
* own text: the node's subtree text with every child's contribution excised: the runs that child constructs divide (its own-text runs), joined exactly at the excision points. N child constructs divide a node's contribution into exactly N + 1 runs in document order — one before the first child construct, one between each adjacent pair, one after the last. A run MAY be empty, and empty runs count, both here and in hashing (5.5).

Both text values are exact bytes; the rules of 3 leave no joining or separator choices, and `text(...)` replacement is one of them, so both values carry embedded text fully expanded. Every own or subtree text this specification outputs — documentation comments (4.2), review text payloads (10.2, 10.7), `query` (11), `show` (12.4) — is this expanded value, and `text(...)` always returns subtree text.

Hashing does not use the expanded values. For hashing (5.5), a node has an own content sequence, computed like its own-text runs but with `text(...)` replacement suspended: each `text(...)` expression is excised like a child construct — contributing no bytes and marking an excision point where its target node enters — rather than replaced by expanded text. For the line-drop rule of 3, the excised expression counts as remaining line content, so the empty-expansion drop never applies; all other removal rules of 3 apply unchanged. Own content thus alternates byte runs (empty runs included) with node references — the excised child at each child excision point, the target at each embedding excision point, the two kinds distinguished — and an embedded target's text is no part of the embedder's own content. This distinction drives hashing (5.5) and change categories (5.6).

Source files are UTF-8: a discovered spec or code source that is not valid UTF-8 or that begins with a byte-order mark is unparseable (14.20). Text values are the decoded content, and code-point counts (4.2) count Unicode code points of it.

## 2. Source Syntax

### 2.1 Imports

xspec source files import nothing from xspec; `<S>`, `<Spec>`, and `text` are provided by the compiler. The only imports permitted in an xspec source file are other spec modules:

```mdx
import BASE from "./BASE.xspec"
```

An import specifier MUST be a relative path beginning with `./` or `../` and ending in `.xspec`, resolved against the importing file's directory; `DIR/NAME.xspec` designates the source file `DIR/NAME.mdx`. The designated file MUST be a discovered source file of a configured spec group (7.1); any other specifier or target is invalid (14.15). The only permitted import form is a single default binding, as above; named, namespace, and side-effect-only imports are invalid (14.15). Multiple imports MAY bind the same module under different names, but no two imports in a file may bind the same identifier, and no import in an xspec source file may bind the identifier `S`, `Spec`, or `text` — the compiler-provided names are never shadowed, so construct recognition is never ambiguous (14.15); an import whose binding is never used is valid and records no edges. Import cycles among spec source files are invalid, even when no requirement-level dependency cycle exists; a file that imports itself is an import cycle of length one.

### 2.2 Dependency prop

The `d` prop declares that one requirement depends on another. It accepts a single reference or an array literal of references, where each reference is either a static property chain rooted at an imported spec module (external form) or a static string literal naming an ID in the same file (local form). The two forms MAY be mixed in one array. An external reference MAY also be the imported module itself, with no property segments, targeting that file's root node. Duplicate references to one target in a single `d` array collapse to a single edge. An empty array (`d={[]}`) declares no dependencies and is equivalent to omitting the prop.

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

The argument to `text(...)` and every reference in `d` MUST be a static string literal or a static property chain rooted at an imported spec module. A static string literal is a plain single- or double-quoted string; template literals are not static. A static property chain is the module's import binding followed by zero or more segments, each either a non-computed property access whose name is an identifier (`.login`) or a computed access whose index is a static string literal (`["login-v2"]`) — the form by which segments that are not TypeScript identifiers are referenced (1.4). No other syntax participates in a chain: optional chaining, non-null assertions, parentheses, and any other index or expression form make the reference dynamic. A `text(...)` call MUST have exactly one argument. Dynamic references and `text(...)` calls of any other arity are invalid (14.8).

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

`tags` is a whitespace-separated list: tags are split on runs of whitespace (1.4), and leading and trailing whitespace is ignored. Duplicate tags collapse. A `tags` value that yields no tags (empty or whitespace-only) is equivalent to omitting the prop. Tags are recorded in the graph, do not render into Markdown output, are not inherited by descendants, and are usable in coverage target filters (7.4) and policy selectors (7.5).

### 2.7 Permitted constructs

Beyond standard Markdown content, an xspec source file may contain only spec module imports (2.1), `<S>`/`<Spec>` sections, `{text(...)}` embeddings, and MDX comments (`{/* … */}`). Any other JSX element, any other expression container, and any export statement are invalid (14.16). Comments are pure annotations: they do not enter own text or any hash, and Markdown output removes them (3). The props defined on `<S>`/`<Spec>` are `id`, `d`, `coverage`, and `tags`; no prop name may occur more than once on one element — a repeated prop, defined or unknown, is invalid (14.17). The value of `id`, `coverage`, and `tags` MUST be a static string literal in quoted attribute form (as in `id="login"`); any other value form — a braced expression such as `id={"login"}` included — is invalid (14.17). The value of `d` MUST be a braced expression (as in `d={BASE.auth.login}`) holding a single static reference or an array literal of static references (2.2, 2.4); a quoted or valueless `d` is invalid (14.17), and a braced `d` value that is not such a reference or array literal is a dynamic argument (14.8). Unknown props, and `coverage` values other than `required` and `none`, are invalid (14.17).

## 3. Markdown Compilation

When enabled (7.3), each source file compiles to a pure Markdown file. The output:

* removes spec module imports
* removes `<S>` / `<Spec>` tags together with their props (`id`, `d`, `coverage`, `tags`)
* removes MDX comments
* replaces each `text(...)` expression with the target's compiled subtree text, fully expanded
* preserves all other Markdown content and author whitespace

Removal is exact textual deletion of the construct's own characters, in place. A line terminator is the sequence U+000D U+000A (one terminator), a U+000A not preceded by U+000D, or a U+000D not followed by U+000A; a line is a maximal terminator-free run of characters plus the terminator that ends it, and the final line MAY have no terminator. A line that contained non-whitespace (1.4) in the source but is left empty or whitespace-only purely by removals (or by a `text(...)` replacement whose expansion is empty) is dropped together with its line terminator, if any; every other line keeps its remaining content and terminator. `<S>` and `<Spec>` are transparent annotations: they divide the source into requirement nodes but are not rendered as visible markup. Authors are responsible for normal Markdown spacing around in-line tags; for example, `<S id="a">Example:</S><S id="b">1. A</S>` strips to `Example:1. A`.

## 4. Generated TypeScript Modules

For each source file `NAME.mdx`, xspec generates a TypeScript module imported as:

```ts
import SPEC, { text } from "./NAME.xspec"
```

In a TypeScript file, an import declaration is a spec module import exactly when its specifier ends in `.xspec`; the specifier follows the same form and resolution as 2.1 and MUST designate a discovered spec source (14.15). The permitted bindings from a spec module are the default export and the named `text` export, each optionally aliased; any other binding is invalid (14.15). A dynamic `import()` whose static specifier ends in `.xspec` is invalid (14.15); one whose specifier is not static is not analyzed and records nothing. An import declaration or static-specifier dynamic `import()` in a code-group file whose relative specifier designates a derived-file path (13.4: a file name containing `.xspec.`, a path under `.xspec/`, or a configured Markdown emit destination) without being a spec module import — e.g. `./NAME.xspec.ts` — is invalid (14.15): derived files are consumed only through their `.xspec` specifier.

The generated module MUST begin with a header identifying it as generated by xspec from its source file. Manual edits to generated files are invalid; staleness is detected by `xspec check` (14.10).

### 4.1 Node skeleton

The default export is the root node. Each node exposes its child sections as readonly properties named by ID segment, carries no requirement text as values, and is an opaque token: the only supported operations are child property access and passing the node to `text()`. A missing requirement path is a TypeScript type error against the generated module.

### 4.2 Documentation and navigation

Every generated node MUST carry a documentation comment containing the node's own text truncated to its first 1000 Unicode code points, with `…` appended when truncation occurred, so editors show hover documentation; each occurrence of the comment-terminating sequence `*/` in the emitted text is written as `*\/`. Go-to-definition on a node reference MUST resolve to the corresponding `<S>` section in the source `.mdx` file.

### 4.3 text

`text(node)` returns the node's subtree text as a `string` and records an `embeds` edge from the calling code location to the node. Requirement text is reachable at runtime only through the `text` export: a consumer that never imports `text` obtains no requirement text from the module.

The string form of `text(...)` is MDX-only; TypeScript usage is always the node form, and a string argument to `text` in a TypeScript file is invalid (14.8).

### 4.4 Module branding

Node types are branded per generated module. Passing a node from one module to the `text` export of another is invalid (14.11): it is a TypeScript type error, and at runtime the call MUST throw an error identifying both the node's module and the called module. When consuming multiple spec modules in one file, the `text` exports are aliased on import.

### 4.5 Dependency markers

In TypeScript files, a bare requirement reference as an expression statement is a dependency marker:

```ts
function printHello() {
  SPEC.print.hello
  console.log("Hello")
}
```

A marker records a `references` edge from the enclosing code location to the node. At runtime, a marker is a harmless property read; markers MUST be valid with no additional tooling installed. A bare reference to the root node records a `references` edge to the root node only; because roots are never coverage targets, a root marker grants no coverage, but it makes the code location impacted by any change in the document (9.2).

A marker and the argument to `text(...)` MUST each be a static property chain (2.4) rooted directly at a spec module import binding; the static argument rule applies in TypeScript equally (14.8). The sanctioned value-level uses are exact: a node — a default-export binding or a chain of child property accesses from it — appears only as a marker or as the sole argument of a call whose callee is a spec module's `text` export, and a `text` binding appears only as such a callee. That call is an ordinary expression, valid in expression-statement position too, where it records its `embeds` edge (4.3) and is not a marker. Any other value-level use of either binding — aliasing, destructuring, re-export, storage in variables or data structures, passing to any other function — is invalid (14.18); passing a node to the `text` export of a different spec module is the cross-module call of 4.4 (14.11). Type-level references are unrestricted and record no edges.

### 4.6 Code locations and attribution

A code location is either a whole file, identified by its workspace-relative path, or a named code unit within a file, identified as `path#unit`, where `unit` is the dot-joined chain of enclosing named-unit names, outermost first (`src/auth.ts#LoginService.validate`).

A named code unit is a construct that statically binds a plain identifier name to executable code: a function declaration; a class declaration; a class member with a non-computed identifier name (a method, getter, setter, or a property whose initializer is a function expression, an arrow function, or a class expression); a variable declaration with a plain identifier name whose initializer is a function expression, an arrow function, or a class expression; a namespace declaration; or a default export, whose name is `default` when the exported construct is anonymous. Constructs that do not statically bind a plain identifier — anonymous or immediately invoked functions, computed or string-literal member names, destructuring bindings — are not named code units.

xspec attributes a TypeScript reference to the innermost enclosing named code unit, and to the file when none encloses it. When the same `unit` chain occurs more than once in a file (a getter/setter pair, same-named declarations in sibling scopes), occurrences after the first are disambiguated with a 1-based document-order suffix: `path#unit@2` identifies the second occurrence.

## 5. Workspace Graph

xspec builds a project-wide graph from the configured spec and code groups.

### 5.1 Node kinds

The graph contains requirement nodes and code locations.

### 5.2 Edge kinds

* `contains`: parent section → child section (document structure)
* `depends`: declared by the `d` prop
* `embeds`: created by `{text(...)}` in MDX and `text(...)` in TypeScript
* `references`: created by a bare TypeScript reference

`depends`, `embeds`, and `references` are the dependency edge kinds; an edge of these kinds means the source depends on the target. `contains` is structural. Edges of each kind form a set: duplicate declarations collapse to a single edge. Each feature states which kinds it interprets.

### 5.3 Cycles

Dependency-edge cycles are invalid. `xspec check` MUST detect and report cycles in the combined graph of `contains`, `depends`, and `embeds` edges over requirement nodes, including the full cycle path. A node that depends on or embeds itself is a dependency cycle of length one. In particular, a section MUST NOT depend on or embed its own ancestor, because text expansion and effectiveHash recurse through both children and dependency targets.

### 5.4 Reference canonicalization

For hashing and identity purposes, every reference (`d` targets, `text(...)` targets) is treated as its target's canonical identity; reference spellings never enter any hash. A node's canonical identity is computed by walking the journal (6) backwards from its newest entry, tracking the node's current identity: an entry that maps another identity to the tracked one extends the chain — the tracked identity becomes that entry's source — while an entry that maps the tracked identity away ends the walk, because that entry vacated the identity and the node now bearing it can only have entered the workspace after it. The canonical identity is the identity the walk ends on, paired with the journal position where it ends — the journal's start when no entry ends it. An identity reintroduced by a new node after leaving the workspace through a journaled rename or move thus starts a new chain: distinct nodes always have distinct canonical identities, and references to them never hash alike. Hash computation therefore takes the journal as an input, and no hash ever changes merely because an identity changed: the pure operations of 6.2 leave every hash unchanged.

### 5.5 Hashes

Each requirement node has four hashes, all deterministic for identical input. Hash inputs are framed so that distinct sequences of components (runs, identities, hashes) never yield the same input:

* ownHash: hash of the node's own content sequence (1.6) — all runs, empty runs included, each referenced node entering as its canonical identity (5.4), child and embedding references distinguished. Because identities enter at their positions, adding, removing, or reordering child sections — byte-identical siblings included — changes the parent's ownHash, as does adding, removing, retargeting, or repositioning an embedded reference, or any edit to the node's own content runs.
* subtreeHash: hash of (ownHash, child subtreeHashes in document order)
* effectiveHash: hash of (ownHash, child effectiveHashes in document order, the node's dependency-edge targets as (canonical identity, effectiveHash) pairs sorted by identity)
* metadataHash: hash of (the node's `d`-declared (`depends`) target set as sorted canonical identities, its coverage attribute, its sorted tags); a root node has no `d` targets, no coverage attribute, and no tags, so its metadataHash is computed from those empty inputs; embedded `text(...)` references are part of own content (1.6) and surface through ownHash, not metadataHash

Properties: subtreeHash changes if and only if a node in the subtree was added, removed, or reordered, or a node's own content (1.6) changed — a run edited, or an embedded reference added, removed, retargeted, or repositioned; journaled renames and moves change no canonical identity, so the pure operations of 6.2 change no hash; because an embedded target's text is no part of the embedder's own content, editing an embedded target's text changes the target's hashes, not the embedder's ownHash or subtreeHash. effectiveHash additionally changes when, for the node or any node in its subtree, a dependency edge is added, removed, or retargeted — identities enter the target pairs, so retargeting between targets with equal effectiveHash still changes it — or a dependency-edge target's effectiveHash changes. metadataHash changes if and only if the node's `d` declarations, coverage attribute, or tags change. Editing an embedded target therefore surfaces at the embedding node as `upstream-changed`, not `changed`, while `text(...)` output remains fully expanded.

### 5.6 Change categories

Relative to a baseline, each requirement node receives zero or more categories:

* changed: the node was added or deleted, or its ownHash changed (adding, removing, or reordering its children included, 5.5 — structural edits originate at the parent)
* metadata-changed: the node's metadataHash changed
* descendant-changed: the node's subtreeHash changed because of a change in a descendant
* upstream-changed: the node's effectiveHash changed because the effectiveHash of a dependency-edge target — of the node or of a node in its subtree — changed, or because a node in its subtree other than the node itself had dependency edges added, removed, or retargeted

Categories are independent flags; a node MAY carry several. The originating nodes of a change are the nodes where edits occurred — those carrying `changed` or `metadata-changed`; every category MUST be attributed to its originating nodes. For a single edit to a leaf's text: the leaf is `changed`; every ancestor is `descendant-changed` attributed to the leaf; sibling subtrees receive no category; dependents of any node on that path are `upstream-changed`, as are those dependents' ancestors — all attributed to the leaf. For an edit that only adds or removes a child C of parent P (no other text touched): C is `changed` — added or deleted; P is `changed` (its own content changed, 5.5) and `descendant-changed` attributed to C; P's ancestors are `descendant-changed` attributed to P and C; and the `upstream-changed` cascade follows as above. For an edit that only adds or removes `d` targets on a node D: D is `metadata-changed`, no node is `changed` or `descendant-changed`, and every other node whose effectiveHash changed — D's ancestors, dependents, dependents' ancestors, and so on transitively — is `upstream-changed` attributed to D. A metadata edit touching only `coverage` or `tags` changes no effectiveHash and propagates no category.

## 6. Identity Continuity

### 6.1 The journal

xspec maintains a journal at `.xspec/journal`: a plain-text, append-only file with one entry per line, where each entry is a self-contained record of a rename or move operation and the identity mapping it produced. The journal is written only by `xspec rename` and `xspec move`; a workspace in which the journal file does not exist has an empty journal, and the file comes into existence with the first journaled operation. It is a durable record, not derived state (13.4): it cannot be regenerated from source and MUST never be modified or deleted by other commands. Entries are byte-deterministic for a given operation and workspace state; entry content is otherwise opaque — the journal's observable contract is its line-oriented, append-only form and its effect on canonical identities, baseline resolution, and validation (5.4, 6.3, 14.13).

### 6.2 Identity guarantee

`xspec rename` and the file form of `xspec move` are pure: they change only identities and reference spellings, and MUST leave every hash in the workspace byte-identical and produce no change categories relative to any baseline, because child constructs and references hash by canonical identity (5.4, 5.5), which journaled renames and moves preserve. The section form of `xspec move` is not pure in general: its identity mapping changes no hash — every node of the moved subtree keeps its ownHash, subtreeHash, and metadataHash — but the operation removes a child construct from the origin parent and inserts one into the target parent (6.5), and each parent whose own content sequence (1.6) changes is `changed`, with the ordinary cascades of 5.6 following, attributed to it. Distinct parents' sequences necessarily change — one loses a node reference, the other gains one. When origin and target parent coincide, the text rules of 6.5 may reproduce the parent's own content exactly — a final construct re-inserted at its own former position — and such a move changes no hash and is pure in effect.

### 6.3 Baseline resolution

When a command takes a baseline git ref, the baseline graph is reconstructed from the workspace content at that ref — sources and configuration alike, so group membership reflects the configuration as it stood at that ref. A journal file absent at the baseline ref, or absent in the current workspace, is read as an empty journal; an empty journal is a prefix of every journal, so baselines predating the first journaled operation resolve normally. The journal entries present in the current journal but absent from the journal content at the baseline ref are applied, in file order, to map baseline identities to current identities; chained mappings compose. Git history itself provides the ordering; journal entries contain no timestamps. Baseline hashes are computed with the journal content at the baseline ref; because the journal is append-only, canonical identities — and therefore hashes — agree between baseline and current for every node changed only by journaled renames or moves. If replay produces an ambiguous or unresolvable mapping, if the journal at the baseline ref is not a prefix of the current journal (the append-only invariant was violated), or if the baseline content cannot be parsed and validated as a workspace, the command MUST fail with an actionable error naming the offending entries or files; a baseline that cannot be read or reconstructed is a usage error (12.0).

### 6.4 Rename

```sh
xspec rename <file> <old-id> <new-id>
```

Renames a requirement ID, rewrites descendant IDs by prefix replacement, rewrites every reference to the affected identities across all configured spec and code sources (`id` attributes, `d` references, `text(...)` references, TypeScript markers), and appends the mapping to the journal. Rewrites are minimal in-place edits, preserving each reference's quote style and access form (2.4); where a form cannot be kept — a chain segment whose new name is not a valid TypeScript identifier, or a reference converted between local and imported form (6.5) — the rewritten part uses dot access for segments that are valid TypeScript identifiers, double-quoted computed access for segments that are not, and double-quoted string literals. Validation MUST confirm: the new ID is valid; it differs from the old ID and collides with no existing ID; structural parent rules remain satisfied; all rewritten references resolve. A `<file>` or old ID that does not exist is a usage error (12.0); every other validation failure refuses the rename (exit 1). Rename MUST also refuse (exit 1), before modifying anything, when the current workspace fails the validations of `xspec build` (12.1), so the operation only ever rewrites a valid workspace. A successful rename finishes by regenerating derived files exactly as `xspec build` does (12.1) — which cannot fail, per the precondition — so generated modules, Markdown output, and graph data match the rewritten sources and no stale output (14.10) remains.

### 6.5 Move

```sh
xspec move <old-file> <new-file>
xspec move <file>#<id> <target-file>#<new-id>
```

The first form relocates an entire source file; IDs are unchanged and every node's identity changes only in its file part. Relocation also rewrites the moved file's own import specifiers, and the paths by which other files import the moved file's generated module, so all references continue to resolve. The second form extracts a section subtree: the section and its descendants are removed from the origin, inserted as the last child of the target parent (or at the end of the file for a top-level `new-id`), and re-identified by prefix replacement of `<id>` with `<new-id>`. The target file is created if absent, empty before insertion. The second form's text edits are exact: the moved text is the section construct's own characters, from the first character of its opening tag through the last of its closing tag. At the origin it is deleted in place, and lines left empty or whitespace-only purely by that deletion are dropped with their line terminators, exactly as in Markdown compilation (3). It is inserted immediately before the target parent's closing tag — at the end of the file for a top-level `new-id` — followed by a U+000A line terminator, and preceded by one when the insertion point is not at the start of a line. Beyond these edits, the identity and reference rewrites of this section, and the finishing regeneration, a move changes no bytes. In both forms, all references across the workspace are rewritten to resolve to the new identities, converting between local and imported forms and adding or removing spec module imports as needed, and the full mapping is appended to the journal. A successful move regenerates derived files as rename does (6.4).

Move validation mirrors rename validation, including the valid-workspace precondition (6.4) and the usage-error classification of a nonexistent origin file or ID (12.0), and additionally MUST refuse: a move that would create an import cycle among spec source files or a dependency cycle; a file-form move whose destination file already exists; and a move whose destination file path (including a target file to be created) would not be a valid discovered spec source after the move — a path belonging to no configured spec group (a move never takes a node out of the workspace), belonging to a code group as well (14.14), containing `#`, or lacking the `.mdx` extension (14.19). These refusals keep every successful move's finishing regeneration (6.4) on a valid workspace, so it cannot fail.

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
      boundaryKind: "code",
      mode: "direct"
    }
  ],
  policy: [
    {
      name: "product-depends-on-nothing",
      type: "forbidden",
      from: { group: "product" },
      to: { group: "tests", kind: "spec" }
    }
  ]
})
```

Every command locates the configuration by upward search for `xspec.config.ts` from the working directory, or uses the path given by the global `--config <path>` option. `specs` is required; `code`, `markdown`, `coverage`, and `policy` are optional — omitting one means no code groups, no Markdown emission, no coverage profiles, or no policy rules, respectively. Unknown keys anywhere in the `defineConfig` argument — a top-level key, or a field of `markdown`, a profile, a rule, or a selector — are a configuration error (14.14). All configured paths and globs resolve relative to the configuration file's directory, which is the workspace root. Globs support exactly `*` (any possibly empty run of characters within one path segment), `?` (one character within a segment), and `**` (any number of whole segments, including none); matching is case-sensitive; a path segment beginning with `.` is matched only by a pattern segment written with a leading `.`; a pattern that resolves outside the workspace root is a configuration error (14.14). Discovery of source files is controlled exclusively by configuration; derived files are never discovered as sources (13.4); imports resolve references between files but never add files to the workspace (2.1). A group whose globs match no files is valid, as is a `specs` or `code` map with no groups: discovery simply yields fewer, possibly zero, sources.

### 7.1 `specs`

Named groups of xspec source files, each a list of globs. A file MAY belong to multiple groups. Every matched file MUST have the `.mdx` extension; a match with any other name is invalid (14.19).

### 7.2 `code`

Named groups of TypeScript source files, each a list of globs. Code groups serve as coverage boundaries and as the population for impacted-code reporting. A file matched by both a spec group and a code group is a configuration error (14.14).

### 7.3 `markdown`

The `markdown` key is optional; when it is absent, no Markdown is emitted. When present, `markdown.emit` (boolean, required) controls whether pure Markdown files are emitted, and `markdown.outDir` (optional path) redirects emitted files into a directory, preserving workspace-relative paths; the default emits next to each source file. `outDir` resolves relative to the workspace root and MUST resolve within it; a value resolving outside the workspace root is a configuration error (14.14).

### 7.4 `coverage`

Named coverage profiles. Each profile has:

* `name` (required): unique profile name
* `target` (required): spec group whose requirements must be covered; a name that is not a configured spec group's is a configuration error (14.14)
* `targetTags`: optional list of tags; when present, the target set is restricted to nodes carrying at least one listed tag; an empty list is a configuration error (14.14)
* `targets`: `"leaves"` (default) or `"all"`; `"leaves"` restricts the target set to nodes with no children
* `boundary` (required): spec or code group that counts as the coverage boundary
* `boundaryKind`: `"spec"` or `"code"`; MUST be inferred when the group name is unambiguous and MUST be required when ambiguous
* `mode` (required): `"direct"` or `"transitive"`
* `edgeKinds`: optional subset of `["depends", "embeds", "references"]`; defaults to all three; an empty list is a configuration error (14.14)

### 7.5 `policy`

Named policy rules constraining which dependency edges may exist. Each rule has:

* `name` (required): unique rule name
* `type` (required): `"forbidden"` or `"allowedOnly"`
* `from`, `to` (required): selectors
* `kinds`: optional subset of the dependency edge kinds; defaults to all three

A selector matches nodes (or code locations) by exactly one of: `{ group: <name> }`, `{ files: <glob> }`, or `{ tags: [<tag>, ...] }` (matching means carrying at least one listed tag; an empty tag list is a configuration error, 14.14). A group selector MAY include `kind: "spec" | "code"`; as with `boundaryKind` (7.4), the kind MUST be inferred when the name is unambiguous and MUST be given when the name exists as both a spec group and a code group (14.14).

In `files` selectors, the `from` pattern MAY contain capture wildcards `$1`…`$9`, each appearing at most once, and the `to` pattern MAY reference them; a `to` containing captures matches only targets whose expansion agrees with the captured values. A capture matches one or more characters within a single path segment (never `/`). When a pattern could match a path in more than one way, the match is disambiguated across the whole pattern, left to right: each wildcard (`*`, `?`, `**`) and each capture, in pattern order, takes as few characters as possible while a match of the remainder of the pattern still exists — so every match, and every capture value, is unique. `$1-$2.ts` against `a-b-c.ts` captures `$1 = a` and `$2 = b-c`; `*$1*` against `abc` captures `$1 = a` (the leading `*` takes the empty string). A `to` referencing a capture absent from `from` is a configuration error (14.14).

Semantics, evaluated over dependency edges of the rule's kinds:

* `forbidden`: any edge whose source matches `from` and whose target matches `to` is a violation.
* `allowedOnly`: every edge whose source matches `from` MUST have a target matching `to`; each edge that does not is a violation.

Violations are findings reported by `xspec check` — and only by `check`: `build` does not evaluate policy (12.1, 14.12) — with the rule name and the offending edge, and cause exit code 1.

## 8. Coverage

Coverage is graph reachability over dependency edges, not proof of semantic correctness. A target requirement is covered for a profile when a permitted path exists from a boundary node to it: in `direct` mode a single edge, in `transitive` mode a path of one or more edges, using only the profile's `edgeKinds`. `contains` edges never grant coverage and never appear in coverage paths.

### 8.1 Required set

A profile's required nodes are the nodes of the `target` group, restricted by `targetTags` when present and to leaves when `targets` is `"leaves"`, excluding nodes marked `coverage="none"` and always excluding root nodes.

### 8.2 Output

`xspec coverage` runs all profiles; `xspec coverage <name>` runs one. The report includes: counts of required, covered, uncovered, and ignored nodes; the identity of every covered, uncovered, and ignored node; and for each covered node one shortest covering path (12.0). The ignored nodes are the nodes of the target group excluded from the required set by 8.1, each reported with its exclusion reasons — all that apply, listed in this fixed order: root node, `coverage="none"`, non-leaf under `targets: "leaves"`, lacking every `targetTags` tag. With `--check`, the command exits 1 if any required node is uncovered. JSON output MUST be available and MUST contain the same information.

## 9. Impact Analysis

```sh
xspec impact --base <git-ref>
```

Impact compares the current workspace graph against the baseline graph reconstructed at the given git ref, with identities mapped through the journal (6.3).

### 9.1 Requirement impact

Requirement-level impact is the change categories of 5.6, each attributed to its originating nodes.

### 9.2 Impacted code

Impacted code is evaluated over the impact edges of a code location: the union of its `references` and `embeds` edges in the baseline graph and in the current graph, with identities mapped through the journal (6.3). For this comparison, a node present on only one side — added or deleted — counts as one whose subtreeHash and effectiveHash changed.

* directly impacted: the code location has an impact edge, in either graph, to a node whose subtreeHash changed
* transitively impacted: the code location has an impact edge, in either graph, to a node whose effectiveHash changed but whose subtreeHash did not

A code location absent from the current graph is reported under its baseline identity, like a deleted requirement node (9.3).

### 9.3 Output

Output is grouped by category, with ancestor chains collapsed alongside their attribution — a maximal chain of ancestors whose only category is `descendant-changed` with identical attribution appears as one entry covering the chain, rather than one entry per node — followed by directly and transitively impacted code, each with an impact edge (9.2) that makes it impacted and one shortest propagation path (12.0) witnessing it: a sequence of nodes from the edge's target to a node whose own edit explains the change — a `changed` node, or a `metadata-changed` node whose `d` targets changed — each step a `contains` edge to a child or a dependency edge to a target. On a directly impacted location's path every node's subtreeHash changed and every step is a `contains` step; on a transitively impacted location's path every node's effectiveHash changed. The recurrences of 5.5 guarantee such a path exists; when the edge's target itself was edited, added, or deleted, the path is that single node. A node absent from the current graph is reported as deleted, under its baseline identity mapped forward through the journal entries applied since the baseline (6.3); when that identity is now borne by a distinct new node (5.4), the identity appears twice — once as deleted, once as added. `impact` is informational: it exits 0 whether or not differences exist. JSON output MUST be available.

## 10. Review

Review turns graph results into a staged checklist. xspec separates the review mechanism (sessions, items, statuses, blocking, invalidation — defined here) from review strategies (the functions that derive items from graph results). Three built-in strategies exist: `path-blocks`, `audit`, and `coverage`.

### 10.1 Sessions

A review session is stored at `.xspec/reviews/<session-name>.json` as a plain, deterministic file. A session name MUST consist of one or more characters from `A–Z`, `a–z`, `0–9`, `.`, `_`, and `-`, and MUST NOT begin with `.`; any other name is a usage error (12.0). Session names are case-sensitive, but so that session files stay unambiguous on case-insensitive filesystems, a name that matches an existing session's name ignoring ASCII case is treated at `review create` as the name of an existing session and refused (10.7); every other subcommand matches names exactly. A session is a durable task ledger for a specific graph state (13.4), not a source of requirement identity. Only a file directly under `.xspec/reviews/` named `<session-name>.json` with a valid session name is a session; any other file there is not a session and is ignored by every command, `check` included. A session file that exists but cannot be parsed, or that violates a session invariant — the fields of 10.2 present and well-formed, statuses drawn from 10.3, item `id`s unique within the session, `blockedBy` naming only item `id`s present in the session, at most one item per kind and scope node (10.5), and the recorded creation parameters and decompositions (10.7) well-formed — is corrupt (14.21): every `review` subcommand naming that session reports the corruption and exits 1, modifying nothing, and `list` reports it as corrupt (10.7).

### 10.2 Items

A review item contains: `id` (unique within the session), `kind` (assigned by the strategy), `scope` (the requirement nodes or code locations under review), `context` (nodes whose text frames the review), `reason`, `origin` (the originating nodes (5.6), when applicable), `baseline` and `current` (the relevant hashes), `status`, optional `note`, and `blockedBy` (item IDs that must resolve first; empty except where a strategy (10.5, 10.6) or `split` (10.7) assigns blockers). Items MUST carry enough baseline identity and baseline text that they remain actionable after the referenced nodes are edited, moved, or deleted.

### 10.3 Statuses

* `unresolved`: still needs review
* `updated`: reviewed; source was changed
* `no-change`: reviewed; intentionally left unchanged
* `skipped`: intentionally deferred or ignored
* `invalidated`: previously resolved, but relevant state changed afterward

An item is resolved when its status is `updated`, `no-change`, or `skipped`; `unresolved` and `invalidated` items need review. An item is blocked while any item in its `blockedBy` is not resolved; because `invalidated` is not a resolved status, a blocker that becomes invalidated re-blocks its dependents until it is resolved again.

### 10.4 Relevant hashes and invalidation

The relevant hashes per built-in item kind are:

* `subtree-coherence`: subtreeHash and metadataHash of each scope node
* `parent-consistency`: ownHash and metadataHash of the scope node; subtreeHash of each context branch
* `dependency-consistency`: ownHash and metadataHash of the scope node; subtreeHash of each upstream target in context
* `metadata-consistency`: metadataHash of the scope node
* `code-impact`: subtreeHash and effectiveHash of each node targeted by the scoped code location's impact edges (9.2)
* `uncovered-requirement`: subtreeHash and metadataHash of the scope node

Resolving an item records its relevant hashes per the list above and, for every scope, context, and origin node, whether the node is present; a node is absent when it is deleted or its identity ceases to resolve through the journal, and an absent node's hashes are recorded as an explicit absent marker. A resolved item becomes `invalidated` when this recorded state differs from the current graph: a recorded hash changed, a node's presence changed in either direction, or the item's context set changed. An item's current context set is the one the session's strategy generators — run with the session's recorded creation parameters (10.7) and recorded decompositions (10.5, 10.7) against the current workspace — assign to it; reads compute it without persisting anything, so context-set invalidation does not wait for a re-derivation. An item the generators no longer produce retains its recorded context set. A node that was already absent when the item was resolved does not invalidate it by remaining absent, so deletion review stays resolvable (10.2). Items added during a session follow the same rule. Item validity is recomputed against the current graph whenever a session is read (`status`, `next`, `show`, `export`); a stale resolution is never reported as resolved — the item is reported `invalidated` and needs review again (10.3, 10.7). Reads never write the session file: read-time invalidation is computed and reported, not persisted; sessions change only through the mutating subcommands (13.5).

### 10.5 Built-in strategy: path-blocks

`path-blocks` is the default strategy for baseline-based sessions. For each `changed` node N, skipping nodes that have a `changed` ancestor:

1. one `subtree-coherence` item — scope: N and all descendants, reviewed as a single block; context: N's ancestor chain; origin: the `changed` nodes in scope
2. one `parent-consistency` item per non-root ancestor A on the path to the root — scope: A, reviewed against its own text; context: the changed branches beneath A; origin: the changed branches' `changed` nodes; when multiple changed nodes share A, A receives a single item against the union of changed branches. Its `blockedBy` holds, for each changed branch, the item whose scope node is A's child on that branch: that child's `subtree-coherence` item when the child is the branch's changed node, otherwise the child's `parent-consistency` item. Only `subtree-coherence` and `parent-consistency` items block `parent-consistency` items; through these chained `blockedBy` sets, a `parent-consistency` item cannot be resolved until every `subtree-coherence` and `parent-consistency` item beneath it on its changed branches has resolved.

For metadata and dependency impact:

1. one `metadata-consistency` item per `metadata-changed` node — scope and origin: that node; context: the added and removed `d` targets; `coverage` and `tags` changes are described in the item's `reason`
2. one `dependency-consistency` item per requirement node having a dependency edge to a target whose effectiveHash changed — scope: that node; context: those changed targets; origin: the originating nodes (5.6) of the targets' changes
3. one `code-impact` item per impacted code location (9.2) — scope: that location; context: the changed nodes targeted by its impact edges; origin: the originating nodes of those targets' changes

Items are totally ordered: requirement-scoped items first, sorted by scope-node depth (ID segment count; roots are 0) deepest first, then by kind — `subtree-coherence`, `metadata-consistency`, `dependency-consistency`, `parent-consistency` — then by scope-node file path, then by document order; `code-impact` items follow, sorted by code-location identity. Paths and identities compare as bytes; a `subtree-coherence` item's scope node is its subtree root. `status`, `next`, and `export` present items in this order; blocking is defined by `blockedBy` alone.

When an item resolves with status `updated`, the session is re-derived at resolve time. This holds for every strategy, each re-running its generators with the session's recorded creation parameters (10.7; here the recorded baseline commit; a `coverage` session's recorded profile; nothing for `audit`) against the current workspace, under these rules:

* A session never contains two items with the same kind and scope node (the scoped code location for `code-impact`). A generated item whose kind and scope node match an existing item is that item — it keeps its `id`, status, and recorded state; if its context set changed it is updated and, when resolved, becomes `invalidated` (10.4). A kind and scope node produced more than once in one derivation yields a single item.
* A generated item whose kind and scope node are recorded as decomposed by `split` (10.7) is never added back: its decomposition applies instead, recursively — it is replaced by one `subtree-coherence` item per current child subtree of the scope node plus the scope node's `parent-consistency` item (10.7), each matched or added under these same rules.
* Items that no longer generate remain in the session and keep their `blockedBy`.
* New items — including a `subtree-coherence` item for any node newly `changed` (5.6) — are added with current state and take their place in item order.
* `blockedBy` is recomputed for every generated or decomposition-produced item, per the strategy's rules and 10.7, with any reference to a decomposed item replaced by all items of its decomposition.

Re-derivation is the only path through which sibling subtrees enter a session.

### 10.6 Built-in strategy: audit

`audit` creates one `subtree-coherence` item per requirement node — root nodes included — with the node's ancestor chain as context, an empty origin, and scope as in 10.5: the node and all its descendants. Audit's item order is scope-node file path first (byte order), then document order within the file; blocking, not order, enforces bottom-up review: each item's `blockedBy` is the set of its child sections' items — after a `split`, the items of their decompositions (10.5, 10.7) — so leaf items are unblocked and subtrees are confirmed bottom-up. It requires no baseline and reviews the entire workspace.

### 10.7 Commands

```sh
xspec review create --base <ref> --name <name>            # path-blocks
xspec review create --strategy audit --name <name>
xspec review create --coverage <profile> --name <name>    # coverage
xspec review list
xspec review status <name>
xspec review next <name> [--json]
xspec review show <name> <item-id>
xspec review split <name> <item-id>
xspec review resolve <name> <item-id> --status <status> [--note <text>]
xspec review export <name> --json
```

`review create` requires exactly one of `--base`, `--strategy audit`, or `--coverage`; supplying none, more than one, or any other `--strategy` value is a usage error (12.0). `create` records the session's creation parameters in the session file, fully resolved: a baseline session records the commit identity `--base` resolved to at creation, a `coverage` session records the named profile's definition — its 7.4 fields, with each group name replaced by that group's configured glob list and kind — and an audit session records none. Every later generator run (10.4, 10.5) uses the recorded parameters — the recorded commit as the baseline, the recorded globs matched against the currently discovered sources (7) — so renaming or editing refs, profiles, or groups after `create` never changes the recorded parameters the session runs with. Discovery itself still follows the current configuration: a file that no longer belongs to any configured group is out of the session's view, exactly as if deleted. A `review` command that cannot resolve or reconstruct the recorded (or, at `create`, the given) baseline fails per 6.3 as a usage error (12.0), modifying nothing. A `coverage` session contains one `uncovered-requirement` item per uncovered required node of the profile — scope: that node; context: its ancestor chain; origin and `blockedBy` empty.

`list` reports every session with its name, strategy, and item counts by status — counted from stored statuses, without the read-time invalidation of 10.4 — and reports each corrupt session (14.21) by name as corrupt in place of those fields; `list` exits 1 when any session is corrupt and 0 otherwise. `status <name>` reports the session's items in item order — each with id, kind, scope, status, and blocked state — plus totals by status. `show <name> <item-id>` reports the full item: every field of 10.2 plus the same self-contained text payload as `next --json`. `export <name>` emits the entire session as a single JSON document — its only output form, with or without `--json`: the session's name, strategy, recorded creation parameters, and recorded decompositions, plus every item in item order, each with every field of 10.2, its blocked state, and the same self-contained text payload as `next --json`, with read-time invalidation (10.4) applied.

`next` returns the first item in the session's item order (10.5, 10.6, or the coverage order below) that needs review (`unresolved` or `invalidated`, 10.3) and is unblocked. When no item qualifies, `next` exits 0 and reports which case holds — every item resolved (a session with no items reports this case), or every item needing review blocked — in both human and `--json` output; the JSON payload then contains no item. With `--json`, the payload MUST be self-contained: scope text, context text, origin before/after text, source ranges, and hashes, so the item can be acted on without further reads. A `coverage` session's `uncovered-requirement` items are ordered by file path, then document order.

`split` decomposes a `subtree-coherence` item whose scope root has children into one `subtree-coherence` item per child subtree plus one `parent-consistency` item for the scope root's own text, whose context is the child subtrees and whose `blockedBy` is those child items. An item of the decomposition whose kind and scope node already exist in the session is not created: the existing item takes its place, keeping its `id`, status, and recorded state — so `split` in an `audit` session reuses the children's existing items. Each decomposition item's `origin` is the originating nodes (5.6) within its scope and context — empty in an `audit` session. Newly created decomposition items additionally inherit the original's `blockedBy`; every item that was blocked by the original becomes blocked by all items of the decomposition; the original item is removed from the session and its `id` is never reused. The decomposition — the original's kind and scope node, replaced by per-child `subtree-coherence` items and the scope node's `parent-consistency` item — is recorded durably in the session and governs re-derivation (10.5). `split` on an item of any other kind, or on a `subtree-coherence` item whose scope root has no children, is refused.

`resolve` sets the status and records the current relevant state (10.4); it applies to any unblocked item regardless of current status, so an `invalidated` (or previously resolved) item is re-resolved the same way. `--status` accepts `updated`, `no-change`, and `skipped`; any other value is a usage error, as is an unknown session name or item ID in any `review` command's arguments (12.0). Resolving a blocked item is refused, as is `review create` with the name of an existing session.

## 11. Query

`xspec query` gives scripts and agents set-level, JSON-only access to the graph:

```sh
xspec query node <node>
xspec query nodes [--group <g>] [--file <glob>] [--tag <t>] [--coverage required|none]
xspec query edges [--from <graph-node>] [--to <graph-node>] [--kinds <kinds>]
xspec query subtree <node>
xspec query ancestors <node>
xspec query reachable --from <graph-node> --to <graph-node> [--kinds <kinds>]
```

`<node>` is a requirement-node identity: `path#id`, or a bare `path` for a file's root node (1.5). `<graph-node>` is any graph-node identity: a requirement node, or a code location (`path`, `path#unit`, or `path#unit@N`; 4.6); whether a bare path names a root node or a code file follows from the file's group (7), and a path in no configured group is unknown (12.0). `node` returns identity, source range, own and subtree text, all four hashes, tags, coverage attribute, and incoming and outgoing edges by kind; for a root node the coverage attribute is reported as absent (1.2), and `nodes --coverage` matches no root. `nodes` filters combine conjunctively. `nodes`, `subtree`, and `ancestors` return one row per node: identity, source range, tags, and coverage attribute (absent for roots). `subtree <node>` returns the queried node and all its descendants, in document order; `ancestors <node>` returns the queried node's proper ancestors — itself excluded — nearest first, ending at the file root. `reachable` reports whether a dependency path exists under the given kinds and, when one does, one shortest witness path (12.0); `reachable`'s `--kinds` defaults to all three dependency edge kinds, while `edges --kinds` filters over all four kinds and defaults to no kind filter. List-valued flags (`--kinds`) take a comma-separated list; `--file <glob>` uses the glob rules of 7. All results use stable, deterministic ordering.

## 12. Commands

### 12.0 Global conventions

* Every command supports `--json`, emitting a single JSON document. Where this specification defines report content, the JSON form MUST contain the same information.
* Every command supports `--config <path>` (7).
* A flag MAY be given at most once per invocation; repeating a flag is a usage error. List-valued flags (`--kinds`) take one comma-separated value (11).
* Arguments that name requirement nodes, graph nodes, workspace files, or file globs (`<node>`, `<graph-node>`, `<file>`, `--file`) are workspace-relative in the form of 1.5, independent of the working directory. `--config <path>` and `--test-hold <path>` are filesystem paths resolved against the working directory.
* IDs, tags, identities, session names, and paths compare byte-wise and case-sensitively; no Unicode normalization or case folding is applied anywhere (the create-time session-name restriction of 10.1 is the sole exception).
* All output, generated files, and stored data are byte-deterministic for identical input: no wall-clock values, no randomness, no absolute paths, no environment-dependent content.
* Where this specification calls for one shortest path and several shortest paths qualify, the reported one is the least by element-wise byte comparison of the paths' node-identity sequences.
* Exit codes partition all outcomes; every defined failure belongs to exactly one class. `0` — success, including informational reports (`ids`, `show`, `impact`, `query`, the `review` read subcommands including `next` with nothing to review, `coverage` without `--check`). `1` — findings: source, workspace, and operation validation failures (`build` on invalid sources, `check` findings, `coverage --check` with uncovered requirements, refused `rename`/`move` (6.4, 6.5), refused review operations (10.7), `review` subcommands naming a corrupt session and `review list` reporting one (14.21)). `2` — usage and configuration errors: unknown commands or flags; missing required flags or arguments; invalid flag values; unknown profiles, sessions, groups, review items, node identities, or files named in arguments; invalid session names; missing or invalid configuration (14.14); a baseline that cannot be read or reconstructed (6.3); a mutating command refused because another is running (13.5).

### 12.1 `xspec build`

Parses configured sources; validates section structure, IDs, tags, and references; resolves dependencies; generates TypeScript modules (13.1); optionally emits Markdown; and writes graph data. `build` does not evaluate policy rules: policy violations are `check` findings (7.5, 14.12), and `build` succeeds and regenerates output whether or not policy is satisfied. Rebuilding regenerates every derived file and removes recorded derived files that the current sources and configuration no longer generate (13.3, 13.4). A `build` that fails — validation errors (exit 1) or a configuration error (12.0) — modifies nothing: every derived file and all graph data remain byte-for-byte as they were.

### 12.2 `xspec check`

Performs all build validations without accepting stale outputs, and additionally verifies: generated files are content-identical to what the current sources and configuration generate, and no recorded derived file remains at a path no longer generated (14.10); all dependency and text references resolve and are static; all TypeScript spec references resolve; no dependency cycles and no spec import cycles exist; the journal is well-formed and replayable with no conflicting mappings; no policy violations exist; review sessions are not internally corrupt. Exits 1 on any finding. Configuration validity is enforced at load by every command (14.14) and is a usage error, not a `check` finding.

### 12.3 `xspec ids`

Lists requirement IDs grouped by file, with `--json` per 12.0. `--tree` renders each file's IDs as a tree following section nesting instead of a flat list. `--file <glob>` restricts the listing to files the glob matches (the rules of 7, as in 11). `--unreferenced` restricts the listing to requirement nodes with no incoming dependency edges from specs or code (`contains` does not count); unreferenced is not the same as uncovered — a node may be referenced yet uncovered by a given profile.

### 12.4 `xspec show`

```sh
xspec show <node>
```

Accepts `path#id`, or a bare `path` for a file's root node (1.5). Prints one requirement for human reading: ID, source range, own and subtree text, hashes, and edges by kind. `query node` is the machine-facing equivalent.

### 12.5 `xspec coverage`, `xspec impact`, `xspec review`, `xspec query`, `xspec rename`, `xspec move`

As specified in sections 8, 9, 10, 11, and 6.

## 13. Workspace Files

### 13.1 Generated TypeScript

`NAME.mdx` generates, in the source file's directory, the TypeScript module `NAME.xspec.ts`, beginning with the generated-file header (4), together with whatever companion files beside it are needed so that the specifier `./NAME.xspec` resolves for consumers: type checking (4.1), hover documentation and go-to-definition into the source `.mdx` (4.2), and runtime behavior (4.3–4.5) MUST all hold under standard TypeScript tooling with no xspec runtime dependency. Every companion file is named `NAME.xspec.` plus a suffix, so the module and all companions carry `.xspec.` in their names and are derived files under the source-discovery exclusion (13.4).

### 13.2 Markdown output

`NAME.mdx` emits `NAME.md` when enabled, pure Markdown with xspec annotations removed and embedded text resolved (3), placed per `markdown.outDir` (7.3).

### 13.3 Graph data

xspec maintains graph data under `.xspec/`, containing requirement nodes, code locations, edges by kind, source ranges, all four hashes, coverage attributes, tags, and the paths of the derived files most recently generated (13.4). Graph data serves `check`, `ids`, `show`, `coverage`, `impact`, `review`, and `query`. Read results never come from stale data: when graph data is missing or does not match the current sources and configuration, `ids`, `show`, `coverage`, `impact`, `review`, and `query` refresh it — writing exactly what `xspec build` would write, except that no TypeScript or Markdown is generated or removed and the recorded derived-file paths are left unchanged — before answering. If the current sources fail `build` validation, these commands report the validation errors and exit 1 without answering and without modifying anything: a failed refresh, like a failed build (12.1), leaves every derived file and all graph data unmodified. `check` never refreshes; it reports staleness instead (14.10).

### 13.4 Derived and durable files

Every file xspec writes is a plain file suitable for committing, written with stable ordering and sorted keys. Files are classified:

* Derived: generated TypeScript modules and their companion files (13.1), emitted Markdown, and graph data. Derived files are fully reproducible from sources, configuration, and the journal (5.4) via `xspec build`; a conflicted, corrupted, deleted, or orphaned derived file is correctly resolved by rebuilding (12.1). Orphan removal relies on the recorded derived-file paths (13.3): a derived file orphaned while that record was itself missing is outside xspec's knowledge — xspec does not remove it, and it MAY be deleted manually.
* Durable: the journal (6.1) and review sessions (10.1). Durable files record operations and resolutions; they are not reproducible, are never regenerated, and MUST NOT be modified except by their owning commands. They are line-oriented or stably keyed so that concurrent additions merge textually; `xspec check` validates their integrity and reports unresolvable states.

Derived-file paths belong to xspec: writing a derived file replaces whatever exists at its path, whether or not xspec wrote it. Derived files are never sources: paths whose file name contains `.xspec.`, files under `.xspec/`, and files at the configured Markdown emit destinations (7.3) are excluded from every spec and code group (7).

### 13.5 Concurrency and isolation

All state is workspace-local; instances operating on different workspaces MUST NOT interfere with each other. Within one workspace, file writes are atomic in their observable effect: at every moment — concurrent readers and interrupted commands included — a path xspec writes holds either its prior state (the previous content, or absence) or the complete new content, never a partial write. Commands that modify sources or durable files — `rename`, `move`, and the mutating `review` subcommands (`create`, `resolve`, `split`) — are mutually exclusive per workspace: while one runs, another MUST fail promptly with a usage error (12.0) without modifying anything, so concurrency never loses a journal append or a resolution. Exclusivity ends when the holding command's process terminates, normally or abnormally; a terminated holder MUST NOT block later commands. As a deterministic test seam for this exclusion, every mutating command accepts `--test-hold <path>`: immediately after acquiring workspace exclusivity and before modifying anything, the command creates an empty file at the given path, then proceeds normally only once that file has been deleted. If the hold file cannot be created, the command fails with a usage error (12.0) without modifying anything. The seam changes no other behavior and grants no access beyond the invoking user's own file permissions. All other commands may run concurrently, with last-write-wins per file; any resulting derived-file inconsistency is resolved by rerunning `xspec build`. A mutating command interrupted before completion can leave sources and durable files inconsistent; `xspec check` reports such states (14).

## 14. Validation Errors

`xspec build` and `xspec check` MUST report actionable errors that identify the file, location, and correction. When several error conditions are present, they MUST report each of them, not only the first; a condition goes unreported only where another error makes it undetectable — an unparseable file (14.20) masks the conditions inside itself, and a reference into it reports as unresolved (14.5–14.7) — and a configuration error (14.14) precedes all source analysis. The defined error conditions, each reported by `build` and `check` unless its entry states otherwise:

1. Missing ID: a non-root section without `id`.
2. Invalid structural ID: a child ID that does not equal the parent ID plus one segment, including IDs that skip levels; the error states the expected form. A top-level section is checked against the empty prefix (exactly one segment). The check needs the parent's ID: for the immediate children of a section lacking `id`, condition 1 masks this condition — their other conditions, and this condition for their own children, report normally.
3. Duplicate ID within a file.
4. Invalid segment or tag: violation of 1.4.
5. Unknown dependency: a `d` reference that does not resolve.
6. Unknown text target: a `text(...)` reference that does not resolve.
7. Unknown TypeScript reference: a marker or `text` call that does not resolve; this is also a type error against the generated module.
8. Invalid argument: a `d` or `text(...)` reference that is not static per 2.4, a `text(...)` call without exactly one argument, or a string-form `text(...)` argument in a TypeScript file (4.3).
9. Cycle: a dependency cycle (with the full path) or a spec import cycle.
10. Stale generated output: a derived file whose content does not match what the current sources and configuration generate, or a recorded derived file (13.3) remaining at a path the current sources and configuration no longer generate; the error names the file and instructs rebuilding. Reported by `check` only: `build` cannot observe staleness because it regenerates every derived file (12.1).
11. Cross-module text call: a node passed to the `text` export of a spec module other than its own; additionally a TypeScript type error and a runtime throw per 4.4.
12. Policy violation: rule name plus offending edge. Reported by `check` only: policy constrains the workspace graph, not source validity, and `build` regenerates output regardless of policy findings (7.5, 12.1).
13. Journal error: malformed, conflicting, or unreplayable entries, naming the lines.
14. Configuration error: missing or invalid configuration — missing required fields, unknown keys (7), or invalid profile, rule, or group shapes; group names referenced by profiles, rules, or selectors that are unknown or not of the kind the reference requires (7.4, 7.5); ambiguous kinds (7.4, 7.5); an empty `edgeKinds`, `targetTags`, or selector `tags` list; a capture violation (7.5); a glob or `markdown.outDir` resolving outside the workspace root (7, 7.3); a file matched by both a spec and a code group. Reported by every command when it loads the configuration and discovers sources, as a usage error (12.0), not a finding.
15. Invalid import: in an xspec source file, an import that is not a single default binding, does not designate an xspec source file belonging to a configured spec group, or binds the identifier `S`, `Spec`, or `text` (2.1); in a TypeScript file, a `.xspec` import that does not designate such a source, a spec-module binding other than the default and `text` exports, a dynamic `import()` whose static specifier ends in `.xspec`, or an import whose relative specifier designates a derived-file path other than through a spec module import's `.xspec` specifier (4, 13.4); in either kind of file, an import binding an identifier already bound by another import in the same file, when either import is a spec module import.
16. Invalid construct: a JSX element other than `<S>`/`<Spec>`, an expression container other than a `text(...)` embedding or an MDX comment (2.7), or an export statement in a source file.
17. Invalid prop: an unknown or repeated prop on `<S>`/`<Spec>`, an `id`, `coverage`, or `tags` value that is not a quoted-form static string literal, a `d` value that is not a braced expression (2.7), or a `coverage` value other than `required` or `none`.
18. Unsupported node usage: a spec module binding or node used in TypeScript other than as a dependency marker, a child property access, or a direct argument to a spec module's `text` export (a cross-module `text` argument is condition 11, not this one).
19. Invalid source path: a discovered spec or code source file whose workspace-relative path contains `#`, or a spec-group file without the `.mdx` extension (7.1).
20. Unparseable source: a spec-group file that is not well-formed MDX, a code-group file that is not well-formed TypeScript, or a discovered source file of either kind that is not valid UTF-8 or begins with a byte-order mark (1.6); the error reports the location of the parse failure.
21. Corrupt review session: a session file that cannot be parsed or that violates a session invariant (10.1). Reported by `check`, by any `review` subcommand naming the session, and by `review list` (exit 1); not reported by `build`, which does not read sessions.

## 15. Example

`specs/SPEC.mdx`:

```mdx
<S id="print">
Print behavior.

<S id="print.hello" tags="critical">
Print hello.
</S>
</S>
```

`specs/DERIVED.mdx`:

```mdx
import SPEC from "./SPEC.xspec"

<S id="derived">
Derived behavior.

<S id="derived.hello" d={SPEC.print.hello}>
Derived hello behavior.
</S>
</S>
```

`src/hello.ts`:

```ts
import DERIVED from "../specs/DERIVED.xspec"

export function hello() {
  DERIVED.derived.hello
  console.log("Hello")
}
```

Graph:

```txt
specs/SPEC.mdx                  contains    specs/SPEC.mdx#print
specs/SPEC.mdx#print            contains    specs/SPEC.mdx#print.hello
specs/DERIVED.mdx               contains    specs/DERIVED.mdx#derived
specs/DERIVED.mdx#derived       contains    specs/DERIVED.mdx#derived.hello
specs/DERIVED.mdx#derived.hello depends     specs/SPEC.mdx#print.hello
src/hello.ts#hello              references  specs/DERIVED.mdx#derived.hello
```

The path `hello → derived.hello → print.hello` satisfies a transitive coverage profile targeting `print.hello`. If the text of `print.hello` is edited: `print.hello` is `changed`; `print` and the SPEC root are `descendant-changed` via `print.hello`; `derived.hello`, `derived`, and the DERIVED root are `upstream-changed`; `hello.ts#hello` is transitively impacted. A default `path-blocks` session for this change contains exactly: a `subtree-coherence` item for `print.hello`, a `parent-consistency` item for `print` blocked by it, a `dependency-consistency` item for `derived.hello`, and a `code-impact` item for `hello.ts#hello`. If `print.hello` is instead renamed with `xspec rename`, the journal records the mapping and an impact run against the pre-rename baseline reports no changes.
