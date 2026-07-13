// TEST-SPEC §8 (coverage) — SUITE-30: T8-1…T8-5, T8.2-1.
//
// Registered product-facing bodies (C-2 "one code path"): each builds its own
// fresh workspace (H-1), drives the product strictly as a subprocess (H-2),
// asserts exact exit codes (H-5), decodes reports through the H-3 adapters,
// and rejects a product only via diagnosed assertion failures (H-8).
//
// SPEC 8: coverage is graph reachability over dependency edges between
// non-root participants — a target requirement is covered for a profile when
// a permitted path exists from a boundary node to it: one edge in `direct`
// mode, one or more in `transitive` mode, using only the profile's
// `edgeKinds`. `contains` edges never grant coverage and never appear in
// coverage paths; root nodes never appear in coverage paths either — not as
// boundary node, intermediate, or target — while roots remain nodes of their
// groups and root-sourced/root-targeted dependency edges remain ordinary for
// policy (7.5), impact (9.2), effectiveHash (5.5), and query (11): the
// exclusion is coverage-scoped. SPEC 8.1: required = the target group's
// nodes, restricted by `targetTags` when present and to leaves under the
// default `targets: "leaves"`, excluding `coverage="none"` nodes and always
// excluding roots. SPEC 8.2: all profiles run by default, one when named;
// the report carries the four counts, every covered/uncovered/ignored
// identity, one shortest covering path per covered node (ties by the 12.0
// element-wise byte-least sequence), and each ignored node's exclusion
// reasons — all that apply, in the fixed order root node, `coverage="none"`,
// non-leaf under `targets: "leaves"`, lacking every `targetTags` tag;
// `--check` exits 1 iff any required node is uncovered; JSON carries the
// same information.
//
// Conservative operationalizations (noted per H-3/H-4):
// - SPEC 8.2 fixes membership, per-node information, and counts — no row or
//   profile order. Profiles are looked up by name and row sets compared
//   sorted; covering paths are order-sensitive sequences and compared
//   exactly.
// - Ignored-reason spellings are output shape: `classifyIgnoredReasons`
//   (helpers/adapters/reports.ts) maps each reported reason string onto the
//   four SPEC 8.2 reason identities, failing loudly on an unclassifiable or
//   ambiguous one (H-3). The tests then assert reason identity and the fixed
//   order as values.
// - T8-1…T8-5 assert covered rows (exact paths) and uncovered membership;
//   counts and ignored composition are T8.2-1's subject (the discipline
//   T7.4-2 fixed). Required-set composition is observed through
//   covered ∪ uncovered (SPEC 8.1/8.2: required = covered ∪ uncovered).
// - T8.2-1's "same information" arms: the JSON document is decoded and
//   asserted in full; `coverage <name>` and `coverage --check` outputs are
//   adapter-decoded and compared for information equality against the
//   default run (a product-to-itself comparison, order-normalized); the
//   human report is checked to mention the same distinctive information —
//   profile names, every covered/uncovered/ignored identity, the covering
//   path's boundary member, and the count digits (identities and profile
//   names in the fixture are digit-free, so digits in the report render
//   counts) — robust matching, never wording (H-3).
// - T8-5's impact arm follows the SUITE-20 (§5.6) conventions: entries are
//   merged per node identity (SPEC 9.3 fixes the grouping by category, not
//   the adapter-level entry granularity); an uncategorized, undeleted node
//   appears in no entry (the T1.5-1 convention); the propagated
//   `descendant-changed`/`upstream-changed` attributions are pinned to the
//   edited leaf per SPEC 5.6's worked single-leaf-edit example, and the
//   originating `changed` attribution is bounded within the originating set
//   (empty accepted).
// - T8-5's policy findings are compared as sorted "rule :: kind: from -> to"
//   renderings plus an exact 14.12 condition count, after a successful
//   `build` in the same workspace (the SUITE-29 protocol: check runs over
//   fresh output, no 14.10 contamination, so the staged violations are the
//   run's only findings).

import type {
  ChangeCategory,
  CoverageCounts,
  CoverageProfileReport,
  CoverageReport,
  Finding,
  IgnoredReasonKind,
  ImpactReport,
} from "../../helpers/adapters/index.js";
import {
  assertReportMentions,
  classifyIgnoredReasons,
  decodeCoverageReport,
  decodeEdgesReport,
  decodeFindingsReport,
  decodeImpactReport,
} from "../../helpers/adapters/index.js";
import { fail, parseJsonStdout } from "../../helpers/assertions.js";
import { defineProductTest } from "../../helpers/registry.js";
import type { ProductTestEntry } from "../../helpers/registry.js";
import type { ProductBinding } from "../../helpers/subprocess.js";
import { TestWorkspace } from "../../helpers/workspace.js";
import {
  assertConditionCounts,
  assertEdgeSetEqual,
  assertSameJson,
  buildOk,
  expectExit,
  runJson,
} from "./support.js";

// ---------------------------------------------------------------------------
// Shared fixture material and assertion sugar
// ---------------------------------------------------------------------------

/** Stage a fresh workspace from files, run `body`, dispose (H-1). */
async function withWorkspace<T>(
  files: Readonly<Record<string, string>>,
  body: (workspace: TestWorkspace) => Promise<T>,
): Promise<T> {
  const workspace = await TestWorkspace.create({ files });
  try {
    return await body(workspace);
  } finally {
    await workspace.dispose();
  }
}

/** `coverage … --json` on exit 0, decoded (H-3, H-5). */
async function coverageJson(
  product: ProductBinding,
  workspace: TestWorkspace,
  argv: readonly string[],
  context: string,
): Promise<CoverageReport> {
  return decodeCoverageReport(
    await runJson(product, workspace, argv, context),
    context,
  );
}

/** Resolve one profile of a coverage report by name, diagnosed (H-8). */
function profileNamed(
  report: CoverageReport,
  name: string,
  context: string,
): CoverageProfileReport {
  const profile = report.profiles.find((candidate) => candidate.name === name);
  if (profile === undefined) {
    fail(
      `${context}: the coverage report must carry profile ${JSON.stringify(name)} — ` +
        `all configured profiles run by default (SPEC 8.2); got profiles ` +
        `${JSON.stringify(report.profiles.map((candidate) => candidate.name))}`,
    );
  }
  return profile;
}

/** One expected covered row: the node and its one shortest covering path. */
interface ExpectedCoveredRow {
  readonly identity: string;
  readonly path: readonly string[];
}

