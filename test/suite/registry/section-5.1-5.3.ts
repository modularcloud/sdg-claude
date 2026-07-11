// TEST-SPEC §5.1–5.2 (node and edge kinds) and §5.3 (cycles) — SUITE-17:
// T5.2-1, T5.3-1, T5.3-2.
//
// Registered product-facing bodies (C-2 "one code path"): each builds its own
// fresh workspace (H-1), drives the product strictly as a subprocess (H-2),
// asserts exact exit codes (H-5), decodes output through the H-3 adapters,
// and rejects a product only via diagnosed assertion failures (H-8).
//
// SPEC 5.2: the four edge kinds are `contains` (parent section → child
// section, the implicit root included, SPEC 1.2), `depends` (the `d` prop),
// `embeds` (`{text(...)}` in MDX and `text(...)` in TypeScript), and
// `references` (a bare TypeScript marker, 4.5); edges of each kind form a
// set — duplicate declarations collapse to a single edge. SPEC 5.3:
// dependency-edge cycles in the combined contains/depends/embeds graph over
// requirement nodes are invalid; `check` MUST detect and report them with the
// full cycle path; a self-`depends`/self-`embeds` is a cycle of length one;
// 14.9 is reported by `build` and `check` alike (SPEC 14).
//
// Conservative operationalizations (noted per H-4):
// - Cycle-path acceptance: SPEC 5.3 fixes the information — the full cycle —
//   not its rendering, so a reported path is accepted in any rotation (any
//   starting node) and in open or closed-walk form (first identity repeated
//   at the end). Direction is never relaxed: the path follows the cycle's
//   edges, so a reversed or partial sequence is rejected — in particular the
//   ancestor arms' three-node cycles must include the intermediate section
//   the `contains` chain runs through.
// - The cross-file `depends` arm of T5.3-1 necessarily co-stages a spec
//   import cycle: a cross-file `depends` edge needs an external reference
//   (the local string form is same-file only, SPEC 2.2), external references
//   need imports (2.1), and A→B→A therefore needs mutual imports — itself an
//   invalid import cycle (2.1, 14.9). The assertion accounts for it per the
//   T2.1-5 convention (section-2.1.ts): reported once, or at most once per
//   participating file, identifying every participating file.
// - Exact finding accounting: every cycle fixture parses, resolves every
//   reference, and is checked without ever having been built — no derived
//   file and no recorded graph data exists, and invalid sources generate
//   nothing a derived file could be compared against (12.1: a failing build
//   modifies nothing) — so the staged cycles are the only error conditions
//   present and every reported finding must be 14.9 (SPEC 14: each present
//   error reported, nothing else).

import type { Finding, GraphEdge } from "../../helpers/adapters/index.js";
import {
  decodeEdgesReport,
  decodeFindingsReport,
} from "../../helpers/adapters/index.js";
import { fail, parseJsonStdout } from "../../helpers/assertions.js";
import { defineProductTest } from "../../helpers/registry.js";
import type { ProductTestEntry } from "../../helpers/registry.js";
import type { ProductBinding } from "../../helpers/subprocess.js";
import { TestWorkspace } from "../../helpers/workspace.js";
import {
  assertEdgeSetEqual,
  buildFindings,
  buildOk,
  expectExit,
  runJson,
} from "./support.js";

