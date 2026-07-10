// TypeScript tooling driver for the xspec test harness (TEST-SPEC 4 preamble,
// 17 S-4; IMPLEMENTATION.md: type-level assertions compile fixture consumer
// files with the TypeScript compiler API and assert on diagnostics; hover and
// go-to-definition are asserted through the language-service API; runtime
// behavior of generated modules runs under plain Node with no xspec
// dependency installed — SPEC.md 13.1). Harness machinery only: this module
// never imports product code; consumer-side contracts are exercised over
// files the product wrote into a test workspace, through standard TypeScript
// tooling.
//
// - A `ConsumerProject` is a fixed set of root TypeScript files under a
//   project root, served by one TypeScript language service: the same program
//   answers diagnostics (with exact locations), go-to-definition targets, and
//   hover text, so type-level and editor-level assertions cannot drift apart.
//   The project snapshots file contents on first access — rebuild a new
//   `ConsumerProject` after changing files on disk.
// - Positions are addressed by substring markers (`locate`), never by
//   hand-maintained numbers. Offsets are UTF-16 code-unit offsets into the
//   decoded file text (the TypeScript convention, not bytes); lines and
//   columns are 1-based, with line breaks counted as TypeScript's scanner
//   does (LF, CR, CRLF, U+2028, U+2029).
// - Compiled consumers run under plain Node (`runConsumer`) through the
//   blackbox subprocess driver: `node <entry>` with the sanitized environment
//   and `NODE_PATH` dropped, so nothing outside the consumer's own files (and
//   the product-written modules beside them) can satisfy an import — SPEC.md
//   13.1's "no xspec runtime dependency", observed structurally.
// - Failure paths are loud (H-8): a missing project root or root file, an
//   unknown or ambiguous marker, and an unreadable definition target all
//   throw diagnosed errors instead of yielding empty results a test could
//   mistake for green. An import the product failed to make resolvable is a
//   diagnosed compile error (TS2307) — the red path for section 4 tests.
//
// Conservative defaults where IMPLEMENTATION.md is silent (overridable per
// project via `compilerOptions`): consumers compile `strict` for modern Node
// (target ES2022, module/moduleResolution NodeNext) with `@types/node`
// resolved from this repository's own pinned node_modules — a compile-time
// affordance that installs nothing into the consumer workspace — and emit
// with LF line endings for deterministic bytes.

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { fail } from "./assertions.js";
import type { ProductBinding, RunResult } from "./subprocess.js";
import { runProduct } from "./subprocess.js";

const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** A position in a consumer project file. */
export interface SourcePosition {
  /** Project-relative `/`-separated path (absolute when outside the root). */
  readonly file: string;
  /** UTF-16 code-unit offset into the file text (TypeScript convention). */
  readonly offset: number;
  /** 1-based line number. */
  readonly line: number;
  /** 1-based column (UTF-16 code units from the line start). */
  readonly column: number;
}

/** A file position addressable without line/column (what queries need). */
export interface FileOffset {
  readonly file: string;
  readonly offset: number;
}

/** One TypeScript diagnostic, mapped to harness-comparable data. */
export interface ConsumerDiagnostic {
  /** Project-relative file, absent for options/global diagnostics. */
  readonly file?: string;
  /** Start of the reported span, absent when the diagnostic has none. */
  readonly start?: SourcePosition;
  /** Length of the reported span in UTF-16 code units. */
  readonly length?: number;
  /** TypeScript error code (e.g. 2345). */
  readonly code: number;
  readonly category: "error" | "warning" | "suggestion" | "message";
  /** Flattened message chain, newline-joined. */
  readonly message: string;
}

/** One go-to-definition target. */
export interface DefinitionTarget {
  readonly file: string;
  /** Start of the declaration-name span. */
  readonly start: SourcePosition;
  readonly length: number;
  /** Declared name. */
  readonly name: string;
  /** TypeScript script-element kind (e.g. "function", "const"). */
  readonly kind: string;
}

/** Hover (quick info) at a position. */
export interface HoverInfo {
  /** Signature/display text, display parts joined. */
  readonly display: string;
  /** Documentation text, parts joined (SPEC.md 4.2 hover documentation). */
  readonly documentation: string;
  /** The hovered span. */
  readonly start: SourcePosition;
  readonly length: number;
}

