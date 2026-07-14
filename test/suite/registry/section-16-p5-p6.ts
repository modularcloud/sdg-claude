// TEST-SPEC §16 P-5 (rename/move purity) and P-6 (baseline replay) — PROP-04.
//
// Two registered product-facing property tests (C-2 "one code path") over the
// PROP-03 workspace model (section-16-p4.ts): seeded, reproducible generators
// (helpers/property.ts, H-10; fixed seed set in CI, E-5) produce random valid
// workspaces, then drive `xspec rename`, the file and section forms of
// `xspec move`, staged edits, and scripted git commits (HARNESS-01: pinned,
// platform-independent commit metadata) against them.
//
//   * P-5 arm 1 — purity sequences. A random workspace, committed as a git
//     baseline, then 1–3 journaled operations drawn from `rename` (fresh
//     final segment, descendants re-prefixed) and file-form `move` (fresh
//     `specs/N<k>.mdx` destination), each followed by a commit. After every
//     operation: `query nodes` enumerates exactly the mapped identity set,
//     every node's four hashes are byte-identical to the previous sweep under
//     the operation's identity map (SPEC 6.2, 5.4), `check` exits 0 — all
//     references resolve and the journal replays (SPEC 12.2, the
//     operationalization of P-5's "all references still resolve") — and
//     `impact --base <c>` against every prior commit in the sequence reports
//     no requirement categories and no impacted code (SPEC 6.2, 6.3, 9).
//   * P-5 arm 2 — random section moves. One random section-form `move`: any
//     section subtree to a random valid target parent (its own parent, a
//     section of any file, or a file root — same-file and cross-file), under
//     a fresh ID. Staged tags/coverage/`d` travel with the subtree. The
//     impact report against the pre-move baseline must equal the oracle diff
//     of the before/after workspace models: with the PROP-03 staging
//     discipline every construct tag stands alone on its line, so no moved
//     node has own-content bytes on the construct's straddling lines and the
//     moved subtree keeps every hash (SPEC 6.2) — the only originators are
//     the parents whose own-content sequence changed (origin and target; or
//     none, when re-inserting a final child at its own former position
//     reproduces the parent's content exactly), with the ordinary 5.6
//     cascades and nothing else: P-5's "only the predicted parents gain
//     categories".
//   * P-6 — baseline replay. A random interleaving of staged edits (the
//     PROP-03 edit classes), `rename`, file-form `move`, and commits; then
//     `impact --base` against every historical baseline must equal the
//     oracle diff of the baseline-snapshot model against the current model,
//     with identities mapped through the journal suffix (SPEC 6.3) — the
//     harness composes the per-operation mappings it requested, which is
//     exactly the journal suffix a conforming product replays.
//
// The oracle (shared by P-5 arm 2 and P-6) computes SPEC 5.6 categories from
// the harness's own model semantics (section-16-p4.ts `semanticsOf`): per
// node, `changed` iff added or its own-content token sequence changed;
// `metadata-changed` iff its `d`-target set, coverage, or tag set changed;
// `descendant-changed` iff a changed node lies among its strict descendants
// (either side); `upstream-changed` iff its effective state changed through a
// dependency-edge cause — a dependency-edge target (of the node or of a
// both-sides subtree node) whose effective state changed, or a strict-subtree
// node whose dependency-edge pair multiset changed (SPEC 5.5's effectiveHash
// recursion, evaluated as a fixpoint over the model).
//
// Conservative operationalizations (noted per H-4):
// - "No change categories" is asserted as an empty `requirements` list — the
//   suite's fixed T1.5-1 interpretation (SPEC 9.3 groups output by category),
//   carried through SUITE-20/22; entry granularity is merged per node
//   identity (the SUITE-20 convention).
// - Category sets are asserted exactly per node; attributions are asserted
//   within the diff's originating-node set (SPEC 5.6: every category MUST be
//   attributed to its originating nodes), the empty list accepted — exact
//   causal attribution is pinned by the deterministic tests (SUITE-20/22).
// - The two-sided ambiguity documented by T6.2-3 — a node whose one-side-only
//   subtree member carries the cause — is kept out of the required diff: the
//   generators never let a changed or metadata-changed node relocate (guarded
//   as a harness defect), P-6 stages no section moves and never deletes
//   nodes, and added sections carry no dependency edges. The one residual
//   case — an ancestor holding a *relocated* dependency-bearing node on one
//   side only while that node's target changed effectively — makes
//   `upstream-changed` optional on exactly those ancestors, accepted present
//   or absent (mirroring T6.2-3's documented tolerance).
// - Every `impact` run follows a successful `build` (the SUITE-20/22
//   protocol); P-5's operations regenerate as `build` does (SPEC 6.4), so no
//   extra build is needed between operations.
// - P-6 applies a staged edit by rewriting the edited file from the model —
//   the file's body is byte-deterministic after journaled renames (SPEC 6.4:
//   minimal in-place edits, forms preserved; every generated segment is a
//   TypeScript identifier) and the import header is recomputed against the
//   files' current paths in the pinned 2.1 form (`./NAME.xspec`, one default
//   binding per line). Byte-exactness of the product's own rewrites is
//   T6.4-2/T6.5-*'s business, not P-6's: a deviating byte form would be
//   replaced by an equivalent-semantics staging here (import spellings and
//   reference spellings enter no hash, SPEC 5.4), never silently trusted.
// - Baselines are commits of the full working tree (sources, configuration,
//   the journal — 6.3 replays the journal content at the ref — and whatever
//   derived files exist; derived files match no spec group and are inert to
//   baseline reconstruction).
// - Identity reuse never occurs: fresh segments come from the model's
//   per-file counters and fresh file names from a trial counter, so the 9.3
//   deleted/added identity-collision edge case stays out of the input space
//   (it is deterministic-test material).
//
// P-5 and P-6 are outside every CERTIFICATIONS.md fixture scope (its
// preamble: conformers for P-4/P-5/P-6 would be near-complete second
// products), so these bodies bind only to the real product surface: `build`,
// `check`, `rename`, `move`, `query node`/`query nodes`, and
// `impact --base` (SPEC 6, 9, 11, 12), decoded through the H-3 adapters.

import type {
  ChangeCategory,
  ImpactReport,
  NodeHashes,
} from "../../helpers/adapters/index.js";
import {
  decodeNodeReport,
  decodeNodeRowsReport,
} from "../../helpers/adapters/index.js";
import { fail } from "../../helpers/assertions.js";
import type { Choices, Gen } from "../../helpers/property.js";
import { checkProperty } from "../../helpers/property.js";
import { defineProductTest } from "../../helpers/registry.js";
import type { ProductTestEntry } from "../../helpers/registry.js";
import type { ProductBinding } from "../../helpers/subprocess.js";
import { TestWorkspace } from "../../helpers/workspace.js";
import type {
  BodyItem,
  Edit,
  EditClass,
  RefModel,
  SectionItem,
  WorkspaceModel,
} from "./section-16-p4.js";
import {
  applyEdit,
  genEditOfClass,
  genWorkspaceModel,
  renderWorkspace,
  semanticsOf,
} from "./section-16-p4.js";
import { SPECS_ONLY_CONFIG, impactAgainst } from "./section-5.6.js";
import {
  assertSameJson,
  buildOk,
  expectExit,
  runJson,
  sortedIdentities,
} from "./support.js";

