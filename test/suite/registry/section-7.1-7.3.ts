// TEST-SPEC §7.1–7.3 (spec groups, code groups, markdown configuration) —
// SUITE-28: T7.1-1, T7.2-1, T7.3-1. Configuration basics (T7-1…T7-3) live in
// section-7-basics.ts, discovery (T7-4…T7-6) in section-7-discovery.ts; the
// §7.4–7.5 profile/rule tests belong to SUITE-29.
//
// Registered product-facing bodies (C-2 "one code path"): each builds its own
// fresh workspace (H-1), drives the product strictly as a subprocess (H-2),
// asserts exact exit codes (H-5), decodes reports through the H-3 adapters,
// and rejects a product only via diagnosed assertion failures (H-8).
//
// SPEC 7.1: spec groups are named glob lists; a file MAY belong to multiple
// groups; every matched file MUST have the `.mdx` extension, any other match
// being invalid (14.19). SPEC 7.2: code groups serve as coverage boundaries
// and as the impacted-code population; a file matched by both a spec and a
// code group is a configuration error (14.14). SPEC 7.3: `markdown` absent →
// no emission; when present, `emit` (boolean) is REQUIRED and controls
// emission; `outDir` redirects emitted files preserving workspace-relative
// paths, resolves against the workspace root, and MUST resolve within it
// (else 14.14); the configured emit destinations exist exactly while emission
// is enabled — with `emit: true` they are the destination paths whether or
// not emission has yet run, with `markdown` absent or `emit: false` no path
// is a destination, so the 13.4 exclusion and the import rule of 4 have no
// Markdown component.
//
// Conservative operationalizations (noted per H-3/H-4):
// - 14.14 contract: `expectConfigurationError` (shared, ./support.ts) — exit
//   2 exactly, byte-empty stdout under --json, stderr matching /config/i.
// - T7.1-1 coverage: profiles are looked up by name (T8.2-1 owns report
//   ordering and the full report contract — counts and the ignored-node
//   composition are not asserted here); "sees it in both" is asserted as the
//   shared file's leaves appearing in each profile's covered/uncovered sets,
//   the covered node with its exact boundary-to-target path (the harness
//   information model, helpers/adapters/model.ts).
// - T7.1-1 policy findings are compared as sorted "rule :: kind: from -> to"
//   renderings: SPEC 7.5 fixes the information (rule name + offending edge),
//   not an order, and one finding per (rule, edge) pair.
// - T7.3-1 emitted Markdown is byte-asserted (SPEC 3 fixes the compiled
//   bytes; H-4); the compilation semantics themselves are T3-*'s subject —
//   fixture sources are single-section files with trivially known output.
// - T7.3-1 classification-follows-emit, discovery channel: 14.19 constrains
//   spec-group files to `.mdx` (7.1), but no extension rule constrains code
//   groups (14.19/14.20: any non-`.tsx` name parses as plain TypeScript), so
//   a destination path is staged as a *valid* code source — with `emit:
//   false` it must be discovered (its top-level marker's `references` edge
//   exists and `--from` knows the location), with `emit: true` it must not
//   (13.4 excludes destinations from every group). Whole-graph edge-set
//   equality has teeth because the fixture's complete edge set is spec-forced
//   (SPEC 5.1–5.2); the unknown-path `--from` probe uses T7-3's exit-2
//   operationalization (empty stdout, non-empty stderr diagnostic; 12.0).
// - T7.3-1 classification-follows-emit, import-rule channel (T4-2's rule,
//   SPEC 4/13.4/14.15): the identical workspace flips between exactly one
//   14.15 finding (`emit: true` — the specifier designates a configured
//   destination) and a clean build (`emit: false` — no path is a
//   destination, so the ordinary import is outside xspec's validations).

