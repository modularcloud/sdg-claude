// TEST-SPEC §16 P-4 (hash laws) — PROP-03.
//
// One registered product-facing property test (C-2 "one code path"): a
// seeded, reproducible generator (helpers/property.ts, H-10; fixed seed set
// in CI, E-5) produces random valid workspaces — 1–3 `.mdx` spec sources
// with nested sections, prose, comments, unconditional imports of every
// earlier file, `d` references and `{text(...)}` embeddings in both external
// and local form, tags, and coverage attributes — plus 1–3 random single
// edits, each applied independently to the pristine workspace. Per edit, the
// trial asserts the SPEC 5.5 iff-conditions for all four hashes on every
// node present on both sides, and per trial it asserts identical-workspace
// hash identity (the same bytes staged in a second directory hash
// identically per node, the H-6 two-directory protocol):
//
//   * ownHash changed iff the node's own content sequence (SPEC 1.6) changed
//     — a run edited, or a child/embedded reference added, removed,
//     retargeted, or repositioned; an embedded target's text is no part of
//     the embedder's own content, so embedded-target edits leave the
//     embedder's ownHash byte-identical (P-4's insensitivity arm).
//   * subtreeHash changed iff a node in the subtree was added, removed, or
//     reordered, or a node in the subtree had its own content changed.
//   * metadataHash changed iff the node's `d`-declared target set, coverage
//     attribute, or tag set changed (duplicates collapse, 2.2/2.6; `d={[]}`
//     and `tags=""` are equivalent to omission; reference spellings never
//     enter any hash, 5.4).
//   * effectiveHash changed iff own content changed in the subtree, a
//     subtree node's dependency edges (5.2: `depends` + `embeds`, one pair
//     per edge) were added, removed, or retargeted, or a dependency-edge
//     target's effectiveHash changed — computed as a fixpoint over the
//     dependency closure, so target changes propagate (P-4's monotonicity
//     arm).
//
// The expected side of every iff is predicted from the harness's own
// workspace model: the generator emits a model, the edit produces a second
// model, and a generic model comparison — own-content token sequences,
// deduplicated `d`/tag sets, per-edge dependency pairs, and two recursions
// over the contains tree and the dependency closure — decides which hashes
// must change. Hash values themselves are opaque: every assertion is a
// self-comparison (changed / byte-identical across the staged edit, or
// equal across identically staged directories), per H-4.
//
// The edit menu spans all four laws and their negative space. Content edits:
// prose-run replacement, embedding add/remove/retarget, two embeddings of
// distinct targets exchanging positions around byte-identical runs, two
// child sections exchanging positions. Structure edits: child section
// added/removed (removal only of subtrees nothing references, so references
// keep resolving). Metadata edits: coverage toggled between omitted and
// "none", a tag added or a set-changing tag removed. Dependency edits: a
// `d` reference added, removed, or retargeted. No-op edits, staged as real
// byte changes that SPEC 5.4/2.2/2.6/2.7 make hash-invisible: reference
// respelling (quote flavor, dot vs computed access), `d` array reordering,
// `d={ref}` vs `d={[ref]}`, `d={[]}` vs omitted, `tags=""` vs omitted, a
// duplicate `d` reference or tag token added or removed, and an MDX comment
// line added or removed (comments enter no text and no hash). Each trial
// draws its edits from distinct law classes — content, referenced-target
// text (the insensitivity/propagation arm: a prose edit on a node that is a
// dependency or embedding target), structure, metadata, dependency, no-op —
// so the fixed seed set (E-5) exercises every law deterministically; the
// class mix under the committed seeds was verified by an implementation-time
// dry-run (all six classes and every law-relevant prediction pattern occur,
// and every staged source — before and after each edit — parses under
// remark-mdx).
//
// P-4 is outside every CERTIFICATIONS.md fixture scope (its preamble:
// conformers for P-4/P-5/P-6 would be near-complete second products), so
// this body binds only to the real product surface: `build`, `query nodes`,
// and the full `query node` report (SPEC 11), decoded through the H-3
// adapters exactly as SUITE-19 (section-5.5.ts) decodes hashes.
//
// Staging discipline (byte-exact per HARNESS-01; the generator, not the
// prediction model, owns these choices — they make the model's own-content
// tokenization exact for every staged shape):
//   * Prose draws from a plain ASCII alphabet that excludes MDX-structural
//     characters (`<`, `>`, `{`, `}`, backtick, `~`, `&`, `\`) and every
//     line starts with an alphanumeric anchor, so a prose byte can never
//     open a fence, tag, expression container, list, or blockquote and
//     every prose line survives compilation byte-exactly (SPEC 3 drops only
//     lines emptied purely by removals).
//   * Every construct the model must excise is line-disciplined: section
//     opening and closing tags stand alone on their lines, imports are
//     own-line and followed by a mandatory blank line (SPEC 2.1 stages
//     imports this way; MDX ESM blocks extend to the next blank line), and
//     comments are own-line expressions — so removal always drops whole
//     lines with their terminators, and the parent's runs are exactly the
//     staged prose/blank lines.
//   * Embeddings live inside prose lines with non-empty prose on both
//     sides, so the excised expression divides staged runs at exactly the
//     modeled positions and no line is ever emptied by embedding removal
//     (SPEC 1.6: the excised expression counts as remaining line content).
//   * Line terminators are LF throughout (terminator classes are P-2's
//     input space, not P-4's).
//   * Dependency and embedding references target only earlier files (every
//     file imports all earlier files unconditionally, so reference edits
//     never add or remove import lines; unused imports are valid, 2.1) or
//     sections of earlier top-level subtrees of the same file — references
//     always resolve, no target is an ancestor, and the combined
//     contains/depends/embeds graph is acyclic by construction (SPEC 5.3),
//     before and after every edit.
//   * Section id segments are `s0`, `s1`, … per file (fresh-counter unique,
//     1.3/1.4-valid, TypeScript-identifier-safe for external chain form).

import type { NodeHashes } from "../../helpers/adapters/index.js";
import {
  decodeNodeReport,
  decodeNodeRowsReport,
} from "../../helpers/adapters/index.js";
import { fail } from "../../helpers/assertions.js";
import type { Choices, Gen } from "../../helpers/property.js";
import { checkProperty, listOf } from "../../helpers/property.js";
import { defineProductTest } from "../../helpers/registry.js";
import type { ProductTestEntry } from "../../helpers/registry.js";
import type { ProductBinding } from "../../helpers/subprocess.js";
import { TestWorkspace } from "../../helpers/workspace.js";
import {
  assertSameJson,
  buildOk,
  runJson,
  sortedIdentities,
} from "./support.js";

// Minimal declarative configuration (SPEC 7): exactly one spec group. No
// code groups and no Markdown emission — hashes are the subject.
const SPECS_ONLY_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  }
})
`;

// ---------------------------------------------------------------------------
// Workspace model
//
// The generator's intermediate representation: plain JSON-safe data (edits
// clone it with structuredClone), rendered to source bytes and interpreted
// into per-node semantics by pure functions, so the staged bytes and the
// predictions always describe the same workspace.

/** A `d` or `text(...)` reference. */
export interface RefModel {
  /** Target file index in the workspace's file list. */
  file: number;
  /** Target dotted id; `""` targets the file's root (external form only). */
  dotted: string;
  /**
   * Spelling selector: renderRef derives the concrete spelling (quote
   * flavor, dot vs computed access) from it. Spellings never enter any hash
   * (SPEC 5.4) — respell edits change only this field.
   */
  spell: number;
}

export interface TextPart {
  kind: "text";
  text: string;
}

export interface EmbedPart {
  kind: "embed";
  ref: RefModel;
}

/** Prose-line parts: `[text (embed text)*]` — non-empty text between embeds. */
export type ProsePart = TextPart | EmbedPart;

export interface ProseItem {
  kind: "prose";
  parts: ProsePart[];
}

export interface BlankItem {
  kind: "blank";
}

export interface CommentItem {
  kind: "comment";
  /** Interior words (no slash, no star): rendered as an own-line MDX comment. */
  words: string;
}

export interface SectionItem {
  kind: "section";
  /** This section's own id segment; the dotted id is contextual (SPEC 1.3). */
  seg: string;
  /** `null` = prop omitted; `[]` = `tags=""` (equivalent, SPEC 2.6). */
  tags: string[] | null;
  /** `coverage="none"` when true; prop omitted (default required) when false. */
  coverageNone: boolean;
  /** `null` = prop omitted; `[]` = `d={[]}` (equivalent, SPEC 2.2). */
  deps: RefModel[] | null;
  /** Render `d={ref}` instead of `d={[ref]}` when exactly one reference. */
  depsSingle: boolean;
  items: BodyItem[];
}

export type BodyItem = ProseItem | BlankItem | CommentItem | SectionItem;

export interface FileModel {
  items: BodyItem[];
  /** Fresh-segment counter (SPEC 1.3 uniqueness), shared with addChild. */
  nextSeg: number;
}

export interface WorkspaceModel {
  files: FileModel[];
}

const FILE_NAMES = ["A", "B", "C"] as const;

function filePath(fileIndex: number): string {
  return `specs/${FILE_NAMES[fileIndex]}.mdx`;
}

/** Import binding of file `j` in every later file (never S/Spec/text, 2.1). */
function importBinding(fileIndex: number): string {
  return `M${String(fileIndex)}`;
}

function refIdentity(ref: RefModel): string {
  return ref.dotted === ""
    ? filePath(ref.file)
    : `${filePath(ref.file)}#${ref.dotted}`;
}