/**
 * The expected content of one profile's report. `covered` is sorted by
 * identity and `uncovered` bytewise (SPEC 8.2 fixes membership, not row
 * order); paths are exact sequences. `counts` and `ignored` (identities
 * sorted, reasons as canonical kinds in the fixed order) are asserted only
 * where a test's text owns them (T8.2-1).
 */
interface ExpectedProfileContent {
  readonly counts?: CoverageCounts;
  readonly covered: readonly ExpectedCoveredRow[];
  readonly uncovered: readonly string[];
  readonly ignored?: readonly {
    readonly identity: string;
    readonly reasons: readonly IgnoredReasonKind[];
  }[];
}

function sortedCoveredRows(
  profile: CoverageProfileReport,
): ExpectedCoveredRow[] {
  return profile.covered
    .map((row) => ({ identity: row.identity, path: [...row.path] }))
    .sort((a, b) => (a.identity < b.identity ? -1 : 1));
}

/** Assert one profile's decoded report against its expected content. */
function assertProfileContent(
  profile: CoverageProfileReport,
  expected: ExpectedProfileContent,
  context: string,
): void {
  if (expected.counts !== undefined) {
    assertSameJson(
      profile.counts,
      expected.counts,
      `${context}: the counts of required, covered, uncovered, and ignored ` +
        `nodes (SPEC 8.2)`,
    );
  }
  assertSameJson(
    sortedCoveredRows(profile),
    expected.covered,
    `${context}: every covered node's identity with its one shortest ` +
      `covering path (SPEC 8, 8.2, 12.0)`,
  );
  assertSameJson(
    [...profile.uncovered].sort(),
    expected.uncovered,
    `${context}: every uncovered node's identity (SPEC 8.1, 8.2)`,
  );
  if (expected.ignored !== undefined) {
    assertSameJson(
      profile.ignored
        .map((row) => ({
          identity: row.identity,
          reasons: classifyIgnoredReasons(
            row.reasons,
            `${context} ignored ${row.identity}`,
          ),
        }))
        .sort((a, b) => (a.identity < b.identity ? -1 : 1)),
      expected.ignored,
      `${context}: every ignored node's identity with all applicable ` +
        `exclusion reasons in the fixed order — root node, ` +
        `coverage="none", non-leaf under targets: "leaves", lacking every ` +
        `targetTags tag (SPEC 8.1, 8.2)`,
    );
  }
}

// ---------------------------------------------------------------------------
// T8-1 — direct mode
// ---------------------------------------------------------------------------

// Graph (dependency edges only):
//
//   bnd/B.mdx#direct --depends--> tgt/T.mdx#one              (one edge)
//   bnd/B.mdx#viahop --depends--> mid/M.mdx#hop --depends--> tgt/T.mdx#two
//
// In `direct` mode the single boundary edge covers `one`; the two-edge path
// to `two` does not (its one incoming edge is sourced at mid/M.mdx#hop, no
// boundary node).
const T8_1_FILES: Readonly<Record<string, string>> = {
  "xspec.config.ts": `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    tgt: ["tgt/**/*.mdx"],
    bnd: ["bnd/**/*.mdx"],
    mid: ["mid/**/*.mdx"]
  },
  coverage: [
    {
      name: "p-direct",
      target: "tgt",
      boundary: "bnd",
      mode: "direct"
    }
  ]
})
`,
  "tgt/T.mdx": `<S id="one">
Target leaf one.
</S>

<S id="two">
Target leaf two.
</S>
`,
  "mid/M.mdx": `import T from "../tgt/T.xspec"

<S id="hop" d={T.two}>
Intermediate hop to target leaf two.
</S>
`,
  "bnd/B.mdx": `import T from "../tgt/T.xspec"
import M from "../mid/M.xspec"

<S id="direct" d={T.one}>
One edge straight to target leaf one.
</S>

<S id="viahop" d={M.hop}>
Two edges away from target leaf two.
</S>
`,
};

const T8_1 = defineProductTest({
  id: "T8-1",
  title:
    "direct mode: a single dependency edge from a boundary node to the " +
    "target covers it, and a two-edge path does not (SPEC 8, 8.2)",
  run: async (product) => {
    await withWorkspace(T8_1_FILES, async (workspace) => {
      await buildOk(product, workspace, "T8-1 `build`");
      const label = "T8-1 `coverage --json`";
      const report = await coverageJson(
        product,
        workspace,
        ["coverage", "--json"],
        label,
      );
      assertProfileContent(
        profileNamed(report, "p-direct", label),
        {
          covered: [
            {
              identity: "tgt/T.mdx#one",
              path: ["bnd/B.mdx#direct", "tgt/T.mdx#one"],
            },
          ],
          uncovered: ["tgt/T.mdx#two"],
        },
        `${label} profile p-direct: the single boundary edge covers ` +
          `\`one\` — its path is exactly [boundary node, target] — while ` +
          `\`two\`, reachable from the boundary only over two edges, is ` +
          `uncovered in direct mode (SPEC 8)`,
      );
    });
  },
});

// ---------------------------------------------------------------------------
// T8-2 — transitive mode
// ---------------------------------------------------------------------------

// Graph (dependency edges beyond contains):
//
//   bnd/B.mdx#start    --depends--> mid/M.mdx#viaembed --embeds-->  tgt/T.mdx#deep
//   bnd/B.mdx#start    --depends--> mid/M.mdx#viadep   --depends--> tgt/T.mdx#far
//   bnd/B.mdx#toparent --depends--> tgt/T.mdx#parent
//
// plus the structural tgt/T.mdx#parent --contains--> tgt/T.mdx#parent.kid:
// the leaf `parent.kid`'s ONLY connection from the boundary runs through
// that contains edge, which never grants coverage. Two transitive profiles
// differ only in `edgeKinds`: the default admits both multi-edge paths;
// ["depends"] breaks `deep`'s path at its embeds step. Every covered path is
// asserted exactly, so no contains edge can appear in a reported path.
const T8_2_FILES: Readonly<Record<string, string>> = {
  "xspec.config.ts": `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    tgt: ["tgt/**/*.mdx"],
    bnd: ["bnd/**/*.mdx"],
    mid: ["mid/**/*.mdx"]
  },
  coverage: [
    {
      name: "p-all-kinds",
      target: "tgt",
      boundary: "bnd",
      mode: "transitive"
    },
    {
      name: "p-depends-only",
      target: "tgt",
      boundary: "bnd",
      mode: "transitive",
      edgeKinds: ["depends"]
    }
  ]
})
`,
  "tgt/T.mdx": `<S id="deep">
Target leaf reached over an embeds step.
</S>

<S id="far">
Target leaf reached over a pure depends chain.
</S>

<S id="parent">
Target parent, depended on by the boundary.

<S id="parent.kid">
Target leaf whose only connection is containment.
</S>
</S>
`,
  "mid/M.mdx": `import T from "../tgt/T.xspec"

<S id="viaembed">
Embeds the deep target:

{text(T.deep)}
</S>

<S id="viadep" d={T.far}>
Depends on the far target.
</S>
`,
  "bnd/B.mdx": `import T from "../tgt/T.xspec"
import M from "../mid/M.xspec"

<S id="start" d={[M.viaembed, M.viadep]}>
Boundary start of both multi-edge paths.
</S>

<S id="toparent" d={T.parent}>
Boundary edge to the target parent.
</S>
`,
};