// ---------------------------------------------------------------------------
// Identity spaces and semantic maps
//
// Internally everything speaks the PROP-03 model space: file paths are the
// generator's `specs/A.mdx`… and dotted IDs are the model's current segments.
// Renames and section moves mutate the model's segments and references (the
// model always mirrors the workspace's current IDs); file moves mutate only
// the trial state's path table. Workspace identities — what the product's
// arguments and reports speak — are the model identities with the path table
// applied. Baseline-to-current mapping composes the per-operation segment
// maps (recorded in model-path space) and applies the current path table
// last, so no per-commit path bookkeeping is ever needed.

type IdentityFn = (identity: string) => string;

/** Semantic content of one node, in whatever identity space it was mapped to. */
interface NodeSemantics {
  readonly children: readonly string[];
  readonly ownTokens: string;
  readonly metaKey: string;
  readonly pairKey: string;
  readonly edgeTargets: readonly string[];
}

type SemanticsMap = ReadonlyMap<string, NodeSemantics>;

function composeIdentityMaps(
  maps: ReadonlyArray<Readonly<Record<string, string>>>,
): IdentityFn {
  return (identity) => {
    let current = identity;
    for (const map of maps) {
      current = map[current] ?? current;
    }
    return current;
  };
}

/**
 * Map every identity occurrence of a semantics map — keys, child lists, the
 * reference tokens inside `ownTokens`, the `d`-target set inside `metaKey`,
 * the dependency-edge pair multiset `pairKey`, and `edgeTargets` — through
 * `fn`, re-sorting the sorted components (mapping is injective over the
 * staged spaces, so deduplicated sets stay deduplicated).
 */
function mapSemantics(sems: SemanticsMap, fn: IdentityFn): SemanticsMap {
  const mapped = new Map<string, NodeSemantics>();
  for (const [identity, sem] of sems) {
    const tokens = JSON.parse(sem.ownTokens) as [string, string][];
    const [deps, coverage, tags] = JSON.parse(sem.metaKey) as [
      string[],
      string,
      string[],
    ];
    const pairs = JSON.parse(sem.pairKey) as string[];
    mapped.set(fn(identity), {
      children: sem.children.map(fn),
      ownTokens: JSON.stringify(
        tokens.map(([kind, value]) =>
          kind === "run" ? [kind, value] : [kind, fn(value)],
        ),
      ),
      metaKey: JSON.stringify([deps.map(fn).sort(), coverage, tags]),
      pairKey: JSON.stringify(pairs.map(fn).sort()),
      edgeTargets: sem.edgeTargets.map(fn).sort(),
    });
  }
  if (mapped.size !== sems.size) {
    throw new Error(
      "P-5/P-6 harness defect: an identity map collapsed two identities — " +
        "generated operations never reuse identities",
    );
  }
  return mapped;
}

// ---------------------------------------------------------------------------
// The SPEC 5.6 category oracle
//
// Inputs are two semantics maps in one identity space (the baseline mapped
// forward to current identities). Output: per current-graph node the exact
// required category set, the optional-upstream tolerance set, and the
// originating-node attribution bound (module header, H-4).

interface OracleDiff {
  /** Exact required category set per current-graph node identity. */
  readonly required: ReadonlyMap<string, ReadonlySet<ChangeCategory>>;
  /** Nodes that may additionally carry `upstream-changed` (module header). */
  readonly optionalUpstream: ReadonlySet<string>;
  /** Attribution bound: every originating node's current identity. */
  readonly originators: ReadonlySet<string>;
}

/** Memoized strict-descendant sets over one side's `children` lists. */
function strictDescendants(sems: SemanticsMap): Map<string, Set<string>> {
  const memo = new Map<string, Set<string>>();
  const visiting = new Set<string>();
  const resolve = (identity: string): Set<string> => {
    const cached = memo.get(identity);
    if (cached !== undefined) return cached;
    if (visiting.has(identity)) {
      throw new Error(
        `P-5/P-6 harness defect: contains-cycle through ${identity}`,
      );
    }
    visiting.add(identity);
    const sem = sems.get(identity);
    if (sem === undefined) {
      throw new Error(`P-5/P-6 harness defect: no semantics for ${identity}`);
    }
    const descendants = new Set<string>();
    for (const child of sem.children) {
      descendants.add(child);
      for (const inner of resolve(child)) descendants.add(inner);
    }
    visiting.delete(identity);
    memo.set(identity, descendants);
    return descendants;
  };
  for (const identity of sems.keys()) resolve(identity);
  return memo;
}