// ---------------------------------------------------------------------------
// Rendering (model → source bytes)

/**
 * Spelling variants per reference form (SPEC 2.2/2.4): local references are
 * quoted string literals (2 flavors); external references are property
 * chains (dot access, double-quoted computed access, single-quoted computed
 * access — segments are TypeScript identifiers by construction, so all
 * three are legal); an external root reference is the bare binding (one
 * spelling). Respell edits require ≥ 2 variants.
 */
export function spellingVariants(ref: RefModel, hostFile: number): number {
  if (ref.file === hostFile) return 2;
  return ref.dotted === "" ? 1 : 3;
}

function renderRef(ref: RefModel, hostFile: number): string {
  if (ref.file === hostFile) {
    if (ref.dotted === "") {
      throw new Error(
        "P-4 harness defect: a local reference cannot name the file root (SPEC 2.2)",
      );
    }
    return ref.spell % 2 === 0 ? `"${ref.dotted}"` : `'${ref.dotted}'`;
  }
  const binding = importBinding(ref.file);
  if (ref.dotted === "") return binding;
  const segments = ref.dotted.split(".");
  switch (ref.spell % 3) {
    case 0:
      return `${binding}.${segments.join(".")}`;
    case 1:
      return `${binding}${segments.map((s) => `["${s}"]`).join("")}`;
    default:
      return `${binding}${segments.map((s) => `['${s}']`).join("")}`;
  }
}

function renderOpenTag(
  section: SectionItem,
  dotted: string,
  hostFile: number,
): string {
  let props = ` id="${dotted}"`;
  if (section.tags !== null) props += ` tags="${section.tags.join(" ")}"`;
  if (section.coverageNone) props += ` coverage="none"`;
  if (section.deps !== null) {
    const refs = section.deps.map((ref) => renderRef(ref, hostFile));
    props +=
      section.depsSingle && refs.length === 1
        ? ` d={${refs[0]}}`
        : ` d={[${refs.join(", ")}]}`;
  }
  return `<S${props}>`;
}

function renderItems(
  items: readonly BodyItem[],
  parentDotted: string,
  hostFile: number,
  out: string[],
): void {
  for (const item of items) {
    switch (item.kind) {
      case "blank":
        out.push("");
        break;
      case "comment":
        out.push(`{/* ${item.words} */}`);
        break;
      case "prose":
        out.push(
          item.parts
            .map((part) =>
              part.kind === "text"
                ? part.text
                : `{text(${renderRef(part.ref, hostFile)})}`,
            )
            .join(""),
        );
        break;
      case "section": {
        const dotted =
          parentDotted === "" ? item.seg : `${parentDotted}.${item.seg}`;
        out.push(renderOpenTag(item, dotted, hostFile));
        renderItems(item.items, dotted, hostFile, out);
        out.push("</S>");
        break;
      }
    }
  }
}

/** Source bytes per workspace-relative path (LF-terminated lines). */
export function renderWorkspace(model: WorkspaceModel): Record<string, string> {
  const files: Record<string, string> = {};
  model.files.forEach((file, fileIndex) => {
    const lines: string[] = [];
    for (let j = 0; j < fileIndex; j += 1) {
      lines.push(`import ${importBinding(j)} from "./${FILE_NAMES[j]}.xspec"`);
    }
    // Mandatory blank line after the import block (module header).
    if (fileIndex > 0) lines.push("");
    renderItems(file.items, "", fileIndex, lines);
    files[filePath(fileIndex)] = `${lines.join("\n")}\n`;
  });
  return files;
}

// ---------------------------------------------------------------------------
// Semantics (model → per-node hash inputs) and change prediction
//
// The own-content token sequence mirrors SPEC 1.6/3 for the staged shapes
// exactly (see the staging discipline in the module header): section tag
// lines, import lines, and comment lines are whole-line removals dropped
// with their terminators; prose lines survive byte-exactly; a child
// construct or excised `text(...)` expression divides the runs and enters
// as a reference token.

type OwnToken = readonly [kind: "run" | "child" | "embed", value: string];

interface NodeSem {
  /** Direct child identities in document order. */
  readonly children: readonly string[];
  /** JSON of the own-content token sequence (runs + references, SPEC 1.6). */
  readonly ownTokens: string;
  /** JSON of [sorted deduplicated `d` target set, coverage, sorted tag set]. */
  readonly metaKey: string;
  /**
   * JSON of the dependency-edge pair multiset's identity components: the
   * deduplicated `depends` targets plus the deduplicated `embeds` targets
   * (one entry per edge, SPEC 5.5/5.2), sorted.
   */
  readonly pairKey: string;
  /** Deduplicated union of dependency-edge targets (for the closure walk). */
  readonly edgeTargets: readonly string[];
}

function dedupSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

interface WalkResult {
  readonly tokens: OwnToken[];
  readonly children: string[];
  readonly embedTargets: string[];
}

function walkItems(
  items: readonly BodyItem[],
  fileIndex: number,
  parentDotted: string,
  leading: string,
  sems: Map<string, NodeSem>,
): WalkResult {
  const tokens: OwnToken[] = [];
  const children: string[] = [];
  const embedTargets: string[] = [];
  let run = leading;
  for (const item of items) {
    switch (item.kind) {
      case "blank":
        run += "\n";
        break;
      case "comment":
        // Comments enter no text and no hash (SPEC 2.7); the own-line
        // comment's line is dropped with its terminator (SPEC 3).
        break;
      case "prose": {
        for (const part of item.parts) {
          if (part.kind === "text") {
            run += part.text;
          } else {
            tokens.push(["run", run]);
            run = "";
            const identity = refIdentity(part.ref);
            tokens.push(["embed", identity]);
            embedTargets.push(identity);
          }
        }
        run += "\n";
        break;
      }
      case "section": {
        const dotted =
          parentDotted === "" ? item.seg : `${parentDotted}.${item.seg}`;
        const identity = `${filePath(fileIndex)}#${dotted}`;
        tokens.push(["run", run]);
        run = "";
        tokens.push(["child", identity]);
        children.push(identity);
        const inner = walkItems(item.items, fileIndex, dotted, "", sems);
        const depTargets = (item.deps ?? []).map(refIdentity);
        const depSet = dedupSorted(depTargets);
        const embedSet = dedupSorted(inner.embedTargets);
        sems.set(identity, {
          children: inner.children,
          ownTokens: JSON.stringify(inner.tokens),
          metaKey: JSON.stringify([
            depSet,
            item.coverageNone ? "none" : "required",
            dedupSorted(item.tags ?? []),
          ]),
          pairKey: JSON.stringify([...depSet, ...embedSet].sort()),
          edgeTargets: dedupSorted([...depSet, ...embedSet]),
        });
        break;
      }
    }
  }
  tokens.push(["run", run]);
  return { tokens, children, embedTargets };
}

/** Per-node semantics of every requirement node (roots included). */
export function semanticsOf(model: WorkspaceModel): Map<string, NodeSem> {
  const sems = new Map<string, NodeSem>();
  model.files.forEach((file, fileIndex) => {
    // Import lines are dropped whole; the mandatory blank line after them
    // contributes one terminator to the root's first run (SPEC 3).
    const leading = fileIndex > 0 ? "\n" : "";
    const walked = walkItems(file.items, fileIndex, "", leading, sems);
    const embedSet = dedupSorted(walked.embedTargets);
    sems.set(filePath(fileIndex), {
      children: walked.children,
      ownTokens: JSON.stringify(walked.tokens),
      // A root has no `d` targets, no coverage attribute, and no tags
      // (SPEC 5.5) — its metadata inputs are constant.
      metaKey: JSON.stringify([[], "root", []]),
      pairKey: JSON.stringify(embedSet),
      edgeTargets: embedSet,
    });
  });
  return sems;
}