const T8_2 = defineProductTest({
  id: "T8-2",
  title:
    "transitive mode: a multi-edge path covers; an `edgeKinds` restriction " +
    "breaks coverage when the path uses an excluded kind; `contains` edges " +
    "never grant coverage — a node connected only via containment is " +
    "uncovered — and never appear in reported paths (SPEC 8, 7.4)",
  run: async (product) => {
    await withWorkspace(T8_2_FILES, async (workspace) => {
      await buildOk(product, workspace, "T8-2 `build`");
      const label = "T8-2 `coverage --json`";
      const report = await coverageJson(
        product,
        workspace,
        ["coverage", "--json"],
        label,
      );

      assertProfileContent(
        profileNamed(report, "p-all-kinds", label),
        {
          covered: [
            {
              identity: "tgt/T.mdx#deep",
              path: ["bnd/B.mdx#start", "mid/M.mdx#viaembed", "tgt/T.mdx#deep"],
            },
            {
              identity: "tgt/T.mdx#far",
              path: ["bnd/B.mdx#start", "mid/M.mdx#viadep", "tgt/T.mdx#far"],
            },
          ],
          uncovered: ["tgt/T.mdx#parent.kid"],
        },
        `${label} profile p-all-kinds: both multi-edge paths cover under ` +
          `the default edgeKinds, each reported exactly and free of ` +
          `contains steps, while \`parent.kid\` — whose only connection ` +
          `from the boundary runs through the parent's contains edge — is ` +
          `uncovered: contains edges never grant coverage (SPEC 8)`,
      );

      assertProfileContent(
        profileNamed(report, "p-depends-only", label),
        {
          covered: [
            {
              identity: "tgt/T.mdx#far",
              path: ["bnd/B.mdx#start", "mid/M.mdx#viadep", "tgt/T.mdx#far"],
            },
          ],
          uncovered: ["tgt/T.mdx#deep", "tgt/T.mdx#parent.kid"],
        },
        `${label} profile p-depends-only: edgeKinds ["depends"] keeps the ` +
          `pure depends chain covering while \`deep\` becomes uncovered — ` +
          `its only path uses an excluded embeds step (SPEC 8, 7.4)`,
      );
    });
  },
});

// ---------------------------------------------------------------------------
// T8-3 — boundaries
// ---------------------------------------------------------------------------

// A spec-group boundary (spec→spec depends edge covers `a`) and a code-group
// boundary (a top-level marker's references edge covers `b`, a top-level
// text(...) call's embeds edge covers `c` — both attributed to the file,
// T4.6-1), each staged with boundaryKind inferred (the names are
// unambiguous) and explicit. The inferred and explicit profile of each pair
// must report identical content.
const T8_3_FILES: Readonly<Record<string, string>> = {
  "xspec.config.ts": `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    tgt: ["tgt/**/*.mdx"],
    bnd: ["bnd/**/*.mdx"]
  },
  code: {
    app: ["src/**/*.ts"]
  },
  coverage: [
    {
      name: "spec-inferred",
      target: "tgt",
      boundary: "bnd",
      mode: "direct"
    },
    {
      name: "spec-explicit",
      target: "tgt",
      boundary: "bnd",
      boundaryKind: "spec",
      mode: "direct"
    },
    {
      name: "code-inferred",
      target: "tgt",
      boundary: "app",
      mode: "direct"
    },
    {
      name: "code-explicit",
      target: "tgt",
      boundary: "app",
      boundaryKind: "code",
      mode: "direct"
    }
  ]
})
`,
  "tgt/T.mdx": `<S id="a">
Covered by the spec boundary.
</S>

<S id="b">
Covered by the code boundary's marker.
</S>

<S id="c">
Covered by the code boundary's text call.
</S>
`,
  "bnd/B.mdx": `import T from "../tgt/T.xspec"

<S id="uses" d={T.a}>
Spec-boundary dependence on the target.
</S>
`,
  "src/impl.ts": `import T, { text } from "../tgt/T.xspec";

T.b;
text(T.c);
`,
};

const T8_3_SPEC_EXPECTED: ExpectedProfileContent = {
  covered: [
    { identity: "tgt/T.mdx#a", path: ["bnd/B.mdx#uses", "tgt/T.mdx#a"] },
  ],
  uncovered: ["tgt/T.mdx#b", "tgt/T.mdx#c"],
};

const T8_3_CODE_EXPECTED: ExpectedProfileContent = {
  covered: [
    { identity: "tgt/T.mdx#b", path: ["src/impl.ts", "tgt/T.mdx#b"] },
    { identity: "tgt/T.mdx#c", path: ["src/impl.ts", "tgt/T.mdx#c"] },
  ],
  uncovered: ["tgt/T.mdx#a"],
};

const T8_3 = defineProductTest({
  id: "T8-3",
  title:
    "boundaries: a spec-group boundary (spec→spec edges) and a code-group " +
    "boundary (marker references and text(...) embeds edges from code) each " +
    "grant coverage, with boundaryKind both inferred and explicit reporting " +
    "identically (SPEC 8, 7.4, 4.5, 4.3, 4.6)",
  run: async (product) => {
    await withWorkspace(T8_3_FILES, async (workspace) => {
      await buildOk(product, workspace, "T8-3 `build`");
      const label = "T8-3 `coverage --json`";
      const report = await coverageJson(
        product,
        workspace,
        ["coverage", "--json"],
        label,
      );

      for (const name of ["spec-inferred", "spec-explicit"] as const) {
        assertProfileContent(
          profileNamed(report, name, label),
          T8_3_SPEC_EXPECTED,
          `${label} profile ${name}: the spec-group boundary's depends edge ` +
            `covers \`a\` over the path [boundary node, target]; the ` +
            `code-covered targets stay uncovered — inferred and explicit ` +
            `boundaryKind report identically (SPEC 8, 7.4)`,
        );
      }
      for (const name of ["code-inferred", "code-explicit"] as const) {
        assertProfileContent(
          profileNamed(report, name, label),
          T8_3_CODE_EXPECTED,
          `${label} profile ${name}: the code-group boundary grants ` +
            `coverage over the top-level marker's references edge (\`b\`) ` +
            `and the top-level text(...) call's embeds edge (\`c\`), each ` +
            `path starting at the file code location (SPEC 8, 4.5, 4.3, ` +
            `4.6), while the spec-covered target stays uncovered — ` +
            `inferred and explicit boundaryKind report identically (SPEC 7.4)`,
        );
      }
    });
  },
});