function computeOracleDiff(
  before: SemanticsMap,
  after: SemanticsMap,
): OracleDiff {
  const kept = [...before.keys()].filter((identity) => after.has(identity));
  const added = [...after.keys()].filter((identity) => !before.has(identity));
  const deleted = [...before.keys()].filter((identity) => !after.has(identity));
  if (deleted.length > 0) {
    throw new Error(
      `P-5/P-6 harness defect: the generated history deleted node(s) ` +
        `${deleted.join(", ")} — deletions are outside PROP-04's input space ` +
        `(module header)`,
    );
  }
  const beforeAt = (identity: string): NodeSemantics => {
    const sem = before.get(identity);
    if (sem === undefined) {
      throw new Error(
        `P-5/P-6 harness defect: no baseline semantics for ${identity}`,
      );
    }
    return sem;
  };
  const afterAt = (identity: string): NodeSemantics => {
    const sem = after.get(identity);
    if (sem === undefined) {
      throw new Error(
        `P-5/P-6 harness defect: no current semantics for ${identity}`,
      );
    }
    return sem;
  };

  const keptSet = new Set(kept);
  const ownChanged = new Set(
    kept.filter((id) => beforeAt(id).ownTokens !== afterAt(id).ownTokens),
  );
  const metaChanged = new Set(
    kept.filter((id) => beforeAt(id).metaKey !== afterAt(id).metaKey),
  );
  const pairChanged = new Set(
    kept.filter((id) => beforeAt(id).pairKey !== afterAt(id).pairKey),
  );
  const changedSet = new Set([...ownChanged, ...added]);
  const originators = new Set([...changedSet, ...metaChanged]);

  const descBefore = strictDescendants(before);
  const descAfter = strictDescendants(after);
  const descAt = (
    memo: Map<string, Set<string>>,
    identity: string,
  ): Set<string> => memo.get(identity) ?? new Set<string>();

  // Input-space guard (module header, H-4): an originator never relocates —
  // its strict-ancestor relation is two-sided — so `descendant-changed` is
  // never ambiguous. Added nodes are one-sided by nature (the 5.6 worked
  // example pins their ancestors' category) and carry no dependency edges.
  for (const id of kept) {
    if (!ownChanged.has(id) && !metaChanged.has(id)) continue;
    const beforeHolders = kept.filter((a) => descAt(descBefore, a).has(id));
    const afterHolders = kept.filter((a) => descAt(descAfter, a).has(id));
    if (
      JSON.stringify(beforeHolders.sort()) !==
      JSON.stringify(afterHolders.sort())
    ) {
      throw new Error(
        `P-5/P-6 harness defect: originating node ${id} relocated between ` +
          `baseline and current — the generators must never move a changed ` +
          `node (module header)`,
      );
    }
  }
  for (const id of added) {
    if (afterAt(id).edgeTargets.length > 0) {
      throw new Error(
        `P-5/P-6 harness defect: added node ${id} carries dependency edges — ` +
          `added sections must be dependency-free (module header)`,
      );
    }
  }

  // effChanged fixpoint over kept nodes: own content changed, own pair
  // multiset changed, a both-sides child changed effectively, or a
  // both-sides dependency-edge target changed effectively (SPEC 5.5; added
  // or removed children and edges surface through ownTokens/pairKey).
  const effMemo = new Map<string, boolean>();
  const effVisiting = new Set<string>();
  const commonOf = (
    beforeList: readonly string[],
    afterList: readonly string[],
  ): string[] =>
    beforeList.filter((id) => keptSet.has(id) && afterList.includes(id));
  const effChanged = (id: string): boolean => {
    const cached = effMemo.get(id);
    if (cached !== undefined) return cached;
    if (effVisiting.has(id)) {
      throw new Error(
        `P-5/P-6 harness defect: dependency/contains cycle through ${id} — ` +
          `generated graphs are acyclic by construction (SPEC 5.3)`,
      );
    }
    effVisiting.add(id);
    const result =
      ownChanged.has(id) ||
      pairChanged.has(id) ||
      commonOf(beforeAt(id).children, afterAt(id).children).some(effChanged) ||
      commonOf(beforeAt(id).edgeTargets, afterAt(id).edgeTargets).some(
        effChanged,
      );
    effVisiting.delete(id);
    effMemo.set(id, result);
    return result;
  };

  // A node's dependency-edge cause (SPEC 5.6 upstream-changed): a common
  // dependency-edge target of the node itself or of a subtree node whose
  // effective state changed, or a strict-subtree node (not the node itself)
  // whose pair multiset changed. Both-sides subtree members give the
  // required cause; one-side-only kept members (relocated subtrees) give the
  // optional tolerance (module header, H-4).
  const targetCause = (id: string): boolean =>
    commonOf(beforeAt(id).edgeTargets, afterAt(id).edgeTargets).some(
      effChanged,
    );
  const memberCause = (member: string): boolean =>
    pairChanged.has(member) || targetCause(member);

  const required = new Map<string, Set<ChangeCategory>>();
  const optionalUpstream = new Set<string>();
  for (const id of kept) {
    const categories = new Set<ChangeCategory>();
    if (ownChanged.has(id)) categories.add("changed");
    if (metaChanged.has(id)) categories.add("metadata-changed");
    const beforeDesc = descAt(descBefore, id);
    const afterDesc = descAt(descAfter, id);
    const eitherDesc = new Set([...beforeDesc, ...afterDesc]);
    if ([...eitherDesc].some((d) => changedSet.has(d))) {
      categories.add("descendant-changed");
    }
    if (effChanged(id)) {
      const bothMembers = [...beforeDesc].filter(
        (d) => keptSet.has(d) && afterDesc.has(d),
      );
      if (targetCause(id) || bothMembers.some(memberCause)) {
        categories.add("upstream-changed");
      } else {
        const oneSided = [...eitherDesc].filter(
          (d) => keptSet.has(d) && !(beforeDesc.has(d) && afterDesc.has(d)),
        );
        // Only a relocated (one-side-only) subtree member's dependency cause
        // makes the category tolerable-but-not-required (module header, H-4).
        if (oneSided.some(memberCause)) optionalUpstream.add(id);
      }
    }
    required.set(id, categories);
  }
  for (const id of added) {
    // An added node is `changed` and receives no category through its own
    // hashes (SPEC 5.6).
    required.set(id, new Set<ChangeCategory>(["changed"]));
  }
  return { required, optionalUpstream, originators };
}

// ---------------------------------------------------------------------------
// Impact-report-vs-oracle assertion (SPEC 5.6, 9.1, 9.3; SUITE-20 merging)

function assertImpactMatchesOracle(
  report: ImpactReport,
  oracle: OracleDiff,
  context: string,
): void {
  interface MergedNode {
    deleted: boolean;
    readonly categories: Map<ChangeCategory, string[]>;
  }
  const actual = new Map<string, MergedNode>();
  for (const entry of report.requirements) {
    for (const identity of entry.nodes) {
      if (!oracle.required.has(identity)) {
        fail(
          `${context}: the report names ${JSON.stringify(identity)}, which is ` +
            `no current node of the workspace (in the workspace-relative ` +
            `identity form of SPEC 1.5) — a pre-operation identity here means ` +
            `the product failed to unify identities through the journal ` +
            `suffix (SPEC 6.3, 9.2); entry: ${JSON.stringify(entry)}`,
        );
      }
      if (entry.deleted) {
        fail(
          `${context}: an entry names ${JSON.stringify(identity)} as deleted — ` +
            `this history deletes nothing: journaled operations map ` +
            `identities forward and staged edits only add (SPEC 6.2, 6.3, ` +
            `9.3); entry: ${JSON.stringify(entry)}`,
        );
      }
      let merged = actual.get(identity);
      if (merged === undefined) {
        merged = { deleted: false, categories: new Map() };
        actual.set(identity, merged);
      }
      for (const category of entry.categories) {
        const attributed = merged.categories.get(category.category) ?? [];
        attributed.push(...category.attributedTo);
        merged.categories.set(category.category, attributed);
      }
    }
  }

  for (const [identity, requiredSet] of oracle.required) {
    const merged = actual.get(identity);
    const actualNames = merged ? [...merged.categories.keys()] : [];
    const requiredNames = [...requiredSet].sort();
    if (requiredNames.length === 0 && !oracle.optionalUpstream.has(identity)) {
      if (merged !== undefined) {
        fail(
          `${context}: ${identity} must receive no category — its own ` +
            `content, metadata, subtree, and effective state are unchanged ` +
            `under the journal mapping (SPEC 5.6, 6.2, 6.3) — and so appear ` +
            `in no requirement entry (SPEC 9.3 groups output by category; ` +
            `the T1.5-1 convention), but the report names it with ` +
            `${JSON.stringify(actualNames.sort())}`,
        );
      }
      continue;
    }
    for (const name of requiredNames) {
      if (!actualNames.includes(name)) {
        fail(
          `${context}: ${identity} must carry ${name} — the oracle graph ` +
            `diff derives it from the staged history (SPEC 5.6, 9.1) — but ` +
            `the report gives it only ${JSON.stringify(actualNames.sort())}`,
        );
      }
    }
    for (const name of actualNames) {
      if (requiredSet.has(name)) continue;
      if (name === "upstream-changed" && oracle.optionalUpstream.has(identity))
        continue;
      fail(
        `${context}: ${identity} carries the category ${name}, which the ` +
          `oracle graph diff gives it no ground for — expected exactly ` +
          `${JSON.stringify(requiredNames)}` +
          `${oracle.optionalUpstream.has(identity) ? " (upstream-changed tolerated, module header)" : ""} ` +
          `(SPEC 5.6, 9.1)`,
      );
    }
    for (const [name, rawAttribution] of merged?.categories ?? []) {
      for (const attributed of new Set(rawAttribution)) {
        if (!oracle.originators.has(attributed)) {
          fail(
            `${context}: the ${name} category of ${identity} is attributed ` +
              `to ${JSON.stringify(attributed)}, which is no originating ` +
              `node of this diff — every category is attributed to its ` +
              `originating nodes, the nodes where edits occurred (SPEC 5.6); ` +
              `originators: ${JSON.stringify([...oracle.originators].sort())}`,
          );
        }
      }
    }
  }

  assertSameJson(
    report.code,
    { direct: [], transitive: [] },
    `${context}: no code groups are configured, so no code location is ` +
      `impacted (SPEC 9.2)`,
  );
}

