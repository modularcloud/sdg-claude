// TEST-SPEC §16 P-9 (review session invariants) — PROP-07.
//
// One registered product-facing property test (C-2 "one code path"): a
// seeded, reproducible generator (helpers/property.ts, H-10; fixed seed set
// in CI, E-5) produces random sequences of valid review operations —
// `create`, `resolve` (re-derive triggers included: `--status updated`
// re-derives the session at resolve time, SPEC 10.5/10.6), `split`, and
// reads — interleaved with workspace edits (prose replaced, sections added,
// sections deleted; `build` after every edit), and asserts P-9's invariants
// after `create` and after every subsequent operation:
//
//   * at most one item per kind and scope node (SPEC 10.1, 10.5);
//   * `blockedBy` acyclic — and naming only item ids present in the session
//     (SPEC 10.1: a stored session violating either invariant is corrupt);
//   * retired ids never reused: `split` removes the original item and its id
//     is never reused (SPEC 10.7). Operationalized around the only
//     id-retiring operation there is — items enter sessions but never leave
//     except through `split` (SPEC 10.5: items that no longer generate
//     remain in the session) — so a retired id reappearing, a split original
//     staying, or an id vanishing without a split all fail;
//   * the `next` contract: `next` returns an unblocked needing-review item
//     or reports the session fully resolved — cross-checked against an
//     adjacent `export` of the same state (no mutation between the two
//     reads): the returned item exists in the session, needs review
//     (`unresolved` or `invalidated`), every one of its blockers is resolved
//     in the same view, and fully-resolved is reported exactly when no item
//     needs review (SPEC 10.3, 10.7);
//   * reads never change session bytes: every read this body issues
//     (`status`, `next`, `show`, `export`, `list`) is bracketed by byte
//     captures of every session file, compared exactly (SPEC 10.4:
//     read-time invalidation is computed and reported, not persisted;
//     sessions change only through the mutating subcommands);
//   * stored sessions always re-read as non-corrupt: every session file
//     stays a plain file at `.xspec/reviews/<name>.json` (SPEC 10.1, 13.4),
//     every read of it exits 0 with a decodable document — a corrupt session
//     makes every `review` subcommand naming it exit 1 (SPEC 10.1, 14.21) —
//     and `review list` reports exactly the created sessions by name, none
//     corrupt (SPEC 10.7).
//
// As supporting consistency the sweep also recomputes every reported item's
// blocked state from its `blockedBy` and the statuses reported in the same
// document (SPEC 10.3 defines blocked purely in those terms, over the
// read-time-invalidated view the read presents): this is the machinery that
// makes "unblocked" in the `next` contract meaningful, applied uniformly.
//
// Strategy choice: the sessions are `audit` sessions. Audit needs no
// baseline — no git staging (SPEC 10.6; T10.6-1 pins git-less operation) —
// yet exercises everything P-9 targets: one item per requirement node,
// bottom-up `blockedBy` chains, `split` decompositions, and resolve-time
// re-derivation on `updated` (SPEC 10.6: the 10.5 re-derivation holds for
// audit too — new nodes' items enter, recorded decompositions are honored,
// `blockedBy` is recomputed). The strategy-specific derivations are pinned
// by the deterministic section-10 fixtures (SPEC 10.5/10.6/10.7); P-9
// searches the operation-sequence space for consistency violations. P-9 is
// outside every CERTIFICATIONS.md fixture scope (its preamble), so this body
// binds only to the real product surface.
//
// Operation model — execution-time rank resolution: item ids are
// product-assigned and blocking is product-computed, so the generator (a
// pure function of its draws, H-10) cannot name concrete resolve/split
// targets. Each drawn operation instead carries plain integers (`rank`,
// `session`) that the body resolves against observed product state: a
// `review status --json` read immediately before the operation supplies the
// candidate rows, and the operation picks `rank % candidates.length`.
// Workspace edits ARE concretized at generation time against the generator's
// own evolving workspace model (the P-6 pattern); the body replays the
// identical evolution by applying the same edits to its own clone of the
// initial model, so staged bytes and split-eligibility checks always
// describe the same workspace. A drawn `split` finding no eligible item
// degrades to the status read it already performed rather than skipping.
//
// Validity discipline (P-9 stages sequences of VALID review operations —
// every mutating command this body issues must exit 0):
//   * `resolve` targets only unblocked items, picked from `status` rows with
//     `blocked` false and no mutation in between (resolving a blocked item
//     is refused, SPEC 10.7; re-resolving a resolved or invalidated item is
//     valid — resolve "applies to any unblocked item regardless of current
//     status");
//   * `split` targets only `subtree-coherence` items whose scope root
//     currently exists with at least one child section (SPEC 10.7 refuses
//     every other kind and childless scope roots; an absent scope root has
//     no current children) — decided against the harness's workspace model,
//     which matches the built workspace exactly;
//   * session names come from a fixed valid pool (SPEC 10.1), each created
//     at most once.
//
// Staging discipline (the known-good line-disciplined shape of the
// section-10 fixtures, trivially remark-mdx-parseable): section tags stand
// alone on their lines carrying the full dotted id, a blank line precedes
// every section opener, every node carries exactly one plain-ASCII prose
// line (anchored alphanumeric start; no MDX-structural characters), LF
// terminators throughout, no imports/embeddings/references (files stay
// independent, so deleting any section never dangles a reference), and
// `build` (asserted exit 0) follows every edit so no read depends on the
// 13.3 refresh path. Section segments come from a per-file fresh counter and
// are never reused, so node identities never recur across delete/add pairs.
//
// An implementation-time dry-run over the committed default seeds at the
// registered 3 runs per seed verified that every operation kind (all three
// edit kinds, all three resolve statuses, split, the status+show read, the
// extra create) occurs across the fixed trial set — and that every staged
// source, initial and after every edit, parses under remark-mdx — so CI
// (E-5) exercises the full menu deterministically.

