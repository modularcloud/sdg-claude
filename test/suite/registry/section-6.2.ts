// TEST-SPEC §6.2 (identity guarantee) — SUITE-22: T6.2-1…T6.2-4.
//
// Registered product-facing bodies (C-2 "one code path"): each builds its own
// fresh workspace (H-1), drives the product strictly as a subprocess (H-2),
// asserts exact exit codes (H-5), decodes output through the H-3 adapters,
// and rejects a product only via diagnosed assertion failures (H-8).
//
// SPEC 6.2: `rename` and the file form of `move` are pure — they change only
// identities and reference spellings and leave every hash byte-identical,
// producing no change categories relative to any baseline, because child
// constructs and references hash by canonical identity (5.4), which journaled
// operations preserve. The section form of `move` is impure only through its
// text edits: the identity mapping itself changes no hash, and every moved
// node keeps its metadataHash unconditionally; own content can differ between
// origin and destination only on the construct's straddling lines, where the
// line-drop rule of 3 consults characters outside the moved text. Baselines
// are committed git sources (HARNESS-01: pinned identities and timestamps);
// the baseline commit precedes the first `build`, so it holds sources only.
//
// Conservative operationalizations (noted per H-4):
// - "No change categories" is asserted as an empty `requirements` list — the
//   suite's fixed T1.5-1 interpretation (SPEC 9.3 groups output by category,
//   so an uncategorized node appears under none), carried through SUITE-20.
// - "Full-workspace sweep" is realized as `query nodes` enumeration,
//   premise-asserted to equal the fixture's statically known identity set (a
//   sweep silently missing nodes could not witness "every node's four
//   hashes"), followed by `query node <identity>` for the four hashes of
//   each node (SPEC 11). Code locations are not requirement nodes and carry
//   no hashes; the sweep is over requirement nodes.
// - Impact entries here must all report `deleted: false`, and any identity
//   outside the expectation table — a pre-operation identity in particular —
//   fails: a product that does not unify identities through the journal
//   (SPEC 6.3, 9.2) reports the vacated identity as deleted and the new one
//   as added, and both are diagnosed.
// - T6.2-3 asserts, for every node of the moved subtree, exactly the three
//   hashes its TEST-SPEC text names (ownHash, subtreeHash, metadataHash);
//   effectiveHash is not asserted directly — TEST-SPEC deliberately omits it
//   (in general a moved subtree's effectiveHash can change through
//   dependency targets) — but the category table still bounds it: these
//   fixtures give the moved subtree no dependency edges, so an
//   `upstream-changed` entry for a moved node would fail as an extra
//   category.
// - T6.2-3's category table pins what SPEC 5.6 decides and bounds what it
//   leaves open. Decided: which nodes are `changed` (exactly the origin and
//   target parents, plus the impure-boundary moved node in the impure arm);
//   the file roots' `descendant-changed` (their changed parent is a
//   descendant present on both sides); the dependents' `upstream-changed`
//   with exact attribution (a dependency-edge target's effectiveHash changed;
//   the edge's target is identity-mapped, so the cascade is unambiguous —
//   the sharp realization of "with the 5.6 cascades attributed to it").
//   Left open, and tolerated: whether a parent whose (former or new) child
//   changed while under it on only one side — the impure moved node departed
//   the origin parent and arrived under the target parent — additionally
//   carries `descendant-changed`, since SPEC 5.6's baseline comparison is
//   defined for nodes present on both sides and the moved node is a
//   descendant of each parent on only one side. Such an entry is accepted
//   only when attributed to the moved node; any other spelling fails.
// - Attribution of the originating category `changed` is unpinned by
//   TEST-SPEC (SPEC 5.6 bounds it to originating nodes), so it is asserted
//   as a subset of the fixture's originating-node set, the empty list
//   accepted — the SUITE-20 convention.

import type {
  ChangeCategory,
  ImpactReport,
  NodeHashes,
  NodeReport,
} from "../../helpers/adapters/index.js";
import {
  decodeImpactReport,
  decodeNodeReport,
  decodeNodeRowsReport,
} from "../../helpers/adapters/index.js";
import { fail, parseJsonStdout } from "../../helpers/assertions.js";
import { defineProductTest } from "../../helpers/registry.js";
import type { ProductTestEntry } from "../../helpers/registry.js";
import type { ProductBinding } from "../../helpers/subprocess.js";
import { TestWorkspace } from "../../helpers/workspace.js";
import {
  assertSameJson,
  buildOk,
  expectExit,
  runJson,
  sortedIdentities,
} from "./support.js";

// One spec group plus one code group (SPEC 7.2), for the T6.2-1/T6.2-2
// fixtures whose impacted-code assertions need a discovered code location.
const SPEC_AND_CODE_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  },
  code: {
    app: ["src/**/*.ts"]
  }
})
`;

// Exactly one spec group (SPEC 7), for the T6.2-3/T6.2-4 fixtures.
const SPECS_ONLY_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  }
})
`;

/** Stage a fresh workspace (config plus `files`), run `body`, dispose (H-1). */
async function withWorkspace<T>(
  config: string,
  files: Readonly<Record<string, string>>,
  body: (workspace: TestWorkspace) => Promise<T>,
): Promise<T> {
  const workspace = await TestWorkspace.create({
    files: { "xspec.config.ts": config, ...files },
  });
  try {
    return await body(workspace);
  } finally {
    await workspace.dispose();
  }
}

/** Full `query node` report (SPEC 11, JSON-only; H-3). */
async function queryNode(
  product: ProductBinding,
  workspace: TestWorkspace,
  identity: string,
  context: string,
): Promise<NodeReport> {
  const label = `${context} \`query node ${identity}\``;
  return decodeNodeReport(
    await runJson(product, workspace, ["query", "node", identity], label),
    label,
  );
}

/**
 * The full-workspace hash sweep (T6.2-1/T6.2-2/T6.2-4): enumerate every
 * requirement node via `query nodes`, premise-assert the enumeration equals
 * the fixture's statically known identity set (module header, H-4), and
 * collect all four hashes of every node via `query node` (SPEC 5.5, 11).
 */