/** Assert a pure history: no requirement entry at all, no impacted code. */
function assertEmptyImpact(report: ImpactReport, context: string): void {
  assertSameJson(
    report.requirements,
    [],
    `${context}: journaled rename/file-move operations are pure — every hash ` +
      `is unchanged and identities map through the journal, so no node ` +
      `receives any category and the requirements list is empty (SPEC 6.2, ` +
      `6.3, 9.1; the T1.5-1 convention)`,
  );
  assertSameJson(
    report.code,
    { direct: [], transitive: [] },
    `${context}: no code groups are configured, so no code location is ` +
      `impacted (SPEC 9.2)`,
  );
}

// ---------------------------------------------------------------------------
// Trial state, model walkers, and operation appliers

interface TrialState {
  /** The model, mutated to mirror the workspace's current IDs and refs. */
  model: WorkspaceModel;
  /** Model-space path per file index (`specs/A.mdx`…), fixed for the trial. */
  readonly modelPaths: readonly string[];
  /** Current workspace path per file index (file moves mutate this). */
  readonly paths: string[];
  /** Fresh-name counter for file-move destinations. */
  movedCounter: number;
}

function initTrialState(model: WorkspaceModel): TrialState {
  const cloned = structuredClone(model);
  const modelPaths = Object.keys(renderWorkspace(cloned));
  return {
    model: cloned,
    modelPaths,
    paths: [...modelPaths],
    movedCounter: 0,
  };
}

/** `specs/A.mdx` → `A` (the generator stages flat `specs/` paths only). */
function specBasename(path: string): string {
  const match = /^specs\/([^/]+)\.mdx$/.exec(path);
  if (match === null) {
    throw new Error(
      `P-5/P-6 harness defect: unexpected spec path ${JSON.stringify(path)}`,
    );
  }
  return match[1];
}

/** Workspace identity of a model identity under the current path table. */
function workspaceIdentityFn(state: TrialState): IdentityFn {
  const byModelPath = new Map<string, string>();
  state.modelPaths.forEach((modelPath, index) => {
    byModelPath.set(modelPath, state.paths[index]);
  });
  return (identity) => {
    const hash = identity.indexOf("#");
    const pathPart = hash === -1 ? identity : identity.slice(0, hash);
    const mappedPath = byModelPath.get(pathPart);
    if (mappedPath === undefined) {
      throw new Error(
        `P-5/P-6 harness defect: identity ${identity} names no model file`,
      );
    }
    return hash === -1 ? mappedPath : mappedPath + identity.slice(hash);
  };
}

interface SectionSite {
  readonly file: number;
  readonly dotted: string;
  readonly parentDotted: string;
  readonly section: SectionItem;
}

/** Every section of the model, document order, with its dotted context. */
function sectionsOf(model: WorkspaceModel): SectionSite[] {
  const sites: SectionSite[] = [];
  const walk = (
    items: readonly BodyItem[],
    file: number,
    parentDotted: string,
  ): void => {
    for (const item of items) {
      if (item.kind !== "section") continue;
      const dotted =
        parentDotted === "" ? item.seg : `${parentDotted}.${item.seg}`;
      sites.push({ file, dotted, parentDotted, section: item });
      walk(item.items, file, dotted);
    }
  };
  model.files.forEach((file, index) => {
    walk(file.items, index, "");
  });
  return sites;
}

/** Locate a section by its dotted ID: its container item list and index. */
function locateSection(
  model: WorkspaceModel,
  file: number,
  dotted: string,
): { readonly items: BodyItem[]; readonly index: number } {
  const segments = dotted.split(".");
  let items = model.files[file].items;
  for (let depth = 0; depth < segments.length; depth += 1) {
    const index = items.findIndex(
      (item) => item.kind === "section" && item.seg === segments[depth],
    );
    if (index === -1) {
      throw new Error(
        `P-5/P-6 harness defect: no section ${dotted} in file ${String(file)}`,
      );
    }
    if (depth === segments.length - 1) return { items, index };
    const item = items[index];
    if (item.kind !== "section") {
      throw new Error("unreachable: findIndex matched a section");
    }
    items = item.items;
  }
  throw new Error(`P-5/P-6 harness defect: empty dotted ID`);
}

/** All dotted IDs of a section subtree (itself first), document order. */
function subtreeDotteds(section: SectionItem, selfDotted: string): string[] {
  const out = [selfDotted];
  for (const item of section.items) {
    if (item.kind === "section") {
      out.push(...subtreeDotteds(item, `${selfDotted}.${item.seg}`));
    }
  }
  return out;
}

/** Visit every reference of the model with its host file (mutable refs). */
function forEachRef(
  model: WorkspaceModel,
  visit: (ref: RefModel, hostFile: number) => void,
): void {
  const walk = (items: readonly BodyItem[], hostFile: number): void => {
    for (const item of items) {
      if (item.kind === "prose") {
        for (const part of item.parts) {
          if (part.kind === "embed") visit(part.ref, hostFile);
        }
      } else if (item.kind === "section") {
        for (const ref of item.deps ?? []) visit(ref, hostFile);
        walk(item.items, hostFile);
      }
    }
  };
  model.files.forEach((file, index) => {
    walk(file.items, index);
  });
}

/** Prefix-rewrite: `old` or `old.<suffix>` → `new` + suffix, else null. */
function rewriteDotted(
  dotted: string,
  oldPrefix: string,
  newPrefix: string,
): string | null {
  if (dotted === oldPrefix) return newPrefix;
  if (dotted.startsWith(`${oldPrefix}.`)) {
    return newPrefix + dotted.slice(oldPrefix.length);
  }
  return null;
}

interface AppliedOp {
  readonly argv: readonly string[];
  /** Model-space identity map (empty for file moves). */
  readonly internalMap: Readonly<Record<string, string>>;
  /** Workspace-space identity map of this operation (for hash sweeps). */
  readonly wsMap: Readonly<Record<string, string>>;
  readonly description: string;
}

interface RenameOp {
  readonly kind: "rename";
  readonly file: number;
  readonly dotted: string;
  readonly newSeg: string;
}

interface MoveFileOp {
  readonly kind: "moveFile";
  readonly file: number;
  readonly newName: string;
}

type PureOp = RenameOp | MoveFileOp;