import { Buffer } from "node:buffer";
import type {
  CoverageProfileReport,
  CoverageReport,
  Finding,
  GraphEdge,
  IdsFileEntry,
} from "../../helpers/adapters/index.js";
import {
  decodeCoverageReport,
  decodeEdgesReport,
  decodeFindingsReport,
  decodeIdsReport,
} from "../../helpers/adapters/index.js";
import {
  assertBytesEqual,
  assertFileBytes,
  assertStdoutEmpty,
  fail,
  parseJsonStdout,
} from "../../helpers/assertions.js";
import { defineProductTest } from "../../helpers/registry.js";
import type { ProductTestEntry } from "../../helpers/registry.js";
import type { ProductBinding } from "../../helpers/subprocess.js";
import { summarizeResult } from "../../helpers/subprocess.js";
import { TestWorkspace } from "../../helpers/workspace.js";
import type { WorkspaceDecl } from "../../helpers/workspace.js";
import {
  assertConditionCounts,
  assertEdgeSetEqual,
  assertFindingLocated,
  assertSameJson,
  buildFindings,
  buildOk,
  byteWindow,
  expectConfigurationError,
  expectExit,
  runJson,
} from "./support.js";

// ---------------------------------------------------------------------------
// Shared fixture material
// ---------------------------------------------------------------------------

/** A minimal valid single-section source: one node `<id>` under the root. */
function mdxSection(id: string): string {
  return `<S id="${id}">\nText for ${id}.\n</S>\n`;
}

/** Stage a fresh workspace, run `body`, dispose (H-1). */
async function withWorkspace<T>(
  decl: WorkspaceDecl,
  body: (workspace: TestWorkspace) => Promise<T>,
): Promise<T> {
  const workspace = await TestWorkspace.create(decl);
  try {
    return await body(workspace);
  } finally {
    await workspace.dispose();
  }
}

/** Copy of an ids listing sorted bytewise by file path (module header:
 * membership is this module's subject; the report's own file ordering is
 * T12.3-1's contract). */
function sortedListing(entries: readonly IdsFileEntry[]): IdsFileEntry[] {
  return entries
    .map((entry) => ({ file: entry.file, ids: entry.ids }))
    .sort((a, b) =>
      Buffer.compare(Buffer.from(a.file, "utf8"), Buffer.from(b.file, "utf8")),
    );
}

/**
 * Run `ids --json` (12.3) and assert the discovered set: exit 0 with exactly
 * one JSON document whose file/ID listing equals `expected` up to file order.
 */
async function expectIdsListing(
  product: ProductBinding,
  workspace: TestWorkspace,
  expected: readonly IdsFileEntry[],
  context: string,
): Promise<void> {
  const report = decodeIdsReport(
    await runJson(product, workspace, ["ids", "--json"], context),
    context,
  );
  assertSameJson(
    sortedListing(report.files),
    sortedListing(expected),
    `${context}: the discovered set — requirement IDs grouped by file, ` +
      `compared bytewise-sorted by path (SPEC 12.3; membership per SPEC 7)`,
  );
}

/**
 * Stage a workspace whose only defect is the given configuration text and
 * assert `build --json` refuses it per 14.14. The staged source is valid and
 * matched by every fixture configuration's spec glob, so a product that
 * wrongly accepts the configuration proceeds to a successful build (exit 0)
 * and fails the exit-code assertion — never exits 2 for a side reason.
 */
async function expectConfigRefused(
  product: ProductBinding,
  config: string,
  context: string,
): Promise<void> {
  await withWorkspace(
    {
      files: {
        "xspec.config.ts": config,
        "specs/A.mdx": mdxSection("a"),
      },
    },
    async (workspace) => {
      await expectConfigurationError(product, workspace, ["build"], context);
    },
  );
}

// ---------------------------------------------------------------------------
// T7.1-1 — spec groups
// ---------------------------------------------------------------------------