interface PredictedChange {
  readonly own: boolean;
  readonly subtree: boolean;
  readonly metadata: boolean;
  readonly effective: boolean;
}

/**
 * The SPEC 5.5 change predictions for every node present in both models:
 * subtree and effective change are recursions over the contains tree and
 * the dependency closure (memoized; the staged graphs are acyclic by
 * construction, and an unexpected cycle is a loud harness defect).
 */
export function predictChanges(
  before: Map<string, NodeSem>,
  after: Map<string, NodeSem>,
): Map<string, PredictedChange> {
  const common = [...before.keys()].filter((id) => after.has(id));
  const commonSet = new Set(common);
  const at = (map: Map<string, NodeSem>, id: string): NodeSem => {
    const sem = map.get(id);
    if (sem === undefined) {
      throw new Error(`P-4 harness defect: no semantics for ${id}`);
    }
    return sem;
  };
  const own = (id: string): boolean =>
    at(before, id).ownTokens !== at(after, id).ownTokens;
  const meta = (id: string): boolean =>
    at(before, id).metaKey !== at(after, id).metaKey;

  const memo = <T>(
    compute: (id: string, recurse: (next: string) => T) => T,
  ): ((id: string) => T) => {
    const cache = new Map<string, T>();
    const visiting = new Set<string>();
    const resolve = (id: string): T => {
      const cached = cache.get(id);
      if (cached !== undefined) return cached;
      if (visiting.has(id)) {
        throw new Error(
          `P-4 harness defect: cycle through ${id} — generated graphs are acyclic by construction (SPEC 5.3)`,
        );
      }
      visiting.add(id);
      const result = compute(id, resolve);
      visiting.delete(id);
      cache.set(id, result);
      return result;
    };
    return resolve;
  };

  // Children/targets present on both sides: hash comparison is defined only
  // for such nodes (SPEC 5.6); membership changes surface through the
  // parent's own tokens and the pair multiset.
  const commonChildren = (id: string): string[] =>
    at(before, id).children.filter(
      (child) => commonSet.has(child) && at(after, id).children.includes(child),
    );
  const commonTargets = (id: string): string[] =>
    at(before, id).edgeTargets.filter(
      (t) => commonSet.has(t) && at(after, id).edgeTargets.includes(t),
    );

  const subtree = memo<boolean>(
    (id, recurse) => own(id) || commonChildren(id).some(recurse),
  );
  const effective = memo<boolean>(
    (id, recurse) =>
      own(id) ||
      commonChildren(id).some(recurse) ||
      at(before, id).pairKey !== at(after, id).pairKey ||
      commonTargets(id).some(recurse),
  );

  const predictions = new Map<string, PredictedChange>();
  for (const id of common) {
    predictions.set(id, {
      own: own(id),
      subtree: subtree(id),
      metadata: meta(id),
      effective: effective(id),
    });
  }
  return predictions;
}

// ---------------------------------------------------------------------------
// Model generation

/** Alphanumeric line-start anchors: never a Markdown block marker. */
const ANCHOR_CHARS = [
  "a",
  "b",
  "k",
  "z",
  "n",
  "d",
  "p",
  "w",
  "0",
  "7",
] as const;

/** MDX-safe prose interior (module header): plain ASCII only. */
const PROSE_REST: ReadonlyArray<readonly [number, string]> = [
  [10, "a"],
  [4, "b"],
  [3, "e"],
  [3, "r"],
  [2, "z"],
  [2, "K"],
  [2, "0"],
  [2, "9"],
  [6, " "],
  [2, "."],
  [1, ","],
  [1, "-"],
  [1, ":"],
];

/** A prose run: anchored non-empty plain text (kept under SPEC 3, always). */
const proseText: Gen<string> = (choices) => {
  const anchor = choices.pick(ANCHOR_CHARS);
  const rest = listOf((c: Choices) => c.weightedPick(PROSE_REST), { max: 7 })(
    choices,
  ).join("");
  return anchor + rest;
};

/** Comment interior words: letters and spaces only (no `/`, no `*`). */
const commentWords: Gen<string> = (choices) => {
  const anchor = choices.pick(["c", "note", "todo", "x"] as const);
  const rest = listOf(
    (c: Choices) =>
      c.weightedPick<string>([
        [6, "a"],
        [3, "m"],
        [3, " "],
        [2, "q"],
      ]),
    { max: 5 },
  )(choices).join("");
  return anchor + rest;
};

/** 1.4-valid tag tokens (one dotted: tags MAY contain `.`). */
const TAG_POOL = ["t1", "t2", "t3", "alpha", "beta.x", "zeta"] as const;

/** A reference target available to a generator or edit site. */
interface RefTarget {
  readonly file: number;
  readonly dotted: string;
}

const genRefFrom =
  (pool: readonly RefTarget[]): Gen<RefModel> =>
  (choices) => {
    const target = choices.pick(pool);
    return {
      file: target.file,
      dotted: target.dotted,
      spell: choices.intInclusive(0, 5),
    };
  };

const MAX_SECTIONS_PER_FILE = 3;

interface GenFileCtx {
  readonly fileIndex: number;
  nextSeg: number;
}

function genProseItem(choices: Choices, pool: readonly RefTarget[]): ProseItem {
  const parts: ProsePart[] = [{ kind: "text", text: proseText(choices) }];
  while (
    parts.length < 5 &&
    pool.length > 0 &&
    choices.boolean(parts.length === 1 ? 0.4 : 0.25)
  ) {
    parts.push({ kind: "embed", ref: genRefFrom(pool)(choices) });
    parts.push({ kind: "text", text: ` ${proseText(choices)}` });
  }
  return { kind: "prose", parts };
}

function genSection(
  choices: Choices,
  ctx: GenFileCtx,
  pool: readonly RefTarget[],
  depth: number,
): SectionItem | null {
  if (ctx.nextSeg >= MAX_SECTIONS_PER_FILE) return null;
  const seg = `s${String(ctx.nextSeg)}`;
  ctx.nextSeg += 1;

  let tags: string[] | null = null;
  if (choices.boolean(0.3)) {
    tags = [...listOf((c: Choices) => c.pick(TAG_POOL), { max: 3 })(choices)];
    // Occasionally a duplicate token (collapses, SPEC 2.6).
    if (tags.length > 0 && choices.boolean(0.2)) tags.push(tags[0]);
  }
  const coverageNone = choices.boolean(0.2);

  let deps: RefModel[] | null = null;
  let depsSingle = false;
  if (choices.boolean(0.55)) {
    if (pool.length === 0) {
      deps = choices.boolean(0.3) ? [] : null;
    } else {
      deps = [...listOf(genRefFrom(pool), { max: 2 })(choices)];
      // Occasionally a duplicate reference (collapses, SPEC 2.2).
      if (deps.length > 0 && choices.boolean(0.2)) {
        deps.push({ ...deps[0], spell: choices.intInclusive(0, 5) });
      }
      depsSingle = deps.length === 1 && choices.boolean(0.5);
    }
  }

  const items: BodyItem[] = [];
  let count = 0;
  while (count < 3 && choices.boolean(0.65)) {
    count += 1;
    const shape = choices.weightedPick<
      "prose" | "blank" | "comment" | "section"
    >(
      depth < 2
        ? [
            [4, "prose"],
            [1, "blank"],
            [1, "comment"],
            [3, "section"],
          ]
        : [
            [4, "prose"],
            [1, "blank"],
            [1, "comment"],
          ],
    );
    if (shape === "section") {
      const child = genSection(choices, ctx, pool, depth + 1);
      items.push(child ?? genProseItem(choices, pool));
    } else if (shape === "prose") {
      items.push(genProseItem(choices, pool));
    } else if (shape === "blank") {
      items.push({ kind: "blank" });
    } else {
      items.push({ kind: "comment", words: commentWords(choices) });
    }
  }
  return { kind: "section", seg, tags, coverageNone, deps, depsSingle, items };
}

/** All dotted ids inside a section item (itself included), document order. */
function collectDotted(section: SectionItem, parentDotted: string): string[] {
  const dotted =
    parentDotted === "" ? section.seg : `${parentDotted}.${section.seg}`;
  const out = [dotted];
  for (const item of section.items) {
    if (item.kind === "section") out.push(...collectDotted(item, dotted));
  }
  return out;
}