function applyRename(state: TrialState, op: RenameOp): AppliedOp {
  const located = locateSection(state.model, op.file, op.dotted);
  const section = located.items[located.index];
  if (section.kind !== "section") {
    throw new Error("unreachable: locateSection returns a section index");
  }
  const lastDot = op.dotted.lastIndexOf(".");
  const newDotted =
    lastDot === -1
      ? op.newSeg
      : `${op.dotted.slice(0, lastDot + 1)}${op.newSeg}`;
  const modelPath = state.modelPaths[op.file];
  const internalMap: Record<string, string> = {};
  for (const dotted of subtreeDotteds(section, op.dotted)) {
    const mapped = rewriteDotted(dotted, op.dotted, newDotted);
    if (mapped === null) {
      throw new Error("unreachable: subtree dotteds share the prefix");
    }
    internalMap[`${modelPath}#${dotted}`] = `${modelPath}#${mapped}`;
  }
  section.seg = op.newSeg;
  state.model.files[op.file].nextSeg += 1;
  forEachRef(state.model, (ref) => {
    if (ref.file !== op.file) return;
    const mapped = rewriteDotted(ref.dotted, op.dotted, newDotted);
    if (mapped !== null) ref.dotted = mapped;
  });
  const wsFn = workspaceIdentityFn(state);
  const wsMap: Record<string, string> = {};
  for (const [from, to] of Object.entries(internalMap)) {
    wsMap[wsFn(from)] = wsFn(to);
  }
  return {
    argv: ["rename", state.paths[op.file], op.dotted, newDotted],
    internalMap,
    wsMap,
    description: `rename ${state.paths[op.file]} ${op.dotted} -> ${newDotted}`,
  };
}

function applyMoveFile(state: TrialState, op: MoveFileOp): AppliedOp {
  const oldPath = state.paths[op.file];
  const newPath = `specs/${op.newName}.mdx`;
  const modelPath = state.modelPaths[op.file];
  const wsMap: Record<string, string> = { [oldPath]: newPath };
  const walkDotteds = (items: readonly BodyItem[], parent: string): void => {
    for (const item of items) {
      if (item.kind !== "section") continue;
      const dotted = parent === "" ? item.seg : `${parent}.${item.seg}`;
      wsMap[`${oldPath}#${dotted}`] = `${newPath}#${dotted}`;
      walkDotteds(item.items, dotted);
    }
  };
  walkDotteds(state.model.files[op.file].items, "");
  state.paths[op.file] = newPath;
  state.movedCounter += 1;
  return {
    argv: ["move", oldPath, newPath],
    internalMap: {},
    wsMap,
    description:
      `move file ${oldPath} -> ${newPath} (IDs unchanged, ` +
      `identities change only in their file part; ${modelPath} in model space)`,
  };
}

function applyPureOp(state: TrialState, op: PureOp): AppliedOp {
  return op.kind === "rename"
    ? applyRename(state, op)
    : applyMoveFile(state, op);
}

interface SectionMoveOp {
  readonly fromFile: number;
  readonly dotted: string;
  readonly toFile: number;
  /** Target parent's dotted ID; null = the target file's root. */
  readonly targetDotted: string | null;
  readonly newSeg: string;
}

function applySectionMove(state: TrialState, op: SectionMoveOp): AppliedOp {
  const located = locateSection(state.model, op.fromFile, op.dotted);
  const section = located.items[located.index];
  if (section.kind !== "section") {
    throw new Error("unreachable: locateSection returns a section index");
  }
  const newDotted =
    op.targetDotted === null ? op.newSeg : `${op.targetDotted}.${op.newSeg}`;
  const oldSub = subtreeDotteds(section, op.dotted);
  located.items.splice(located.index, 1);
  section.seg = op.newSeg;
  if (op.targetDotted === null) {
    state.model.files[op.toFile].items.push(section);
  } else {
    const target = locateSection(state.model, op.toFile, op.targetDotted);
    const parent = target.items[target.index];
    if (parent.kind !== "section") {
      throw new Error("unreachable: locateSection returns a section index");
    }
    parent.items.push(section);
  }
  state.model.files[op.toFile].nextSeg += 1;
  const fromModelPath = state.modelPaths[op.fromFile];
  const toModelPath = state.modelPaths[op.toFile];
  const internalMap: Record<string, string> = {};
  const dottedMap: Record<string, string> = {};
  for (const dotted of oldSub) {
    const mapped = rewriteDotted(dotted, op.dotted, newDotted);
    if (mapped === null) {
      throw new Error("unreachable: subtree dotteds share the prefix");
    }
    dottedMap[dotted] = mapped;
    internalMap[`${fromModelPath}#${dotted}`] = `${toModelPath}#${mapped}`;
  }
  forEachRef(state.model, (ref) => {
    if (ref.file !== op.fromFile) return;
    const mapped = dottedMap[ref.dotted];
    if (mapped !== undefined) {
      ref.file = op.toFile;
      ref.dotted = mapped;
    }
  });
  return {
    argv: [
      "move",
      `${state.paths[op.fromFile]}#${op.dotted}`,
      `${state.paths[op.toFile]}#${newDotted}`,
    ],
    internalMap,
    wsMap: {},
    description:
      `move section ${state.paths[op.fromFile]}#${op.dotted} -> ` +
      `${state.paths[op.toFile]}#${newDotted}`,
  };
}

// ---------------------------------------------------------------------------
// Staged-edit application (P-6): rewrite edited files from the model
//
// The model mirrors the workspace's current IDs and reference targets, and
// every generated segment is a TypeScript identifier, so a file's body is
// byte-deterministic after journaled renames (SPEC 6.4). The import header
// is recomputed against the current path table in the pinned 2.1 form
// (module header, H-4).

function currentFileBytes(state: TrialState, fileIndex: number): string {
  const rendered = renderWorkspace(state.model)[state.modelPaths[fileIndex]];
  if (fileIndex === 0) return rendered;
  const lines = rendered.split("\n");
  const header: string[] = [];
  for (let j = 0; j < fileIndex; j += 1) {
    header.push(
      `import M${String(j)} from "./${specBasename(state.paths[j])}.xspec"`,
    );
  }
  header.push("");
  return [...header, ...lines.slice(fileIndex + 1)].join("\n");
}

/**
 * Apply one staged edit: mutate the model and rewrite the changed files in
 * the workspace at their current paths. Returns a description for contexts.
 */
async function applyEditStep(
  state: TrialState,
  workspace: TestWorkspace,
  edit: Edit,
): Promise<string> {
  const beforeFiles = renderWorkspace(state.model);
  const { after, description } = applyEdit(state.model, edit);
  state.model = after;
  const afterFiles = renderWorkspace(after);
  const changedIndexes = state.modelPaths.flatMap((modelPath, index) =>
    afterFiles[modelPath] !== beforeFiles[modelPath] ? [index] : [],
  );
  if (changedIndexes.length === 0) {
    throw new Error(
      `P-6 harness defect: the edit "${description}" staged no byte change`,
    );
  }
  for (const index of changedIndexes) {
    await workspace.file(state.paths[index], currentFileBytes(state, index));
  }
  return description;
}

// ---------------------------------------------------------------------------
// Product-query helpers (SPEC 11; H-3), per the SUITE-19/22 protocol

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
    `${context}: the workspace's full node-identity set — a journaled ` +
      `operation maps every identity and neither adds nor deletes nodes ` +
      `(SPEC 1.5, 6.2, 11)`,
  );
}