// One file (shared/S.mdx) matched by two spec groups, `alpha` and `beta`,
// each also holding a private file; group `ext` supplies the coverage
// boundary and group `low` the policy-rule target, wired acyclically
// (imports: shared → low, ext → shared; SPEC 2.1: import cycles are invalid,
// so the boundary edge into the shared file and the policy edge out of it
// must not point at each other's files):
//
//   ext/E.mdx#e          --depends-->  shared/S.mdx#s.covered   (covers it)
//   shared/S.mdx#s.uses  --depends-->  low/L.mdx#l              (policy edge)
//
// Two identically shaped coverage profiles target `alpha` and `beta` with
// boundary `ext` (unambiguous name — `boundaryKind` inferred, SPEC 7.4) in
// `direct` mode; two identically shaped `forbidden` rules match the s.uses →
// l edge from `alpha` and from `beta`. A product assigning the file to only
// one of its groups loses the shared leaves from one profile's report and
// one rule's finding.
const TWO_GROUP_MEMBERSHIP_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    alpha: ["alpha/*.mdx", "shared/*.mdx"],
    beta: ["beta/*.mdx", "shared/*.mdx"],
    ext: ["ext/*.mdx"],
    low: ["low/*.mdx"]
  },
  coverage: [
    {
      name: "cov-alpha",
      target: "alpha",
      boundary: "ext",
      mode: "direct"
    },
    {
      name: "cov-beta",
      target: "beta",
      boundary: "ext",
      mode: "direct"
    }
  ],
  policy: [
    {
      name: "alpha-to-low",
      type: "forbidden",
      from: { group: "alpha" },
      to: { group: "low" }
    },
    {
      name: "beta-to-low",
      type: "forbidden",
      from: { group: "beta" },
      to: { group: "low" }
    }
  ]
})
`;

const SHARED_SOURCE = `import L from "../low/L.xspec"

<S id="s">
Shared behavior.

<S id="s.covered">
Coverable from ext.
</S>

<S id="s.uses" d={L.l}>
Uses low-level behavior.
</S>
</S>
`;

const EXT_SOURCE = `import SH from "../shared/S.xspec"

<S id="e" d={SH.s.covered}>
Ext behavior depending on the shared leaf.
</S>
`;

const TWO_GROUP_FILES: Readonly<Record<string, string>> = {
  "xspec.config.ts": TWO_GROUP_MEMBERSHIP_CONFIG,
  "alpha/A.mdx": mdxSection("a"),
  "beta/B.mdx": mdxSection("b"),
  "shared/S.mdx": SHARED_SOURCE,
  "ext/E.mdx": EXT_SOURCE,
  "low/L.mdx": mdxSection("l"),
};

const SHARED_COVERED = "shared/S.mdx#s.covered";
const SHARED_USES = "shared/S.mdx#s.uses";
const EXT_BOUNDARY = "ext/E.mdx#e";
const LOW_TARGET = "low/L.mdx#l";

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

/**
 * Assert one profile sees the shared file's leaves: `s.covered` covered with
 * the exact one-edge boundary-to-target path (SPEC 8: direct mode, one
 * dependency edge from a boundary node), `s.uses` and the group's private
 * leaf uncovered (membership, compared sorted — the module header's
 * operationalization note).
 */
function assertProfileSeesSharedFile(
  profile: CoverageProfileReport,
  privateLeaf: string,
  context: string,
): void {
  assertSameJson(
    profile.covered.map((node) => ({
      identity: node.identity,
      path: node.path,
    })),
    [{ identity: SHARED_COVERED, path: [EXT_BOUNDARY, SHARED_COVERED] }],
    `${context}: the shared file's leaf ${SHARED_COVERED} is covered via the ` +
      `single boundary edge (SPEC 8, 7.1 — the file's nodes belong to this ` +
      `profile's target group too)`,
  );
  assertSameJson(
    [...profile.uncovered].sort(),
    [privateLeaf, SHARED_USES].sort(),
    `${context}: the group's private leaf and the shared file's other leaf ` +
      `are the uncovered required nodes (SPEC 8.1, 7.1)`,
  );
}

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

