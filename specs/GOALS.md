# GOALS

- xspec is a requirement-traceability tool for specifications written in MDX: requirement sections are marked with `<S>`/`<Spec>` tags and carry structural dot-path IDs; every node has a stable identity `path#id`.
- Each source file compiles to a strongly typed TypeScript module: requirement references are type-checked, carry hover documentation, resolve to their source section via go-to-definition, and are opaque tokens — requirement text is reachable at runtime only through the `text` export.
- Optional pure-Markdown output strips all xspec annotations and fully expands embedded requirement text.
- xspec builds a project-wide graph of requirement nodes and code locations (`contains`, `depends`, `embeds`, `references`) and uses it to validate structure and references, enforce dependency policy, measure coverage, analyze change impact, drive staged review sessions, and answer ad-hoc queries.
- Change detection is hash-based (ownHash, subtreeHash, effectiveHash, metadataHash); every change category is attributed to its originating nodes.
- Identity is durable: `xspec rename` and `xspec move` rewrite all references and record journal mappings, so a pure rename or move produces no change categories and no hash changes against any baseline.
- Coverage is graph reachability over named profiles (target, boundary, mode, edge kinds); root nodes and `coverage="none"` nodes are never coverage targets.
- The complete interface is the `xspec` CLI, `xspec.config.ts`, the source syntax, the generated modules, and the workspace files; every behavior is observable through these surfaces.
- Every command supports `--json`; all output, generated files, and stored data are byte-deterministic; exit codes distinguish success (0), findings (1), and usage/configuration errors (2).
- xspec performs no network access, reads git data only where explicitly stated, and never performs git write operations.
- Derived files (generated TypeScript, Markdown, graph data) are always reproducible via `xspec build`; durable files (journal, review sessions) are never regenerated and merge textually.