/** The random-workspace generator (module header). */
export const genWorkspaceModel: Gen<WorkspaceModel> = (choices) => {
  // Simplest (one file) first for shrinking; multi-file weighted up so
  // cross-file reference pools — and with them the dependency and no-op
  // edit classes — are routinely populated under the fixed seeds.
  const fileCount = choices.weightedPick<number>([
    [2, 1],
    [4, 2],
    [4, 3],
  ]);
  const files: FileModel[] = [];
  const fileSections: string[][] = [];
  for (let fileIndex = 0; fileIndex < fileCount; fileIndex += 1) {
    const external: RefTarget[] = [];
    for (let j = 0; j < fileIndex; j += 1) {
      external.push({ file: j, dotted: "" });
      for (const dotted of fileSections[j]) external.push({ file: j, dotted });
    }
    const local: RefTarget[] = [];
    const sections: string[] = [];
    const ctx: GenFileCtx = { fileIndex, nextSeg: 0 };
    const items: BodyItem[] = [];
    // Guaranteed construct-free first prose line: every file root has an
    // editable run, and editProse (the universal fallback) always has a site.
    items.push({
      kind: "prose",
      parts: [{ kind: "text", text: proseText(choices) }],
    });
    let count = 0;
    while (count < 5 && choices.boolean(0.75)) {
      count += 1;
      const shape = choices.weightedPick<
        "prose" | "blank" | "comment" | "section"
      >([
        [3, "prose"],
        [2, "blank"],
        [1, "comment"],
        [5, "section"],
      ]);
      if (shape === "section") {
        // The local pool is frozen for the whole subtree: only sections of
        // earlier top-level subtrees are targetable (module header).
        const section = genSection(choices, ctx, [...local, ...external], 0);
        if (section === null) {
          items.push(genProseItem(choices, [...local, ...external]));
          continue;
        }
        items.push(section);
        for (const dotted of collectDotted(section, "")) {
          sections.push(dotted);
          local.push({ file: fileIndex, dotted });
        }
      } else if (shape === "prose") {
        items.push(genProseItem(choices, [...local, ...external]));
      } else if (shape === "blank") {
        items.push({ kind: "blank" });
      } else {
        items.push({ kind: "comment", words: commentWords(choices) });
      }
    }
    files.push({ items, nextSeg: ctx.nextSeg });
    fileSections.push(sections);
  }
  return { files };
};

// ---------------------------------------------------------------------------
// Edits
//
// An edit is plain JSON-safe data addressing nodes by identity and body
// items/parts by index; applyEdit clones the model, mutates the clone, and
// returns it with a human-readable description. Every edit changes at least
// one staged byte and keeps the workspace valid (module header).

export type Edit =
  | {
      kind: "editProse";
      node: string;
      item: number;
      part: number;
      text: string;
    }
  | { kind: "addChild"; node: string; at: number; text: string }
  | { kind: "removeChild"; node: string; item: number }
  | { kind: "swapChildren"; node: string; itemA: number; itemB: number }
  | {
      kind: "addEmbed";
      node: string;
      item: number;
      ref: RefModel;
      tail: string;
    }
  | { kind: "removeEmbed"; node: string; item: number; part: number }
  | {
      kind: "retargetEmbed";
      node: string;
      item: number;
      part: number;
      ref: RefModel;
    }
  | {
      kind: "swapEmbeds";
      node: string;
      itemA: number;
      partA: number;
      itemB: number;
      partB: number;
    }
  | { kind: "depAdd"; node: string; ref: RefModel }
  | { kind: "depRemove"; node: string; index: number }
  | { kind: "depRetarget"; node: string; index: number; ref: RefModel }
  | { kind: "depSwap"; node: string; indexA: number; indexB: number }
  | { kind: "depDuplicate"; node: string; index: number; spell: number }
  | { kind: "depFormToggle"; node: string }
  | { kind: "depEmptyToggle"; node: string }
  | { kind: "respellDep"; node: string; index: number; bump: number }
  | {
      kind: "respellEmbed";
      node: string;
      item: number;
      part: number;
      bump: number;
    }
  | { kind: "coverageToggle"; node: string }
  | { kind: "tagsAdd"; node: string; token: string }
  | { kind: "tagsRemove"; node: string; index: number }
  | { kind: "tagsSwap"; node: string; indexA: number; indexB: number }
  | { kind: "tagsEmptyToggle"; node: string }
  | { kind: "commentAdd"; node: string; at: number; words: string }
  | { kind: "commentRemove"; node: string; item: number };

/** A node located in a model, with edit-site context. */
interface NodeLoc {
  readonly identity: string;
  readonly fileIndex: number;
  /** The node's own body items (the file's items for a root). */
  readonly items: BodyItem[];
  /** The section item, or null for a root. */
  readonly section: SectionItem | null;
  /**
   * Root-level item index of the containing top-level subtree (sections),
   * or null for roots — the reference-pool horizon (module header).
   */
  readonly topIndex: number | null;
}

function nodesOf(model: WorkspaceModel): NodeLoc[] {
  const nodes: NodeLoc[] = [];
  const walkSection = (
    section: SectionItem,
    fileIndex: number,
    parentDotted: string,
    topIndex: number,
  ): void => {
    const dotted =
      parentDotted === "" ? section.seg : `${parentDotted}.${section.seg}`;
    nodes.push({
      identity: `${filePath(fileIndex)}#${dotted}`,
      fileIndex,
      items: section.items,
      section,
      topIndex,
    });
    for (const item of section.items) {
      if (item.kind === "section") {
        walkSection(item, fileIndex, dotted, topIndex);
      }
    }
  };
  model.files.forEach((file, fileIndex) => {
    nodes.push({
      identity: filePath(fileIndex),
      fileIndex,
      items: file.items,
      section: null,
      topIndex: null,
    });
    file.items.forEach((item, index) => {
      if (item.kind === "section") walkSection(item, fileIndex, "", index);
    });
  });
  return nodes;
}

function locateNode(model: WorkspaceModel, identity: string): NodeLoc {
  const found = nodesOf(model).find((node) => node.identity === identity);
  if (found === undefined) {
    throw new Error(`P-4 harness defect: cannot locate node ${identity}`);
  }
  return found;
}

/**
 * Targets a reference created at `node` may name (module header): every
 * node of an earlier file (roots included, SPEC 2.2 external form), plus
 * sections of earlier top-level subtrees of the same file — for root-level
 * prose sites, subtrees under root items before `beforeItem`.
 */
function targetPoolFor(
  model: WorkspaceModel,
  node: NodeLoc,
  beforeItem: number,
): RefTarget[] {
  const pool: RefTarget[] = [];
  const horizon = node.topIndex ?? beforeItem;
  model.files[node.fileIndex].items.slice(0, horizon).forEach((item) => {
    if (item.kind === "section") {
      for (const dotted of collectDotted(item, "")) {
        pool.push({ file: node.fileIndex, dotted });
      }
    }
  });
  for (let j = 0; j < node.fileIndex; j += 1) {
    pool.push({ file: j, dotted: "" });
    model.files[j].items.forEach((item) => {
      if (item.kind === "section") {
        for (const dotted of collectDotted(item, "")) {
          pool.push({ file: j, dotted });
        }
      }
    });
  }
  return pool;
}

/** Every identity referenced by any `d` or embedding in the model. */
function referencedIdentities(model: WorkspaceModel): Set<string> {
  const referenced = new Set<string>();
  const walkBody = (items: readonly BodyItem[]): void => {
    for (const item of items) {
      if (item.kind === "prose") {
        for (const part of item.parts) {
          if (part.kind === "embed") referenced.add(refIdentity(part.ref));
        }
      } else if (item.kind === "section") {
        for (const ref of item.deps ?? []) referenced.add(refIdentity(ref));
        walkBody(item.items);
      }
    }
  };
  for (const file of model.files) walkBody(file.items);
  return referenced;
}

// --- edit-site enumeration ---------------------------------------------------

interface ProseSite {
  readonly node: string;
  readonly item: number;
  readonly part: number;
}

function proseSitesOf(nodes: readonly NodeLoc[]): ProseSite[] {
  const sites: ProseSite[] = [];
  for (const node of nodes) {
    node.items.forEach((item, itemIndex) => {
      if (item.kind !== "prose") return;
      item.parts.forEach((part, partIndex) => {
        if (part.kind === "text") {
          sites.push({ node: node.identity, item: itemIndex, part: partIndex });
        }
      });
    });
  }
  return sites;
}

function embedSitesOf(nodes: readonly NodeLoc[]): {
  readonly node: NodeLoc;
  readonly item: number;
  readonly part: number;
  readonly ref: RefModel;
}[] {
  const sites: {
    node: NodeLoc;
    item: number;
    part: number;
    ref: RefModel;
  }[] = [];
  for (const node of nodes) {
    node.items.forEach((item, itemIndex) => {
      if (item.kind !== "prose") return;
      item.parts.forEach((part, partIndex) => {
        if (part.kind === "embed") {
          sites.push({ node, item: itemIndex, part: partIndex, ref: part.ref });
        }
      });
    });
  }
  return sites;
}