// ---------------------------------------------------------------------------
// T8-4 — boundary∩target overlap
// ---------------------------------------------------------------------------

// One file belongs to both the target and the boundary spec group (a file
// MAY belong to multiple groups, SPEC 7.1 — T7.1-1). `alone` and `user` have
// no incoming dependency edge: each is itself a boundary node, yet MUST be
// uncovered in both modes — coverage needs a path of one or more edges from
// a boundary node to the target (SPEC 8), and boundary membership alone is
// no such path. `used` has a single incoming depends edge from its sibling
// `user` (itself a boundary node) and is covered in both modes.
const T8_4_FILES: Readonly<Record<string, string>> = {
  "xspec.config.ts": `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    tgtgrp: ["shared/**/*.mdx"],
    bndgrp: ["shared/**/*.mdx"]
  },
  coverage: [
    {
      name: "p-direct",
      target: "tgtgrp",
      boundary: "bndgrp",
      mode: "direct"
    },
    {
      name: "p-transitive",
      target: "tgtgrp",
      boundary: "bndgrp",
      mode: "transitive"
    }
  ]
})
`,
  "shared/S.mdx": `<S id="alone">
No incoming dependency edge.
</S>

<S id="used">
Depended on by a sibling boundary node.
</S>

<S id="user" d={"used"}>
Depends on the sibling.
</S>
`,
};

const T8_4_EXPECTED: ExpectedProfileContent = {
  covered: [
    {
      identity: "shared/S.mdx#used",
      path: ["shared/S.mdx#user", "shared/S.mdx#used"],
    },
  ],
  uncovered: ["shared/S.mdx#alone", "shared/S.mdx#user"],
};

const T8_4 = defineProductTest({
  id: "T8-4",
  title:
    "boundary∩target overlap: in a file belonging to both the target and " +
    "the boundary spec group, a required node with no incoming dependency " +
    "edge is itself a boundary node yet uncovered in direct and transitive " +
    "mode — boundary membership alone is no covering path — while a sibling " +
    "with one incoming depends edge from another node of the file is " +
    "covered in both (SPEC 8, 7.1)",
  run: async (product) => {
    await withWorkspace(T8_4_FILES, async (workspace) => {
      await buildOk(product, workspace, "T8-4 `build`");
      const label = "T8-4 `coverage --json`";
      const report = await coverageJson(
        product,
        workspace,
        ["coverage", "--json"],
        label,
      );
      for (const name of ["p-direct", "p-transitive"] as const) {
        assertProfileContent(
          profileNamed(report, name, label),
          T8_4_EXPECTED,
          `${label} profile ${name}: \`used\` is covered over its sibling's ` +
            `edge; \`alone\` and \`user\` — boundary nodes themselves, with ` +
            `no incoming dependency edge — are uncovered: coverage needs a ` +
            `path of one or more edges from a boundary node to the target, ` +
            `and boundary membership alone is no such path (SPEC 8)`,
        );
      }
    });
  },
});

// ---------------------------------------------------------------------------
// T8-5 — root path exclusion (and the coverage-scoped-exclusion arms)
// ---------------------------------------------------------------------------

// Spec groups `base` (file A) and `derived` (file B), per the TEST-SPEC
// staging:
//
//   specs/A.mdx  (base):    top-level {text(B.b1)} outside any section — a
//                           root-sourced embeds edge A-root → b1 (SPEC 2.3,
//                           1.2) — and a section a1 with d={B} — a
//                           root-targeted depends edge a1 → B-root (SPEC 2.2).
//   specs/B.mdx  (derived): sections b1, b2 and a top-level {text("b2")} —
//                           a root-sourced embeds edge B-root → b2.
//
// Profiles target `derived` with boundary `base`, one direct and one
// transitive. b1 is uncovered in both modes — a spec-group boundary
// contributes only its non-root nodes as boundary nodes, and a root-sourced
// edge never extends a covering path; b2 is uncovered in transitive mode
// although a1 → B-root → b2 is a chain of dependency edges — a root is never
// an intermediate, and neither the root-targeted nor the root-sourced edge
// extends a covering path (SPEC 8).
const B_ROOT = "specs/B.mdx";
const A_ROOT = "specs/A.mdx";
const A_ONE = "specs/A.mdx#a1";
const B_ONE = "specs/B.mdx#b1";
const B_TWO = "specs/B.mdx#b2";

function derivedSource(leafOneText: string): string {
  return `<S id="b1">
${leafOneText}
</S>

<S id="b2">
Derived leaf two.
</S>

{text("b2")}
`;
}

const ROOT_EXCLUSION_FILES: Readonly<Record<string, string>> = {
  "xspec.config.ts": `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    base: ["specs/A.mdx"],
    derived: ["specs/B.mdx"]
  },
  coverage: [
    {
      name: "p-direct",
      target: "derived",
      boundary: "base",
      mode: "direct"
    },
    {
      name: "p-transitive",
      target: "derived",
      boundary: "base",
      mode: "transitive"
    }
  ],
  policy: [
    {
      name: "no-base-to-derived",
      type: "forbidden",
      from: { group: "base" },
      to: { group: "derived" }
    }
  ]
})
`,
  "specs/A.mdx": `import B from "./B.xspec"

{text(B.b1)}

<S id="a1" d={B}>
Depends on the derived file as a whole.
</S>
`,
  "specs/B.mdx": derivedSource("Derived leaf one."),
};

/** Render policy findings for order-insensitive exact comparison (7.5). */
function renderPolicyFindings(findings: readonly Finding[]): string[] {
  return findings
    .map(
      (finding) =>
        `${finding.rule ?? "<no rule>"} :: ` +
        (finding.edge === undefined
          ? "<no edge>"
          : `${finding.edge.kind}: ${finding.edge.from} -> ${finding.edge.to}`),
    )
    .sort();
}

