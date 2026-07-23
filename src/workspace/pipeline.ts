// The workspace analysis pipeline (SPEC 12.1, 13.3, 14) — the shared
// pre-answer step of every command that parses and validates the configured
// sources: `build` runs it before generating, the graph-data consumers run
// it to refresh and to fail on invalid sources (SPEC 13.3), and `check` runs
// it as the base of its validations (SPEC 12.2).
//
// IMPLEMENTATION (Architecture): this workspace-layer module owns the I/O —
// discovery (the walk), reading source bytes, loading the journal — and
// composes the pure core: MDX parsing (core/mdx.ts), import and reference
// analysis (core/spec-references.ts), TypeScript analysis
// (core/code-analysis.ts), graph assembly (core/graph.ts), the text model
// (core/text-model.ts), and the four hashes (core/hashes.ts).
//
// Reporting semantics (SPEC 14): every detectable condition is collected —
// each present condition, not only the first — with the masking rules
// applied where the data flows:
//
// - a discovery-level configuration error (a file matched by both a spec and
//   a code group, SPEC 7.2 → 14.14) precedes all source analysis: it is
//   returned separately as a usage-class error (exit 2, SPEC 12.0) and no
//   source is parsed;
// - an unparseable source (14.20) masks the conditions inside itself: the
//   file contributes its single 14.20 finding and nothing else, and
//   references into it report as unresolved (14.5–14.7) during graph
//   resolution;
// - invalid source paths (14.19) make the file no source: it is skipped with
//   its finding.
//
// The journal is loaded here because it is a validation subject (14.13) and
// a hash input (SPEC 5.4, 5.5): a workspace whose journal is malformed fails
// build validation like any other finding-bearing workspace.

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { compareBytes } from "../core/bytes.js";
import type { CodeAnalysis } from "../core/code-analysis.js";
import { analyzeCodeSource } from "../core/code-analysis.js";
import type { Configuration } from "../core/config.js";
import type { SourceClassification } from "../core/discovery.js";
import { markdownEmitDestinations } from "../core/discovery.js";
import type { Finding } from "../core/findings.js";
import { conditionExitClass } from "../core/findings.js";
import { configurationToStored } from "../core/config-data.js";
import type { StoredInputs } from "../core/graph-data.js";
import type { SpecFileAnalysis } from "../core/graph.js";
import { buildWorkspaceGraph, WorkspaceGraph } from "../core/graph.js";
import { sha256Hex } from "../core/hash.js";
import type { NodeHashes } from "../core/hashes.js";
import { computeWorkspaceHashes } from "../core/hashes.js";
import { Journal } from "../core/journal.js";
import { parseSpecSource } from "../core/mdx.js";
import {
  analyzeSpecImports,
  analyzeSpecReferences,
} from "../core/spec-references.js";
import { WorkspaceTextModel } from "../core/text-model.js";
import type { LoadedWorkspace } from "./config.js";
import { discoverSources } from "./discovery.js";
import type { LoadedJournal } from "./journal.js";
import { loadJournal } from "./journal.js";

/** The analyzed workspace: models plus the collected validation findings. */
export interface WorkspaceAnalysis {
  readonly classification: SourceClassification;
  /** SPEC 7.3: the configured Markdown emit destinations (may be empty). */
  readonly markdownDestinations: ReadonlySet<string>;
  /** The parseable spec sources' analyses, byte-ordered by path. */
  readonly specs: readonly SpecFileAnalysis[];
  /** The parseable code sources' analyses, byte-ordered by path. */
  readonly code: readonly CodeAnalysis[];
  readonly graph: WorkspaceGraph;
  readonly textModel: WorkspaceTextModel;
  /** SPEC 5.5: the four hashes of every requirement node. */
  readonly hashes: ReadonlyMap<string, NodeHashes>;
  readonly journal: LoadedJournal;
  /**
   * SHA-256 (hex) of each discovered source's exact bytes as analyzed —
   * the graph data's recorded derivation inputs (SPEC 13.3;
   * core/graph-data.ts). Unreadable sources have no entry (their 14.20
   * finding fails validation before any store write).
   */
  readonly sourceHashes: ReadonlyMap<string, string>;
  /**
   * Every exit-1 validation finding (SPEC 14), deterministically ordered
   * (file bytes, location, condition — SPEC 12.0). Empty exactly when the
   * workspace passes build validation (SPEC 12.1; the write-path conditions
   * of 14.22 are the writing caller's to add).
   */
  readonly findings: readonly Finding[];
  /**
   * Discovery-level configuration errors (SPEC 7.2 → 14.14): usage-class
   * (exit 2, SPEC 12.0), preceding all source analysis (SPEC 14) — when
   * non-empty, nothing was parsed and `findings` is empty.
   */
  readonly configurationErrors: readonly Finding[];
}