// --- per-class edit generation ------------------------------------------------

export type EditClass =
  | "content"
  | "referencedText"
  | "structure"
  | "metadata"
  | "dependency"
  | "noop";

const EDIT_CLASSES: readonly EditClass[] = [
  "content",
  "referencedText",
  "structure",
  "metadata",
  "dependency",
  "noop",
];

/** The universal fallback: replace a prose run (a site always exists). */
function genEditProse(choices: Choices, sites: readonly ProseSite[]): Edit {
  const site = choices.pick(sites);
  return { kind: "editProse", ...site, text: proseText(choices) };
}

/**
 * One random edit of the given class against the given model (exported for
 * the P-6 interleaving generator, which draws edits one at a time against an
 * evolving model — section-16-p5-p6.ts).
 */
export function genEditOfClass(
  choices: Choices,
  model: WorkspaceModel,
  editClass: EditClass,
): Edit {
  const nodes = nodesOf(model);
  const proseSites = proseSitesOf(nodes);
  const embedSites = embedSitesOf(nodes);
  const sections = nodes.filter((n) => n.section !== null);
  const referenced = referencedIdentities(model);

  // Candidate edit thunks for the class, applicable sites only; weighted
  // simplest-first. An empty class falls back to the universal prose edit.
  const candidates: (readonly [number, () => Edit])[] = [];
  const add = (weight: number, make: () => Edit): void => {
    candidates.push([weight, make]);
  };

  switch (editClass) {
    case "content": {
      add(2, () => genEditProse(choices, proseSites));
      const embedHosts = nodes.flatMap((node) =>
        node.items.flatMap((item, itemIndex) =>
          item.kind === "prose" &&
          targetPoolFor(model, node, itemIndex).length > 0
            ? [{ node, itemIndex }]
            : [],
        ),
      );
      if (embedHosts.length > 0) {
        add(3, () => {
          const host = choices.pick(embedHosts);
          const pool = targetPoolFor(model, host.node, host.itemIndex);
          return {
            kind: "addEmbed",
            node: host.node.identity,
            item: host.itemIndex,
            ref: genRefFrom(pool)(choices),
            tail: ` ${proseText(choices)}`,
          };
        });
      }
      if (embedSites.length > 0) {
        add(2, () => {
          const site = choices.pick(embedSites);
          return {
            kind: "removeEmbed",
            node: site.node.identity,
            item: site.item,
            part: site.part,
          };
        });
        const retargetable = embedSites.flatMap((site) => {
          const pool = targetPoolFor(model, site.node, site.item).filter(
            (t) => refIdentity({ ...t, spell: 0 }) !== refIdentity(site.ref),
          );
          return pool.length > 0 ? [{ site, pool }] : [];
        });
        if (retargetable.length > 0) {
          add(2, () => {
            const { site, pool } = choices.pick(retargetable);
            return {
              kind: "retargetEmbed",
              node: site.node.identity,
              item: site.item,
              part: site.part,
              ref: genRefFrom(pool)(choices),
            };
          });
        }
      }
      // Two embeddings of distinct targets exchange positions (the sharp
      // reposition arm: runs byte-identical, identities swapped).
      const swapPairs: {
        node: string;
        a: { item: number; part: number };
        b: { item: number; part: number };
      }[] = [];
      for (const node of nodes) {
        const own = embedSites.filter((s) => s.node.identity === node.identity);
        for (let i = 0; i < own.length; i += 1) {
          for (let j = i + 1; j < own.length; j += 1) {
            if (refIdentity(own[i].ref) !== refIdentity(own[j].ref)) {
              swapPairs.push({
                node: node.identity,
                a: { item: own[i].item, part: own[i].part },
                b: { item: own[j].item, part: own[j].part },
              });
            }
          }
        }
      }
      if (swapPairs.length > 0) {
        add(3, () => {
          const pair = choices.pick(swapPairs);
          return {
            kind: "swapEmbeds",
            node: pair.node,
            itemA: pair.a.item,
            partA: pair.a.part,
            itemB: pair.b.item,
            partB: pair.b.part,
          };
        });
      }
      // Two child sections exchange positions (reorder: parent own content
      // changes, both children keep their subtrees).
      const childSwapSites = nodes.flatMap((node) => {
        const sectionIndexes = node.items.flatMap((item, index) =>
          item.kind === "section" ? [index] : [],
        );
        return sectionIndexes.length >= 2 ? [{ node, sectionIndexes }] : [];
      });
      if (childSwapSites.length > 0) {
        add(2, () => {
          const site = choices.pick(childSwapSites);
          const first = choices.intInclusive(0, site.sectionIndexes.length - 2);
          const second = choices.intInclusive(
            first + 1,
            site.sectionIndexes.length - 1,
          );
          return {
            kind: "swapChildren",
            node: site.node.identity,
            itemA: site.sectionIndexes[first],
            itemB: site.sectionIndexes[second],
          };
        });
      }
      break;
    }
    case "referencedText": {
      // A prose edit on a dependency/embedding target: the embedder's
      // ownHash stays byte-identical while effectiveHash propagates.
      const targetSites = proseSites.filter((site) =>
        referenced.has(site.node),
      );
      if (targetSites.length > 0) {
        add(1, () => genEditProse(choices, targetSites));
      }
      break;
    }
    case "structure": {
      add(3, () => {
        const node = choices.pick(nodes);
        return {
          kind: "addChild",
          node: node.identity,
          at: choices.intInclusive(0, node.items.length),
          text: proseText(choices),
        };
      });
      const removable = nodes.flatMap((node) =>
        node.items.flatMap((item, index) => {
          if (item.kind !== "section") return [];
          const parentDotted =
            node.section === null
              ? ""
              : node.identity.slice(node.identity.indexOf("#") + 1);
          const inside = collectDotted(item, parentDotted).map(
            (dotted) => `${filePath(node.fileIndex)}#${dotted}`,
          );
          return inside.every((id) => !referenced.has(id))
            ? [{ node: node.identity, index }]
            : [];
        }),
      );
      if (removable.length > 0) {
        add(2, () => {
          const site = choices.pick(removable);
          return { kind: "removeChild", node: site.node, item: site.index };
        });
      }
      break;
    }
    case "metadata": {
      if (sections.length > 0) {
        add(2, () => {
          const node = choices.pick(sections);
          return { kind: "coverageToggle", node: node.identity };
        });
        add(2, () => {
          const node = choices.pick(sections);
          const current = new Set(node.section?.tags ?? []);
          const fresh = TAG_POOL.filter((token) => !current.has(token));
          return {
            kind: "tagsAdd",
            node: node.identity,
            token: choices.pick(fresh),
          };
        });
        const removableTags = sections.flatMap((node) => {
          const tags = node.section?.tags ?? [];
          return tags.flatMap((token, index) =>
            tags.filter((t) => t === token).length === 1
              ? [{ node: node.identity, index }]
              : [],
          );
        });
        if (removableTags.length > 0) {
          add(2, () => {
            const site = choices.pick(removableTags);
            return { kind: "tagsRemove", node: site.node, index: site.index };
          });
        }
      }
      break;
    }
    case "dependency": {
      const addable = sections.flatMap((node) => {
        const pool = targetPoolFor(model, node, 0).filter(
          (t) =>
            !(node.section?.deps ?? []).some(
              (ref) => refIdentity(ref) === refIdentity({ ...t, spell: 0 }),
            ),
        );
        return pool.length > 0 ? [{ node, pool }] : [];
      });
      if (addable.length > 0) {
        add(1, () => {
          const site = choices.pick(addable);
          return {
            kind: "depAdd",
            node: site.node.identity,
            ref: genRefFrom(site.pool)(choices),
          };
        });
      }
      const depOccurrences = sections.flatMap((node) =>
        (node.section?.deps ?? []).map((ref, index) => ({ node, ref, index })),
      );
      const setChangingRemovals = depOccurrences.filter(
        ({ node, ref }) =>
          (node.section?.deps ?? []).filter(
            (other) => refIdentity(other) === refIdentity(ref),
          ).length === 1,
      );
      if (setChangingRemovals.length > 0) {
        add(4, () => {
          const site = choices.pick(setChangingRemovals);
          return {
            kind: "depRemove",
            node: site.node.identity,
            index: site.index,
          };
        });
      }
      const retargetable = depOccurrences.flatMap((occurrence) => {
        const pool = targetPoolFor(model, occurrence.node, 0).filter(
          (t) =>
            refIdentity({ ...t, spell: 0 }) !== refIdentity(occurrence.ref),
        );
        return pool.length > 0 ? [{ ...occurrence, pool }] : [];
      });
      if (retargetable.length > 0) {
        add(4, () => {
          const site = choices.pick(retargetable);
          return {
            kind: "depRetarget",
            node: site.node.identity,
            index: site.index,
            ref: genRefFrom(site.pool)(choices),
          };
        });
      }
      break;
    }
    case "noop": {
      const depOccurrences = sections.flatMap((node) =>
        (node.section?.deps ?? []).map((ref, index) => ({ node, ref, index })),
      );
      const respellableDeps = depOccurrences.filter(
        ({ node, ref }) => spellingVariants(ref, node.fileIndex) > 1,
      );
      if (respellableDeps.length > 0) {
        add(4, () => {
          const site = choices.pick(respellableDeps);
          const variants = spellingVariants(site.ref, site.node.fileIndex);
          return {
            kind: "respellDep",
            node: site.node.identity,
            index: site.index,
            bump: 1 + choices.intInclusive(0, variants - 2),
          };
        });
      }
      const respellableEmbeds = embedSites.filter(
        (site) => spellingVariants(site.ref, site.node.fileIndex) > 1,
      );
      if (respellableEmbeds.length > 0) {
        add(4, () => {
          const site = choices.pick(respellableEmbeds);
          const variants = spellingVariants(site.ref, site.node.fileIndex);
          return {
            kind: "respellEmbed",
            node: site.node.identity,
            item: site.item,
            part: site.part,
            bump: 1 + choices.intInclusive(0, variants - 2),
          };
        });
      }
      const swappableDeps = sections.flatMap((node) => {
        const deps = node.section?.deps ?? [];
        const pairs: { indexA: number; indexB: number }[] = [];
        for (let i = 0; i < deps.length; i += 1) {
          for (let j = i + 1; j < deps.length; j += 1) {
            if (
              renderRef(deps[i], node.fileIndex) !==
              renderRef(deps[j], node.fileIndex)
            ) {
              pairs.push({ indexA: i, indexB: j });
            }
          }
        }
        return pairs.map((pair) => ({ node: node.identity, ...pair }));
      });
      if (swappableDeps.length > 0) {
        add(1, () => {
          const site = choices.pick(swappableDeps);
          return { kind: "depSwap", ...site };
        });
      }
      if (depOccurrences.length > 0) {
        add(1, () => {
          const site = choices.pick(depOccurrences);
          return {
            kind: "depDuplicate",
            node: site.node.identity,
            index: site.index,
            spell: choices.intInclusive(0, 5),
          };
        });
        const dupRemovals = depOccurrences.filter(
          ({ node, ref }) =>
            (node.section?.deps ?? []).filter(
              (other) => refIdentity(other) === refIdentity(ref),
            ).length >= 2,
        );
        if (dupRemovals.length > 0) {
          add(1, () => {
            const site = choices.pick(dupRemovals);
            return {
              kind: "depRemove",
              node: site.node.identity,
              index: site.index,
            };
          });
        }
      }
      const singleDep = sections.filter(
        (node) => (node.section?.deps ?? []).length === 1,
      );
      if (singleDep.length > 0) {
        add(1, () => ({
          kind: "depFormToggle",
          node: choices.pick(singleDep).identity,
        }));
      }
      const emptyToggleable = sections.filter(
        (node) =>
          node.section !== null &&
          (node.section.deps === null || node.section.deps.length === 0),
      );
      if (emptyToggleable.length > 0) {
        add(1, () => ({
          kind: "depEmptyToggle",
          node: choices.pick(emptyToggleable).identity,
        }));
      }
      const tagsEmptyToggleable = sections.filter(
        (node) =>
          node.section !== null &&
          (node.section.tags === null || node.section.tags.length === 0),
      );
      if (tagsEmptyToggleable.length > 0) {
        add(1, () => ({
          kind: "tagsEmptyToggle",
          node: choices.pick(tagsEmptyToggleable).identity,
        }));
      }
      const taggedSections = sections.filter(
        (node) => (node.section?.tags ?? []).length > 0,
      );
      if (taggedSections.length > 0) {
        add(1, () => {
          const node = choices.pick(taggedSections);
          const tags = node.section?.tags ?? [];
          return {
            kind: "tagsAdd",
            node: node.identity,
            token: tags[choices.intInclusive(0, tags.length - 1)],
          };
        });
      }
      const swappableTags = sections.flatMap((node) => {
        const tags = node.section?.tags ?? [];
        const pairs: { indexA: number; indexB: number }[] = [];
        for (let i = 0; i < tags.length; i += 1) {
          for (let j = i + 1; j < tags.length; j += 1) {
            if (tags[i] !== tags[j]) pairs.push({ indexA: i, indexB: j });
          }
        }
        return pairs.map((pair) => ({ node: node.identity, ...pair }));
      });
      if (swappableTags.length > 0) {
        add(1, () => {
          const site = choices.pick(swappableTags);
          return { kind: "tagsSwap", ...site };
        });
      }
      add(1, () => {
        const node = choices.pick(nodes);
        return {
          kind: "commentAdd",
          node: node.identity,
          at: choices.intInclusive(0, node.items.length),
          words: commentWords(choices),
        };
      });
      const commentSites = nodes.flatMap((node) =>
        node.items.flatMap((item, index) =>
          item.kind === "comment" ? [{ node: node.identity, index }] : [],
        ),
      );
      if (commentSites.length > 0) {
        add(1, () => {
          const site = choices.pick(commentSites);
          return { kind: "commentRemove", node: site.node, item: site.index };
        });
      }
      break;
    }
  }

  if (candidates.length === 0) return genEditProse(choices, proseSites);
  return choices.weightedPick(candidates)();
}