/**
 * Assert the root-exclusion fixture's impact report after the b1 text edit
 * (module header: SUITE-20 conventions). Expected per SPEC 5.6's worked
 * single-leaf-edit example: b1 `changed`; B-root `descendant-changed`
 * through containment; A-root `upstream-changed` through the root-sourced
 * dependency pair (b1 is no child of A-root, so containment cannot explain
 * it); a1 `upstream-changed` through the root-targeted pair (B-root's
 * effectiveHash changed through containment) — the propagated categories all
 * attributed to the edited leaf b1; b2 uncategorized.
 */
function assertRootExclusionImpact(
  report: ImpactReport,
  context: string,
): void {
  assertSameJson(
    report.code,
    { direct: [], transitive: [] },
    `${context}: no code groups are configured, so no code location is impacted`,
  );

  // Merge categories and attributions per node identity across entries.
  const merged = new Map<string, Map<ChangeCategory, string[]>>();
  for (const entry of report.requirements) {
    if (entry.deleted) {
      fail(
        `${context}: no node was deleted — every node is present on both ` +
          `sides (SPEC 5.6) — but an entry flags ${JSON.stringify(entry.nodes)} deleted`,
      );
    }
    for (const identity of entry.nodes) {
      let categories = merged.get(identity);
      if (categories === undefined) {
        categories = new Map();
        merged.set(identity, categories);
      }
      for (const category of entry.categories) {
        const attributed = categories.get(category.category) ?? [];
        attributed.push(...category.attributedTo);
        categories.set(category.category, attributed);
      }
    }
  }

  // The complete expectation table: every named identity must be in it (a
  // category for any other node — b2 included — is a phantom).
  const expectations: readonly {
    readonly identity: string;
    readonly category: ChangeCategory;
    /** Exact merged attribution; undefined = originating category, bounded
     * within the originating set {b1} (empty accepted, module header). */
    readonly exact?: readonly string[];
  }[] = [
    { identity: B_ONE, category: "changed" },
    { identity: B_ROOT, category: "descendant-changed", exact: [B_ONE] },
    { identity: A_ROOT, category: "upstream-changed", exact: [B_ONE] },
    { identity: A_ONE, category: "upstream-changed", exact: [B_ONE] },
  ];
  const expectedBy = new Map(
    expectations.map((expectation) => [expectation.identity, expectation]),
  );
  for (const identity of merged.keys()) {
    if (!expectedBy.has(identity)) {
      fail(
        `${context}: the report names ${JSON.stringify(identity)}, which must ` +
          `receive no category — editing b1's text categorizes exactly b1, ` +
          `B-root, A-root, and a1 (SPEC 5.5, 5.6) — and so appear in no ` +
          `requirement entry (SPEC 9.3 groups output by category)`,
      );
    }
  }
  for (const expectation of expectations) {
    const categories = merged.get(expectation.identity);
    if (categories === undefined) {
      fail(
        `${context}: ${expectation.identity} must be reported ` +
          `\`${expectation.category}\` (SPEC 5.5, 5.6), but no requirement ` +
          `entry names it`,
      );
    }
    assertSameJson(
      [...categories.keys()].sort(),
      [expectation.category],
      `${context}: ${expectation.identity} carries exactly the category ` +
        `\`${expectation.category}\` (SPEC 5.5, 5.6)`,
    );
    const attributed = [...(categories.get(expectation.category) ?? [])].sort();
    if (expectation.exact !== undefined) {
      assertSameJson(
        attributed,
        expectation.exact,
        `${context}: ${expectation.identity}'s \`${expectation.category}\` is ` +
          `attributed to the edited leaf (SPEC 5.6's worked single-leaf-edit ` +
          `example: all attributed to the leaf)`,
      );
    } else {
      for (const attribution of attributed) {
        if (attribution !== B_ONE) {
          fail(
            `${context}: ${expectation.identity}'s \`${expectation.category}\` ` +
              `attribution must lie within the originating set ` +
              `${JSON.stringify([B_ONE])} (SPEC 5.6: every category is ` +
              `attributed to its originating nodes); got ${JSON.stringify(attributed)}`,
          );
        }
      }
    }
  }
}

// The second T8-5 workspace: required-set composition (SPEC 8.1) — one
// workspace asserting group restriction, `targetTags` restriction, "leaves"
// vs "all", `coverage="none"` exclusion, and root exclusion. The boundary
// group has no outgoing dependency edges, so nothing is covered and each
// profile's uncovered set IS its required set (required = covered ∪
// uncovered).
const REQUIRED_SET_FILES: Readonly<Record<string, string>> = {
  "xspec.config.ts": `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    tgt: ["tgt/**/*.mdx"],
    bnd: ["bnd/**/*.mdx"],
    oth: ["oth/**/*.mdx"]
  },
  coverage: [
    {
      name: "req-leaves",
      target: "tgt",
      boundary: "bnd",
      mode: "direct"
    },
    {
      name: "req-all",
      target: "tgt",
      boundary: "bnd",
      targets: "all",
      mode: "direct"
    },
    {
      name: "req-tagged",
      target: "tgt",
      boundary: "bnd",
      targetTags: ["hot"],
      mode: "direct"
    }
  ]
})
`,
  "tgt/T.mdx": `<S id="t">
Internal parent behavior.

<S id="t.leaf" tags="hot">
Tagged leaf behavior.
</S>

<S id="t.none" coverage="none">
Coverage-excluded leaf behavior.
</S>

<S id="t.plain">
Untagged leaf behavior.
</S>
</S>
`,
  "bnd/B.mdx": `<S id="b">
Boundary node with no outgoing dependency edges.
</S>
`,
  "oth/O.mdx": `<S id="o">
A node of a group that is neither target nor boundary.
</S>
`,
};