/** The absolute filesystem path of a workspace-relative `/`-path. */
function absoluteOf(root: string, rel: string): string {
  return path.join(root, ...rel.split("/"));
}

/**
 * SPEC 14: deterministic report order — by file (byte order), then location,
 * then condition number. The sort is stable, so equal keys keep their
 * collection order (which is already document order within a file).
 */
function orderFindings(findings: readonly Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      compareBytes(a.file ?? "", b.file ?? "") ||
      (a.range?.start ?? -1) - (b.range?.start ?? -1) ||
      (a.range?.end ?? -1) - (b.range?.end ?? -1) ||
      a.condition - b.condition,
  );
}

/**
 * A workspace's content, however sourced: the classified file listing, a
 * byte reader for the discovered sources, and the journal. The filesystem
 * workspace (`analyzeWorkspace`) and a git tree at a baseline ref
 * (SPEC 6.3, src/workspace/baseline.ts) both analyze through this shape,
 * so the baseline analysis and the current analysis can never drift apart.
 */
export interface WorkspaceContent {
  readonly classification: SourceClassification;
  /**
   * Read one discovered source's exact bytes; null when the content cannot
   * be read (reported as an unparseable source, SPEC 14.20).
   */
  readonly readSource: (rel: string) => Promise<Uint8Array | null>;
  /**
   * Load the journal (SPEC 6.1). Called only when analysis proceeds past
   * configuration errors — those precede all source analysis (SPEC 14).
   */
  readonly loadJournal: () => Promise<LoadedJournal>;
}

/**
 * Analyze the workspace (see the module header): discover, parse, and
 * validate every configured source, load the journal, assemble the graph,
 * and compute the text model and hashes. Total over invalid workspaces —
 * every condition arrives as data in `findings`/`configurationErrors`, and
 * only I/O failures throw.
 */
export async function analyzeWorkspace(
  workspace: LoadedWorkspace,
): Promise<WorkspaceAnalysis> {
  const { root, configuration } = workspace;
  const classification = await discoverSources(root, configuration);
  return analyzeWorkspaceContent(configuration, {
    classification,
    readSource: (rel) => readSourceBytes(root, rel),
    loadJournal: () => loadJournal(root),
  });
}

/**
 * Analyze already-classified workspace content (see the module header):
 * parse and validate every discovered source, load the journal, assemble
 * the graph, and compute the text model and hashes. The shared body behind
 * `analyzeWorkspace` (filesystem) and baseline reconstruction (a git tree
 * at a ref, SPEC 6.3).
 */