async function sweepHashes(
  product: ProductBinding,
  workspace: TestWorkspace,
  identities: readonly string[],
  context: string,
): Promise<Map<string, NodeHashes>> {
  await assertIdentitySet(product, workspace, identities, context);
  const hashes = new Map<string, NodeHashes>();
  for (const identity of [...identities].sort()) {
    hashes.set(
      identity,
      await queryHashes(product, workspace, identity, context),
    );
  }
  return hashes;
}

// ---------------------------------------------------------------------------
// P-5 arm 1 — purity sequences

interface PurityTrial {
  readonly model: WorkspaceModel;
  readonly ops: readonly PureOp[];
}

const genPurityTrial: Gen<PurityTrial> = (choices) => {
  const model = genWorkspaceModel(choices);
  const state = initTrialState(model);
  const ops: PureOp[] = [];
  do {
    const sections = sectionsOf(state.model);
    const kind =
      sections.length === 0
        ? "moveFile"
        : choices.weightedPick<"moveFile" | "rename">([
            [2, "moveFile"],
            [3, "rename"],
          ]);
    let op: PureOp;
    if (kind === "rename") {
      const site = choices.pick(sections);
      op = {
        kind: "rename",
        file: site.file,
        dotted: site.dotted,
        newSeg: `s${String(state.model.files[site.file].nextSeg)}`,
      };
    } else {
      op = {
        kind: "moveFile",
        file: choices.intInclusive(0, state.model.files.length - 1),
        newName: `N${String(state.movedCounter)}`,
      };
    }
    applyPureOp(state, op);
    ops.push(op);
  } while (ops.length < 3 && choices.boolean(0.6));
  return { model, ops };
};

async function runPurityTrial(
  product: ProductBinding,
  trial: PurityTrial,
): Promise<void> {
  const state = initTrialState(trial.model);
  const workspace = await TestWorkspace.create({
    files: {
      "xspec.config.ts": SPECS_ONLY_CONFIG,
      ...renderWorkspace(state.model),
    },
  });
  try {
    await workspace.gitInit();
    const commits = [await workspace.gitCommitAll("baseline 0")];
    await buildOk(
      product,
      workspace,
      "P-5: `build` of the generated workspace (the generator stages only " +
        "valid workspaces)",
    );
    const wsFn = workspaceIdentityFn(state);
    let identities = [...semanticsOf(state.model).keys()].map(wsFn);
    let hashes = await sweepHashes(
      product,
      workspace,
      identities,
      "P-5 pre-operation sweep:",
    );

    for (const [index, op] of trial.ops.entries()) {
      const applied = applyPureOp(state, op);
      const context = `P-5 after operation ${String(index + 1)} — ${applied.description} —`;
      await expectExit(
        product,
        workspace,
        applied.argv,
        0,
        `P-5 operation ${String(index + 1)}: \`${applied.argv.join(" ")}\` on a valid workspace (SPEC 6.4, 6.5)`,
      );
      commits.push(
        await workspace.gitCommitAll(`after operation ${String(index + 1)}`),
      );
      await expectExit(
        product,
        workspace,
        ["check"],
        0,
        `${context} \`check\` must pass: all references resolve after the ` +
          `rewrite and the journal is well-formed and replayable (SPEC 6.4, ` +
          `6.5, 12.2 — P-5's "all references still resolve")`,
      );
      identities = identities.map(
        (identity) => applied.wsMap[identity] ?? identity,
      );
      const swept = await sweepHashes(product, workspace, identities, context);
      for (const [before, hash] of hashes) {
        const current = applied.wsMap[before] ?? before;
        assertSameJson(
          swept.get(current),
          hash,
          `${context} the operation is pure — every node's four hashes stay ` +
            `byte-identical, because child constructs and references hash ` +
            `by canonical identity (SPEC 5.4), which journaled operations ` +
            `preserve (SPEC 6.2, 5.5); the hashes of ${before}` +
            `${current === before ? "" : ` (now ${current})`} differ`,
        );
      }
      hashes = swept;
      for (let prior = 0; prior < commits.length - 1; prior += 1) {
        const label =
          `${context} \`impact --base <commit ${String(prior)}> --json\` — ` +
          `every prior commit in the sequence`;
        assertEmptyImpact(
          await impactAgainst(product, workspace, commits[prior], label),
          label,
        );
      }
    }
  } finally {
    await workspace.dispose();
  }
}

// ---------------------------------------------------------------------------
// P-5 arm 2 — random section moves

interface SectionMoveTrial {
  readonly model: WorkspaceModel;
  readonly move: SectionMoveOp;
}

interface MoveCandidate {
  readonly toFile: number;
  readonly targetDotted: string | null;
}

/**
 * Valid target parents for moving `moved`, mirroring SPEC 6.5's refusals
 * over the staged space (module header): the target is not within the moved
 * subtree; no reference from the moved subtree names the target or one of
 * its ancestors, the destination root included (a dependency edge to a new
 * ancestor would be a 5.3 cycle); and the destination file lies within the
 * import-cycle-free window — every file referenced from the subtree at or
 * before it, every file referencing into the subtree at or after it (the
 * base import graph is the complete downward DAG, so any other destination
 * would need a forward import that closes a cycle).
 */
function moveCandidates(
  model: WorkspaceModel,
  moved: SectionSite,
): MoveCandidate[] {
  const movedKeys = new Set(
    subtreeDotteds(moved.section, moved.dotted).map(
      (dotted) => `${String(moved.file)}#${dotted}`,
    ),
  );
  const refKey = (ref: RefModel): string => `${String(ref.file)}#${ref.dotted}`;

  // Which references live inside the moved subtree? Host granularity is the
  // file; subtree membership is decided per reference by re-walking the
  // subtree's own items.
  const insideRefs = new Set<RefModel>();
  const collectInside = (items: readonly BodyItem[]): void => {
    for (const item of items) {
      if (item.kind === "prose") {
        for (const part of item.parts) {
          if (part.kind === "embed") insideRefs.add(part.ref);
        }
      } else if (item.kind === "section") {
        for (const ref of item.deps ?? []) insideRefs.add(ref);
        collectInside(item.items);
      }
    }
  };
  for (const ref of moved.section.deps ?? []) insideRefs.add(ref);
  collectInside(moved.section.items);

  let maxOut = 0;
  let minIn = model.files.length - 1;
  const outTargets = new Set<string>();
  forEachRef(model, (ref, hostFile) => {
    const targetsMoved = movedKeys.has(refKey(ref));
    if (insideRefs.has(ref)) {
      if (!targetsMoved) {
        maxOut = Math.max(maxOut, ref.file);
        outTargets.add(refKey(ref));
      }
    } else if (targetsMoved) {
      minIn = Math.min(minIn, hostFile);
    }
  });

  const candidates: MoveCandidate[] = [];
  const consider = (
    toFile: number,
    targetDotted: string | null,
    ancestorKeys: readonly string[],
  ): void => {
    if (toFile < maxOut || toFile > minIn) return;
    if (
      targetDotted !== null &&
      movedKeys.has(`${String(toFile)}#${targetDotted}`)
    ) {
      return;
    }
    for (const key of ancestorKeys) {
      if (outTargets.has(key)) return;
    }
    candidates.push({ toFile, targetDotted });
  };
  model.files.forEach((_file, fileIndex) => {
    // The file root as target parent (top-level insertion): its ancestor set
    // is itself (external root references use the empty dotted part).
    consider(fileIndex, null, [`${String(fileIndex)}#`]);
  });
  for (const site of sectionsOf(model)) {
    const ancestorKeys = [`${String(site.file)}#`];
    const segments = site.dotted.split(".");
    for (let depth = 1; depth <= segments.length; depth += 1) {
      ancestorKeys.push(
        `${String(site.file)}#${segments.slice(0, depth).join(".")}`,
      );
    }
    consider(site.file, site.dotted, ancestorKeys);
  }
  return candidates;
}