// Minimal declarative configuration (SPEC 7): exactly one spec group.
const SPECS_ONLY_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  }
})
`;

// One spec group plus one code group (SPEC 7.2): TypeScript files under
// `src/` are discovered code sources, so `build` analyzes their spec-module
// usage (4.3, 4.5) — the TS half of T5.2-1's edge kinds.
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

/**
 * `check --json` over a workspace staged to produce findings: exit 1 (H-5;
 * SPEC 12.0) with exactly one JSON document, decoded as the findings report.
 */
async function checkFindings(
  product: ProductBinding,
  workspace: TestWorkspace,
  context: string,
): Promise<readonly Finding[]> {
  const result = await expectExit(
    product,
    workspace,
    ["check", "--json"],
    1,
    context,
  );
  return decodeFindingsReport(parseJsonStdout(result, context), context)
    .findings;
}

/**
 * A reported cycle path reduced to its open cyclic form: a closed walk (the
 * first identity repeated at the end) reduces to its open rotation, so
 * `[a, b, a]` and `[a, b]` name the same cycle (SPEC 5.3 fixes the
 * information, not the rendering).
 */
function openCycleForm(path: readonly string[]): readonly string[] {
  if (path.length > 1 && path[0] === path[path.length - 1]) {
    return path.slice(0, -1);
  }
  return path;
}

/**
 * Whether a reported cycle path names exactly the staged cycle: the same
 * identities in the same cyclic edge order, from any starting node
 * (rotation-invariant), open or closed form. Direction is never relaxed —
 * the path follows the cycle's edges — and no node may be missing or extra.
 */
function matchesCycle(
  reported: readonly string[],
  staged: readonly string[],
): boolean {
  const open = openCycleForm(reported);
  const n = staged.length;
  if (open.length !== n) return false;
  for (let shift = 0; shift < n; shift += 1) {
    let matched = true;
    for (let i = 0; i < n; i += 1) {
      if (open[(shift + i) % n] !== staged[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/** The file path of a requirement-node identity (SPEC 1.5: `path#id`). */
function fileOfIdentity(identity: string): string {
  const hash = identity.indexOf("#");
  return hash === -1 ? identity : identity.slice(0, hash);
}

/** What one cycle fixture stages — and everything its report may contain. */
interface CycleExpectation {
  /** The dependency cycle in edge order, one identity per node (open form). */
  readonly cycle: readonly string[];
  /**
   * Participating files of the spec import cycle the fixture necessarily
   * co-stages (the cross-file arm only; see the module header).
   */
  readonly importCycleFiles?: readonly string[];
}

/**
 * Assert a findings report over a fixture staging exactly one dependency
 * cycle (plus, when stated, the import cycle its cross-file staging
 * necessarily carries): every finding is 14.9, the dependency cycle is
 * reported with its full cycle path — once, or at most once per
 * participating file — and the co-staged import cycle accounts for every
 * remaining finding (SPEC 5.3, 14, 14.9).
 */