/** 1–3 edits per trial, each from a distinct law class (module header). */
export const genEditsFor =
  (model: WorkspaceModel): Gen<Edit[]> =>
  (choices) => {
    const remaining = [...EDIT_CLASSES];
    const edits: Edit[] = [];
    do {
      const index = choices.intInclusive(0, remaining.length - 1);
      const [editClass] = remaining.splice(index, 1);
      edits.push(genEditOfClass(choices, model, editClass));
    } while (edits.length < 3 && choices.boolean(0.75));
    return edits;
  };

// --- edit application ----------------------------------------------------------

function expectProse(items: BodyItem[], index: number): ProseItem {
  const item = items[index];
  if (item === undefined || item.kind !== "prose") {
    throw new Error("P-4 harness defect: edit does not address a prose item");
  }
  return item;
}

function expectSectionAt(items: BodyItem[], index: number): SectionItem {
  const item = items[index];
  if (item === undefined || item.kind !== "section") {
    throw new Error("P-4 harness defect: edit does not address a section item");
  }
  return item;
}

function expectSection(node: NodeLoc): SectionItem {
  if (node.section === null) {
    throw new Error("P-4 harness defect: edit requires a section node");
  }
  return node.section;
}

function expectDeps(section: SectionItem): RefModel[] {
  if (section.deps === null) {
    throw new Error("P-4 harness defect: edit requires a `d` prop");
  }
  return section.deps;
}

function expectTags(section: SectionItem): string[] {
  if (section.tags === null) {
    throw new Error("P-4 harness defect: edit requires a `tags` prop");
  }
  return section.tags;
}

/**
 * Apply one edit to a clone of the model. Pure: identical inputs produce
 * identical outputs (tape replay and shrinking re-derive the same staged
 * workspaces, H-10).
 */