import type {
  ExportReport,
  ItemStatus,
  NextReport,
  ReviewItem,
  SessionStatusReport,
} from "../../helpers/adapters/index.js";
import {
  decodeExportReport,
  decodeItemReport,
  decodeNextReport,
  decodeSessionListReport,
  decodeSessionStatusReport,
} from "../../helpers/adapters/index.js";
import { assertBytesEqual, fail } from "../../helpers/assertions.js";
import type { Choices, Gen } from "../../helpers/property.js";
import { checkProperty, listOf } from "../../helpers/property.js";
import { defineProductTest } from "../../helpers/registry.js";
import type { ProductTestEntry } from "../../helpers/registry.js";
import type { ProductBinding } from "../../helpers/subprocess.js";
import { TestWorkspace } from "../../helpers/workspace.js";
import { assertSameJson, buildOk, expectExit, runJson } from "./support.js";

// Minimal declarative configuration (SPEC 7): exactly one spec group. Audit
// sessions need no code group — they derive `subtree-coherence` items only.
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
// Deliberately minimal (unlike P-4's): P-9's invariants are structural
// consistency ones, needing no hash or text prediction — the model exists to
// stage valid workspaces, address edits, and decide split eligibility
// (which nodes currently have child sections).

export interface SectionModel {
  /** This section's own id segment; the dotted id is contextual (SPEC 1.3). */
  seg: string;
  /** The section's single prose line. */
  prose: string;
  children: SectionModel[];
}

export interface FileModel {
  /** The root's single prose line. */
  prose: string;
  sections: SectionModel[];
  /** Fresh-segment counter (SPEC 1.3 uniqueness); segments never recur. */
  nextSeg: number;
}

export interface P9WorkspaceModel {
  files: FileModel[];
}

const FILE_NAMES = ["A", "B"] as const;

function filePath(fileIndex: number): string {
  return `specs/${FILE_NAMES[fileIndex]}.mdx`;
}

function renderSectionLines(
  section: SectionModel,
  parentDotted: string,
): string[] {
  const dotted =
    parentDotted === "" ? section.seg : `${parentDotted}.${section.seg}`;
  const lines = [`<S id="${dotted}">`, section.prose];
  for (const child of section.children) {
    lines.push("", ...renderSectionLines(child, dotted));
  }
  lines.push("</S>");
  return lines;
}

/** Source bytes per workspace-relative path (LF-terminated lines). */
export function renderP9Workspace(
  model: P9WorkspaceModel,
): Record<string, string> {
  const files: Record<string, string> = {};
  model.files.forEach((file, fileIndex) => {
    const lines = [file.prose];
    for (const section of file.sections) {
      lines.push("", ...renderSectionLines(section, ""));
    }
    files[filePath(fileIndex)] = `${lines.join("\n")}\n`;
  });
  return files;
}

/** Every node identity (roots and sections), files in order, DFS within. */
function allNodeIdentities(model: P9WorkspaceModel): string[] {
  const out: string[] = [];
  model.files.forEach((file, fileIndex) => {
    out.push(filePath(fileIndex));
    const walk = (
      sections: readonly SectionModel[],
      parentDotted: string,
    ): void => {
      for (const section of sections) {
        const dotted =
          parentDotted === "" ? section.seg : `${parentDotted}.${section.seg}`;
        out.push(`${filePath(fileIndex)}#${dotted}`);
        walk(section.children, dotted);
      }
    };
    walk(file.sections, "");
  });
  return out;
}

function allSectionIdentities(model: P9WorkspaceModel): string[] {
  return allNodeIdentities(model).filter((identity) => identity.includes("#"));
}

interface SectionLocation {
  /** The containing sibling list. */
  readonly list: SectionModel[];
  readonly index: number;
  readonly node: SectionModel;
}

/**
 * Locate a section by identity in the current model; null when the identity
 * does not (or no longer does) name a section. Tolerant deliberately: split
 * eligibility feeds product-reported scope identities through here, and an
 * unknown identity must classify as "no current children", never crash.
 */