export interface EmitResult {
  readonly emitSkipped: boolean;
  /** Written files, project-relative, sorted. */
  readonly emittedFiles: readonly string[];
  readonly diagnostics: readonly ConsumerDiagnostic[];
}

/**
 * Defaults for consumer compilation (see the module header for the
 * rationale). Returned fresh so callers can spread-and-override freely.
 */
export function defaultConsumerCompilerOptions(): ts.CompilerOptions {
  return {
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    types: ["node"],
    typeRoots: [path.join(repoRoot, "node_modules", "@types")],
    newLine: ts.NewLineKind.LineFeed,
  };
}

export interface ConsumerProjectOptions {
  /** Absolute path of the consumer project root. */
  readonly rootDir: string;
  /**
   * Root files, project-relative with `/` separators. Imports are resolved
   * transitively as usual; diagnostics cover every program file.
   */
  readonly rootFiles: readonly string[];
  /** Merged over `defaultConsumerCompilerOptions()`. */
  readonly compilerOptions?: ts.CompilerOptions;
}

/**
 * A consumer TypeScript project under standard tooling: compile diagnostics,
 * go-to-definition, hover, and emit, all answered by one language service
 * (IMPLEMENTATION.md: compiler API for diagnostics, language-service API for
 * editor guarantees).
 */
export class ConsumerProject {
  readonly rootDir: string;
  readonly compilerOptions: ts.CompilerOptions;

  readonly #rootFilesAbs: readonly string[];
  readonly #service: ts.LanguageService;
  readonly #readCached: (fileName: string) => string | undefined;

  /**
   * Validate and open a project. A missing root directory or root file is a
   * diagnosed error here rather than a confusing empty program later (H-8).
   */
  static async load(options: ConsumerProjectOptions): Promise<ConsumerProject> {
    if (!path.isAbsolute(options.rootDir)) {
      throw new Error(
        `consumer project root must be an absolute path (H-1), got ${JSON.stringify(options.rootDir)}`,
      );
    }
    const rootStats = await fsp.stat(options.rootDir).catch(() => undefined);
    if (!rootStats?.isDirectory()) {
      throw new Error(
        `consumer project root does not exist or is not a directory: ${options.rootDir}`,
      );
    }
    if (options.rootFiles.length === 0) {
      throw new Error(
        `consumer project needs at least one root file (rootDir: ${options.rootDir})`,
      );
    }
    for (const rel of options.rootFiles) {
      const abs = path.resolve(options.rootDir, rel);
      const stats = await fsp.stat(abs).catch(() => undefined);
      if (!stats?.isFile()) {
        throw new Error(
          `consumer project root file missing: ${rel} (resolved: ${abs}). ` +
            `Root files are the consumer sources a test stages itself; a product-written ` +
            `module a consumer imports need not be listed — its absence surfaces as a ` +
            `diagnosed TS2307 compile error instead (H-8).`,
        );
      }
    }
    return new ConsumerProject(options);
  }

  private constructor(options: ConsumerProjectOptions) {
    this.rootDir = options.rootDir;
    this.compilerOptions = {
      ...defaultConsumerCompilerOptions(),
      ...options.compilerOptions,
    };
    this.#rootFilesAbs = options.rootFiles.map((rel) =>
      path.resolve(options.rootDir, rel),
    );