async function sweepHashes(
  product: ProductBinding,
  workspace: TestWorkspace,
  expectedIdentities: readonly string[],
  context: string,
): Promise<Map<string, NodeHashes>> {
  const enumLabel = `${context} \`query nodes\` (full-workspace enumeration)`;
  const rows = decodeNodeRowsReport(
    await runJson(product, workspace, ["query", "nodes"], enumLabel),
    enumLabel,
  );
  assertSameJson(
    sortedIdentities(rows),
    [...expectedIdentities].sort(),
    `${context}: the sweep must enumerate exactly the fixture's requirement ` +
      `nodes, in the workspace-relative identity form of SPEC 1.5 (SPEC 11) — ` +
      `a sweep over any other node set could not witness "every node's four ` +
      `hashes" (SPEC 6.2)`,
  );
  const hashes = new Map<string, NodeHashes>();
  for (const identity of [...expectedIdentities].sort()) {
    hashes.set(
      identity,
      (await queryNode(product, workspace, identity, context)).hashes,
    );
  }
  return hashes;
}

/**
 * Assert a pure operation left every node's four hashes byte-identical
 * (SPEC 6.2): each pre-operation node, looked up after the operation under
 * its mapped identity (`identityMap`, identities absent from it unchanged),
 * reports the same four hash strings.
 */
function assertHashesPreserved(
  before: ReadonlyMap<string, NodeHashes>,
  after: ReadonlyMap<string, NodeHashes>,
  identityMap: Readonly<Record<string, string>>,
  operation: string,
  context: string,
): void {
  for (const [pre, hashes] of before) {
    const post = identityMap[pre] ?? pre;
    const actual = after.get(post);
    if (actual === undefined) {
      throw new Error(
        `fixture bug: ${post} is missing from the post-operation sweep despite ` +
          `the enumeration premise`,
      );
    }
    assertSameJson(
      actual,
      hashes,
      `${context}: ${operation} is pure — every hash in the workspace stays ` +
        `byte-identical, because references hash by canonical identity (5.4), ` +
        `which journaled operations preserve (SPEC 6.2, 5.5); the four hashes ` +
        `of ${pre}${post === pre ? "" : ` (now ${post})`} differ`,
    );
  }
}

/**
 * `impact --base <ref> --json`: exit 0 (impact is informational, SPEC 9.3;
 * H-5) with exactly one JSON document, decoded as the impact report (H-3).
 */
async function impactAgainst(
  product: ProductBinding,
  workspace: TestWorkspace,
  ref: string,
  context: string,
): Promise<ImpactReport> {
  const result = await expectExit(
    product,
    workspace,
    ["impact", "--base", ref, "--json"],
    0,
    context,
  );
  return decodeImpactReport(parseJsonStdout(result, context), context);
}

/**
 * Assert an impact report shows a pure operation (T6.2-1/T6.2-2/T6.2-4): no
 * requirement entry at all — no node carries any change category (SPEC 6.2,
 * 9.1; the T1.5-1 empty-requirements convention) — and both impacted-code
 * groups empty: the location's baseline impact edges (old identities) and
 * current ones (new identities) unify through the journal (SPEC 9.2, 6.3); a
 * product failing to unify them evaluates a deleted and an added target
 * instead — each counting as changed in both hashes (9.2) — and reports the
 * location spuriously impacted.
 */
function assertPureImpact(
  report: ImpactReport,
  operation: string,
  context: string,
): void {
  assertSameJson(
    report.requirements,
    [],
    `${context}: ${operation} must produce no change categories relative to ` +
      `the pre-operation baseline — every hash is unchanged and identities ` +
      `map through the journal, so no node receives any category and the ` +
      `requirements list is empty (SPEC 6.2, 6.3, 9.1)`,
  );
  assertSameJson(
    report.code,
    { direct: [], transitive: [] },
    `${context}: the directly and the transitively impacted code groups must ` +
      `be empty — the code location's baseline impact edges (old identities) ` +
      `and current ones (new identities) unify through the journal (SPEC 9.2, ` +
      `6.3); a product failing to unify them evaluates a deleted and an added ` +
      `target instead, each counting as changed in both hashes (9.2), and ` +
      `reports the location spuriously impacted`,
  );
}

/**
 * Read a workspace source file as UTF-8 text, failing diagnosed (H-8) when
 * the path does not hold a plain file.
 */