const T7_1_1 = defineProductTest({
  id: "T7.1-1",
  title:
    "spec groups: a file in two spec groups is valid, listed once, and " +
    "coverage and policy see it in both groups; a spec-group match without " +
    "`.mdx` is invalid (SPEC 7.1, 8, 7.5, 14.19)",
  run: async (product) => {
    // A file in two spec groups is valid — and coverage/policy see it in
    // both.
    await withWorkspace({ files: TWO_GROUP_FILES }, async (workspace) => {
      await buildOk(
        product,
        workspace,
        "T7.1-1 `build` — a file in two spec groups is valid (SPEC 7.1)",
      );
      await expectIdsListing(
        product,
        workspace,
        [
          { file: "alpha/A.mdx", ids: ["a"] },
          { file: "beta/B.mdx", ids: ["b"] },
          { file: "ext/E.mdx", ids: ["e"] },
          { file: "low/L.mdx", ids: ["l"] },
          { file: "shared/S.mdx", ids: ["s", "s.covered", "s.uses"] },
        ],
        "T7.1-1 `ids --json` — the twice-grouped file is one source, listed " +
          "once (SPEC 7.1, 7, 12.3)",
      );

      // Coverage: both profiles — one per group — report the shared file's
      // leaves in their required sets.
      const coverageLabel = "T7.1-1 `coverage --json`";
      const coverage = decodeCoverageReport(
        await runJson(
          product,
          workspace,
          ["coverage", "--json"],
          coverageLabel,
        ),
        coverageLabel,
      );
      assertProfileSeesSharedFile(
        profileNamed(coverage, "cov-alpha", coverageLabel),
        "alpha/A.mdx#a",
        `${coverageLabel} profile cov-alpha`,
      );
      assertProfileSeesSharedFile(
        profileNamed(coverage, "cov-beta", coverageLabel),
        "beta/B.mdx#b",
        `${coverageLabel} profile cov-beta`,
      );

      // Policy: the depends edge sourced at the shared file's node violates
      // BOTH group-scoped rules — one finding per rule, each naming the rule
      // and the offending edge (SPEC 7.5, 14.12).
      const checkLabel = "T7.1-1 `check --json`";
      const checkResult = await expectExit(
        product,
        workspace,
        ["check", "--json"],
        1,
        `${checkLabel} — the staged edge violates both forbidden rules, a ` +
          `finding outcome (SPEC 7.5, 12.0)`,
      );
      const findings = decodeFindingsReport(
        parseJsonStdout(checkResult, checkLabel),
        checkLabel,
      ).findings;
      assertConditionCounts(findings, { "14.12": 2 }, checkLabel);
      assertSameJson(
        renderPolicyFindings(findings),
        [
          `alpha-to-low :: depends: ${SHARED_USES} -> ${LOW_TARGET}`,
          `beta-to-low :: depends: ${SHARED_USES} -> ${LOW_TARGET}`,
        ],
        `${checkLabel}: the rule scoped to each group flags the edge — ` +
          `policy sees the shared file in both spec groups (SPEC 7.1, 7.5)`,
      );
    });

    // A spec-group match without `.mdx` → 14.19. The offending file's
    // content is itself well-formed, so the invalid path is the workspace's
    // only condition (the exact-count assertion has teeth) — and a product
    // that wrongly accepts the match builds cleanly and fails the exit-code
    // assertion.
    await withWorkspace(
      {
        files: {
          "xspec.config.ts": `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/*"]
  }
})
`,
          "specs/A.mdx": mdxSection("a"),
          "specs/notes.txt": mdxSection("n"),
        },
      },
      async (workspace) => {
        const context =
          "T7.1-1 `build --json` with the spec-group glob specs/* matching " +
          "specs/notes.txt";
        const findings = await buildFindings(product, workspace, context);
        assertConditionCounts(findings, { "14.19": 1 }, context);
        const finding = findings[0]!;
        if (finding.file !== "specs/notes.txt") {
          fail(
            `${context}: the 14.19 finding must identify the offending ` +
              `workspace-relative source path (SPEC 14, 7.1, 1.5); expected ` +
              `file "specs/notes.txt", got ${JSON.stringify(finding.file)} ` +
              `(message: ${JSON.stringify(finding.message)})`,
          );
        }
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T7.2-1 — code groups
// ---------------------------------------------------------------------------

// The positive roles of code groups — coverage boundaries (SPEC 7.2, 8) and
// the impacted-code population (9.2) — are asserted by the section 8/9 tests
// (T8-3, T9.2-*), per T7.2-1's own text. This test's subject is the overlap
// rule: a file matched by both a spec and a code group is a configuration
// error (14.14), reported when the configuration is loaded and sources are
// discovered, as a usage error (exit 2). The decoy pair — a spec source and
// a code source each matched by exactly one group — keeps the overlap the
// workspace's only defect: a product that wrongly accepts it proceeds past
// configuration load (to exit 0 or a finding exit 1, whatever it makes of
// mixed/X.mdx) and fails the exit-2 assertion either way.
const OVERLAP_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/*.mdx", "mixed/*.mdx"]
  },
  code: {
    app: ["src/*.ts", "mixed/*"]
  }
})
`;

const T7_2_1 = defineProductTest({
  id: "T7.2-1",
  title:
    "code groups: a file matched by both a spec and a code group is a " +
    "configuration error (14.14, exit 2); the coverage-boundary and " +
    "impacted-code-population roles are asserted in sections 8/9 (SPEC 7.2)",
  run: async (product) => {
    await withWorkspace(
      {
        files: {
          "xspec.config.ts": OVERLAP_CONFIG,
          "specs/A.mdx": mdxSection("a"),
          "src/impl.ts": "export const ok = 1;\n",
          "mixed/X.mdx": mdxSection("x"),
        },
      },
      async (workspace) => {
        await expectConfigurationError(
          product,
          workspace,
          ["build"],
          "T7.2-1 `build --json` with mixed/X.mdx matched by both the spec " +
            "group (mixed/*.mdx) and the code group (mixed/*)",
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T7.3-1 — markdown configuration
// ---------------------------------------------------------------------------

/** The canonical one-spec-group configuration plus an optional extra key. */
function specsMainConfig(extra: string): string {
  return `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  }${extra}
})
`;
}

// Two sources, one in a subdirectory, so "next to each source" and the
// outDir path preservation are both observable. Compiled bytes are fixed by
// SPEC 3 (the tag-only lines drop with their terminators; the content line
// keeps its own): byte-asserted per H-4; compilation semantics are T3-*'s.
const EMISSION_FILES: Readonly<Record<string, string>> = {
  "specs/A.mdx": mdxSection("a"),
  "specs/sub/B.mdx": mdxSection("b"),
};
const A_COMPILED = "Text for a.\n";
const B_COMPILED = "Text for b.\n";

// The emission-scope matrix (SPEC 7.3): absent and `emit: false` mean no
// emission; `emit: true` emits next to each source.
const EMISSION_VARIANTS = [
  { key: "`markdown` absent", config: specsMainConfig(""), emits: false },
  {
    key: "`markdown: { emit: false }`",
    config: specsMainConfig(",\n  markdown: { emit: false }"),
    emits: false,
  },
  {
    key: "`markdown: { emit: true }`",
    config: specsMainConfig(",\n  markdown: { emit: true }"),
    emits: true,
  },
] as const;

// `markdown` present without `emit` → 14.14 (SPEC 7.3: `emit` is required
// when `markdown` is present). The outDir-bearing arm discriminates a
// product that infers emission from any other markdown key.
const EMIT_REQUIRED_VIOLATIONS: readonly { label: string; extra: string }[] = [
  { label: "markdown: {}", extra: ",\n  markdown: {}" },
  {
    label: 'markdown: { outDir: "docs" } (outDir given, emit still missing)',
    extra: ',\n  markdown: { outDir: "docs" }',
  },
];

// `outDir` redirect (SPEC 7.3: emitted files land under outDir, preserving
// workspace-relative paths; outDir resolves against the workspace root).
const OUTDIR_CONFIG = specsMainConfig(
  ',\n  markdown: { emit: true, outDir: "docs" }',
);

// `outDir` resolving outside the workspace root → 14.14: a plain `../`
// escape and a `..` traversal buried mid-path.
const OUTSIDE_OUTDIRS: readonly string[] = ["../out", "docs/../../out"];

// Classification-follows-emit, discovery channel (module header): the
// destination path `specs/A.md` staged as a *valid code source* — plain-TS
// content whose top-level marker records a `references` edge attributed to
// the file (SPEC 4.5, 4.6, 14.20) — in a code group whose glob matches only
// it. The spec and code globs are disjoint (`*.mdx` vs `*.md` suffixes), so
// no 14.14 overlap arises.
const DESTINATION_CODE_SOURCE = `import BASE from "./A.xspec"

BASE.a
`;

function destinationDiscoveryConfig(emit: boolean): string {
  return `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/*.mdx"]
  },
  code: {
    doc: ["specs/*.md"]
  },
  markdown: { emit: ${String(emit)} }
})
`;
}

const DESTINATION_DISCOVERY_FILES: Readonly<Record<string, string>> = {
  "specs/A.mdx": mdxSection("a"),
  "specs/A.md": DESTINATION_CODE_SOURCE,
};

const CONTAINS_EDGE: GraphEdge = {
  from: "specs/A.mdx",
  to: "specs/A.mdx#a",
  kind: "contains",
};
const DESTINATION_MARKER_EDGE: GraphEdge = {
  from: "specs/A.md",
  to: "specs/A.mdx#a",
  kind: "references",
};

// Classification-follows-emit, import-rule channel (T4-2's rule, SPEC 4,
// 13.4, 14.15): a code-group file importing the destination path. The
// classification is by path, so nothing exists at specs/A.md here.
const DESTINATION_IMPORT_STATEMENT = 'import DOC from "../specs/A.md";';

function destinationImportConfig(emit: boolean): string {
  return `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/*.mdx"]
  },
  code: {
    app: ["src/*.ts"]
  },
  markdown: { emit: ${String(emit)} }
})
`;
}

const DESTINATION_IMPORT_FILES: Readonly<Record<string, string>> = {
  "specs/A.mdx": mdxSection("a"),
  "src/use.ts": `${DESTINATION_IMPORT_STATEMENT}\n`,
};

// Classification-by-configuration-alone arm (SPEC 7.3 "whether or not
// emission has yet run"): emission enabled, no emission ever run, a
// user-authored file at the destination, one spec-group glob matching both
// the source and the destination.
const CONFIG_ALONE_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/*"]
  },
  markdown: { emit: true }
})
`;

const USER_AUTHORED_DESTINATION =
  "User-authored notes at the emit destination.\n";

/** Assert nothing occupies a would-be emit destination (SPEC 7.3). */
async function assertNotEmitted(
  workspace: TestWorkspace,
  rel: string,
  context: string,
): Promise<void> {
  const kind = await workspace.kind(rel);
  if (kind !== "absent") {
    fail(
      `${context}: expected nothing at ${rel} — with \`markdown\` absent or ` +
        `\`emit: false\` no path is a Markdown emit destination, and with ` +
        `outDir the default next-to-source paths are not destinations ` +
        `(SPEC 7.3) — but found: ${kind}`,
    );
  }
}

const T7_3_1 = defineProductTest({
  id: "T7.3-1",
  title:
    "markdown configuration: absent and emit:false mean no emission, " +
    "emit:true emits next to each source; markdown without emit is 14.14; " +
    "outDir redirects preserving workspace-relative paths and must resolve " +
    "within the root (else 14.14); emit-destination classification follows " +
    "emit — by configuration alone, whether or not emission has yet run " +
    "(SPEC 7.3, 13.2, 13.4, 14.14)",
  run: async (product) => {
    // (a) The emission-scope matrix: absent → none, emit:false → none,
    // emit:true → next to each source. Fresh workspace per variant, so no
    // arm can observe a leftover emission.
    for (const variant of EMISSION_VARIANTS) {
      await withWorkspace(
        { files: { "xspec.config.ts": variant.config, ...EMISSION_FILES } },
        async (workspace) => {
          await buildOk(
            product,
            workspace,
            `T7.3-1 \`build\` under ${variant.key}`,
          );
          if (variant.emits) {
            await assertFileBytes(
              workspace.path("specs/A.md"),
              A_COMPILED,
              `T7.3-1 under ${variant.key}: specs/A.mdx emits specs/A.md ` +
                `next to its source (SPEC 7.3, 13.2)`,
            );
            await assertFileBytes(
              workspace.path("specs/sub/B.md"),
              B_COMPILED,
              `T7.3-1 under ${variant.key}: specs/sub/B.mdx emits ` +
                `specs/sub/B.md next to its source (SPEC 7.3, 13.2)`,
            );
          } else {
            await assertNotEmitted(
              workspace,
              "specs/A.md",
              `T7.3-1 under ${variant.key}`,
            );
            await assertNotEmitted(
              workspace,
              "specs/sub/B.md",
              `T7.3-1 under ${variant.key}`,
            );
          }
        },
      );
    }

    // (b) `markdown` present without `emit` → 14.14 (exit 2).
    for (const arm of EMIT_REQUIRED_VIOLATIONS) {
      await expectConfigRefused(
        product,
        specsMainConfig(arm.extra),
        `T7.3-1 (${arm.label}) \`build --json\` — \`emit\` is required when ` +
          `\`markdown\` is present (SPEC 7.3, 14.14)`,
      );
    }

    // (c) `outDir` redirects, preserving workspace-relative paths — and
    // redirects rather than duplicates: the default next-to-source paths
    // stay vacant.
    await withWorkspace(
      { files: { "xspec.config.ts": OUTDIR_CONFIG, ...EMISSION_FILES } },
      async (workspace) => {
        await buildOk(product, workspace, "T7.3-1 `build` with outDir docs");
        await assertFileBytes(
          workspace.path("docs/specs/A.md"),
          A_COMPILED,
          "T7.3-1 (outDir): specs/A.mdx emits docs/specs/A.md — outDir " +
            "prefixes the preserved workspace-relative path (SPEC 7.3)",
        );
        await assertFileBytes(
          workspace.path("docs/specs/sub/B.md"),
          B_COMPILED,
          "T7.3-1 (outDir): specs/sub/B.mdx emits docs/specs/sub/B.md — " +
            "subdirectory structure preserved under outDir (SPEC 7.3)",
        );
        await assertNotEmitted(
          workspace,
          "specs/A.md",
          "T7.3-1 (outDir redirects, not duplicates)",
        );
        await assertNotEmitted(
          workspace,
          "specs/sub/B.md",
          "T7.3-1 (outDir redirects, not duplicates)",
        );
      },
    );

    // (d) `outDir` resolving outside the workspace root → 14.14 (exit 2).
    for (const outDir of OUTSIDE_OUTDIRS) {
      await expectConfigRefused(
        product,
        specsMainConfig(
          `,\n  markdown: { emit: true, outDir: ${JSON.stringify(outDir)} }`,
        ),
        `T7.3-1 (outDir ${JSON.stringify(outDir)} resolves outside the ` +
          `workspace root) \`build --json\` (SPEC 7.3, 14.14)`,
      );
    }

    // (e) Classification follows `emit`, discovery channel: with emission
    // off the destination path IS a discovered (code) source — its marker
    // edge exists and `--from` knows the location; with emission on it is
    // not — 13.4 excludes destinations from every group.
    await withWorkspace(
      {
        files: {
          "xspec.config.ts": destinationDiscoveryConfig(false),
          ...DESTINATION_DISCOVERY_FILES,
        },
      },
      async (workspace) => {
        const allLabel =
          "T7.3-1 (emit: false — destination path as code source) " +
          "`query edges` (unfiltered)";
        assertEdgeSetEqual(
          decodeEdgesReport(
            await runJson(product, workspace, ["query", "edges"], allLabel),
            allLabel,
          ),
          [CONTAINS_EDGE, DESTINATION_MARKER_EDGE],
          `${allLabel}: with emission off no path is a destination, so ` +
            `specs/A.md is an ordinary discovered code source and its ` +
            `top-level marker records its references edge (SPEC 7.3, 13.4, ` +
            `4.5, 4.6)`,
        );
        const fromLabel =
          "T7.3-1 (emit: false) `query edges --from specs/A.md`";
        assertEdgeSetEqual(
          decodeEdgesReport(
            await runJson(
              product,
              workspace,
              ["query", "edges", "--from", "specs/A.md"],
              fromLabel,
            ),
            fromLabel,
          ),
          [DESTINATION_MARKER_EDGE],
          `${fromLabel}: the path names a known code location — the file is ` +
            `discovered (SPEC 11, 7.3)`,
        );
      },
    );
    await withWorkspace(
      {
        files: {
          "xspec.config.ts": destinationDiscoveryConfig(true),
          ...DESTINATION_DISCOVERY_FILES,
        },
      },
      async (workspace) => {
        const allLabel =
          "T7.3-1 (emit: true — destination path excluded) `query edges` " +
          "(unfiltered)";
        assertEdgeSetEqual(
          decodeEdgesReport(
            await runJson(product, workspace, ["query", "edges"], allLabel),
            allLabel,
          ),
          [CONTAINS_EDGE],
          `${allLabel}: with emission enabled specs/A.md is a configured ` +
            `emit destination, excluded from every group (SPEC 13.4) — no ` +
            `edge is sourced at it`,
        );
        const fromLabel = "T7.3-1 (emit: true) `query edges --from specs/A.md`";
        const fromResult = await expectExit(
          product,
          workspace,
          ["query", "edges", "--from", "specs/A.md"],
          2,
          `${fromLabel} — the excluded destination belongs to no configured ` +
            `group, so the path is unknown, a usage error (SPEC 7.3, 13.4, ` +
            `11, 12.0)`,
        );
        assertStdoutEmpty(
          fromResult,
          `${fromLabel} — query's single JSON document is its only output ` +
            `form, and the exit-2 error prevents emitting one (SPEC 11, ` +
            `12.0, H-5)`,
        );
        if (fromResult.stderrBytes.length === 0) {
          fail(
            `${fromLabel}: the usage error must be a standard-error ` +
              `diagnostic (SPEC 12.0); stderr is empty — ` +
              summarizeResult(fromResult),
          );
        }
      },
    );

    // (f) Classification follows `emit`, import-rule channel (T4-2's rule):
    // the identical workspace flips between exactly one 14.15 finding
    // (emission enabled — the specifier designates a configured destination)
    // and a clean build (emission disabled — no Markdown component to the
    // import rule).
    await withWorkspace(
      {
        files: {
          "xspec.config.ts": destinationImportConfig(true),
          ...DESTINATION_IMPORT_FILES,
        },
      },
      async (workspace) => {
        const context =
          "T7.3-1 (emit: true) `build --json` over src/use.ts importing " +
          "../specs/A.md — a configured Markdown emit destination";
        const findings = await buildFindings(product, workspace, context);
        assertConditionCounts(findings, { "14.15": 1 }, context);
        assertFindingLocated(
          findings[0]!,
          {
            file: "src/use.ts",
            window: byteWindow("", DESTINATION_IMPORT_STATEMENT),
          },
          `${context}: the 14.15 finding (SPEC 4, 13.4)`,
        );
      },
    );
    await withWorkspace(
      {
        files: {
          "xspec.config.ts": destinationImportConfig(false),
          ...DESTINATION_IMPORT_FILES,
        },
      },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T7.3-1 (emit: false) `build` over the identical workspace — with " +
            "emission off no path is a destination, so the same import is " +
            "an ordinary one outside xspec's validations (SPEC 7.3, 4)",
        );
      },
    );

    // (g) Classification is by configuration alone, "whether or not emission
    // has yet run" (SPEC 7.3): no emission has ever run, yet the read
    // command treats the user-occupied destination as no source — not
    // discovered, no 14.19 from the non-`.mdx` match, bytes untouched
    // (`ids` is the representative read; its 13.3 refresh never emits).
    await withWorkspace(
      {
        files: {
          "xspec.config.ts": CONFIG_ALONE_CONFIG,
          "specs/A.mdx": mdxSection("a"),
          "specs/A.md": USER_AUTHORED_DESTINATION,
        },
      },
      async (workspace) => {
        await expectIdsListing(
          product,
          workspace,
          [{ file: "specs/A.mdx", ids: ["a"] }],
          "T7.3-1 (classification by configuration alone) `ids --json` — " +
            "emission enabled but never run: the glob-matched user file at " +
            "the destination specs/A.md is no source (no 14.19 despite the " +
            "non-`.mdx` match), discriminating classification by existing " +
            "emitted output (SPEC 7.3, 13.4)",
        );
        assertBytesEqual(
          await workspace.readBytes("specs/A.md"),
          USER_AUTHORED_DESTINATION,
          "T7.3-1 (classification by configuration alone): the user-authored " +
            "bytes at the destination are untouched — the read's refresh " +
            "never emits (SPEC 13.3, 7.3)",
        );
      },
    );
  },
});

/** TEST-SPEC §7.1–7.3 T7.1-1, T7.2-1, T7.3-1, in canonical order (SUITE-28). */
export const section71to73Tests: readonly ProductTestEntry[] = [
  T7_1_1,
  T7_2_1,
  T7_3_1,
];