function assertDependencyCycleFindings(
  findings: readonly Finding[],
  expectation: CycleExpectation,
  context: string,
): void {
  const conditions = findings.map((finding) => finding.condition);
  if (
    findings.length === 0 ||
    conditions.some((condition) => condition !== "14.9")
  ) {
    fail(
      `${context}: the staged cycles are the fixture's only error conditions, so ` +
        `every finding must be 14.9 (SPEC 5.3, 14, 14.9); got conditions ` +
        `${JSON.stringify(conditions)} (findings: ${JSON.stringify(findings)})`,
    );
  }

  // The dependency-cycle report: the finding(s) carrying the staged cycle's
  // full path. SPEC 5.3 mandates the full path, so a finding without one (or
  // with a rotated-but-wrong, partial, or reversed one) never counts.
  const cycleFindings = findings.filter(
    (finding) =>
      finding.cycle !== undefined &&
      matchesCycle(finding.cycle, expectation.cycle),
  );
  const cycleFileCount = new Set(expectation.cycle.map(fileOfIdentity)).size;
  if (cycleFindings.length < 1 || cycleFindings.length > cycleFileCount) {
    fail(
      `${context}: the dependency cycle must be reported with its full cycle ` +
        `path — ${JSON.stringify(expectation.cycle)}, accepted in any rotation, ` +
        `open or closed form — once, or at most once per participating file ` +
        `(${String(cycleFileCount)}); got ${String(cycleFindings.length)} such ` +
        `finding(s) among ${JSON.stringify(findings)}`,
    );
  }

  const rest = findings.filter((finding) => !cycleFindings.includes(finding));
  const importCycleFiles = expectation.importCycleFiles;
  if (importCycleFiles === undefined) {
    if (rest.length > 0) {
      fail(
        `${context}: the staged dependency cycle is the fixture's only cycle, ` +
          `so nothing beyond its report may appear (SPEC 14: each present error ` +
          `reported, nothing double-reported); got extra findings ` +
          JSON.stringify(rest),
      );
    }
    return;
  }
  // The co-staged spec import cycle: reported once, or at most once per
  // participating file, identifying every participating file through any of
  // a finding's file, message, or cycle-path information (the T2.1-5
  // convention; SPEC 2.1, 14).
  if (rest.length < 1 || rest.length > importCycleFiles.length) {
    fail(
      `${context}: the mutual imports this cross-file cycle needs are ` +
        `themselves a spec import cycle (SPEC 2.1), reported as one further ` +
        `14.9 finding — or at most one per participating file ` +
        `(${String(importCycleFiles.length)}); got ${String(rest.length)} ` +
        `finding(s) beyond the dependency-cycle report: ${JSON.stringify(findings)}`,
    );
  }
  const identified = rest
    .map((finding) =>
      [finding.message, finding.file ?? "", ...(finding.cycle ?? [])].join(
        "\n",
      ),
    )
    .join("\n");
  for (const file of importCycleFiles) {
    if (!identified.includes(file)) {
      fail(
        `${context}: the import-cycle report must identify the participating ` +
          `file ${JSON.stringify(file)} (SPEC 14: actionable errors identify ` +
          `the file); findings beyond the dependency-cycle report: ` +
          JSON.stringify(rest),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// T5.2-1 — all four edge kinds in one workspace, duplicates collapsing
// ---------------------------------------------------------------------------

// The MDX side: document structure gives the `contains` edges (root → alpha,
// root → beta, alpha → alpha.child; SPEC 5.2, 1.2), `beta`'s `d` array gives
// the `depends` edge — the same target referenced twice, so a product
// recording one edge per declaration fails (SPEC 2.2, 5.2) — and two
// identical own-line `{text("alpha.child")}` embeddings give the MDX
// `embeds` edge, likewise duplicated at declaration.
const T5_2_1_SPEC_SOURCE = [
  '<S id="alpha">',
  "Alpha behavior.",
  "",
  '<S id="alpha.child">',
  "Child behavior.",
  "</S>",
  "</S>",
  "",
  '<S id="beta" d={["alpha", "alpha"]}>',
  "Beta behavior.",
  "",
  '{text("alpha.child")}',
  '{text("alpha.child")}',
  "</S>",
  "",
].join("\n");

// The TypeScript side: two identical `text(SPEC.alpha)` calls inside one
// function give the TS `embeds` edge (SPEC 4.3), and two identical bare
// markers inside another give the `references` edge (SPEC 4.5) — each pair
// collapsing to a single edge from its enclosing named unit (SPEC 4.6, 5.2).
// Distinct functions keep the two kinds' sources distinguishable.
const T5_2_1_APP_SOURCE = [
  'import SPEC, { text } from "../specs/MAIN.xspec";',
  "",
  "function useText(): string {",
  "  const first = text(SPEC.alpha);",
  "  const second = text(SPEC.alpha);",
  "  return first + second;",
  "}",
  "",
  "function marker(): void {",
  "  SPEC.beta;",
  "  SPEC.beta;",
  "}",
  "",
].join("\n");

// The workspace's complete edge set: three `contains` from document
// structure, and — duplicates collapsed — one `depends`, one `embeds` per
// mechanism (MDX and TS), one `references`.
const T5_2_1_EXPECTED_EDGES: readonly GraphEdge[] = [
  { from: "specs/MAIN.mdx", to: "specs/MAIN.mdx#alpha", kind: "contains" },
  { from: "specs/MAIN.mdx", to: "specs/MAIN.mdx#beta", kind: "contains" },
  {
    from: "specs/MAIN.mdx#alpha",
    to: "specs/MAIN.mdx#alpha.child",
    kind: "contains",
  },
  {
    from: "specs/MAIN.mdx#beta",
    to: "specs/MAIN.mdx#alpha",
    kind: "depends",
  },
  {
    from: "specs/MAIN.mdx#beta",
    to: "specs/MAIN.mdx#alpha.child",
    kind: "embeds",
  },
  { from: "src/app.ts#useText", to: "specs/MAIN.mdx#alpha", kind: "embeds" },
  { from: "src/app.ts#marker", to: "specs/MAIN.mdx#beta", kind: "references" },
];

const T5_2_1 = defineProductTest({
  id: "T5.2-1",
  title:
    "one workspace exercises all four edge kinds — `contains` from document structure, `depends` from `d`, `embeds` from MDX `{text(...)}` and from TS `text(...)`, `references` from a marker — and unfiltered `query edges` reports exactly them with correct source, target, and kind, duplicate declarations within each dependency kind collapsed to a single edge (SPEC 5.1, 5.2, 11)",
  run: async (product) => {
    await withWorkspace(
      SPEC_AND_CODE_CONFIG,
      { "specs/MAIN.mdx": T5_2_1_SPEC_SOURCE, "src/app.ts": T5_2_1_APP_SOURCE },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T5.2-1 `build` over the four-edge-kind workspace",
        );
        const label = "T5.2-1 unfiltered `query edges`";
        const edges = decodeEdgesReport(
          await runJson(product, workspace, ["query", "edges"], label),
          label,
        );
        // The exact-set comparison pins every recorded edge of every kind —
        // correct source, target, and kind; none missing, none phantom — and
        // simultaneously asserts duplicate collapse for each dependency kind:
        // every staged `depends`, `embeds`, and `references` declaration is
        // duplicated at source, so an uncollapsed product (or a query surface
        // reporting a collapsed edge twice) fails (SPEC 5.2).
        assertEdgeSetEqual(
          edges,
          T5_2_1_EXPECTED_EDGES,
          "T5.2-1 the workspace's complete edge set — all four kinds with " +
            "correct source, target, and kind, duplicates within each " +
            "dependency kind collapsed (SPEC 5.2, 2.2, 2.3, 4.3, 4.5)",
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T5.3-1 — check detects and reports cycles with the full cycle path
// ---------------------------------------------------------------------------

/** One cycle fixture: its files plus the CycleExpectation it stages. */
interface CycleArm extends CycleExpectation {
  readonly name: string;
  readonly files: Readonly<Record<string, string>>;
}

const T5_3_1_ARMS: readonly CycleArm[] = [
  {
    // Both directions need external references, hence mutual imports — the
    // co-staged import cycle (see the module header).
    name:
      "a `depends` cycle A→B→A across files (with its unavoidable mutual-" +
      "import spec import cycle)",
    files: {
      "specs/A.mdx": [
        'import B from "./B.xspec"',
        "",
        '<S id="a" d={B.b}>',
        "A behavior.",
        "</S>",
        "",
      ].join("\n"),
      "specs/B.mdx": [
        'import A from "./A.xspec"',
        "",
        '<S id="b" d={A.a}>',
        "B behavior.",
        "</S>",
        "",
      ].join("\n"),
    },
    cycle: ["specs/A.mdx#a", "specs/B.mdx#b"],
    importCycleFiles: ["specs/A.mdx", "specs/B.mdx"],
  },
  {
    // p contains p.q; p.q embeds x; x embeds p — mixed through `contains`
    // and `embeds`, with no ancestor relation along either embeds edge (the
    // ancestor shapes are the two arms below).
    name: "a mixed cycle through `contains` + `embeds`",
    files: {
      "specs/A.mdx": [
        '<S id="p">',
        "P behavior.",
        "",
        '<S id="p.q">',
        'Q embeds: {text("x")}',
        "</S>",
        "</S>",
        "",
        '<S id="x">',
        'X embeds: {text("p")}',
        "</S>",
        "",
      ].join("\n"),
    },
    cycle: ["specs/A.mdx#p", "specs/A.mdx#p.q", "specs/A.mdx#x"],
  },
  {
    name: "a self-`depends` (a dependency cycle of length one)",
    files: {
      "specs/A.mdx": [
        '<S id="s" d={"s"}>',
        "Depends on itself.",
        "</S>",
        "",
      ].join("\n"),
    },
    cycle: ["specs/A.mdx#s"],
  },
  {
    name: "a self-`embeds` (a dependency cycle of length one)",
    files: {
      "specs/A.mdx": [
        '<S id="s">',
        'Embeds itself: {text("s")}',
        "</S>",
        "",
      ].join("\n"),
    },
    cycle: ["specs/A.mdx#s"],
  },
  {
    // The full path must include the intermediate section a.b the `contains`
    // chain runs through: a → a.b → a.b.c → a.
    name: "a section depending on its own ancestor (grandparent)",
    files: {
      "specs/A.mdx": [
        '<S id="a">',
        "Alpha behavior.",
        "",
        '<S id="a.b">',
        "Beta behavior.",
        "",
        '<S id="a.b.c" d={"a"}>',
        "Gamma depends on its grandparent.",
        "</S>",
        "</S>",
        "</S>",
        "",
      ].join("\n"),
    },
    cycle: ["specs/A.mdx#a", "specs/A.mdx#a.b", "specs/A.mdx#a.b.c"],
  },
  {
    name: "a section embedding its own ancestor (grandparent)",
    files: {
      "specs/A.mdx": [
        '<S id="a">',
        "Alpha behavior.",
        "",
        '<S id="a.b">',
        "Beta behavior.",
        "",
        '<S id="a.b.c">',
        'Gamma embeds its grandparent: {text("a")}',
        "</S>",
        "</S>",
        "</S>",
        "",
      ].join("\n"),
    },
    cycle: ["specs/A.mdx#a", "specs/A.mdx#a.b", "specs/A.mdx#a.b.c"],
  },
];

const T5_3_1 = defineProductTest({
  id: "T5.3-1",
  title:
    "`check` detects and reports, with the full cycle path, each staged dependency cycle — a `depends` cycle A→B→A across files, a mixed cycle through `contains` + `embeds`, a self-`depends` and a self-`embeds` of length one, and a section depending on / embedding its own ancestor — at exit 1 (SPEC 5.3, 14.9)",
  run: async (product) => {
    for (const arm of T5_3_1_ARMS) {
      await withWorkspace(SPECS_ONLY_CONFIG, arm.files, async (workspace) => {
        const context = `T5.3-1 \`check --json\` over ${arm.name}`;
        assertDependencyCycleFindings(
          await checkFindings(product, workspace, context),
          arm,
          context,
        );
      });
    }
  },
});

// ---------------------------------------------------------------------------
// T5.3-2 — build also rejects dependency cycles (14.9 build-and-check)
// ---------------------------------------------------------------------------

// A two-node same-file `depends` cycle via local string references — no
// import exists, so the dependency cycle is the fixture's only error
// condition and its report is exactly one 14.9 finding with the full path.
const T5_3_2_SOURCE = [
  '<S id="a" d={"b"}>',
  "A behavior.",
  "</S>",
  "",
  '<S id="b" d={"a"}>',
  "B behavior.",
  "</S>",
  "",
].join("\n");

const T5_3_2_CYCLE: readonly string[] = ["specs/A.mdx#a", "specs/A.mdx#b"];

const T5_3_2 = defineProductTest({
  id: "T5.3-2",
  title:
    "`build` also rejects dependency cycles: a two-node `depends` cycle fails `build` at exit 1 with one 14.9 finding carrying the full cycle path, and `check` over the same workspace reports the same — 14.9 is a build-and-check condition (SPEC 5.3, 14, 14.9)",
  run: async (product) => {
    await withWorkspace(
      SPECS_ONLY_CONFIG,
      { "specs/A.mdx": T5_3_2_SOURCE },
      async (workspace) => {
        const buildContext =
          "T5.3-2 `build --json` over a two-node `depends` cycle";
        assertDependencyCycleFindings(
          await buildFindings(product, workspace, buildContext),
          { cycle: T5_3_2_CYCLE },
          buildContext,
        );
        const checkContext =
          "T5.3-2 `check --json` over the same workspace (14.9 is a " +
          "build-and-check condition)";
        assertDependencyCycleFindings(
          await checkFindings(product, workspace, checkContext),
          { cycle: T5_3_2_CYCLE },
          checkContext,
        );
      },
    );
  },
});

/** TEST-SPEC §5.1–5.3, in canonical ID order (SUITE-17). */
export const section51to53Tests: readonly ProductTestEntry[] = [
  T5_2_1,
  T5_3_1,
  T5_3_2,
];