async function readSourceText(
  workspace: TestWorkspace,
  rel: string,
  context: string,
): Promise<string> {
  const kind = await workspace.kind(rel);
  if (kind !== "file") {
    fail(`${context}: expected a plain file at ${rel}; found ${kind}`);
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(
    await workspace.readBytes(rel),
  );
}

/**
 * Premise check that an operation rewrote a source's references (SPEC 6.4,
 * 6.5): the stale spelling is gone and, when one is pinned by the minimal
 * edit rules, the rewritten spelling is present. Deliberately substring-level
 * (byte-exact rewrite content is T6.4-2/T6.5-2's business); this check makes
 * a missing rewrite fail with a crisp diagnosis instead of a downstream one.
 */
function assertRewriteHappened(
  text: string,
  rel: string,
  staleSpelling: string,
  rewrittenSpelling: string | undefined,
  context: string,
): void {
  if (text.includes(staleSpelling)) {
    fail(
      `${context}: ${rel} still contains the stale spelling ` +
        `${JSON.stringify(staleSpelling)} — the operation rewrites every ` +
        `reference to the affected identities across all configured spec and ` +
        `code sources (SPEC 6.4, 6.5)`,
    );
  }
  if (rewrittenSpelling !== undefined && !text.includes(rewrittenSpelling)) {
    fail(
      `${context}: ${rel} does not contain the rewritten spelling ` +
        `${JSON.stringify(rewrittenSpelling)} — the rewrite keeps dot access ` +
        `for valid-identifier segments and retargets the reference to the new ` +
        `identity (SPEC 6.4)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Category-table assertion (T6.2-3)
// ---------------------------------------------------------------------------

/** Expected attribution for one category of one node (module header, H-4). */
interface ExpectedCategory {
  readonly category: ChangeCategory;
  /** Attribution pinned exactly. Exactly one of `exact`/`within`. */
  readonly exact?: readonly string[];
  /** Attribution bounded: the merged `attributedTo` must be a subset. */
  readonly within?: readonly string[];
  /** With `within`: identities the attribution must include. */
  readonly mustInclude?: readonly string[];
  /**
   * The category may be absent entirely — the two-sided `descendant-changed`
   * ambiguity documented in the module header. When present, its attribution
   * is checked like any other.
   */
  readonly optional?: boolean;
}

/** The complete expectation for one node identity of a fixture. */
interface ExpectedNodeImpact {
  /** Current (post-operation, journal-mapped) identity — nothing is deleted. */
  readonly identity: string;
  /** The node's category expectations; empty = must receive no category. */
  readonly categories: readonly ExpectedCategory[];
}

/**
 * Assert an impact report's requirement-level content against the complete
 * per-node expectation table of a fixture (SPEC 5.6, 6.2, 9.1):
 *
 * - every identity named by any entry must be in the table — a pre-operation
 *   identity in particular fails: identities must be unified through the
 *   journal (SPEC 6.3, 9.2);
 * - every entry must report `deleted: false` — a journaled move deletes
 *   nothing (SPEC 6.2);
 * - a node whose expected categories are empty (or all optional and absent)
 *   must be named by no entry (the T1.5-1 convention);
 * - the categories merged across entries naming a node must equal the
 *   required set, extended by whichever optional ones appear; nothing else;
 * - each category's attribution is checked per its expectation;
 * - no code location is impacted (these fixtures configure no code groups).
 */
function assertImpactTable(
  report: ImpactReport,
  expectations: readonly ExpectedNodeImpact[],
  context: string,
): void {
  const expectedBy = new Map<string, ExpectedNodeImpact>();
  for (const expectation of expectations) {
    if (expectedBy.has(expectation.identity)) {
      throw new Error(
        `fixture bug: duplicate expectation for ${expectation.identity}`,
      );
    }
    for (const category of expectation.categories) {
      if ((category.exact === undefined) === (category.within === undefined)) {
        throw new Error(
          `fixture bug: category ${category.category} of ` +
            `${expectation.identity} must declare exactly one of exact/within`,
        );
      }
      if (
        category.mustInclude !== undefined &&
        (category.within === undefined ||
          category.mustInclude.some(
            (identity) => !category.within?.includes(identity),
          ))
      ) {
        throw new Error(
          `fixture bug: mustInclude of ${category.category} of ` +
            `${expectation.identity} requires a within bound containing it`,
        );
      }
    }
    expectedBy.set(expectation.identity, expectation);
  }

  // Merge the report per node identity (SPEC 9.3 fixes the grouping, not the
  // adapter-level entry granularity — the SUITE-20 convention).
  const actualBy = new Map<string, Map<ChangeCategory, string[]>>();
  for (const entry of report.requirements) {
    for (const identity of entry.nodes) {
      const expected = expectedBy.get(identity);
      if (expected === undefined) {
        fail(
          `${context}: the report names ${JSON.stringify(identity)}, which is ` +
            `no current node of the fixture (in the workspace-relative ` +
            `identity form of SPEC 1.5) — a pre-operation identity here means ` +
            `the product failed to unify identities through the journal ` +
            `(SPEC 6.2, 6.3, 9.2); entry: ${JSON.stringify(entry)}`,
        );
      }
      if (entry.deleted) {
        fail(
          `${context}: an entry names ${JSON.stringify(identity)} as deleted — ` +
            `a journaled move deletes nothing: the moved subtree keeps its ` +
            `identity through the journal mapping (SPEC 6.2, 6.3, 9.3); ` +
            `entry: ${JSON.stringify(entry)}`,
        );
      }
      let merged = actualBy.get(identity);
      if (merged === undefined) {
        merged = new Map();
        actualBy.set(identity, merged);
      }
      for (const category of entry.categories) {
        const attributed = merged.get(category.category) ?? [];
        attributed.push(...category.attributedTo);
        merged.set(category.category, attributed);
      }
    }
  }

  for (const expected of expectations) {
    const merged = actualBy.get(expected.identity);
    const required = expected.categories.filter(
      (category) => category.optional !== true,
    );
    const byName = new Map(
      expected.categories.map((category) => [category.category, category]),
    );
    if (byName.size !== expected.categories.length) {
      throw new Error(
        `fixture bug: duplicate category expectation on ${expected.identity}`,
      );
    }

    if (merged === undefined) {
      if (required.length > 0) {
        fail(
          `${context}: ${expected.identity} must carry the categories ` +
            `${JSON.stringify(required.map((category) => category.category).sort())} ` +
            `(SPEC 5.6, 6.2), but no requirement entry names it`,
        );
      }
      continue;
    }
    if (expected.categories.length === 0) {
      fail(
        `${context}: ${expected.identity} must receive no category — its ` +
          `hashes are unchanged and its identity maps through the journal ` +
          `(SPEC 6.2, 5.6) — and so appear in no requirement entry (SPEC 9.3 ` +
          `groups output by category; the T1.5-1 convention), but the report ` +
          `names it with categories ` +
          `${JSON.stringify([...merged.keys()].sort())}`,
      );
    }

    for (const name of merged.keys()) {
      if (!byName.has(name)) {
        fail(
          `${context}: ${expected.identity} carries the category ${name}, ` +
            `which SPEC 5.6 gives it no ground for — expected ` +
            `${JSON.stringify([...byName.keys()].sort())} (optional ones ` +
            `included; SPEC 5.6, 6.2)`,
        );
      }
    }
    for (const category of required) {
      if (!merged.has(category.category)) {
        fail(
          `${context}: ${expected.identity} must carry ${category.category} ` +
            `(SPEC 5.6, 6.2), but the report gives it only ` +
            `${JSON.stringify([...merged.keys()].sort())}`,
        );
      }
    }

    for (const [name, rawAttribution] of merged) {
      const expectation = byName.get(name);
      if (expectation === undefined) continue; // failed above
      const attributed = [...new Set(rawAttribution)].sort();
      if (expectation.exact !== undefined) {
        assertSameJson(
          attributed,
          [...expectation.exact].sort(),
          `${context}: the ${name} category of ${expected.identity} must be ` +
            `attributed to exactly its originating node(s) (SPEC 5.6, 9.1)`,
        );
        continue;
      }
      for (const identity of attributed) {
        if (!expectation.within?.includes(identity)) {
          fail(
            `${context}: the ${name} category of ${expected.identity} is ` +
              `attributed to ${JSON.stringify(identity)}, outside its ` +
              `originating-node bound ` +
              `${JSON.stringify([...(expectation.within ?? [])].sort())} ` +
              `(SPEC 5.6: every category is attributed to its originating nodes)`,
          );
        }
      }
      for (const identity of expectation.mustInclude ?? []) {
        if (!attributed.includes(identity)) {
          fail(
            `${context}: the ${name} category of ${expected.identity} must be ` +
              `attributed to ${JSON.stringify(identity)} among its originating ` +
              `nodes (SPEC 5.6, 9.1); got ${JSON.stringify(attributed)}`,
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

// ---------------------------------------------------------------------------
// T6.2-1 — rename purity
// ---------------------------------------------------------------------------

// The rename subject: a mid-tree node with a descendant (both re-identified
// by prefix replacement), a sibling, metadata on the renamed node (so its
// kept metadataHash is content-bearing), plus a spec file and a code location
// referencing the renamed nodes — every reference spelling is rewritten
// (SPEC 6.4) while every hash stays put (SPEC 6.2, 5.4).
const R1_CORE = "specs/Core.mdx";
const R1_TOP = "specs/Core.mdx#core";
const R1_MID_PRE = "specs/Core.mdx#core.mid";
const R1_LEAF_PRE = "specs/Core.mdx#core.mid.leaf";
const R1_MID_POST = "specs/Core.mdx#core.hub";
const R1_LEAF_POST = "specs/Core.mdx#core.hub.leaf";
const R1_OTHER = "specs/Core.mdx#core.other";
const R1_REFS = "specs/Refs.mdx";
const R1_REFS_TOP = "specs/Refs.mdx#refs";
const R1_REFS_DEP = "specs/Refs.mdx#refs.dep";
const R1_APP = "src/app.ts";

const R1_CORE_SOURCE = [
  '<S id="core">',
  "Core holder text.",
  "",
  '<S id="core.mid" coverage="none" tags="mid keep">',
  "Mid text carrying metadata.",
  "",
  '<S id="core.mid.leaf">',
  "Leaf text under the renamed node.",
  "</S>",
  "</S>",
  "",
  '<S id="core.other">',
  "Sibling text staying put.",
  "</S>",
  "</S>",
  "",
].join("\n");

const R1_REFS_SOURCE = [
  'import Core from "./Core.xspec"',
  "",
  '<S id="refs">',
  "Refs holder text.",
  "",
  '<S id="refs.dep" d={Core.core.mid}>',
  "Depends on the renamed node. Embeds: {text(Core.core.mid.leaf)}",
  "</S>",
  "</S>",
  "",
].join("\n");

// One code location (the whole file, SPEC 4.6) bearing a marker and a
// `text(...)` call whose targets are renamed nodes — both rewritten (6.4),
// and the location's baseline and current impact edges must unify through
// the journal (9.2).
const R1_APP_SOURCE = [
  'import CORE, { text } from "../specs/Core.xspec";',
  "",
  "CORE.core.mid.leaf;",
  "text(CORE.core.mid);",
  "",
].join("\n");

const R1_PRE_IDENTITIES = [
  R1_CORE,
  R1_TOP,
  R1_MID_PRE,
  R1_LEAF_PRE,
  R1_OTHER,
  R1_REFS,
  R1_REFS_TOP,
  R1_REFS_DEP,
];
const R1_IDENTITY_MAP: Readonly<Record<string, string>> = {
  [R1_MID_PRE]: R1_MID_POST,
  [R1_LEAF_PRE]: R1_LEAF_POST,
};
const R1_POST_IDENTITIES = R1_PRE_IDENTITIES.map(
  (identity) => R1_IDENTITY_MAP[identity] ?? identity,
);

const T6_2_1 = defineProductTest({
  id: "T6.2-1",
  title:
    "rename purity: after `xspec rename`, every node's four hashes are byte-identical (full-workspace sweep) and `impact --base <pre-rename ref>` reports no change categories and empty directly/transitively impacted code — the code location's marker and `text(...)` edges (old identities at the baseline, new ones currently) unify through the journal (SPEC 6.2, 6.3, 6.4, 9.2)",
  run: async (product) => {
    await withWorkspace(
      SPEC_AND_CODE_CONFIG,
      {
        [R1_CORE]: R1_CORE_SOURCE,
        [R1_REFS]: R1_REFS_SOURCE,
        [R1_APP]: R1_APP_SOURCE,
      },
      async (workspace) => {
        await workspace.gitInit();
        const base = await workspace.gitCommitAll("pre-rename baseline");
        await buildOk(
          product,
          workspace,
          "T6.2-1 `build` over the staged workspace",
        );

        const before = await sweepHashes(
          product,
          workspace,
          R1_PRE_IDENTITIES,
          "T6.2-1 pre-rename sweep",
        );

        await expectExit(
          product,
          workspace,
          ["rename", "specs/Core.mdx", "core.mid", "core.hub"],
          0,
          "T6.2-1 `rename specs/Core.mdx core.mid core.hub`",
        );

        // Premise: the rename rewrote the spec-side and code-side reference
        // spellings (SPEC 6.4) — a crisp diagnosis ahead of the sweep.
        for (const rel of [R1_REFS, R1_APP]) {
          assertRewriteHappened(
            await readSourceText(workspace, rel, "T6.2-1 rewrite premise"),
            rel,
            "core.mid",
            "core.hub",
            "T6.2-1 rewrite premise",
          );
        }

        const after = await sweepHashes(
          product,
          workspace,
          R1_POST_IDENTITIES,
          "T6.2-1 post-rename sweep",
        );
        assertHashesPreserved(
          before,
          after,
          R1_IDENTITY_MAP,
          "`xspec rename`",
          "T6.2-1",
        );

        const label = "T6.2-1 `impact --base <pre-rename ref> --json`";
        assertPureImpact(
          await impactAgainst(product, workspace, base, label),
          "a journaled `rename`",
          label,
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T6.2-2 — file-move purity
// ---------------------------------------------------------------------------

// The moved file itself imports another spec file (its own import specifier
// must be rewritten across the directory change, SPEC 6.5) and is referenced
// by a spec file and a code location (their import paths rewritten); IDs are
// unchanged and identities change only in their file part.
const M2_OTHER = "specs/Other.mdx";
const M2_OTH = "specs/Other.mdx#oth";
const M2_CORE = "specs/Core.mdx";
const M2_MOVED = "specs/sub/Moved.mdx";
const M2_REFS = "specs/Refs.mdx";
const M2_APP = "src/app.ts";

const M2_OTHER_SOURCE = [
  '<S id="oth">',
  "Outside target text.",
  "</S>",
  "",
].join("\n");

const M2_CORE_SOURCE = [
  'import Other from "./Other.xspec"',
  "",
  '<S id="core">',
  "Core holder text.",
  "",
  '<S id="core.mid" d={Other.oth} coverage="none" tags="mid keep">',
  "Mid text with a dependency.",
  "",
  '<S id="core.mid.leaf">',
  "Leaf text embedding: {text(Other.oth)}",
  "</S>",
  "</S>",
  "</S>",
  "",
].join("\n");

const M2_REFS_SOURCE = [
  'import Core from "./Core.xspec"',
  "",
  '<S id="refs">',
  "Refs holder text.",
  "",
  '<S id="refs.dep" d={Core.core.mid}>',
  "Depends on the moved file. Embeds: {text(Core.core.mid.leaf)}",
  "</S>",
  "</S>",
  "",
].join("\n");

const M2_APP_SOURCE = [
  'import CORE, { text } from "../specs/Core.xspec";',
  "",
  "CORE.core.mid.leaf;",
  "text(CORE.core.mid);",
  "",
].join("\n");

const M2_PRE_IDENTITIES = [
  M2_OTHER,
  M2_OTH,
  M2_CORE,
  `${M2_CORE}#core`,
  `${M2_CORE}#core.mid`,
  `${M2_CORE}#core.mid.leaf`,
  M2_REFS,
  `${M2_REFS}#refs`,
  `${M2_REFS}#refs.dep`,
];
// Identities change only in their file part (SPEC 6.5): same IDs, new path.
const M2_IDENTITY_MAP: Readonly<Record<string, string>> = {
  [M2_CORE]: M2_MOVED,
  [`${M2_CORE}#core`]: `${M2_MOVED}#core`,
  [`${M2_CORE}#core.mid`]: `${M2_MOVED}#core.mid`,
  [`${M2_CORE}#core.mid.leaf`]: `${M2_MOVED}#core.mid.leaf`,
};
const M2_POST_IDENTITIES = M2_PRE_IDENTITIES.map(
  (identity) => M2_IDENTITY_MAP[identity] ?? identity,
);

const T6_2_2 = defineProductTest({
  id: "T6.2-2",
  title:
    "file-move purity: after `xspec move old.mdx new.mdx` every node's four hashes are byte-identical (full-workspace sweep), identities change only in their file part, `impact --base <pre-move ref>` reports no change categories, and the marker-and-`text(...)` code location's impacted-code groups are empty — its edges unify through the journal despite the rewritten import specifiers (SPEC 6.2, 6.3, 6.5, 9.2)",
  run: async (product) => {
    await withWorkspace(
      SPEC_AND_CODE_CONFIG,
      {
        [M2_OTHER]: M2_OTHER_SOURCE,
        [M2_CORE]: M2_CORE_SOURCE,
        [M2_REFS]: M2_REFS_SOURCE,
        [M2_APP]: M2_APP_SOURCE,
      },
      async (workspace) => {
        await workspace.gitInit();
        const base = await workspace.gitCommitAll("pre-move baseline");
        await buildOk(
          product,
          workspace,
          "T6.2-2 `build` over the staged workspace",
        );

        const before = await sweepHashes(
          product,
          workspace,
          M2_PRE_IDENTITIES,
          "T6.2-2 pre-move sweep",
        );

        await expectExit(
          product,
          workspace,
          ["move", "specs/Core.mdx", "specs/sub/Moved.mdx"],
          0,
          "T6.2-2 file-form `move specs/Core.mdx specs/sub/Moved.mdx`",
        );

        // Premises: the file was relocated; its own import specifier and the
        // other files' import paths were rewritten so everything resolves
        // (SPEC 6.5). Spellings are substring-checked only (byte exactness
        // is T6.5-1's business).
        const originKind = await workspace.kind(M2_CORE);
        if (originKind !== "absent") {
          fail(
            `T6.2-2: the origin file ${M2_CORE} must be gone after the ` +
              `file-form move (SPEC 6.5); found ${originKind}`,
          );
        }
        assertRewriteHappened(
          await readSourceText(workspace, M2_MOVED, "T6.2-2 rewrite premise"),
          M2_MOVED,
          '"./Other.xspec"',
          undefined,
          "T6.2-2 rewrite premise (the moved file's own import specifier)",
        );
        assertRewriteHappened(
          await readSourceText(workspace, M2_REFS, "T6.2-2 rewrite premise"),
          M2_REFS,
          '"./Core.xspec"',
          "Moved.xspec",
          "T6.2-2 rewrite premise (the referencing spec file's import)",
        );
        assertRewriteHappened(
          await readSourceText(workspace, M2_APP, "T6.2-2 rewrite premise"),
          M2_APP,
          '"../specs/Core.xspec"',
          "Moved.xspec",
          "T6.2-2 rewrite premise (the code file's import)",
        );

        const after = await sweepHashes(
          product,
          workspace,
          M2_POST_IDENTITIES,
          "T6.2-2 post-move sweep",
        );
        assertHashesPreserved(
          before,
          after,
          M2_IDENTITY_MAP,
          "the file form of `xspec move`",
          "T6.2-2",
        );

        const label = "T6.2-2 `impact --base <pre-move ref> --json`";
        assertPureImpact(
          await impactAgainst(product, workspace, base, label),
          "a journaled file-form `move`",
          label,
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T6.2-3 — section move impurity
// ---------------------------------------------------------------------------

// Clean-boundary arm: the moved construct's opening and closing tags each
// stand alone on their lines and the descendant sits on interior lines, so no
// moved node has own-content bytes on the straddling lines (SPEC 6.2) — the
// tag-only lines are dropped at origin and destination alike (SPEC 3).
const C3_ORIGIN = "specs/Origin.mdx";
const C3_OP = "specs/Origin.mdx#origin";
const C3_MV_PRE = "specs/Origin.mdx#origin.mv";
const C3_KID_PRE = "specs/Origin.mdx#origin.mv.kid";
const C3_TARGET = "specs/Target.mdx";
const C3_TP = "specs/Target.mdx#tgt";
const C3_MV_POST = "specs/Target.mdx#tgt.mv";
const C3_KID_POST = "specs/Target.mdx#tgt.mv.kid";
const C3_WATCH = "specs/Watch.mdx";
const C3_W_TOP = "specs/Watch.mdx#watch";
const C3_W_ONORIGIN = "specs/Watch.mdx#watch.onorigin";
const C3_W_ONTARGET = "specs/Watch.mdx#watch.ontarget";

const C3_ORIGIN_SOURCE = [
  '<S id="origin">',
  "Origin holder text.",
  "",
  '<S id="origin.mv" coverage="none" tags="keep mv">',
  "Moved root text.",
  "",
  '<S id="origin.mv.kid">',
  "Moved kid text.",
  "</S>",
  "</S>",
  "</S>",
  "",
].join("\n");

const C3_TARGET_SOURCE = [
  '<S id="tgt">',
  "Target parent text.",
  "</S>",
  "",
].join("\n");

// One dependent of each parent: the ordinary upstream cascades, attributed
// per parent (SPEC 5.6).
const C3_WATCH_SOURCE = [
  'import Origin from "./Origin.xspec"',
  'import Target from "./Target.xspec"',
  "",
  '<S id="watch">',
  "Watch holder text.",
  "",
  '<S id="watch.onorigin" d={Origin.origin}>',
  "Depends on the origin parent.",
  "</S>",
  "",
  '<S id="watch.ontarget" d={Target.tgt}>',
  "Depends on the target parent.",
  "</S>",
  "</S>",
  "",
].join("\n");

// Impure-boundary arm (SPEC 6.2's worked case): the moved section's opening
// tag is preceded on its origin line by non-whitespace (`Lead-in prose.`) and
// followed there only by whitespace (two spaces before the terminator). The
// within-construct remainder and terminator contribute to its own content at
// the origin — the line is kept, `Lead-in prose.` remains after tag removal —
// but not at the destination, where insertion starts the construct at line
// start and the tag-only line is dropped (SPEC 3, 6.5).
const I3_ROOM = "specs/Room.mdx";
const I3_OP = "specs/Room.mdx#op";
const I3_IMP_PRE = "specs/Room.mdx#op.imp";
const I3_HALL = "specs/Hall.mdx";
const I3_TP = "specs/Hall.mdx#tp";
const I3_IMP_POST = "specs/Hall.mdx#tp.imp";
const I3_DEPS = "specs/Deps.mdx";
const I3_W_TOP = "specs/Deps.mdx#watch";
const I3_W_ONIMP = "specs/Deps.mdx#watch.onimp";

const I3_ROOM_SOURCE = [
  '<S id="op">',
  "Op holder text.",
  "",
  'Lead-in prose.<S id="op.imp" coverage="none" tags="edge imp">  ',
  "Impure line one.",
  "Impure line two.",
  "</S>",
  "</S>",
  "",
].join("\n");

const I3_HALL_SOURCE = ['<S id="tp">', "Hall parent text.", "</S>", ""].join(
  "\n",
);

// A dependent of the moved node itself: its dependency edge is
// identity-mapped through the journal, so its `upstream-changed` — caused by
// the moved node's own-content change — is attributed exactly to the moved
// node: the unambiguous "5.6 cascades attributed to it".
const I3_DEPS_SOURCE = [
  'import Room from "./Room.xspec"',
  "",
  '<S id="watch">',
  "Dependents holder text.",
  "",
  '<S id="watch.onimp" d={Room.op.imp}>',
  "Depends on the impure moved node.",
  "</S>",
  "</S>",
  "",
].join("\n");

/** The three hashes T6.2-3 pins for every node of a moved subtree. */
function assertKeptSectionMoveHashes(
  before: NodeHashes,
  after: NodeHashes,
  pre: string,
  post: string,
  context: string,
): void {
  for (const key of ["ownHash", "subtreeHash", "metadataHash"] as const) {
    assertSameJson(
      after[key],
      before[key],
      `${context}: ${pre} (now ${post}) must keep its ${key} across the ` +
        `section-form move — the identity mapping changes no hash, and with ` +
        `no own-content bytes on the construct's straddling lines the moved ` +
        `text reads identically at origin and destination (SPEC 6.2, 5.4)`,
    );
  }
}

const T6_2_3 = defineProductTest({
  id: "T6.2-3",
  title:
    "section move impurity: on a clean-boundary fixture every moved node keeps ownHash, subtreeHash, and metadataHash, the origin and target parents are each `changed` with ordinary cascades attributed to them, and no other node is `changed`; a moved section with an impure origin boundary (SPEC 6.2's worked case) is itself additionally `changed` with the 5.6 cascades attributed to it, its metadataHash still unchanged (SPEC 6.2, 3, 5.6, 6.5)",
  run: async (product) => {
    // --- Clean-boundary arm ---
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      {
        [C3_ORIGIN]: C3_ORIGIN_SOURCE,
        [C3_TARGET]: C3_TARGET_SOURCE,
        [C3_WATCH]: C3_WATCH_SOURCE,
      },
      async (workspace) => {
        const context = "T6.2-3 clean-boundary arm";
        await workspace.gitInit();
        const base = await workspace.gitCommitAll("pre-move baseline");
        await buildOk(product, workspace, `${context}: \`build\``);

        const mvBefore = await queryNode(
          product,
          workspace,
          C3_MV_PRE,
          `${context} pre-move`,
        );
        const kidBefore = await queryNode(
          product,
          workspace,
          C3_KID_PRE,
          `${context} pre-move`,
        );

        await expectExit(
          product,
          workspace,
          ["move", "specs/Origin.mdx#origin.mv", "specs/Target.mdx#tgt.mv"],
          0,
          `${context}: \`move specs/Origin.mdx#origin.mv specs/Target.mdx#tgt.mv\``,
        );

        const mvAfter = await queryNode(
          product,
          workspace,
          C3_MV_POST,
          `${context} post-move`,
        );
        const kidAfter = await queryNode(
          product,
          workspace,
          C3_KID_POST,
          `${context} post-move`,
        );
        assertKeptSectionMoveHashes(
          mvBefore.hashes,
          mvAfter.hashes,
          C3_MV_PRE,
          C3_MV_POST,
          context,
        );
        assertKeptSectionMoveHashes(
          kidBefore.hashes,
          kidAfter.hashes,
          C3_KID_PRE,
          C3_KID_POST,
          context,
        );

        const label = `${context}: \`impact --base <pre-move ref> --json\``;
        assertImpactTable(
          await impactAgainst(product, workspace, base, label),
          [
            // The two originating nodes: each parent's own content changed —
            // one lost a child reference, the other gained one (SPEC 6.2).
            {
              identity: C3_OP,
              categories: [{ category: "changed", within: [C3_OP, C3_TP] }],
            },
            {
              identity: C3_TP,
              categories: [{ category: "changed", within: [C3_OP, C3_TP] }],
            },
            // The moved subtree: hashes kept, identity mapped — no category.
            { identity: C3_MV_POST, categories: [] },
            { identity: C3_KID_POST, categories: [] },
            // Ordinary cascades, attributed per parent: the file roots'
            // descendant-changed…
            {
              identity: C3_ORIGIN,
              categories: [{ category: "descendant-changed", exact: [C3_OP] }],
            },
            {
              identity: C3_TARGET,
              categories: [{ category: "descendant-changed", exact: [C3_TP] }],
            },
            // …and the dependents' upstream-changed, meeting at their shared
            // ancestors with merged attribution (SPEC 5.6).
            {
              identity: C3_W_ONORIGIN,
              categories: [{ category: "upstream-changed", exact: [C3_OP] }],
            },
            {
              identity: C3_W_ONTARGET,
              categories: [{ category: "upstream-changed", exact: [C3_TP] }],
            },
            {
              identity: C3_W_TOP,
              categories: [
                { category: "upstream-changed", exact: [C3_OP, C3_TP] },
              ],
            },
            {
              identity: C3_WATCH,
              categories: [
                { category: "upstream-changed", exact: [C3_OP, C3_TP] },
              ],
            },
          ],
          label,
        );
      },
    );

    // --- Impure-boundary arm (SPEC 6.2's worked case) ---
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      {
        [I3_ROOM]: I3_ROOM_SOURCE,
        [I3_HALL]: I3_HALL_SOURCE,
        [I3_DEPS]: I3_DEPS_SOURCE,
      },
      async (workspace) => {
        const context = "T6.2-3 impure-boundary arm";
        await workspace.gitInit();
        const base = await workspace.gitCommitAll("pre-move baseline");
        await buildOk(product, workspace, `${context}: \`build\``);

        const impBefore = await queryNode(
          product,
          workspace,
          I3_IMP_PRE,
          `${context} pre-move`,
        );

        await expectExit(
          product,
          workspace,
          ["move", "specs/Room.mdx#op.imp", "specs/Hall.mdx#tp.imp"],
          0,
          `${context}: \`move specs/Room.mdx#op.imp specs/Hall.mdx#tp.imp\``,
        );

        const impAfter = await queryNode(
          product,
          workspace,
          I3_IMP_POST,
          `${context} post-move`,
        );
        assertSameJson(
          impAfter.hashes.metadataHash,
          impBefore.hashes.metadataHash,
          `${context}: the moved node's metadataHash is kept unconditionally — ` +
            `its \`coverage\`, tags, and (absent) \`d\` targets are untouched ` +
            `by the move (SPEC 6.2, 5.5)`,
        );
        if (impAfter.hashes.ownHash === impBefore.hashes.ownHash) {
          fail(
            `${context}: the moved node's ownHash must change — at the origin ` +
              `its opening tag's line is kept (preceded by non-whitespace), so ` +
              `the within-construct remainder and terminator contribute to its ` +
              `own content, while at the destination the tag-only line is ` +
              `dropped (SPEC 6.2's worked case, 3); both sides report ownHash ` +
              `${JSON.stringify(impAfter.hashes.ownHash)}`,
          );
        }

        const label = `${context}: \`impact --base <pre-move ref> --json\``;
        const originators = [I3_OP, I3_TP, I3_IMP_POST];
        assertImpactTable(
          await impactAgainst(product, workspace, base, label),
          [
            // The moved node itself is additionally `changed` (SPEC 6.2's
            // worked case) — and nothing else: metadataHash unchanged (no
            // metadata-changed), no descendants (no descendant-changed), no
            // dependency edges (no upstream-changed).
            {
              identity: I3_IMP_POST,
              categories: [{ category: "changed", within: originators }],
            },
            // The parents, as in the clean arm; whether the departed/arrived
            // changed child additionally gives them descendant-changed is the
            // documented two-sided ambiguity — tolerated only when attributed
            // to the moved node (module header, H-4).
            {
              identity: I3_OP,
              categories: [
                { category: "changed", within: originators },
                {
                  category: "descendant-changed",
                  within: [I3_IMP_POST],
                  optional: true,
                },
              ],
            },
            {
              identity: I3_TP,
              categories: [
                { category: "changed", within: originators },
                {
                  category: "descendant-changed",
                  within: [I3_IMP_POST],
                  optional: true,
                },
              ],
            },
            // The file roots: descendant-changed through their changed parent
            // (present on both sides); the moved node may join the
            // attribution (same ambiguity).
            {
              identity: I3_ROOM,
              categories: [
                {
                  category: "descendant-changed",
                  within: [I3_OP, I3_IMP_POST],
                  mustInclude: [I3_OP],
                },
              ],
            },
            {
              identity: I3_HALL,
              categories: [
                {
                  category: "descendant-changed",
                  within: [I3_TP, I3_IMP_POST],
                  mustInclude: [I3_TP],
                },
              ],
            },
            // The dependent of the moved node: the unambiguous 5.6 cascade
            // attributed to it — the dependency edge is identity-mapped, and
            // the target's effectiveHash changed through its own edit.
            {
              identity: I3_W_ONIMP,
              categories: [
                { category: "upstream-changed", exact: [I3_IMP_POST] },
              ],
            },
            {
              identity: I3_W_TOP,
              categories: [
                { category: "upstream-changed", exact: [I3_IMP_POST] },
              ],
            },
            {
              identity: I3_DEPS,
              categories: [
                { category: "upstream-changed", exact: [I3_IMP_POST] },
              ],
            },
          ],
          label,
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T6.2-4 — same-parent final-position move
// ---------------------------------------------------------------------------

// The parent's last child is moved onto itself under a new ID: removal plus
// re-insertion at its own former position reproduces the parent's own content
// exactly (SPEC 6.2), so the move changes no hash and is pure in effect —
// asserted with the same full-workspace sweep and empty impact as T6.2-1.
// A referencing file's `d` and `text(...)` spellings are rewritten to the new
// identity while its hashes stay put (SPEC 5.4).
const P4_FILE = "specs/P.mdx";
const P4_TOP = "specs/P.mdx#p";
const P4_FIRST = "specs/P.mdx#p.first";
const P4_LAST_PRE = "specs/P.mdx#p.last";
const P4_LAST_POST = "specs/P.mdx#p.final";
const P4_WATCH = "specs/Watch.mdx";
const P4_W_TOP = "specs/Watch.mdx#watch";

const P4_SOURCE = [
  '<S id="p">',
  "Parent text.",
  "",
  '<S id="p.first">',
  "First child text.",
  "</S>",
  "",
  '<S id="p.last" coverage="none" tags="tail">',
  "Tail child text.",
  "</S>",
  "</S>",
  "",
].join("\n");

const P4_WATCH_SOURCE = [
  'import P from "./P.xspec"',
  "",
  '<S id="watch" d={P.p.last}>',
  "Depends on the tail child. Embeds: {text(P.p.last)}",
  "</S>",
  "",
].join("\n");

const P4_PRE_IDENTITIES = [
  P4_FILE,
  P4_TOP,
  P4_FIRST,
  P4_LAST_PRE,
  P4_WATCH,
  P4_W_TOP,
];
const P4_IDENTITY_MAP: Readonly<Record<string, string>> = {
  [P4_LAST_PRE]: P4_LAST_POST,
};
const P4_POST_IDENTITIES = P4_PRE_IDENTITIES.map(
  (identity) => P4_IDENTITY_MAP[identity] ?? identity,
);

const T6_2_4 = defineProductTest({
  id: "T6.2-4",
  title:
    "same-parent final-position move: moving a parent's last child onto itself (same parent, same final position, new ID) changes no hash in the workspace (full sweep) and is pure in effect — `impact --base <pre-move ref>` reports no categories and no impacted code — apart from the identity mapping (SPEC 6.2, 6.5)",
  run: async (product) => {
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      { [P4_FILE]: P4_SOURCE, [P4_WATCH]: P4_WATCH_SOURCE },
      async (workspace) => {
        await workspace.gitInit();
        const base = await workspace.gitCommitAll("pre-move baseline");
        await buildOk(
          product,
          workspace,
          "T6.2-4 `build` over the staged workspace",
        );

        const before = await sweepHashes(
          product,
          workspace,
          P4_PRE_IDENTITIES,
          "T6.2-4 pre-move sweep",
        );

        await expectExit(
          product,
          workspace,
          ["move", "specs/P.mdx#p.last", "specs/P.mdx#p.final"],
          0,
          "T6.2-4 `move specs/P.mdx#p.last specs/P.mdx#p.final`",
        );

        // Premise: the referencing file's spellings were rewritten to the new
        // identity (SPEC 6.5) — the purity claim covers a real rewrite.
        assertRewriteHappened(
          await readSourceText(workspace, P4_WATCH, "T6.2-4 rewrite premise"),
          P4_WATCH,
          "p.last",
          "p.final",
          "T6.2-4 rewrite premise",
        );

        const after = await sweepHashes(
          product,
          workspace,
          P4_POST_IDENTITIES,
          "T6.2-4 post-move sweep",
        );
        assertHashesPreserved(
          before,
          after,
          P4_IDENTITY_MAP,
          "the same-parent final-position `move`",
          "T6.2-4",
        );

        const label = "T6.2-4 `impact --base <pre-move ref> --json`";
        assertPureImpact(
          await impactAgainst(product, workspace, base, label),
          "a same-parent final-position `move`",
          label,
        );
      },
    );
  },
});

/** TEST-SPEC §6.2, in canonical ID order (SUITE-22). */
export const section62Tests: readonly ProductTestEntry[] = [
  T6_2_1,
  T6_2_2,
  T6_2_3,
  T6_2_4,
];