const T8_5 = defineProductTest({
  id: "T8-5",
  title:
    "root path exclusion: a spec-group boundary contributes only its " +
    "non-root nodes, and root-sourced/root-targeted dependency edges never " +
    "extend a covering path — a root is never boundary node, intermediate, " +
    "or target — while the same edges remain ordinary for policy, impact " +
    "(upstream-changed through the root pairs), and query edges; plus one " +
    "workspace asserting the 8.1 required set: group restriction, " +
    'targetTags, leaves vs all, coverage="none", and root exclusion ' +
    "(SPEC 8, 8.1, 7.5, 5.5, 5.6, 11, 2.2, 2.3)",
  run: async (product) => {
    // (a) The root-exclusion workspace, with its coverage-scoped-exclusion
    // arms (policy, impact, query) over the same edges.
    await withWorkspace(ROOT_EXCLUSION_FILES, async (workspace) => {
      await workspace.gitInit();
      const base = await workspace.gitCommitAll("baseline");
      await buildOk(
        product,
        workspace,
        "T8-5 `build` (root-exclusion fixture)",
      );

      // Coverage: both derived leaves uncovered in both modes.
      const coverageLabel = "T8-5 `coverage --json`";
      const coverage = await coverageJson(
        product,
        workspace,
        ["coverage", "--json"],
        coverageLabel,
      );
      assertProfileContent(
        profileNamed(coverage, "p-direct", coverageLabel),
        { covered: [], uncovered: [B_ONE, B_TWO] },
        `${coverageLabel} profile p-direct: b1 is uncovered — the boundary ` +
          `group contributes only its non-root nodes as boundary nodes, and ` +
          `the root-sourced A-root → b1 edge never extends a covering path ` +
          `— and b2 has no single covering edge (SPEC 8)`,
      );
      assertProfileContent(
        profileNamed(coverage, "p-transitive", coverageLabel),
        { covered: [], uncovered: [B_ONE, B_TWO] },
        `${coverageLabel} profile p-transitive: b1 stays uncovered, and b2 ` +
          `is uncovered although a1 → B-root → b2 is a chain of dependency ` +
          `edges — a root is never an intermediate, and neither the ` +
          `root-targeted nor the root-sourced edge extends a covering path ` +
          `(SPEC 8)`,
      );

      // Policy: the same edges remain ordinary dependency edges — the
      // forbidden rule reports both the root-sourced and the root-targeted
      // edge (SPEC 8: the exclusion is coverage-scoped; 7.5).
      const checkLabel = "T8-5 `check --json`";
      const checkResult = await expectExit(
        product,
        workspace,
        ["check", "--json"],
        1,
        `${checkLabel} — the two staged base→derived edges violate the ` +
          `forbidden rule, a finding outcome (SPEC 7.5, 12.0)`,
      );
      const findings = decodeFindingsReport(
        parseJsonStdout(checkResult, checkLabel),
        checkLabel,
      ).findings;
      assertConditionCounts(findings, { "14.12": 2 }, checkLabel);
      assertSameJson(
        renderPolicyFindings(findings),
        [
          `no-base-to-derived :: depends: ${A_ONE} -> ${B_ROOT}`,
          `no-base-to-derived :: embeds: ${A_ROOT} -> ${B_ONE}`,
        ],
        `${checkLabel}: the forbidden rule from base to derived reports ` +
          `both the root-sourced A-root → b1 edge and the root-targeted ` +
          `a1 → B-root edge — roots remain nodes of their groups and the ` +
          `edges remain ordinary dependency edges for policy (SPEC 8, 7.5)`,
      );

      // Query: `query edges` reports both edges (SPEC 11; with T2.2-2's
      // bare-module root targeting). Exact per-kind sets, so a product
      // dropping either root-adjacent edge fails.
      const embedsLabel = "T8-5 `query edges --kinds embeds --json`";
      assertEdgeSetEqual(
        decodeEdgesReport(
          await runJson(
            product,
            workspace,
            ["query", "edges", "--kinds", "embeds", "--json"],
            embedsLabel,
          ),
          embedsLabel,
        ),
        [
          { from: A_ROOT, to: B_ONE, kind: "embeds" },
          { from: B_ROOT, to: B_TWO, kind: "embeds" },
        ],
        `${embedsLabel}: the complete embeds edge set carries the ` +
          `root-sourced A-root → b1 edge (and B-root → b2) — the coverage ` +
          `exclusion does not remove them from the graph (SPEC 8, 2.3, 11)`,
      );
      const dependsLabel = "T8-5 `query edges --kinds depends --json`";
      assertEdgeSetEqual(
        decodeEdgesReport(
          await runJson(
            product,
            workspace,
            ["query", "edges", "--kinds", "depends", "--json"],
            dependsLabel,
          ),
          dependsLabel,
        ),
        [{ from: A_ONE, to: B_ROOT, kind: "depends" }],
        `${dependsLabel}: the complete depends edge set is the ` +
          `root-targeted a1 → B-root edge (SPEC 8, 2.2, 11)`,
      );

      // Impact: editing b1's text changes A-root's effectiveHash through
      // the root-sourced dependency pair — b1 is no child of A-root, so
      // containment cannot explain it — and B-root's through containment,
      // hence a1's through the root-targeted pair: A-root and a1 are both
      // upstream-changed (SPEC 5.5, 5.6).
      await workspace.file(
        "specs/B.mdx",
        derivedSource("Derived leaf one, edited."),
      );
      await buildOk(
        product,
        workspace,
        "T8-5 `build` over the b1-edited workspace",
      );
      const impactLabel =
        "T8-5 `impact --base <baseline> --json` after the b1 edit";
      const impactResult = await expectExit(
        product,
        workspace,
        ["impact", "--base", base, "--json"],
        0,
        `${impactLabel} — impact is informational (SPEC 9.3, 12.0)`,
      );
      assertRootExclusionImpact(
        decodeImpactReport(
          parseJsonStdout(impactResult, impactLabel),
          impactLabel,
        ),
        impactLabel,
      );
    });

    // (b) One workspace asserting the 8.1 required-set composition through
    // covered ∪ uncovered: group restriction (no node of bnd or oth ever
    // appears), targetTags restriction, "leaves" vs "all", coverage="none"
    // exclusion, and root exclusion (the root is excluded even under
    // targets: "all").
    await withWorkspace(REQUIRED_SET_FILES, async (workspace) => {
      await buildOk(product, workspace, "T8-5 `build` (required-set fixture)");
      const label = "T8-5 `coverage --json` (required-set fixture)";
      const report = await coverageJson(
        product,
        workspace,
        ["coverage", "--json"],
        label,
      );
      assertProfileContent(
        profileNamed(report, "req-leaves", label),
        {
          covered: [],
          uncovered: ["tgt/T.mdx#t.leaf", "tgt/T.mdx#t.plain"],
        },
        `${label} profile req-leaves: the required set is exactly the ` +
          `target group's leaves minus the coverage="none" node — the ` +
          `internal node, the root, and every node of bnd and oth are ` +
          `excluded (SPEC 8.1)`,
      );
      assertProfileContent(
        profileNamed(report, "req-all", label),
        {
          covered: [],
          uncovered: ["tgt/T.mdx#t", "tgt/T.mdx#t.leaf", "tgt/T.mdx#t.plain"],
        },
        `${label} profile req-all: targets "all" adds the internal node to ` +
          `the required set while the root and the coverage="none" node ` +
          `stay excluded — roots are always excluded (SPEC 8.1, 7.4)`,
      );
      assertProfileContent(
        profileNamed(report, "req-tagged", label),
        { covered: [], uncovered: ["tgt/T.mdx#t.leaf"] },
        `${label} profile req-tagged: targetTags ["hot"] restricts the ` +
          `required set to nodes carrying at least one listed tag — the ` +
          `untagged leaf drops out (SPEC 8.1, 7.4)`,
      );
    });
  },
});