    // Snapshot-on-first-access cache shared by the language service and
    // `locate`, so positions and program contents can never disagree.
    const snapshots = new Map<string, string | undefined>();
    this.#readCached = (fileName: string): string | undefined => {
      if (!snapshots.has(fileName)) {
        snapshots.set(fileName, ts.sys.readFile(fileName));
      }
      return snapshots.get(fileName);
    };

    const host: ts.LanguageServiceHost = {
      getCompilationSettings: () => this.compilerOptions,
      getScriptFileNames: () => [...this.#rootFilesAbs],
      getScriptVersion: () => "0",
      getScriptSnapshot: (fileName) => {
        const text = this.#readCached(fileName);
        return text === undefined
          ? undefined
          : ts.ScriptSnapshot.fromString(text);
      },
      getCurrentDirectory: () => this.rootDir,
      getDefaultLibFileName: (opts) => ts.getDefaultLibFilePath(opts),
      fileExists: ts.sys.fileExists,
      readFile: this.#readCached,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    };
    this.#service = ts.createLanguageService(host, ts.createDocumentRegistry());
  }

  /** All pre-emit diagnostics (syntactic, semantic, options), sorted. */
  diagnostics(): readonly ConsumerDiagnostic[] {
    const raw = ts.getPreEmitDiagnostics(this.#program());
    return raw
      .map((diagnostic) => this.#convertDiagnostic(diagnostic))
      .sort(compareDiagnostics);
  }

  /** Error-category diagnostics only. */
  errors(): readonly ConsumerDiagnostic[] {
    return this.diagnostics().filter((d) => d.category === "error");
  }

  /**
   * Address a position by a substring marker. Fails loudly on an unknown
   * marker; a marker occurring more than once requires an explicit
   * `index` (0-based occurrence). `charOffset` advances within the marker
   * (e.g. to land on an identifier after a keyword prefix).
   */
  locate(
    fileRef: string,
    needle: string,
    options: { readonly index?: number; readonly charOffset?: number } = {},
  ): SourcePosition {
    if (needle === "") {
      fail(`locate: the marker must be a non-empty substring (${fileRef})`);
    }
    const abs = this.#absPath(fileRef);
    const text = this.#readCached(abs);
    if (text === undefined) {
      fail(
        `locate: file not readable: ${abs} (marker ${JSON.stringify(needle)})`,
      );
    }
    const occurrences: number[] = [];
    for (
      let at = text.indexOf(needle);
      at !== -1;
      at = text.indexOf(needle, at + 1)
    ) {
      occurrences.push(at);
    }
    if (occurrences.length === 0) {
      fail(
        `locate: marker not found in ${fileRef}: ${JSON.stringify(needle)} — ` +
          `position markers must match the file text exactly`,
      );
    }
    if (options.index === undefined && occurrences.length > 1) {
      fail(
        `locate: ambiguous marker in ${fileRef}: ${JSON.stringify(needle)} occurs ` +
          `${occurrences.length} times — pass { index } to pick one explicitly`,
      );
    }
    const base = occurrences[options.index ?? 0];
    if (base === undefined) {
      fail(
        `locate: marker index ${options.index} out of range in ${fileRef}: ` +
          `${JSON.stringify(needle)} occurs ${occurrences.length} time(s)`,
      );
    }
    const offset = base + (options.charOffset ?? 0);
    return positionInText(this.#describePath(abs), text, offset);
  }

  /** Go-to-definition targets at a position (empty when there are none). */
  definitionsAt(position: FileOffset): readonly DefinitionTarget[] {
    const abs = this.#absPath(position.file);
    const infos =
      this.#service.getDefinitionAtPosition(abs, position.offset) ?? [];
    return infos.map((info) => {
      const text = this.#readCached(info.fileName);
      if (text === undefined) {
        fail(
          `go-to-definition target is not readable: ${info.fileName} ` +
            `(from ${position.file} offset ${position.offset})`,
        );
      }
      const file = this.#describePath(info.fileName);
      return {
        file,
        start: positionInText(file, text, info.textSpan.start),
        length: info.textSpan.length,
        name: info.name,
        kind: String(info.kind),
      };
    });
  }

  /** Hover (quick info) at a position, or undefined when there is none. */
  hoverAt(position: FileOffset): HoverInfo | undefined {
    const abs = this.#absPath(position.file);
    const info = this.#service.getQuickInfoAtPosition(abs, position.offset);
    if (!info) return undefined;
    const text = this.#readCached(abs);
    if (text === undefined) {
      fail(`hover: file not readable: ${abs}`);
    }
    return {
      display: ts.displayPartsToString(info.displayParts),
      documentation: ts.displayPartsToString(info.documentation),
      start: positionInText(this.#describePath(abs), text, info.textSpan.start),
      length: info.textSpan.length,
    };
  }

  /**
   * Emit the program's JavaScript (in place unless the project's
   * compilerOptions direct otherwise), returning what was written. Emitting
   * is standard tsc behavior — it proceeds even with type errors; assert
   * diagnostics separately.
   */
  emit(): EmitResult {
    const written: string[] = [];
    const result = this.#program().emit(
      undefined,
      (fileName, data, writeByteOrderMark) => {
        const abs = path.isAbsolute(fileName)
          ? fileName
          : path.resolve(this.rootDir, fileName);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const bom = "\u{FEFF}";
        fs.writeFileSync(abs, writeByteOrderMark ? bom + data : data);
        written.push(this.#describePath(abs));
      },
    );
    return {
      emitSkipped: result.emitSkipped,
      emittedFiles: [...written].sort(),
      diagnostics: result.diagnostics
        .map((diagnostic) => this.#convertDiagnostic(diagnostic))
        .sort(compareDiagnostics),
    };
  }

  #program(): ts.Program {
    const program = this.#service.getProgram();
    if (!program) {
      throw new Error(
        `TypeScript language service produced no program for ${this.rootDir} — tooling-driver bug`,
      );
    }
    return program;
  }

  #convertDiagnostic(diagnostic: ts.Diagnostic): ConsumerDiagnostic {
    const message = ts.flattenDiagnosticMessageText(
      diagnostic.messageText,
      "\n",
    );
    const category = categoryName(diagnostic.category);
    if (diagnostic.file === undefined || diagnostic.start === undefined) {
      return { code: diagnostic.code, category, message };
    }
    const file = this.#describePath(diagnostic.file.fileName);
    return {
      file,
      start: positionInText(file, diagnostic.file.text, diagnostic.start),
      length: diagnostic.length,
      code: diagnostic.code,
      category,
      message,
    };
  }

  #absPath(fileRef: string): string {
    return path.isAbsolute(fileRef)
      ? path.normalize(fileRef)
      : path.resolve(this.rootDir, fileRef);
  }

  #describePath(fileName: string): string {
    const rel = path.relative(this.rootDir, fileName);
    if (
      rel === "" ||
      rel.split(/[\\/]/, 1)[0] === ".." ||
      path.isAbsolute(rel)
    ) {
      return fileName.replace(/\\/g, "/");
    }
    return rel.replace(/\\/g, "/");
  }
}

export interface RunConsumerOptions {
  /** Absolute consumer workspace directory; the run's working directory. */
  readonly dir: string;
  /** Compiled entry module, `dir`-relative (or absolute). */
  readonly entry: string;
  /** process.argv arguments after the entry path. */
  readonly argv?: readonly string[];
  /** Merged last over the sanitized environment (see subprocess driver). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
}

/**
 * Run a compiled consumer program under plain Node (SPEC.md 13.1) via the
 * blackbox subprocess driver: exact exit code, separated stdout/stderr bytes,
 * hang guard. `NODE_PATH` is dropped so module resolution sees only the
 * consumer workspace's own files.
 */
export async function runConsumer(
  options: RunConsumerOptions,
): Promise<RunResult> {
  const entryAbs = path.isAbsolute(options.entry)
    ? options.entry
    : path.resolve(options.dir, options.entry);
  const binding: ProductBinding = {
    label: "compiled consumer program under plain Node (SPEC 13.1)",
    command: process.execPath,
    prefixArgs: [entryAbs],
    requiredFiles: [entryAbs],
  };
  return await runProduct(binding, {
    cwd: options.dir,
    argv: options.argv ?? [],
    env: { NODE_PATH: undefined, ...(options.env ?? {}) },
    timeoutMs: options.timeoutMs,
  });
}

/** One-line rendering of a diagnostic for failure diagnoses. */
export function formatConsumerDiagnostic(
  diagnostic: ConsumerDiagnostic,
): string {
  const where =
    diagnostic.file !== undefined && diagnostic.start !== undefined
      ? `${diagnostic.file}:${diagnostic.start.line}:${diagnostic.start.column}` +
        ` (offset ${diagnostic.start.offset}` +
        (diagnostic.length !== undefined
          ? `, length ${diagnostic.length})`
          : ")")
      : "<no location>";
  return `TS${diagnostic.code} [${diagnostic.category}] ${where}: ${diagnostic.message}`;
}

function describeAll(diagnostics: readonly ConsumerDiagnostic[]): string {
  if (diagnostics.length === 0) return "  <none>";
  return diagnostics
    .map((diagnostic) => `  ${formatConsumerDiagnostic(diagnostic)}`)
    .join("\n");
}

/** Assert the project compiles with zero error diagnostics. */
export function assertNoCompileErrors(
  project: ConsumerProject,
  context?: string,
): void {
  const errors = project.errors();
  if (errors.length > 0) {
    fail(
      `${context ?? "consumer project"}: expected a clean compile, got ` +
        `${errors.length} error(s):\n${describeAll(errors)}`,
    );
  }
}

/**
 * Assert compilation fails and the failing location is the consumer
 * reference under test (TEST-SPEC 4 preamble): some error diagnostic's span
 * covers `position` (and matches `code` when given). Returns the matched
 * diagnostic for further assertions.
 */
export function assertCompileErrorAt(
  project: ConsumerProject,
  position: SourcePosition,
  expected: {
    readonly code?: number;
    readonly messageIncludes?: readonly string[];
  } = {},
  context?: string,
): ConsumerDiagnostic {
  const errors = project.errors();
  const matches = errors.filter(
    (diagnostic) =>
      diagnostic.file === position.file &&
      diagnostic.start !== undefined &&
      diagnostic.start.offset <= position.offset &&
      position.offset <
        diagnostic.start.offset + Math.max(diagnostic.length ?? 1, 1) &&
      (expected.code === undefined || diagnostic.code === expected.code),
  );
  const wanted =
    `an error${expected.code !== undefined ? ` TS${expected.code}` : ""} at ` +
    `${position.file}:${position.line}:${position.column} (offset ${position.offset})`;
  const match = matches[0];
  if (match === undefined) {
    fail(
      `${context ?? "consumer project"}: compilation must fail with ${wanted} ` +
        `— the failing location is the consumer reference under test ` +
        `(TEST-SPEC 4). Errors reported:\n${describeAll(errors)}`,
    );
  }
  for (const needle of expected.messageIncludes ?? []) {
    if (!match.message.includes(needle)) {
      fail(
        `${context ?? "consumer project"}: the diagnostic at ${wanted} must ` +
          `mention ${JSON.stringify(needle)}; got: ${formatConsumerDiagnostic(match)}`,
      );
    }
  }
  return match;
}

function categoryName(
  category: ts.DiagnosticCategory,
): ConsumerDiagnostic["category"] {
  switch (category) {
    case ts.DiagnosticCategory.Error:
      return "error";
    case ts.DiagnosticCategory.Warning:
      return "warning";
    case ts.DiagnosticCategory.Suggestion:
      return "suggestion";
    default:
      return "message";
  }
}

function compareDiagnostics(
  a: ConsumerDiagnostic,
  b: ConsumerDiagnostic,
): number {
  const fileA = a.file ?? "";
  const fileB = b.file ?? "";
  if (fileA !== fileB) return fileA < fileB ? -1 : 1;
  const offsetA = a.start?.offset ?? -1;
  const offsetB = b.start?.offset ?? -1;
  if (offsetA !== offsetB) return offsetA - offsetB;
  if (a.code !== b.code) return a.code - b.code;
  return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
}

/**
 * Line starts per TypeScript's scanner conventions: LF, CR, CRLF, U+2028,
 * U+2029 end lines. Every position the driver reports uses this one mapping.
 */
function lineStartOffsets(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    if (ch === 0x0d) {
      if (i + 1 < text.length && text.charCodeAt(i + 1) === 0x0a) i += 1;
      starts.push(i + 1);
    } else if (ch === 0x0a || ch === 0x2028 || ch === 0x2029) {
      starts.push(i + 1);
    }
  }
  return starts;
}

function positionInText(
  file: string,
  text: string,
  offset: number,
): SourcePosition {
  if (offset < 0 || offset > text.length) {
    fail(
      `position offset ${offset} out of range for ${file} (0..${text.length})`,
    );
  }
  const starts = lineStartOffsets(text);
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid]! <= offset) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return { file, offset, line: low + 1, column: offset - starts[low]! + 1 };
}