export async function analyzeWorkspaceContent(
  configuration: Configuration,
  content: WorkspaceContent,
): Promise<WorkspaceAnalysis> {
  const { classification } = content;

  // SPEC 14/14.14: discovery-level configuration errors are usage-class and
  // precede all source analysis — with one present, no source is parsed and
  // no finding-class condition is reported.
  const configurationErrors = classification.findings.filter(
    (finding) => conditionExitClass(finding.condition) === 2,
  );
  if (configurationErrors.length > 0) {
    const graph = buildWorkspaceGraph({ specs: [], code: [] });
    const textModel = new WorkspaceTextModel(graph.embeddingResolver());
    return {
      classification,
      markdownDestinations: new Set(),
      specs: [],
      code: [],
      graph,
      textModel,
      hashes: new Map(),
      // Not loaded: configuration errors precede all source analysis
      // (SPEC 14), and no caller consumes the journal on the exit-2 path.
      journal: {
        fileState: "absent",
        journal: new Journal([]),
        entries: [],
        findings: [],
        rawBytes: null,
      },
      sourceHashes: new Map(),
      findings: [],
      configurationErrors,
    };
  }

  const findings: Finding[] = [...classification.findings];

  const specPaths = new Set(
    classification.specSources.map((source) => source.path),
  );
  // SPEC 7.3: destinations exist exactly while emission is enabled —
  // classification by configuration alone, whether or not emission has run.
  const markdownDestinations = markdownEmitDestinations(
    configuration,
    specPaths,
  );

  // --- spec sources (SPEC 1–3; conditions 14.1–14.4, 14.8, 14.15–14.17,
  // 14.20) --------------------------------------------------------------
  const sourceHashes = new Map<string, string>();
  const specs: SpecFileAnalysis[] = [];
  for (const source of classification.specSources) {
    const bytes = await content.readSource(source.path);
    if (bytes === null) {
      findings.push(unreadableSourceFinding(source.path));
      continue;
    }
    sourceHashes.set(source.path, sha256Hex(bytes));
    try {
      const parsed = parseSpecSource(source.path, bytes);
      if (parsed.kind === "unparseable") {
        // SPEC 14.20: the file's single finding masks everything inside
        // it; references into it report as unresolved at graph resolution.
        findings.push(parsed.finding);
        continue;
      }
      const document = parsed.document;
      const imports = analyzeSpecImports(document, specPaths);
      const references = analyzeSpecReferences(document, imports);
      findings.push(...document.findings);
      findings.push(...imports.findings);
      findings.push(...references.findings);
      specs.push({ document, imports, references });
    } catch (error) {
      // SPEC 14.20: nesting beyond what the recursive analyses can process
      // (a call-stack overflow surfaces as a RangeError — possible in the
      // TypeScript re-parse of extracted import/reference expressions even
      // when the MDX parse itself succeeded) makes the file unparseable —
      // one finding, the file's contents masked, never a crash (SPEC 12.0).
      if (!(error instanceof RangeError)) throw error;
      findings.push({
        condition: 20,
        file: source.path,
        range: { start: 0, end: 0 },
        message:
          `unparseable source: not well-formed MDX — the file's nesting ` +
          `exceeds what the analyzer can process, so no location inside ` +
          `it can be analyzed; simplify or split the file (SPEC 14.20)`,
      });
    }
  }

  // --- code sources (SPEC 4; conditions 14.8, 14.11, 14.15, 14.18,
  // 14.20) ---------------------------------------------------------------
  const code: CodeAnalysis[] = [];
  for (const source of classification.codeSources) {
    const bytes = await content.readSource(source.path);
    if (bytes === null) {
      findings.push(unreadableSourceFinding(source.path));
      continue;
    }
    sourceHashes.set(source.path, sha256Hex(bytes));
    const analyzed = analyzeCodeSource(source.path, bytes, {
      specPaths,
      markdownDestinations,
    });
    if (analyzed.kind === "unparseable") {
      findings.push(analyzed.finding);
      continue;
    }
    findings.push(...analyzed.analysis.findings);
    code.push(analyzed.analysis);
  }

  // --- journal (SPEC 6.1, 5.4 → 14.13) ----------------------------------
  const journal = await content.loadJournal();
  findings.push(...journal.findings);

  // --- graph, text model, hashes (SPEC 5; conditions 14.5–14.7, 14.9) ---
  const graph = buildWorkspaceGraph({ specs, code });
  findings.push(...graph.findings);
  const textModel = new WorkspaceTextModel(graph.embeddingResolver());
  // Total even over invalid workspaces (core/hashes.ts); only valid
  // workspaces ever surface hashes (SPEC 12.1, 13.3).
  const hashes = computeWorkspaceHashes(graph, textModel, journal.journal);

  return {
    classification,
    markdownDestinations,
    specs,
    code,
    graph,
    textModel,
    hashes,
    journal,
    sourceHashes,
    findings: orderFindings(findings),
    configurationErrors: [],
  };
}

/**
 * The graph data's recorded derivation inputs for this analysis
 * (SPEC 13.3; core/graph-data.ts `StoredInputs`): the configuration file's
 * content hash with its parsed form, the journal's content hash, and every
 * analyzed source's content hash in byte order of path (SPEC 12.0). Shared
 * by every producer of stored graph data — `build`, refresh-on-read,
 * `check`'s would-be comparison, and the finishing regeneration of
 * `rename`/`move` — so all of them record inputs by one rule.
 */
export function workspaceInputsOf(
  workspace: LoadedWorkspace,
  analysis: WorkspaceAnalysis,
): StoredInputs {
  return {
    configHash: workspace.configHash,
    config: configurationToStored(workspace.configuration),
    journalHash:
      analysis.journal.rawBytes === null
        ? null
        : sha256Hex(analysis.journal.rawBytes),
    sources: [...analysis.sourceHashes.entries()]
      .map(([sourcePath, hash]) => ({ path: sourcePath, hash }))
      .sort((a, b) => compareBytes(a.path, b.path)),
  };
}

/**
 * Read one discovered source's exact bytes from the filesystem, null when
 * unreadable — the reader `analyzeWorkspace` hands the shared body.
 */
async function readSourceBytes(
  root: string,
  rel: string,
): Promise<Uint8Array | null> {
  try {
    return await fsp.readFile(absoluteOf(root, rel));
  } catch {
    return null;
  }
}

/**
 * SPEC 14.20: a discovered source whose content cannot be read. On the
 * filesystem that means the file vanished (or became unreadable) between
 * the walk and the read — concurrent modification, SPEC 13.5
 * last-write-wins territory; it was discovered, and its content cannot be
 * analyzed.
 */
function unreadableSourceFinding(rel: string): Finding {
  return {
    condition: 20,
    file: rel,
    message:
      `unparseable source: the discovered file could not be read — it ` +
      `changed or vanished while the command ran; re-run the command ` +
      `once the workspace is quiescent (SPEC 13.5, 14.20)`,
  };
}