// ---------------------------------------------------------------------------
// T8.2-1 — report contract
// ---------------------------------------------------------------------------

// One workspace, two profiles:
//
//   prof-main  transitive, targetTags ["hot"], targets: "leaves" (explicit)
//   prof-aux   direct, no targetTags, targets "leaves" (the default)
//
// tgt/T.mdx stages the two TEST-SPEC ignored nodes: `combo` is
// simultaneously coverage="none", non-leaf (child combo.kid), and untagged —
// reasons coverage="none", non-leaf, lacking-tags in the fixed order — and
// the file root has children in a profile with targets: "leaves" and
// targetTags — reasons root node, non-leaf, lacking-tags, pinning the root
// reason's first position (roots carry no tags and no coverage attribute,
// SPEC 5.5). prof-aux (no targetTags) re-pins the order with the tag reason
// inapplicable. bnd/B.mdx stages the 12.0 tie-break: `first` and `second`
// each hold a depends edge to `win` (two equal-length covering paths; the
// byte-least sequence runs through #first) and `chain` → `first` adds a
// longer route prof-main's shortest-path selection must reject.
const REPORT_FILES: Readonly<Record<string, string>> = {
  "xspec.config.ts": `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    tgt: ["tgt/**/*.mdx"],
    bnd: ["bnd/**/*.mdx"]
  },
  coverage: [
    {
      name: "prof-main",
      target: "tgt",
      boundary: "bnd",
      targetTags: ["hot"],
      targets: "leaves",
      mode: "transitive"
    },
    {
      name: "prof-aux",
      target: "tgt",
      boundary: "bnd",
      mode: "direct"
    }
  ]
})
`,
  "tgt/T.mdx": `<S id="win" tags="hot">
Covered winner leaf.
</S>

<S id="lone" tags="hot">
Uncovered tagged leaf.
</S>

<S id="combo" coverage="none">
Simultaneously coverage-excluded, a parent, and untagged.

<S id="combo.kid" tags="hot">
Tagged child leaf.
</S>
</S>

<S id="plain">
Untagged leaf.
</S>
`,
  "bnd/B.mdx": `import T from "../tgt/T.xspec"

<S id="chain" d={"first"}>
A longer route to the winner, through first.
</S>

<S id="first" d={T.win}>
First equal-length covering edge.
</S>

<S id="second" d={T.win}>
Second equal-length covering edge.
</S>
`,
};

const WIN_ROW: ExpectedCoveredRow = {
  identity: "tgt/T.mdx#win",
  // Three candidate covering paths exist in prof-main: [#first, win] and
  // [#second, win] of equal length, and the longer [#chain, #first, win].
  // One shortest path is reported, ties by element-wise byte comparison of
  // the node-identity sequences (SPEC 8.2, 12.0): #first < #second.
  path: ["bnd/B.mdx#first", "tgt/T.mdx#win"],
};

const PROF_MAIN_EXPECTED: ExpectedProfileContent = {
  counts: { required: 3, covered: 1, uncovered: 2, ignored: 3 },
  covered: [WIN_ROW],
  uncovered: ["tgt/T.mdx#combo.kid", "tgt/T.mdx#lone"],
  ignored: [
    { identity: "tgt/T.mdx", reasons: ["root", "non-leaf", "lacking-tags"] },
    {
      identity: "tgt/T.mdx#combo",
      reasons: ["coverage-none", "non-leaf", "lacking-tags"],
    },
    { identity: "tgt/T.mdx#plain", reasons: ["lacking-tags"] },
  ],
};

const PROF_AUX_EXPECTED: ExpectedProfileContent = {
  counts: { required: 4, covered: 1, uncovered: 3, ignored: 2 },
  covered: [WIN_ROW],
  uncovered: ["tgt/T.mdx#combo.kid", "tgt/T.mdx#lone", "tgt/T.mdx#plain"],
  ignored: [
    { identity: "tgt/T.mdx", reasons: ["root", "non-leaf"] },
    { identity: "tgt/T.mdx#combo", reasons: ["coverage-none", "non-leaf"] },
  ],
};

// The distinctive information the human report must mention (module header:
// identities, profile names, the covering path's boundary member, and the
// count digits — the fixture's identities and names are digit-free).
const REPORT_HUMAN_MENTIONS: readonly (string | RegExp)[] = [
  "prof-main",
  "prof-aux",
  "tgt/T.mdx#win",
  "bnd/B.mdx#first",
  "tgt/T.mdx#lone",
  "tgt/T.mdx#combo.kid",
  "tgt/T.mdx#combo",
  "tgt/T.mdx#plain",
  /\b1\b/,
  /\b2\b/,
  /\b3\b/,
  /\b4\b/,
];

/** Order-normalize a decoded profile for product-to-itself comparison. */
function normalizedProfile(profile: CoverageProfileReport): unknown {
  return {
    name: profile.name,
    counts: profile.counts,
    covered: sortedCoveredRows(profile),
    uncovered: [...profile.uncovered].sort(),
    ignored: profile.ignored
      .map((row) => ({ identity: row.identity, reasons: [...row.reasons] }))
      .sort((a, b) => (a.identity < b.identity ? -1 : 1)),
  };
}

function normalizedReport(report: CoverageReport): unknown {
  return report.profiles
    .map(normalizedProfile)
    .sort((a, b) =>
      (a as { name: string }).name < (b as { name: string }).name ? -1 : 1,
    );
}

// The fully covered workspace for `--check`'s "0 otherwise" arm: one
// profile, one required leaf, covered.
const CHECK_GREEN_FILES: Readonly<Record<string, string>> = {
  "xspec.config.ts": `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    tgt: ["tgt/**/*.mdx"],
    bnd: ["bnd/**/*.mdx"]
  },
  coverage: [
    {
      name: "p-green",
      target: "tgt",
      boundary: "bnd",
      mode: "direct"
    }
  ]
})
`,
  "tgt/T.mdx": `<S id="only">
The only required leaf.
</S>
`,
  "bnd/B.mdx": `import T from "../tgt/T.xspec"

<S id="covers" d={T.only}>
Covers the only leaf.
</S>
`,
};