function locateSection(
  model: P9WorkspaceModel,
  identity: string,
): SectionLocation | null {
  const hash = identity.indexOf("#");
  if (hash < 0) return null;
  const path = identity.slice(0, hash);
  const fileIndex = model.files.findIndex((_, i) => filePath(i) === path);
  if (fileIndex < 0) return null;
  let list = model.files[fileIndex].sections;
  let found: SectionLocation | null = null;
  for (const seg of identity.slice(hash + 1).split(".")) {
    const index = list.findIndex((section) => section.seg === seg);
    if (index < 0) return null;
    const node = list[index];
    found = { list, index, node };
    list = node.children;
  }
  return found;
}

/**
 * Child-section count of the node the identity names in the current model —
 * 0 for identities that name nothing (deleted nodes, or product-reported
 * identities the harness never staged): they have no current children, so
 * they are simply split-ineligible (SPEC 10.7).
 */
function currentChildCount(model: P9WorkspaceModel, identity: string): number {
  const hash = identity.indexOf("#");
  if (hash < 0) {
    const fileIndex = model.files.findIndex((_, i) => filePath(i) === identity);
    return fileIndex < 0 ? 0 : model.files[fileIndex].sections.length;
  }
  return locateSection(model, identity)?.node.children.length ?? 0;
}

/** The file index of a harness-staged identity; a miss is a harness defect. */
function strictFileIndexOf(model: P9WorkspaceModel, identity: string): number {
  const hash = identity.indexOf("#");
  const path = hash < 0 ? identity : identity.slice(0, hash);
  const fileIndex = model.files.findIndex((_, i) => filePath(i) === path);
  if (fileIndex < 0) {
    throw new Error(
      `P-9 harness defect: identity ${identity} names no staged file`,
    );
  }
  return fileIndex;
}

// ---------------------------------------------------------------------------
// Edits
//
// Concrete, JSON-safe, and generated against the generator's own evolving
// model; the body replays the identical evolution (module header). Applying
// an edit that does not address the model is a harness defect: generation
// concretizes only valid edits, and shrinking replays the whole generator,
// so ops and models never drift apart.

export type P9Edit =
  | { kind: "editProse"; node: string; text: string }
  | { kind: "addSection"; parent: string; seg: string; prose: string }
  | { kind: "deleteSection"; node: string };

/** A staged section located strictly; a miss is a harness defect. */
function strictLocateSection(
  model: P9WorkspaceModel,
  identity: string,
  what: string,
): SectionLocation {
  const location = locateSection(model, identity);
  if (location === null) {
    throw new Error(
      `P-9 harness defect: ${what} addresses no section: ${identity}`,
    );
  }
  return location;
}