export function applyEdit(
  model: WorkspaceModel,
  edit: Edit,
): { after: WorkspaceModel; description: string } {
  const after = structuredClone(model);
  const node = locateNode(after, edit.node);
  switch (edit.kind) {
    case "editProse": {
      const prose = expectProse(node.items, edit.item);
      const part = prose.parts[edit.part];
      if (part === undefined || part.kind !== "text") {
        throw new Error(
          "P-4 harness defect: edit does not address a text part",
        );
      }
      const replacement = edit.text === part.text ? `${edit.text}x` : edit.text;
      part.text = replacement;
      return {
        after,
        description: `replace a prose run of ${edit.node}`,
      };
    }
    case "addChild": {
      const file = after.files[node.fileIndex];
      const seg = `s${String(file.nextSeg)}`;
      file.nextSeg += 1;
      node.items.splice(edit.at, 0, {
        kind: "section",
        seg,
        tags: null,
        coverageNone: false,
        deps: null,
        depsSingle: false,
        items: [{ kind: "prose", parts: [{ kind: "text", text: edit.text }] }],
      });
      return {
        after,
        description: `add a child section (segment ${seg}) to ${edit.node}`,
      };
    }
    case "removeChild": {
      const child = expectSectionAt(node.items, edit.item);
      node.items.splice(edit.item, 1);
      return {
        after,
        description: `remove the unreferenced child section ${child.seg} of ${edit.node}`,
      };
    }
    case "swapChildren": {
      const a = expectSectionAt(node.items, edit.itemA);
      const b = expectSectionAt(node.items, edit.itemB);
      node.items[edit.itemA] = b;
      node.items[edit.itemB] = a;
      return {
        after,
        description: `exchange the positions of child sections ${a.seg} and ${b.seg} of ${edit.node}`,
      };
    }
    case "addEmbed": {
      const prose = expectProse(node.items, edit.item);
      prose.parts.push(
        { kind: "embed", ref: structuredClone(edit.ref) },
        { kind: "text", text: edit.tail },
      );
      return {
        after,
        description: `add an embedding of ${refIdentity(edit.ref)} to ${edit.node}`,
      };
    }
    case "removeEmbed": {
      const prose = expectProse(node.items, edit.item);
      const part = prose.parts[edit.part];
      if (part === undefined || part.kind !== "embed") {
        throw new Error(
          "P-4 harness defect: edit does not address an embed part",
        );
      }
      const before = prose.parts[edit.part - 1];
      const following = prose.parts[edit.part + 1];
      if (
        before === undefined ||
        before.kind !== "text" ||
        following === undefined ||
        following.kind !== "text"
      ) {
        throw new Error(
          "P-4 harness defect: embed part not between text parts",
        );
      }
      before.text += following.text;
      prose.parts.splice(edit.part, 2);
      return {
        after,
        description: `remove the embedding of ${refIdentity(part.ref)} from ${edit.node}`,
      };
    }
    case "retargetEmbed": {
      const prose = expectProse(node.items, edit.item);
      const part = prose.parts[edit.part];
      if (part === undefined || part.kind !== "embed") {
        throw new Error(
          "P-4 harness defect: edit does not address an embed part",
        );
      }
      const from = refIdentity(part.ref);
      part.ref = structuredClone(edit.ref);
      return {
        after,
        description: `retarget an embedding of ${edit.node} from ${from} to ${refIdentity(edit.ref)}`,
      };
    }
    case "swapEmbeds": {
      const proseA = expectProse(node.items, edit.itemA);
      const proseB = expectProse(node.items, edit.itemB);
      const partA = proseA.parts[edit.partA];
      const partB = proseB.parts[edit.partB];
      if (
        partA === undefined ||
        partA.kind !== "embed" ||
        partB === undefined ||
        partB.kind !== "embed"
      ) {
        throw new Error("P-4 harness defect: swapEmbeds addresses non-embeds");
      }
      const held = partA.ref;
      partA.ref = partB.ref;
      partB.ref = held;
      return {
        after,
        description:
          `exchange the positions of the embeddings of ${refIdentity(partB.ref)} ` +
          `and ${refIdentity(partA.ref)} within ${edit.node} (runs byte-identical)`,
      };
    }
    case "depAdd": {
      const section = expectSection(node);
      section.deps = [...(section.deps ?? []), structuredClone(edit.ref)];
      section.depsSingle = false;
      return {
        after,
        description: `add a \`d\` reference to ${refIdentity(edit.ref)} on ${edit.node}`,
      };
    }
    case "depRemove": {
      const deps = expectDeps(expectSection(node));
      const removed = deps[edit.index];
      if (removed === undefined) {
        throw new Error("P-4 harness defect: depRemove index out of range");
      }
      deps.splice(edit.index, 1);
      return {
        after,
        description: `remove a \`d\` reference to ${refIdentity(removed)} from ${edit.node}`,
      };
    }
    case "depRetarget": {
      const deps = expectDeps(expectSection(node));
      const previous = deps[edit.index];
      if (previous === undefined) {
        throw new Error("P-4 harness defect: depRetarget index out of range");
      }
      deps[edit.index] = structuredClone(edit.ref);
      return {
        after,
        description: `retarget a \`d\` reference of ${edit.node} from ${refIdentity(previous)} to ${refIdentity(edit.ref)}`,
      };
    }
    case "depSwap": {
      const deps = expectDeps(expectSection(node));
      const a = deps[edit.indexA];
      const b = deps[edit.indexB];
      if (a === undefined || b === undefined) {
        throw new Error("P-4 harness defect: depSwap index out of range");
      }
      deps[edit.indexA] = b;
      deps[edit.indexB] = a;
      return {
        after,
        description: `reorder the \`d\` array of ${edit.node} (target set unchanged)`,
      };
    }
    case "depDuplicate": {
      const section = expectSection(node);
      const deps = expectDeps(section);
      const source = deps[edit.index];
      if (source === undefined) {
        throw new Error("P-4 harness defect: depDuplicate index out of range");
      }
      deps.push({ ...source, spell: edit.spell });
      section.depsSingle = false;
      return {
        after,
        description: `add a duplicate \`d\` reference to ${refIdentity(source)} on ${edit.node} (collapses, SPEC 2.2)`,
      };
    }
    case "depFormToggle": {
      const section = expectSection(node);
      if ((section.deps ?? []).length !== 1) {
        throw new Error(
          "P-4 harness defect: depFormToggle needs exactly one ref",
        );
      }
      section.depsSingle = !section.depsSingle;
      return {
        after,
        description: `toggle ${edit.node} between \`d={ref}\` and \`d={[ref]}\` (same reference)`,
      };
    }
    case "depEmptyToggle": {
      const section = expectSection(node);
      if (section.deps !== null && section.deps.length > 0) {
        throw new Error(
          "P-4 harness defect: depEmptyToggle needs empty/omitted d",
        );
      }
      section.deps = section.deps === null ? [] : null;
      section.depsSingle = false;
      return {
        after,
        description: `toggle ${edit.node} between \`d={[]}\` and an omitted \`d\` (equivalent, SPEC 2.2)`,
      };
    }
    case "respellDep": {
      const deps = expectDeps(expectSection(node));
      const ref = deps[edit.index];
      if (ref === undefined) {
        throw new Error("P-4 harness defect: respellDep index out of range");
      }
      ref.spell += edit.bump;
      return {
        after,
        description: `respell a \`d\` reference to ${refIdentity(ref)} on ${edit.node} (spellings never enter any hash, SPEC 5.4)`,
      };
    }
    case "respellEmbed": {
      const prose = expectProse(node.items, edit.item);
      const part = prose.parts[edit.part];
      if (part === undefined || part.kind !== "embed") {
        throw new Error(
          "P-4 harness defect: respellEmbed addresses a non-embed",
        );
      }
      part.ref.spell += edit.bump;
      return {
        after,
        description: `respell an embedding of ${refIdentity(part.ref)} in ${edit.node} (spellings never enter any hash, SPEC 5.4)`,
      };
    }
    case "coverageToggle": {
      const section = expectSection(node);
      section.coverageNone = !section.coverageNone;
      return {
        after,
        description: `toggle the coverage attribute of ${edit.node} between omitted (required) and "none"`,
      };
    }
    case "tagsAdd": {
      const section = expectSection(node);
      section.tags = [...(section.tags ?? []), edit.token];
      return {
        after,
        description: `append the tag token ${JSON.stringify(edit.token)} to ${edit.node}`,
      };
    }
    case "tagsRemove": {
      const tags = expectTags(expectSection(node));
      const removed = tags[edit.index];
      if (removed === undefined) {
        throw new Error("P-4 harness defect: tagsRemove index out of range");
      }
      tags.splice(edit.index, 1);
      return {
        after,
        description: `remove the tag token ${JSON.stringify(removed)} from ${edit.node}`,
      };
    }
    case "tagsSwap": {
      const tags = expectTags(expectSection(node));
      const a = tags[edit.indexA];
      const b = tags[edit.indexB];
      if (a === undefined || b === undefined) {
        throw new Error("P-4 harness defect: tagsSwap index out of range");
      }
      tags[edit.indexA] = b;
      tags[edit.indexB] = a;
      return {
        after,
        description: `reorder the tags of ${edit.node} (token set unchanged)`,
      };
    }
    case "tagsEmptyToggle": {
      const section = expectSection(node);
      if (section.tags !== null && section.tags.length > 0) {
        throw new Error(
          "P-4 harness defect: tagsEmptyToggle needs empty/omitted tags",
        );
      }
      section.tags = section.tags === null ? [] : null;
      return {
        after,
        description: `toggle ${edit.node} between \`tags=""\` and an omitted \`tags\` (equivalent, SPEC 2.6)`,
      };
    }
    case "commentAdd": {
      node.items.splice(edit.at, 0, { kind: "comment", words: edit.words });
      return {
        after,
        description: `add an MDX comment line inside ${edit.node} (comments enter no text and no hash, SPEC 2.7)`,
      };
    }
    case "commentRemove": {
      const item = node.items[edit.item];
      if (item === undefined || item.kind !== "comment") {
        throw new Error(
          "P-4 harness defect: commentRemove addresses a non-comment",
        );
      }
      node.items.splice(edit.item, 1);
      return {
        after,
        description: `remove an MDX comment line from ${edit.node} (comments enter no text and no hash, SPEC 2.7)`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// The trial

export interface P4Trial {
  readonly model: WorkspaceModel;
  readonly edits: readonly Edit[];
}

/** The P-4 trial generator: a random workspace plus 1–3 single edits. */
export const genP4Trial: Gen<P4Trial> = (choices) => {
  const model = genWorkspaceModel(choices);
  const edits = genEditsFor(model)(choices);
  return { model, edits };
};

/** Counterexample rendering: staged sources plus the edit data. */
function renderTrial(trial: P4Trial): string {
  return JSON.stringify({
    files: renderWorkspace(trial.model),
    edits: trial.edits,
  });
}

/** The four hashes of one node via `query node` (SPEC 5.5, 11; H-3). */
async function queryHashes(
  product: ProductBinding,
  workspace: TestWorkspace,
  identity: string,
  context: string,
): Promise<NodeHashes> {
  const label = `${context} \`query node ${identity}\``;
  return decodeNodeReport(
    await runJson(product, workspace, ["query", "node", identity], label),
    label,
  ).hashes;
}

/** The workspace's full node-identity set via `query nodes` (SPEC 11). */
async function assertIdentitySet(
  product: ProductBinding,
  workspace: TestWorkspace,
  expected: readonly string[],
  context: string,
): Promise<void> {
  const label = `${context} \`query nodes\``;
  const rows = decodeNodeRowsReport(
    await runJson(product, workspace, ["query", "nodes"], label),
    label,
  );
  assertSameJson(
    sortedIdentities(rows),
    [...expected].sort(),
    `${context} the workspace's full node-identity set (SPEC 1.5, 11)`,
  );
}

const HASH_LAWS: ReadonlyArray<
  readonly [keyof NodeHashes, keyof PredictedChange, string]
> = [
  [
    "ownHash",
    "own",
    "ownHash hashes the node's own content sequence — runs and referenced " +
      "identities at their positions; an embedded target's text is no part " +
      "of the embedder's own content (SPEC 5.5, 1.6)",
  ],
  [
    "subtreeHash",
    "subtree",
    "subtreeHash changes iff a node in the subtree was added, removed, or " +
      "reordered, or a node's own content changed (SPEC 5.5)",
  ],
  [
    "metadataHash",
    "metadata",
    "metadataHash changes iff the node's `d` declarations, coverage " +
      "attribute, or tags change — duplicates collapse and spellings never " +
      "enter any hash (SPEC 5.5, 5.4, 2.2, 2.6)",
  ],
  [
    "effectiveHash",
    "effective",
    "effectiveHash changes iff own content changed in the subtree, a " +
      "subtree node's dependency edges were added, removed, or retargeted, " +
      "or a dependency-edge target's effectiveHash changed — target changes " +
      "propagate over the dependency closure (SPEC 5.5)",
  ],
];

function assertHashLaws(
  identity: string,
  before: NodeHashes,
  observed: NodeHashes,
  predicted: PredictedChange,
  context: string,
): void {
  for (const [hashKey, predictionKey, law] of HASH_LAWS) {
    const changed = before[hashKey] !== observed[hashKey];
    if (changed === predicted[predictionKey]) continue;
    if (predicted[predictionKey]) {
      fail(
        `${context}: ${hashKey} of ${identity} must change — ${law} — but it ` +
          `is byte-identical: ${JSON.stringify(before[hashKey])}`,
      );
    }
    fail(
      `${context}: ${hashKey} of ${identity} must be byte-identical — ${law} ` +
        `— but it changed: ${JSON.stringify(before[hashKey])} -> ` +
        `${JSON.stringify(observed[hashKey])}`,
    );
  }
}

async function runP4Trial(
  product: ProductBinding,
  trial: P4Trial,
): Promise<void> {
  const beforeFiles = renderWorkspace(trial.model);
  const beforeSem = semanticsOf(trial.model);
  const beforeIds = [...beforeSem.keys()].sort();
  const staged = { "xspec.config.ts": SPECS_ONLY_CONFIG, ...beforeFiles };
  const first = await TestWorkspace.create({ files: staged });
  try {
    const second = await TestWorkspace.create({ files: staged });
    try {
      await buildOk(
        product,
        first,
        "P-4: `build` of the generated workspace (the generator stages only valid workspaces)",
      );
      await buildOk(
        product,
        second,
        "P-4: `build` of the identical workspace in a second directory (H-6 protocol)",
      );
      await assertIdentitySet(
        product,
        first,
        beforeIds,
        "P-4 before the edit:",
      );

      const baseline = new Map<string, NodeHashes>();
      for (const identity of beforeIds) {
        baseline.set(
          identity,
          await queryHashes(product, first, identity, "P-4 directory 1:"),
        );
        const twin = await queryHashes(
          product,
          second,
          identity,
          "P-4 directory 2:",
        );
        assertSameJson(
          twin,
          baseline.get(identity),
          `P-4: all four hashes of ${identity} are identical across two ` +
            `directories staging identical workspaces — identical workspaces ` +
            `hash identically (SPEC 5.5, H-6)`,
        );
      }

      for (const edit of trial.edits) {
        const { after, description } = applyEdit(trial.model, edit);
        const afterFiles = renderWorkspace(after);
        const afterSem = semanticsOf(after);
        const predictions = predictChanges(beforeSem, afterSem);
        const changedPaths = Object.keys(afterFiles).filter(
          (path) => afterFiles[path] !== beforeFiles[path],
        );
        if (changedPaths.length === 0) {
          throw new Error(
            `P-4 harness defect: the edit "${description}" staged no byte change`,
          );
        }
        for (const path of changedPaths) {
          await first.file(path, afterFiles[path]);
        }
        const context = `P-4 after the single edit — ${description} —`;
        await buildOk(
          product,
          first,
          `${context} \`build\` of the edited workspace`,
        );
        await assertIdentitySet(
          product,
          first,
          [...afterSem.keys()].sort(),
          context,
        );
        for (const identity of [...predictions.keys()].sort()) {
          const before = baseline.get(identity);
          const predicted = predictions.get(identity);
          if (before === undefined || predicted === undefined) {
            throw new Error(
              `P-4 harness defect: no baseline or prediction for ${identity}`,
            );
          }
          const observed = await queryHashes(product, first, identity, context);
          assertHashLaws(identity, before, observed, predicted, context);
        }
        // Restore the pristine workspace: each edit applies independently
        // to the same before-state ("random single edits", not sequences).
        for (const path of changedPaths) {
          await first.file(path, beforeFiles[path]);
        }
      }
    } finally {
      await second.dispose();
    }
  } finally {
    await first.dispose();
  }
}

// ---------------------------------------------------------------------------
// The registered property test

const P_4 = defineProductTest({
  id: "P-4",
  title:
    "property: over random valid workspaces and random single edits, the SPEC 5.5 hash " +
    "laws hold on every node — subtreeHash changed iff a subtree node was added, removed, " +
    "or reordered or its own content changed; metadataHash changed iff `d`/coverage/tags " +
    "changed; ownHash insensitive to embedded-target edits; effectiveHash propagating over " +
    "the dependency closure — and identical workspaces hash identically " +
    "(SPEC 5.5, 5.4, 1.6, 11; TEST-SPEC §16 P-4)",
  // Wall-clock hang guard only (H-10): three fixed seeds (E-5), two
  // workspaces, up to four builds and ~5·|nodes| `query node` invocations
  // per trial, plus the shrink budget on falsification.
  timeoutMs: 420_000,
  run: async (product) => {
    await checkProperty(
      "P-4 hash laws",
      genP4Trial,
      async (trial) => {
        await runP4Trial(product, trial);
      },
      { runs: 6, maxShrinkExecutions: 100, render: renderTrial },
    );
  },
});

/** TEST-SPEC §16 P-4 (PROP-03). */
export const section16P4Tests: readonly ProductTestEntry[] = [P_4];