const T8_2_1 = defineProductTest({
  id: "T8.2-1",
  title:
    "report contract: all profiles run by default and `coverage <name>` " +
    "runs one; counts of required/covered/uncovered/ignored; the identity " +
    "of every covered, uncovered, and ignored node; one shortest covering " +
    "path per covered node with the 12.0 byte-least tie-break; ignored " +
    "nodes report all applicable reasons in the fixed order (root node " +
    "first); --check exits 1 iff any required node is uncovered; --json " +
    "carries the same information (SPEC 8.1, 8.2, 12.0)",
  run: async (product) => {
    await withWorkspace(REPORT_FILES, async (workspace) => {
      await buildOk(product, workspace, "T8.2-1 `build`");

      // All profiles run by default; full per-profile content: counts,
      // covered rows with the tie-broken shortest path, uncovered and
      // ignored identities, and each ignored node's reasons in the fixed
      // order.
      const fullLabel = "T8.2-1 `coverage --json`";
      const full = await coverageJson(
        product,
        workspace,
        ["coverage", "--json"],
        fullLabel,
      );
      assertSameJson(
        full.profiles.map((profile) => profile.name).sort(),
        ["prof-aux", "prof-main"],
        `${fullLabel}: all configured profiles run by default (SPEC 8.2)`,
      );
      assertProfileContent(
        profileNamed(full, "prof-main", fullLabel),
        PROF_MAIN_EXPECTED,
        `${fullLabel} profile prof-main — the equal-length paths through ` +
          `#first and #second tie-break to the byte-least sequence, the ` +
          `longer #chain route loses to the shortest, the root reports ` +
          `reasons [root node, non-leaf, lacking every tag] pinning the ` +
          `root reason's first position, and combo reports ` +
          `[coverage="none", non-leaf, lacking every tag] (SPEC 8.2, 12.0)`,
      );
      assertProfileContent(
        profileNamed(full, "prof-aux", fullLabel),
        PROF_AUX_EXPECTED,
        `${fullLabel} profile prof-aux — without targetTags the tag reason ` +
          `applies to no ignored node, and the untagged leaf joins the ` +
          `required set (SPEC 8.1, 8.2)`,
      );

      // `coverage <name>` runs exactly the named profile, carrying the same
      // information as the default run's profile (adapter-asserted
      // equality, product-to-itself).
      const oneLabel = "T8.2-1 `coverage prof-aux --json`";
      const one = await coverageJson(
        product,
        workspace,
        ["coverage", "prof-aux", "--json"],
        oneLabel,
      );
      assertSameJson(
        one.profiles.map((profile) => profile.name),
        ["prof-aux"],
        `${oneLabel}: \`coverage <name>\` runs exactly the named profile (SPEC 8.2)`,
      );
      assertSameJson(
        normalizedProfile(profileNamed(one, "prof-aux", oneLabel)),
        normalizedProfile(profileNamed(full, "prof-aux", fullLabel)),
        `${oneLabel}: the named run reports the same information for the ` +
          `profile as the all-profiles run (SPEC 8.2)`,
      );

      // --check exits 1 iff any required node is uncovered — here some are,
      // with and without --json; the JSON document still carries the same
      // information as the checkless run (SPEC 12.0: exit 1 is a findings
      // outcome, the report is the stdout).
      const checkJsonLabel = "T8.2-1 `coverage --check --json`";
      const checkResult = await expectExit(
        product,
        workspace,
        ["coverage", "--check", "--json"],
        1,
        `${checkJsonLabel} — required nodes are uncovered, so --check exits ` +
          `1 (SPEC 8.2, 12.0)`,
      );
      assertSameJson(
        normalizedReport(
          decodeCoverageReport(
            parseJsonStdout(checkResult, checkJsonLabel),
            checkJsonLabel,
          ),
        ),
        normalizedReport(full),
        `${checkJsonLabel}: --check changes the exit code, not the ` +
          `information — the JSON document carries the same report (SPEC 8.2)`,
      );
      await expectExit(
        product,
        workspace,
        ["coverage", "--check"],
        1,
        "T8.2-1 `coverage --check` (human) — exits 1 with uncovered " +
          "required nodes (SPEC 8.2)",
      );

      // The human report carries the same information as the JSON document
      // (module header: robust matching of the distinctive information,
      // never wording — H-3).
      const humanLabel = "T8.2-1 `coverage` (human report)";
      const human = await expectExit(
        product,
        workspace,
        ["coverage"],
        0,
        `${humanLabel} — without --check, coverage is informational even ` +
          `with uncovered required nodes (SPEC 12.0)`,
      );
      assertReportMentions(
        human,
        REPORT_HUMAN_MENTIONS,
        `${humanLabel}: profile names, covered/uncovered/ignored ` +
          `identities, the covering path's boundary member, and the count ` +
          `digits — the same information as the JSON form (SPEC 8.2, 12.0)`,
      );
    });

    // The "0 otherwise" arm: a workspace whose every required node is
    // covered — --check exits 0, and the report is non-vacuous (a required
    // node exists and is covered).
    await withWorkspace(CHECK_GREEN_FILES, async (workspace) => {
      await buildOk(product, workspace, "T8.2-1 `build` (covered fixture)");
      const greenLabel = "T8.2-1 `coverage --check --json` (covered fixture)";
      const green = decodeCoverageReport(
        await runJson(
          product,
          workspace,
          ["coverage", "--check", "--json"],
          greenLabel,
        ),
        greenLabel,
      );
      assertProfileContent(
        profileNamed(green, "p-green", greenLabel),
        {
          covered: [
            {
              identity: "tgt/T.mdx#only",
              path: ["bnd/B.mdx#covers", "tgt/T.mdx#only"],
            },
          ],
          uncovered: [],
        },
        `${greenLabel}: the one required node is covered, so the exit-0 ` +
          `outcome is not vacuous (SPEC 8.2)`,
      );
      await expectExit(
        product,
        workspace,
        ["coverage", "--check"],
        0,
        "T8.2-1 `coverage --check` (human, covered fixture) — exits 0 when " +
          "no required node is uncovered (SPEC 8.2)",
      );
    });
  },
});

/** TEST-SPEC §8 T8-1…T8-5, T8.2-1, in canonical ID order (SUITE-30). */
export const section8Tests: readonly ProductTestEntry[] = [
  T8_1,
  T8_2,
  T8_3,
  T8_4,
  T8_5,
  T8_2_1,
];
