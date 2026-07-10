# IMPLEMENTATION

Technical choices for building xspec and its test harness. This document adds no requirements: `SPEC.md` and `TEST-SPEC.md` define all behavior; anything named here is a means of satisfying them, and where a choice here cannot satisfy them, the spec wins.

## Product (`xspec`)

### Language and runtime

- TypeScript (current 5.x, `strict`), ES modules throughout, compiled with `tsc`.
- Runs on Node.js, active LTS lines (currently 22/24); no APIs beyond the oldest supported LTS, no platform-specific code paths.

### Distribution

- One npm package, `xspec`, providing the `xspec` bin and the `defineConfig` export that `xspec.config.ts` imports.
- The package is a build-time tool: generated modules and their companions are self-contained (SPEC 13.1) and consumer code never depends on `xspec` at runtime.

### Key libraries

- MDX parsing: `remark-mdx` on the unified/remark toolchain — its grammar defines well-formed MDX (SPEC 14.20) and it yields exact source offsets for every construct, which the byte-exact text and removal rules (SPEC 1.6, 3) require.
- TypeScript parsing, analysis, and emission: the TypeScript compiler API (`typescript` package). One shared static-reference analyzer (SPEC 2.4) serves MDX expression spans and TypeScript sources alike; `xspec.config.ts` is parsed statically as an AST and reduced to data, never executed or imported.
- Editor guarantees of generated modules (SPEC 4.2) are verified against the same `typescript` package's language-service API.
- Hashing: SHA-256 from `node:crypto`, hex-encoded, with length-prefixed component framing to make hash inputs injective (SPEC 5.5).
- Git baseline reads (SPEC 6.3, 9): the system `git` executable via read-only plumbing subcommands; no git library, no git write operations.
- No CLI framework, no glob library: argument parsing (SPEC 12.0 flag rules), the glob dialect with captures (SPEC 7, 7.5), and symlink-free directory walking are implemented in-repo — their semantics are pinned exactly by the spec and off-the-shelf behavior differs.
- No other runtime dependencies without a spec-grounded reason.

### Architecture

Three layers in one package:

1. **core** — pure and I/O-free: source models for MDX and TypeScript, graph construction, canonical identities and the four hashes, validation (SPEC 14), Markdown compilation, and coverage/impact/review/query derivation. Deterministic by construction: explicit ordering everywhere, no wall clock, no randomness, no absolute paths.
2. **workspace** — all I/O: configuration loading, source discovery, derived-file writes (atomic: temp file + rename in the same directory), journal and session storage, workspace mutual exclusion (SPEC 13.5), and baseline reconstruction from git.
3. **cli** — argument parsing, command dispatch, human and `--json` rendering, and the exit-code taxonomy (SPEC 12.0). The entry point is a function `(argv, cwd, stdout, stderr) → exit code`; the bin is a trivial wrapper around it.

Cross-cutting rules:

- Every validation failure is represented as data carrying its SPEC 14 condition number and exit class; reports are built as data and rendered once per output form (human, JSON).
- Stored and emitted JSON goes through one canonical serializer (sorted keys, stable ordering, trailing newline) shared by graph data, sessions, and `--json` output.

### Coding style

- `strict` TypeScript; no `any` outside compiler-API boundaries; `readonly` data by default in core.
- Prettier with default configuration; no lint layer beyond `tsc` itself.
- Code that implements a numbered SPEC rule cites the section number in a comment; comments otherwise only where reasoning is non-obvious.

## Test harness

- Same language and runtime as the product; same repository.
- Test runner: Vitest.
- Tests drive the product through its specified surfaces only: build a temporary workspace from fixture files, invoke the CLI, assert on stdout, stderr, exit code, and workspace file bytes.
- CLI invocation is in-process through the `(argv, cwd, stdout, stderr)` entry by default (fast, debuggable); real subprocesses are used where process semantics are themselves under test — concurrency and `--test-hold` (SPEC 13.5) — and for bin smoke coverage.
- Type-level assertions (SPEC 4.1, 4.4) compile fixture consumer files with the TypeScript compiler API and assert on diagnostics; hover and go-to-definition (SPEC 4.2) are asserted through the language-service API; runtime behavior of generated modules (SPEC 4.3–4.5) runs under plain Node with no xspec dependency installed.
- Byte-determinism (SPEC 12.0) is asserted with run-twice, compare-bytes helpers over outputs and written files.

## Repository and tooling

- Package manager: npm with a committed lockfile.
- Layout: `src/` (product), `test/` (harness), `specs/` (SDG documents) at the repository root.