/** Apply one edit in place. Pure in (model, edit): replay-deterministic. */
export function applyP9Edit(model: P9WorkspaceModel, edit: P9Edit): void {
  switch (edit.kind) {
    case "editProse": {
      const holder: { prose: string } = edit.node.includes("#")
        ? strictLocateSection(model, edit.node, "editProse").node
        : model.files[strictFileIndexOf(model, edit.node)];
      // Always a real byte change (deterministically, for replay).
      holder.prose = edit.text === holder.prose ? `${edit.text}x` : edit.text;
      return;
    }
    case "addSection": {
      const fileIndex = strictFileIndexOf(model, edit.parent);
      const list = edit.parent.includes("#")
        ? strictLocateSection(model, edit.parent, "addSection").node.children
        : model.files[fileIndex].sections;
      list.push({ seg: edit.seg, prose: edit.prose, children: [] });
      model.files[fileIndex].nextSeg += 1;
      return;
    }
    case "deleteSection": {
      const location = strictLocateSection(model, edit.node, "deleteSection");
      location.list.splice(location.index, 1);
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Operations and their generator

/** Statuses `resolve --status` accepts (SPEC 10.7). */
export type ResolveStatus = "no-change" | "skipped" | "updated";

export type P9Op =
  | { kind: "read"; session: number; rank: number }
  | { kind: "resolve"; session: number; rank: number; status: ResolveStatus }
  | { kind: "edit"; edit: P9Edit }
  | { kind: "split"; session: number; rank: number }
  | { kind: "createSession" };

export interface P9Trial {
  readonly initial: P9WorkspaceModel;
  readonly ops: readonly P9Op[];
}

/** Valid session names (SPEC 10.1), one per `create` in draw order. */
const SESSION_NAMES = ["r0", "r1"] as const;

const MIN_OPS = 2;
const MAX_OPS = 6;

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

/** A prose line: anchored non-empty plain text (kept under SPEC 3, always). */
const proseText: Gen<string> = (choices) => {
  const anchor = choices.pick(ANCHOR_CHARS);
  const rest = listOf((c: Choices) => c.weightedPick(PROSE_REST), { max: 7 })(
    choices,
  ).join("");
  return anchor + rest;
};

function genSection(
  choices: Choices,
  counter: { next: number },
  depth: number,
): SectionModel {
  const seg = `s${String(counter.next)}`;
  counter.next += 1;
  const prose = proseText(choices);
  const children: SectionModel[] = [];
  while (depth < 2 && children.length < 2 && choices.boolean(0.35)) {
    children.push(genSection(choices, counter, depth + 1));
  }
  return { seg, prose, children };
}

/**
 * 1–2 files, each with 1–3 top-level sections nested up to two levels deep —
 * every file has at least one section, so the initial audit session always
 * has splittable root items and non-trivial `blockedBy` chains.
 */
const genInitialModel: Gen<P9WorkspaceModel> = (choices) => {
  const fileCount = choices.weightedPick<number>([
    [2, 1],
    [3, 2],
  ]);
  const files: FileModel[] = [];
  for (let fileIndex = 0; fileIndex < fileCount; fileIndex += 1) {
    const prose = proseText(choices);
    const counter = { next: 0 };
    const sections: SectionModel[] = [];
    do {
      sections.push(genSection(choices, counter, 0));
    } while (sections.length < 3 && choices.boolean(0.6));
    files.push({ prose, sections, nextSeg: counter.next });
  }
  return { files };
};

/** The trial generator (module header). Exported for dry-run instrumentation. */
export const genP9Trial: Gen<P9Trial> = (choices) => {
  const initial = genInitialModel(choices);
  // The evolving concretization model: mutated as edit ops are drawn, so
  // later draws address the workspace those edits produce. The body replays
  // the same evolution from its own clone of `initial`.
  const working = structuredClone(initial);
  let extraSessionAvailable = true;

  const genEdit = (): P9Edit => {
    const sections = allSectionIdentities(working);
    const menu: (readonly [number, () => P9Edit])[] = [
      [
        2,
        () => ({
          kind: "editProse",
          node: choices.pick(allNodeIdentities(working)),
          text: proseText(choices),
        }),
      ],
      [
        2,
        () => {
          const parent = choices.pick(allNodeIdentities(working));
          const fileIndex = strictFileIndexOf(working, parent);
          return {
            kind: "addSection",
            parent,
            seg: `s${String(working.files[fileIndex].nextSeg)}`,
            prose: proseText(choices),
          };
        },
      ],
    ];
    if (sections.length > 0) {
      menu.push([
        2,
        () => ({ kind: "deleteSection", node: choices.pick(sections) }),
      ]);
    }
    return choices.weightedPick(menu)();
  };

  const genOp = (): P9Op => {
    const menu: (readonly [
      number,
      "read" | "resolve" | "edit" | "split" | "createSession",
    ])[] = [
      [1, "read"], // simplest first: pure reads shrink best
      [3, "resolve"],
      [3, "edit"],
      [2, "split"],
    ];
    if (extraSessionAvailable) menu.push([1, "createSession"]);
    const kind = choices.weightedPick(menu);
    switch (kind) {
      case "read":
        return {
          kind,
          session: choices.intInclusive(0, 1),
          rank: choices.intInclusive(0, 7),
        };
      case "resolve":
        return {
          kind,
          session: choices.intInclusive(0, 1),
          rank: choices.intInclusive(0, 7),
          // `no-change` first (simplest: no re-derivation); the re-derive
          // trigger `updated` weighted highest (P-9 names it explicitly).
          status: choices.weightedPick<ResolveStatus>([
            [2, "no-change"],
            [3, "updated"],
            [1, "skipped"],
          ]),
        };
      case "split":
        return {
          kind,
          session: choices.intInclusive(0, 1),
          rank: choices.intInclusive(0, 7),
        };
      case "createSession":
        extraSessionAvailable = false;
        return { kind };
      case "edit": {
        const edit = genEdit();
        applyP9Edit(working, edit);
        return { kind, edit };
      }
    }
  };

  const ops: P9Op[] = [];
  do {
    ops.push(genOp());
  } while (
    ops.length < MIN_OPS ||
    (ops.length < MAX_OPS && choices.boolean(0.7))
  );
  return { initial, ops };
};

function describeEdit(edit: P9Edit): string {
  switch (edit.kind) {
    case "editProse":
      return `edit: replace the prose of ${edit.node}`;
    case "addSection":
      return `edit: add section ${edit.seg} under ${edit.parent}`;
    case "deleteSection":
      return `edit: delete section ${edit.node}`;
  }
}

function describeOp(op: P9Op): string {
  switch (op.kind) {
    case "edit":
      return describeEdit(op.edit);
    case "resolve":
      return `resolve (rank ${String(op.rank)}) in session#${String(op.session)} --status ${op.status}`;
    case "split":
      return `split (rank ${String(op.rank)}) in session#${String(op.session)}`;
    case "read":
      return `read status+show (rank ${String(op.rank)}) of session#${String(op.session)}`;
    case "createSession":
      return "create the second audit session";
  }
}

/** Compact counterexample rendering; seed replay reconstructs the rest. */
export function renderP9Trial(trial: P9Trial): string {
  return JSON.stringify({
    nodes: allNodeIdentities(trial.initial),
    ops: trial.ops.map(describeOp),
  });
}

// ---------------------------------------------------------------------------
// Execution: session tracking, byte-stable reads, the invariant sweep

interface SessionTracker {
  readonly name: string;
  /** Ids retired by `split` — never allowed to reappear (SPEC 10.7). */
  readonly retired: Set<string>;
  /** Ids present at the previous sweep: only `split` removes items. */
  present: ReadonlySet<string>;
}

function sessionFileRel(name: string): string {
  return `.xspec/reviews/${name}.json`;
}

function sessionAt(
  sessions: readonly SessionTracker[],
  rank: number,
): SessionTracker {
  if (sessions.length === 0) {
    throw new Error(
      "P-9 harness defect: an operation ran before any session was created",
    );
  }
  return sessions[rank % sessions.length];
}

function isResolved(status: ItemStatus): boolean {
  return status === "updated" || status === "no-change" || status === "skipped";
}

function needsReview(status: ItemStatus): boolean {
  return status === "unresolved" || status === "invalidated";
}

/**
 * Capture every session file's bytes, asserting each is stored as a plain
 * file at its 10.1 location (P-9 "stored sessions"; SPEC 13.4).
 */
async function captureSessionBytes(
  workspace: TestWorkspace,
  sessions: readonly SessionTracker[],
  context: string,
): Promise<ReadonlyMap<string, Uint8Array>> {
  const bytes = new Map<string, Uint8Array>();
  for (const tracker of sessions) {
    const rel = sessionFileRel(tracker.name);
    const kind = await workspace.kind(rel);
    if (kind !== "file") {
      fail(
        `${context}: a session is stored at ${rel} as a plain file ` +
          `(SPEC 10.1, 13.4; P-9: stored sessions always re-read as ` +
          `non-corrupt) — found ${kind}`,
      );
    }
    bytes.set(tracker.name, await workspace.readBytes(rel));
  }
  return bytes;
}

/**
 * Run one read command expecting exit 0 with exactly one JSON document,
 * bracketed by byte captures of every session file: reads never change
 * session bytes (P-9; SPEC 10.4).
 */
async function stableJsonRead(
  product: ProductBinding,
  workspace: TestWorkspace,
  sessions: readonly SessionTracker[],
  argv: readonly string[],
  label: string,
): Promise<unknown> {
  const before = await captureSessionBytes(
    workspace,
    sessions,
    `${label} (pre-read capture)`,
  );
  const doc = await runJson(product, workspace, argv, label);
  const after = await captureSessionBytes(
    workspace,
    sessions,
    `${label} (post-read capture)`,
  );
  for (const [name, expected] of before) {
    assertBytesEqual(
      after.get(name) ?? new Uint8Array(),
      expected,
      `${label}: reads never change session bytes (P-9; SPEC 10.4: ` +
        `read-time invalidation is computed and reported, not persisted — ` +
        `sessions change only through the mutating subcommands) — ` +
        sessionFileRel(name),
    );
  }
  return doc;
}

/** `review status <name> --json`, byte-stable, decoded (SPEC 10.7). */
async function readStatusStable(
  product: ProductBinding,
  workspace: TestWorkspace,
  sessions: readonly SessionTracker[],
  name: string,
  label: string,
): Promise<SessionStatusReport> {
  const statusLabel = `${label} — \`review status ${name} --json\``;
  return decodeSessionStatusReport(
    await stableJsonRead(
      product,
      workspace,
      sessions,
      ["review", "status", name, "--json"],
      statusLabel,
    ),
    statusLabel,
  );
}

/** Create the next audit session from the name pool and start tracking it. */
async function createAuditSession(
  product: ProductBinding,
  workspace: TestWorkspace,
  sessions: SessionTracker[],
  label: string,
): Promise<void> {
  const name = SESSION_NAMES[sessions.length];
  if (name === undefined) {
    throw new Error(
      "P-9 harness defect: session name pool exhausted — the generator " +
        "draws at most one extra create",
    );
  }
  await expectExit(
    product,
    workspace,
    ["review", "create", "--strategy", "audit", "--name", name],
    0,
    `${label} — \`review create --strategy audit --name ${name}\` (a fresh ` +
      `valid name; audit needs no baseline) is a valid operation and must ` +
      `succeed (SPEC 10.6, 10.7)`,
  );
  sessions.push({ name, retired: new Set(), present: new Set() });
}

/** The structural invariants of one session's export view (module header). */
function assertSessionInvariants(
  tracker: SessionTracker,
  exported: ExportReport,
  context: string,
): void {
  const items = exported.items;

  // Item ids unique within the session (SPEC 10.2; duplicates make a stored
  // session corrupt, SPEC 10.1).
  const byId = new Map<string, ReviewItem>();
  for (const item of items) {
    if (byId.has(item.id)) {
      fail(
        `${context}: item ids must be unique within the session ` +
          `(SPEC 10.1, 10.2) — id ${item.id} appears more than once`,
      );
    }
    byId.set(item.id, item);
  }

  // At most one item per kind and scope node (P-9; SPEC 10.1, 10.5).
  const byKindScope = new Map<string, string>();
  for (const item of items) {
    const key = `${item.kind} ${item.scope.node}`;
    const prior = byKindScope.get(key);
    if (prior !== undefined) {
      fail(
        `${context}: at most one item per kind and scope node (P-9; ` +
          `SPEC 10.1, 10.5: a session never contains two items with the ` +
          `same kind and scope node) — items ${prior} and ${item.id} are ` +
          `both \`${key}\``,
      );
    }
    byKindScope.set(key, item.id);
  }

  // blockedBy names only present ids (SPEC 10.1) and is acyclic (P-9).
  for (const item of items) {
    for (const ref of item.blockedBy) {
      if (!byId.has(ref)) {
        fail(
          `${context}: blockedBy must name only item ids present in the ` +
            `session (SPEC 10.1) — item ${item.id} is blocked by unknown ` +
            `id ${ref}`,
        );
      }
    }
  }
  assertAcyclicBlockedBy(items, byId, context);

  // Blocked-state consistency (SPEC 10.3: blocked while any blockedBy item
  // is not resolved, over the statuses this same read reports).
  for (const item of items) {
    const unresolvedBlockers = item.blockedBy.filter((ref) => {
      const blocker = byId.get(ref);
      return blocker !== undefined && !isResolved(blocker.status);
    });
    const expectBlocked = unresolvedBlockers.length > 0;
    if (item.blocked !== expectBlocked) {
      fail(
        `${context}: an item is blocked while any item in its blockedBy is ` +
          `not resolved (SPEC 10.3) — item ${item.id} reports ` +
          `blocked=${String(item.blocked)}, but its blockers' reported ` +
          `statuses imply ${String(expectBlocked)} (not-resolved blockers: ` +
          `${JSON.stringify(unresolvedBlockers)})`,
      );
    }
  }

  // Retired ids never reused — a split's original never reappears (P-9;
  // SPEC 10.7: the original item is removed and its id is never reused).
  for (const item of items) {
    if (tracker.retired.has(item.id)) {
      fail(
        `${context}: retired ids are never reused (P-9; SPEC 10.7: split ` +
          `removes the original item and its id is never reused) — retired ` +
          `id ${item.id} is present as \`${item.kind} ${item.scope.node}\``,
      );
    }
  }

  // Continuity: items leave a session only through split (SPEC 10.5: items
  // that no longer generate remain) — the check that makes retired-id
  // tracking sound (an id vanishing any other way would evade it).
  const present = new Set(byId.keys());
  for (const prior of tracker.present) {
    if (!present.has(prior) && !tracker.retired.has(prior)) {
      fail(
        `${context}: items never leave a session except through split ` +
          `(SPEC 10.5: items that no longer generate remain in the ` +
          `session; SPEC 10.7) — item ${prior} vanished without one`,
      );
    }
  }
  tracker.present = present;
}

/** Fail with the concrete cycle when blockedBy is not acyclic (P-9). */
function assertAcyclicBlockedBy(
  items: readonly ReviewItem[],
  byId: ReadonlyMap<string, ReviewItem>,
  context: string,
): void {
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, stack: string[]): void => {
    const mark = state.get(id);
    if (mark === "done") return;
    if (mark === "visiting") {
      const start = stack.indexOf(id);
      fail(
        `${context}: blockedBy must be acyclic (P-9; SPEC 10.1: no item ` +
          `transitively blocks itself) — cycle: ` +
          [...stack.slice(start), id].join(" -> "),
      );
    }
    state.set(id, "visiting");
    stack.push(id);
    const item = byId.get(id);
    if (item !== undefined) {
      for (const ref of item.blockedBy) {
        if (byId.has(ref)) visit(ref, stack);
      }
    }
    stack.pop();
    state.set(id, "done");
  };
  for (const item of items) visit(item.id, []);
}

/**
 * The `next` contract (P-9): an unblocked needing-review item, or fully
 * resolved exactly when nothing needs review — cross-checked against the
 * adjacent export of the same state (no mutation between the reads; reads
 * are pure, as the byte-stability assertions establish).
 */
function assertNextContract(
  next: NextReport,
  exported: ExportReport,
  context: string,
): void {
  const byId = new Map(exported.items.map((item) => [item.id, item] as const));
  const needing = exported.items.filter((item) => needsReview(item.status));
  if (next.fullyResolved) {
    if (needing.length > 0) {
      const example = needing[0];
      fail(
        `${context}: \`next\` reports the session fully resolved, but ` +
          `${String(needing.length)} item(s) still need review in the ` +
          `adjacent export of the same state (P-9; SPEC 10.7: when no item ` +
          `qualifies, every item is resolved) — e.g. ${example.id} ` +
          `(${example.kind} ${example.scope.node}, status ${example.status})`,
      );
    }
    return;
  }
  const item = next.item;
  if (item === undefined) {
    fail(
      `${context}: not fully resolved, so \`next\` must return an item ` +
        `(SPEC 10.7)`,
    );
  }
  const row = byId.get(item.id);
  if (row === undefined) {
    fail(
      `${context}: \`next\` returned item ${item.id}, which the adjacent ` +
        `export of the same state does not contain (P-9; SPEC 10.7)`,
    );
  }
  if (!needsReview(item.status) || !needsReview(row.status)) {
    fail(
      `${context}: \`next\` must return a needing-review item — unresolved ` +
        `or invalidated (P-9; SPEC 10.3, 10.7) — but ${item.id} has status ` +
        `${item.status} in the payload and ${row.status} in the export`,
    );
  }
  const unresolvedBlockers = row.blockedBy.filter((ref) => {
    const blocker = byId.get(ref);
    return blocker !== undefined && !isResolved(blocker.status);
  });
  if (unresolvedBlockers.length > 0) {
    fail(
      `${context}: \`next\` must return an UNBLOCKED needing-review item ` +
        `(P-9; SPEC 10.3, 10.7) — ${item.id} is blocked by ` +
        `${unresolvedBlockers.join(", ")}, not resolved in the adjacent export`,
    );
  }
  if (item.blocked || row.blocked) {
    fail(
      `${context}: the item \`next\` returns must present as unblocked ` +
        `(SPEC 10.3, 10.7) — payload blocked=${String(item.blocked)}, ` +
        `export blocked=${String(row.blocked)}`,
    );
  }
  if (item.kind !== row.kind || item.scope.node !== row.scope.node) {
    fail(
      `${context}: item ${item.id} presents inconsistently across \`next\` ` +
        `and \`export\` of the same state — next: \`${item.kind} ` +
        `${item.scope.node}\`, export: \`${row.kind} ${row.scope.node}\``,
    );
  }
}

/**
 * The full invariant sweep, run after `create` and after every operation:
 * per session an `export` (structural invariants) and a `next` (contract),
 * then one `list` — every read byte-stable, exit 0, decodable (P-9
 * "non-corrupt": a corrupt session exits 1 from every subcommand naming it,
 * SPEC 10.1, 14.21).
 */
async function sweepInvariants(
  product: ProductBinding,
  workspace: TestWorkspace,
  sessions: readonly SessionTracker[],
  label: string,
): Promise<void> {
  for (const tracker of sessions) {
    const exportLabel = `${label} — \`review export ${tracker.name} --json\``;
    const exported = decodeExportReport(
      await stableJsonRead(
        product,
        workspace,
        sessions,
        ["review", "export", tracker.name, "--json"],
        exportLabel,
      ),
      exportLabel,
    );
    assertSessionInvariants(tracker, exported, exportLabel);
    const nextLabel = `${label} — \`review next ${tracker.name} --json\``;
    const next = decodeNextReport(
      await stableJsonRead(
        product,
        workspace,
        sessions,
        ["review", "next", tracker.name, "--json"],
        nextLabel,
      ),
      nextLabel,
    );
    assertNextContract(next, exported, nextLabel);
  }
  const listLabel = `${label} — \`review list --json\``;
  const listed = decodeSessionListReport(
    await stableJsonRead(
      product,
      workspace,
      sessions,
      ["review", "list", "--json"],
      listLabel,
    ),
    listLabel,
  );
  assertSameJson(
    listed.sessions.map((entry) => entry.name).sort(),
    sessions.map((tracker) => tracker.name).sort(),
    `${listLabel}: \`list\` reports every session — exactly the created ` +
      `ones by name (SPEC 10.7; only files named <session-name>.json under ` +
      `.xspec/reviews/ are sessions, SPEC 10.1)`,
  );
  for (const entry of listed.sessions) {
    if (entry.corrupt) {
      fail(
        `${listLabel}: stored sessions always re-read as non-corrupt (P-9; ` +
          `SPEC 10.1, 14.21) — \`list\` reports session ${entry.name} corrupt`,
      );
    }
  }
}

/** Execute one drawn operation (module header: validity discipline). */
async function executeOp(
  product: ProductBinding,
  workspace: TestWorkspace,
  model: P9WorkspaceModel,
  sessions: SessionTracker[],
  op: P9Op,
  label: string,
): Promise<void> {
  switch (op.kind) {
    case "edit": {
      applyP9Edit(model, op.edit);
      for (const [rel, contents] of Object.entries(renderP9Workspace(model))) {
        await workspace.file(rel, contents);
      }
      await buildOk(
        product,
        workspace,
        `${label} — \`build\` after the edit (edited workspaces stay valid ` +
          `by construction)`,
      );
      return;
    }
    case "createSession": {
      await createAuditSession(product, workspace, sessions, label);
      return;
    }
    case "read": {
      // Every read operation exercises both non-sweep reads: `status`, then
      // `show` of the rank-picked item (the sweep covers export/next/list).
      const tracker = sessionAt(sessions, op.session);
      const status = await readStatusStable(
        product,
        workspace,
        sessions,
        tracker.name,
        label,
      );
      if (status.items.length === 0) {
        fail(
          `${label}: an audit session over a non-empty workspace holds at ` +
            `least one item — one per requirement node at creation ` +
            `(SPEC 10.6), and items leave only through split, which always ` +
            `adds replacements (SPEC 10.5, 10.7) — but \`status\` reports ` +
            `none`,
        );
      }
      const row = status.items[op.rank % status.items.length];
      const showLabel = `${label} — \`review show ${tracker.name} ${row.id} --json\``;
      const item = decodeItemReport(
        await stableJsonRead(
          product,
          workspace,
          sessions,
          ["review", "show", tracker.name, row.id, "--json"],
          showLabel,
        ),
        showLabel,
      );
      if (item.id !== row.id) {
        fail(
          `${showLabel}: \`show\` must report the named item (SPEC 10.7) — ` +
            `asked for ${row.id}, got ${item.id}`,
        );
      }
      return;
    }
    case "resolve": {
      const tracker = sessionAt(sessions, op.session);
      const status = await readStatusStable(
        product,
        workspace,
        sessions,
        tracker.name,
        `${label} — target selection`,
      );
      const unblocked = status.items.filter((row) => !row.blocked);
      if (unblocked.length === 0) {
        fail(
          `${label}: no unblocked item to resolve — an audit session here ` +
            `always holds items (SPEC 10.6; items leave only through ` +
            `split, SPEC 10.5, 10.7), and with acyclic blockedBy some ` +
            `item's blockers are all resolved (SPEC 10.1, 10.3), so a ` +
            `non-empty session with zero unblocked items violates the ` +
            `blocking contract (got ${String(status.items.length)} items, ` +
            `all reported blocked)`,
        );
      }
      const row = unblocked[op.rank % unblocked.length];
      await expectExit(
        product,
        workspace,
        ["review", "resolve", tracker.name, row.id, "--status", op.status],
        0,
        `${label} — resolving the unblocked item ${row.id} (${row.kind} ` +
          `${row.scope}) with --status ${op.status} is a valid operation ` +
          `regardless of its current status and must succeed (SPEC 10.7)`,
      );
      return;
    }
    case "split": {
      const tracker = sessionAt(sessions, op.session);
      const status = await readStatusStable(
        product,
        workspace,
        sessions,
        tracker.name,
        `${label} — target selection`,
      );
      const eligible = status.items.filter(
        (row) =>
          row.kind === "subtree-coherence" &&
          currentChildCount(model, row.scope) > 0,
      );
      // No eligible target: the operation degrades to the status read it
      // already performed (module header) — never an invalid `split`.
      if (eligible.length === 0) return;
      const row = eligible[op.rank % eligible.length];
      await expectExit(
        product,
        workspace,
        ["review", "split", tracker.name, row.id],
        0,
        `${label} — splitting ${row.id} (subtree-coherence at ${row.scope}, ` +
          `whose scope root currently has child sections) is a valid ` +
          `operation and must succeed (SPEC 10.7)`,
      );
      tracker.retired.add(row.id);
      return;
    }
  }
}

/** One trial: stage, create, run the op sequence, sweep after every step. */
async function runP9Trial(
  product: ProductBinding,
  trial: P9Trial,
): Promise<void> {
  const model = structuredClone(trial.initial);
  const workspace = await TestWorkspace.create({
    files: {
      "xspec.config.ts": SPECS_ONLY_CONFIG,
      ...renderP9Workspace(model),
    },
  });
  try {
    await buildOk(
      product,
      workspace,
      "P-9: `build` of the generated workspace (the generator stages only " +
        "valid workspaces)",
    );
    const sessions: SessionTracker[] = [];
    await createAuditSession(
      product,
      workspace,
      sessions,
      "P-9: initial session",
    );
    await sweepInvariants(
      product,
      workspace,
      sessions,
      "P-9 after `review create`",
    );
    for (let index = 0; index < trial.ops.length; index += 1) {
      const op = trial.ops[index];
      const label = `P-9 op ${String(index + 1)}/${String(trial.ops.length)} [${describeOp(op)}]`;
      await executeOp(product, workspace, model, sessions, op, label);
      await sweepInvariants(
        product,
        workspace,
        sessions,
        `${label} — post-operation sweep`,
      );
    }
  } finally {
    await workspace.dispose();
  }
}

// ---------------------------------------------------------------------------
// Registration

const P_9 = defineProductTest({
  id: "P-9",
  title:
    "review session invariants under random sequences of valid review operations interleaved with workspace edits (TEST-SPEC §16 P-9): audit sessions driven through create, resolve (re-derive triggers included: --status updated), split, and reads, with prose edits, section additions, and section deletions (each followed by `build`) in between — after every operation the session holds at most one item per kind and scope node; blockedBy is acyclic and names only present items, with every item's blocked state consistent with its blockers' reported statuses; ids retired by split never reappear (and items leave the session only through split); `next` returns an unblocked needing-review item consistent with an adjacent export, or reports fully resolved exactly when no item needs review; reads (status/next/show/export/list) never change session bytes; and stored sessions always re-read as non-corrupt plain files, with `review list` reporting exactly the created sessions, none corrupt (SPEC 10.1-10.7, 13.4, 14.21)",
  // Wall-clock hang guard only (H-10): three fixed seeds (E-5), up to 6
  // operations per trial, each operation costing a handful of product
  // invocations (the op itself plus the per-session export/next/list sweep).
  timeoutMs: 600_000,
  run: async (product) => {
    await checkProperty(
      "P-9 review session invariants",
      genP9Trial,
      async (trial) => {
        await runP9Trial(product, trial);
      },
      { runs: 3, maxShrinkExecutions: 50, render: renderP9Trial },
    );
  },
});

/** TEST-SPEC §16 P-9, registered as PROP-07. */
export const section16P9Tests: readonly ProductTestEntry[] = [P_9];