const genSectionMoveTrial: Gen<SectionMoveTrial> = (choices) => {
  let model = genWorkspaceModel(choices);
  if (sectionsOf(model).length === 0) {
    // Guarantee a movable subtree: add one prose-only section to file 0
    // (deterministic — no draws — so tape replay is unaffected).
    const rootIdentity = Object.keys(renderWorkspace(model))[0];
    model = applyEdit(model, {
      kind: "addChild",
      node: rootIdentity,
      at: model.files[0].items.length,
      text: "moved anchor body",
    }).after;
  }
  const sections = sectionsOf(model);
  // Bias toward subtree-bearing moves (descendant re-identification and the
  // richer cascades) when any exist; a plain pick underexercises them under
  // the fixed seeds. Shrinks toward the unbiased simple pick.
  const withChildren = sections.filter((site) =>
    site.section.items.some((item) => item.kind === "section"),
  );
  const moved =
    withChildren.length > 0 && choices.boolean(0.5)
      ? choices.pick(withChildren)
      : choices.pick(sections);
  const candidates = moveCandidates(model, moved);
  if (candidates.length === 0) {
    // The moved section's own parent is always a valid target (same file,
    // ancestors unchanged), so an empty candidate list is a harness defect.
    throw new Error(
      `P-5 harness defect: no valid move target for ` +
        `${String(moved.file)}#${moved.dotted}`,
    );
  }
  // Bias toward section target parents (nesting under a section, the deeper
  // 6.5 insertion) over file roots, which otherwise dominate small models.
  const sectionTargets = candidates.filter(
    (candidate) => candidate.targetDotted !== null,
  );
  const target =
    sectionTargets.length > 0 && choices.boolean(0.65)
      ? choices.pick(sectionTargets)
      : choices.pick(candidates);
  return {
    model,
    move: {
      fromFile: moved.file,
      dotted: moved.dotted,
      toFile: target.toFile,
      targetDotted: target.targetDotted,
      newSeg: `s${String(model.files[target.toFile].nextSeg)}`,
    },
  };
};

async function runSectionMoveTrial(
  product: ProductBinding,
  trial: SectionMoveTrial,
): Promise<void> {
  const state = initTrialState(trial.model);
  const beforeSems = mapSemantics(
    semanticsOf(state.model),
    workspaceIdentityFn(state),
  );
  const workspace = await TestWorkspace.create({
    files: {
      "xspec.config.ts": SPECS_ONLY_CONFIG,
      ...renderWorkspace(state.model),
    },
  });
  try {
    await workspace.gitInit();
    const base = await workspace.gitCommitAll("pre-move baseline");
    await buildOk(
      product,
      workspace,
      "P-5: `build` of the generated workspace (the generator stages only " +
        "valid workspaces)",
    );
    const applied = applySectionMove(state, trial.move);
    const context = `P-5 section move — ${applied.description} —`;
    await expectExit(
      product,
      workspace,
      applied.argv,
      0,
      `P-5: \`${applied.argv.join(" ")}\` satisfies every 6.5 validation ` +
        `over the staged space (module header), so the move must succeed`,
    );
    await expectExit(
      product,
      workspace,
      ["check"],
      0,
      `${context} \`check\` must pass: all rewritten references resolve and ` +
        `the journal replays (SPEC 6.5, 12.2)`,
    );
    const afterSems = mapSemantics(
      semanticsOf(state.model),
      workspaceIdentityFn(state),
    );
    const diff = computeOracleDiff(
      mapSemantics(beforeSems, composeIdentityMaps([applied.internalMap])),
      afterSems,
    );
    const label = `${context} \`impact --base <pre-move ref> --json\``;
    assertImpactMatchesOracle(
      await impactAgainst(product, workspace, base, label),
      diff,
      `${label} — only the predicted parents originate categories: the ` +
        `moved subtree keeps every hash (no own-content bytes on the ` +
        `construct's straddling lines, SPEC 6.2), so the oracle diff holds ` +
        `exactly the parents whose own-content sequence changed, with their ` +
        `5.6 cascades`,
    );
  } finally {
    await workspace.dispose();
  }
}

// ---------------------------------------------------------------------------
// P-6 — edit/rename/move/commit interleavings

type ReplayStep =
  | { readonly kind: "commit" }
  | { readonly kind: "edit"; readonly edit: Edit }
  | { readonly kind: "op"; readonly op: PureOp };

interface ReplayTrial {
  readonly model: WorkspaceModel;
  readonly steps: readonly ReplayStep[];
}

/** Edit classes safe for interleaved replay (module header: no deletions). */
const REPLAY_EDIT_CLASSES: readonly EditClass[] = [
  "content",
  "metadata",
  "dependency",
  "referencedText",
  "noop",
];

/** Deterministic MDX-safe prose pool for added sections (module header). */
const ADDED_SECTION_TEXT = [
  "added body alpha",
  "added body beta",
  "added body k9",
] as const;

function genReplayEdit(choices: Choices, model: WorkspaceModel): Edit {
  const shape = choices.weightedPick<EditClass | "addChild">([
    [3, "content"],
    [2, "metadata"],
    [2, "dependency"],
    [2, "referencedText"],
    [2, "noop"],
    [2, "addChild"],
  ]);
  if (shape !== "addChild") {
    return genEditOfClass(choices, model, shape);
  }
  // A dependency-free added section (module header): the P-4 addChild edit
  // adds exactly that — a fresh-segment section holding one prose line.
  const hosts: { readonly identity: string; readonly size: number }[] = [];
  const modelPaths = Object.keys(renderWorkspace(model));
  model.files.forEach((file, index) => {
    hosts.push({ identity: modelPaths[index], size: file.items.length });
  });
  for (const site of sectionsOf(model)) {
    hosts.push({
      identity: `${modelPaths[site.file]}#${site.dotted}`,
      size: site.section.items.length,
    });
  }
  const host = choices.pick(hosts);
  return {
    kind: "addChild",
    node: host.identity,
    at: choices.intInclusive(0, host.size),
    text: choices.pick(ADDED_SECTION_TEXT),
  };
}

const genReplayTrial: Gen<ReplayTrial> = (choices) => {
  const model = genWorkspaceModel(choices);
  const state = initTrialState(model);
  const steps: ReplayStep[] = [];
  do {
    const sections = sectionsOf(state.model);
    const kind = choices.weightedPick<
      "commit" | "edit" | "rename" | "moveFile"
    >([
      [2, "commit"],
      [4, "edit"],
      [2, "rename"],
      [1, "moveFile"],
    ]);
    if (kind === "commit") {
      steps.push({ kind: "commit" });
    } else if (kind === "edit") {
      const edit = genReplayEdit(choices, state.model);
      state.model = applyEdit(state.model, edit).after;
      steps.push({ kind: "edit", edit });
    } else if (kind === "rename" && sections.length > 0) {
      const site = choices.pick(sections);
      const op: PureOp = {
        kind: "rename",
        file: site.file,
        dotted: site.dotted,
        newSeg: `s${String(state.model.files[site.file].nextSeg)}`,
      };
      applyPureOp(state, op);
      steps.push({ kind: "op", op });
    } else {
      const op: PureOp = {
        kind: "moveFile",
        file: choices.intInclusive(0, state.model.files.length - 1),
        newName: `N${String(state.movedCounter)}`,
      };
      applyPureOp(state, op);
      steps.push({ kind: "op", op });
    }
  } while (steps.length < 6 && choices.boolean(0.8));
  return { model, steps };
};

async function runReplayTrial(
  product: ProductBinding,
  trial: ReplayTrial,
): Promise<void> {
  const state = initTrialState(trial.model);
  const workspace = await TestWorkspace.create({
    files: {
      "xspec.config.ts": SPECS_ONLY_CONFIG,
      ...renderWorkspace(state.model),
    },
  });
  try {
    await workspace.gitInit();
    interface Snapshot {
      readonly commit: string;
      readonly sems: SemanticsMap;
      /** Index into `internalMaps` from which later maps apply. */
      readonly mapsFrom: number;
      readonly label: string;
    }
    const internalMaps: Readonly<Record<string, string>>[] = [];
    const snapshots: Snapshot[] = [
      {
        commit: await workspace.gitCommitAll("baseline 0"),
        sems: semanticsOf(state.model),
        mapsFrom: 0,
        label: "baseline 0 (the initial commit)",
      },
    ];
    await buildOk(
      product,
      workspace,
      "P-6: `build` of the generated workspace (the generator stages only " +
        "valid workspaces)",
    );

    const history: string[] = [];
    for (const [index, step] of trial.steps.entries()) {
      if (step.kind === "commit") {
        snapshots.push({
          commit: await workspace.gitCommitAll(
            `baseline ${String(snapshots.length)}`,
          ),
          sems: semanticsOf(state.model),
          mapsFrom: internalMaps.length,
          label: `baseline ${String(snapshots.length)} (after: ${history.join("; ") || "nothing"})`,
        });
      } else if (step.kind === "edit") {
        history.push(await applyEditStep(state, workspace, step.edit));
      } else {
        const applied = applyPureOp(state, step.op);
        await expectExit(
          product,
          workspace,
          applied.argv,
          0,
          `P-6 step ${String(index + 1)}: \`${applied.argv.join(" ")}\` on a ` +
            `valid workspace (SPEC 6.4, 6.5)`,
        );
        internalMaps.push(applied.internalMap);
        history.push(applied.description);
      }
    }

    await buildOk(
      product,
      workspace,
      "P-6: final `build` before the impact runs (the SUITE-20/22 protocol)",
    );
    const wsFn = workspaceIdentityFn(state);
    const currentSems = mapSemantics(semanticsOf(state.model), wsFn);
    for (const snapshot of snapshots) {
      const mapped = mapSemantics(snapshot.sems, (identity) =>
        wsFn(
          composeIdentityMaps(internalMaps.slice(snapshot.mapsFrom))(identity),
        ),
      );
      const diff = computeOracleDiff(mapped, currentSems);
      const label =
        `P-6 \`impact --base <${snapshot.label}> --json\` — full history: ` +
        `${history.join("; ") || "no steps"}`;
      assertImpactMatchesOracle(
        await impactAgainst(product, workspace, snapshot.commit, label),
        diff,
        `${label} — the report must equal the oracle graph diff of the two ` +
          `models with identities mapped through the journal suffix ` +
          `(SPEC 6.3, 5.6, 9.1)`,
      );
    }
  } finally {
    await workspace.dispose();
  }
}

// ---------------------------------------------------------------------------
// The registered property tests

function renderPurityTrial(trial: PurityTrial): string {
  return JSON.stringify({
    files: renderWorkspace(trial.model),
    ops: trial.ops,
  });
}

function renderSectionMoveTrial(trial: SectionMoveTrial): string {
  return JSON.stringify({
    files: renderWorkspace(trial.model),
    move: trial.move,
  });
}

function renderReplayTrial(trial: ReplayTrial): string {
  return JSON.stringify({
    files: renderWorkspace(trial.model),
    steps: trial.steps,
  });
}

const P_5 = defineProductTest({
  id: "P-5",
  title:
    "property: random journaled rename/file-move sequences over random valid workspaces are " +
    "pure — after every operation each node's four hashes are byte-identical under the " +
    "operation's identity map, `check` passes (all references resolve, the journal replays), " +
    "and `impact --base` against every prior commit in the sequence reports no categories and " +
    "no impacted code; random clean-boundary section moves produce exactly the oracle-predicted " +
    "impact: only the parents whose own-content sequence changed originate categories, with " +
    "their ordinary 5.6 cascades (SPEC 5.4-5.6, 6.1-6.5, 9, 12.2; TEST-SPEC §16 P-5)",
  // Wall-clock hang guard only (H-10): three fixed seeds (E-5), and per
  // purity trial up to 3 operations x (sweep of every node + impact against
  // every prior commit), plus the shrink budget on falsification.
  timeoutMs: 600_000,
  run: async (product) => {
    await checkProperty(
      "P-5 rename/file-move purity sequences",
      genPurityTrial,
      async (trial) => {
        await runPurityTrial(product, trial);
      },
      { runs: 3, maxShrinkExecutions: 60, render: renderPurityTrial },
    );
    await checkProperty(
      "P-5 random section moves",
      genSectionMoveTrial,
      async (trial) => {
        await runSectionMoveTrial(product, trial);
      },
      { runs: 5, maxShrinkExecutions: 80, render: renderSectionMoveTrial },
    );
  },
});

const P_6 = defineProductTest({
  id: "P-6",
  title:
    "property: over random interleavings of staged edits, journaled renames, journaled " +
    "file-form moves, and git commits, `impact --base` against each historical baseline " +
    "reports exactly the categories of an oracle diff of the two workspace graphs with " +
    "identities mapped through the journal suffix — per-node category sets exact, added nodes " +
    "`changed` only, attributions within the originating nodes, no impacted code " +
    "(SPEC 5.5, 5.6, 6.3, 6.4, 6.5, 9; TEST-SPEC §16 P-6)",
  // Wall-clock hang guard only (H-10): three fixed seeds (E-5), up to 6
  // steps and one impact run per historical baseline per trial, plus the
  // shrink budget on falsification.
  timeoutMs: 600_000,
  run: async (product) => {
    await checkProperty(
      "P-6 baseline replay",
      genReplayTrial,
      async (trial) => {
        await runReplayTrial(product, trial);
      },
      { runs: 4, maxShrinkExecutions: 60, render: renderReplayTrial },
    );
  },
});

/** TEST-SPEC §16 P-5 and P-6 (PROP-04). */
export const section16P5P6Tests: readonly ProductTestEntry[] = [P_5, P_6];
