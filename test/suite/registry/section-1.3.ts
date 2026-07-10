// TEST-SPEC §1.3 (requirement IDs) — SUITE-02: T1.3-1 … T1.3-6.
//
// Registered product-facing bodies (C-2 "one code path"): each builds its own
// fresh workspace (H-1), drives the product strictly as a subprocess (H-2),
// asserts exact exit codes (H-5), decodes findings through the H-3 adapters,
// and rejects a product only via diagnosed assertion failures (H-8). Error
// reports are asserted for the SPEC.md 14 required information — condition
// identity, file, location, and (14.2) a statement of the expected form —
// never exact wording.
//
// CONF-VALID in-scope (CERTIFICATIONS.md §CONF-VALID): every fixture stays
// within that entry's scope — one configured spec group of `.mdx` sources
// whose sections carry `id`/`tags` props only; no imports, embeddings, `d`
// props, code groups, `markdown`, `coverage`, `policy`, or git; the command
// surface is `build` (error reporting of 14.1–14.4) plus `query nodes`.
// T1.3-5's cross-file duplicate-ID arm is the multi-file case.
//
// Location assertions: fixtures are staged as prefix + offending construct +
// suffix, all pure ASCII (string indices are byte offsets), and each negative
// arm asserts the finding's location falls within the offending construct's
// own byte window. The window is end-widened by one byte so a product
// reporting a line-granular location (last construct line plus its
// terminator) still passes; every other staged construct lies outside the
// widened window, so a finding attributed to the wrong construct fails.

import { Buffer } from "node:buffer";
import type { Finding } from "../../helpers/adapters/index.js";
import {
  assertReportMentions,
  decodeNodeRowsReport,
} from "../../helpers/adapters/index.js";
import { fail } from "../../helpers/assertions.js";
import { defineProductTest } from "../../helpers/registry.js";
import type { ProductTestEntry } from "../../helpers/registry.js";
import type { ProductBinding } from "../../helpers/subprocess.js";
import { TestWorkspace } from "../../helpers/workspace.js";
import {
  assertConditionCounts,
  assertFindingLocated,
  buildFindings,
  buildOk,
  runJson,
  sortedIdentities,
} from "./support.js";

// Minimal declarative configuration (SPEC 7): exactly one spec group, nothing
// else — the CONF-VALID scope.
const SPECS_ONLY_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  }
})
`;

/** A construct's byte window: its own range, end-widened by one byte. */
function byteWindow(
  prefix: string,
  construct: string,
): { start: number; end: number } {
  const start = Buffer.byteLength(prefix, "utf8");
  return { start, end: start + Buffer.byteLength(construct, "utf8") + 1 };
}

/** Stage one single-file workspace and collect its `build --json` findings. */
async function findingsOf(
  product: ProductBinding,
  source: string,
  context: string,
): Promise<readonly Finding[]> {
  const workspace = await TestWorkspace.create({
    files: { "xspec.config.ts": SPECS_ONLY_CONFIG, "specs/A.mdx": source },
  });
  try {
    return await buildFindings(product, workspace, context);
  } finally {
    await workspace.dispose();
  }
}

// T1.3-1: a valid sibling first, so the offending construct is a proper
// sub-range of the file and the location assertion has teeth.
const MISSING_ID_PREFIX = '<S id="ok">\nA valid sibling section.\n</S>\n\n';
const MISSING_ID_CONSTRUCT = "<S>\nThis non-root section lacks an id.\n</S>";
const MISSING_ID_SOURCE = `${MISSING_ID_PREFIX}${MISSING_ID_CONSTRUCT}\n`;

const T1_3_1 = defineProductTest({
  id: "T1.3-1",
  title:
    "a non-root section without `id` fails `build` with condition 14.1 naming the file and location; exit 1 (SPEC 1.3, 14.1)",
  run: async (product) => {
    const context = "T1.3-1 `build --json` over a section without `id`";
    const findings = await findingsOf(product, MISSING_ID_SOURCE, context);
    assertConditionCounts(findings, { "14.1": 1 }, context);
    assertFindingLocated(
      findings[0]!,
      {
        file: "specs/A.mdx",
        window: byteWindow(MISSING_ID_PREFIX, MISSING_ID_CONSTRUCT),
      },
      `${context}: the 14.1 finding`,
    );
  },
});

// T1.3-2: SPEC 1.3's worked example builds; each invalid case from SPEC 1.3
// fails with 14.2 and an error stating the expected form.
const VALID_NESTING_SOURCE = [
  '<S id="login">',
  "Login behavior.",
  "",
  '<S id="login.validCredentials">',
  "A user with valid credentials can log in.",
  "</S>",
  "</S>",
  "",
].join("\n");

interface StructuralArm {
  /** Which SPEC 1.3 invalid case this is (failure diagnostics). */
  readonly name: string;
  readonly prefix: string;
  readonly construct: string;
  readonly suffix: string;
  /**
   * Substring every statement of the expected form exhibits, when the arm
   * admits one: for a child of parent `P`, the expected form is `P.` plus
   * exactly one segment (SPEC 1.3), so any statement of that form — the
   * corrected ID, `P.<segment>`, … — contains `P.`. The top-level arm's
   * expected form (the empty prefix: exactly one segment, 14.2) has no
   * implementation-independent substring, so it asserts none; the
   * discriminating positive/negative segment-count pair is T1.3-4.
   */
  readonly expectedFormMention?: string;
}

const STRUCTURAL_ARMS: readonly StructuralArm[] = [
  {
    name: '`<S id="validCredentials">` nested inside `login`',
    prefix: '<S id="login">\nLogin behavior.\n\n',
    construct:
      '<S id="validCredentials">\nDoes not equal the parent id plus one segment.\n</S>',
    suffix: "\n</S>\n",
    expectedFormMention: "login.",
  },
  {
    name: '`<S id="login.validCredentials">` nested inside `account`',
    prefix: '<S id="account">\nAccount behavior.\n\n',
    construct:
      '<S id="login.validCredentials">\nExtends a different parent id.\n</S>',
    suffix: "\n</S>\n",
    expectedFormMention: "account.",
  },
  {
    name: 'top-level `<S id="auth.login">` with no enclosing `auth`',
    prefix: "",
    construct:
      '<S id="auth.login">\nTop-level, yet the id has two segments.\n</S>',
    suffix: "\n",
  },
];

/**
 * Run one invalid-structure arm: exactly one 14.2 finding, located within the
 * offending construct, stating the expected form where the arm fixes one.
 */
async function runStructuralArm(
  product: ProductBinding,
  arm: StructuralArm,
  testId: string,
): Promise<void> {
  const context = `${testId} \`build --json\` over ${arm.name}`;
  const findings = await findingsOf(
    product,
    arm.prefix + arm.construct + arm.suffix,
    context,
  );
  assertConditionCounts(findings, { "14.2": 1 }, context);
  const finding = findings[0]!;
  assertFindingLocated(
    finding,
    { file: "specs/A.mdx", window: byteWindow(arm.prefix, arm.construct) },
    `${context}: the 14.2 finding`,
  );
  if (arm.expectedFormMention !== undefined) {
    assertReportMentions(
      finding.message,
      [arm.expectedFormMention],
      `${context}: the error states the expected form (SPEC 14.2) — any statement of ` +
        `the form for this child exhibits the parent prefix ` +
        `${JSON.stringify(arm.expectedFormMention)}`,
    );
  }
}

const T1_3_2 = defineProductTest({
  id: "T1.3-2",
  title:
    "valid nesting builds; each invalid case of SPEC 1.3 fails with 14.2 and an error stating the expected form (SPEC 1.3, 14.2)",
  run: async (product) => {
    const validWorkspace = await TestWorkspace.create({
      files: {
        "xspec.config.ts": SPECS_ONLY_CONFIG,
        "specs/A.mdx": VALID_NESTING_SOURCE,
      },
    });
    try {
      await buildOk(
        product,
        validWorkspace,
        "T1.3-2 `build` of the valid nesting (`login` containing `login.validCredentials`)",
      );
    } finally {
      await validWorkspace.dispose();
    }
    for (const arm of STRUCTURAL_ARMS) {
      await runStructuralArm(product, arm, "T1.3-2");
    }
  },
});

const T1_3_3 = defineProductTest({
  id: "T1.3-3",
  title:
    "an ID that skips a level (`a` containing `a.b.c` with no `a.b`) fails with 14.2 (SPEC 1.3, 14.2)",
  run: async (product) => {
    await runStructuralArm(
      product,
      {
        name: "`a` containing `a.b.c` with no `a.b` section",
        prefix: '<S id="a">\nAlpha.\n\n',
        construct: '<S id="a.b.c">\nSkips the level a.b.\n</S>',
        suffix: "\n</S>\n",
        // The offending id `a.b.c` itself contains every prefix-shaped
        // substring of the expected form (`a.`), so no message content is
        // implementation-independently assertable here.
      },
      "T1.3-3",
    );
  },
});

const TOP_LEVEL_MULTI_SEGMENT: StructuralArm = {
  name: "a top-level section with a multi-segment ID",
  prefix: "",
  construct: '<S id="alpha.beta">\nTwo segments at top level.\n</S>',
  suffix: "\n",
  // Checked against the empty prefix (14.2): the expected form — exactly one
  // segment — has no implementation-independent substring to require.
};

const TOP_LEVEL_ONE_SEGMENT_SOURCE =
  '<S id="alpha">\nOne segment at top level.\n</S>\n';

const T1_3_4 = defineProductTest({
  id: "T1.3-4",
  title:
    "a multi-segment top-level ID fails with 14.2 (checked against the empty prefix); a one-segment top-level ID passes (SPEC 1.3, 14.2)",
  run: async (product) => {
    await runStructuralArm(product, TOP_LEVEL_MULTI_SEGMENT, "T1.3-4");
    const workspace = await TestWorkspace.create({
      files: {
        "xspec.config.ts": SPECS_ONLY_CONFIG,
        "specs/A.mdx": TOP_LEVEL_ONE_SEGMENT_SOURCE,
      },
    });
    try {
      await buildOk(
        product,
        workspace,
        "T1.3-4 `build` of a one-segment top-level ID",
      );
    } finally {
      await workspace.dispose();
    }
  },
});

// T1.3-5, same-file arm: two occurrences of one ID, each a known byte range.
const DUP_FIRST = '<S id="dup">\nFirst occurrence.\n</S>';
const DUP_GAP = "\n\n";
const DUP_SECOND = '<S id="dup">\nSecond occurrence.\n</S>';
const DUP_SOURCE = `${DUP_FIRST}${DUP_GAP}${DUP_SECOND}\n`;

const T1_3_5 = defineProductTest({
  id: "T1.3-5",
  title:
    "duplicate IDs in one file fail with 14.3; the same ID in two files is valid — identities differ by path (SPEC 1.3, 1.5, 14.3)",
  run: async (product) => {
    // Same-file arm. SPEC 14.3 defines one condition over the duplicate pair;
    // whether a product reports the duplication once or per occurrence is not
    // fixed, so one or two findings are accepted — every one of them must be
    // 14.3, name the file, and point at one of the two `dup` constructs.
    const sameFileContext =
      "T1.3-5 `build --json` over two sections with the same ID in one file";
    const findings = await findingsOf(product, DUP_SOURCE, sameFileContext);
    const conditions = findings.map((finding) => finding.condition);
    if (
      findings.length < 1 ||
      findings.length > 2 ||
      conditions.some((condition) => condition !== "14.3")
    ) {
      fail(
        `${sameFileContext}: expected the duplicate pair to report condition 14.3 — ` +
          `one finding for the duplication, or one per occurrence — got ` +
          `${JSON.stringify(conditions)}`,
      );
    }
    const firstWindow = byteWindow("", DUP_FIRST);
    const secondWindow = byteWindow(DUP_FIRST + DUP_GAP, DUP_SECOND);
    for (const finding of findings) {
      const findingContext = `${sameFileContext}: a 14.3 finding`;
      assertFindingLocated(finding, { file: "specs/A.mdx" }, findingContext);
      const { location } = finding;
      const within = (window: { start: number; end: number }): boolean =>
        location !== undefined &&
        location.start >= window.start &&
        location.end <= window.end;
      if (!within(firstWindow) && !within(secondWindow)) {
        fail(
          `${findingContext}: its location must point at one of the two duplicate ` +
            `constructs (byte windows [${String(firstWindow.start)}, ${String(firstWindow.end)}] ` +
            `and [${String(secondWindow.start)}, ${String(secondWindow.end)}]); got ` +
            `[${String(location?.start)}, ${String(location?.end)})`,
        );
      }
    }

    // Cross-file arm: uniqueness is per file (SPEC 1.3), identities differ by
    // path (SPEC 1.5) — the build succeeds and both nodes are reported.
    const crossFile = await TestWorkspace.create({
      files: {
        "xspec.config.ts": SPECS_ONLY_CONFIG,
        "specs/A.mdx": '<S id="dup">\nIn file A.\n</S>\n',
        "specs/B.mdx": '<S id="dup">\nIn file B.\n</S>\n',
      },
    });
    try {
      await buildOk(
        product,
        crossFile,
        "T1.3-5 `build` with the same ID in two different files",
      );
      const queryContext = "T1.3-5 `query nodes` over the cross-file workspace";
      const rows = decodeNodeRowsReport(
        await runJson(product, crossFile, ["query", "nodes"], queryContext),
        queryContext,
      );
      const identities = sortedIdentities(rows);
      for (const identity of ["specs/A.mdx#dup", "specs/B.mdx#dup"]) {
        if (!identities.includes(identity)) {
          fail(
            `${queryContext}: expected ${identity} among the reported nodes — the same ` +
              `ID in two files yields two nodes whose identities differ by path ` +
              `(SPEC 1.3, 1.5); got ${JSON.stringify(identities)}`,
          );
        }
      }
    } finally {
      await crossFile.dispose();
    }
  },
});

// T1.3-6: one fixture carrying all three masking-relevant conditions.
//
//   <S>                 → 14.1 (missing id)
//     <S id="a.b">      → immediate child: 14.2 masked by the parent's 14.1
//                         (a non-masking product would flag `a.b` here, so
//                         the exact-count assertion below discriminates)
//       <S id="zzz">    → grandchild: its structural check runs normally
//                         against its parent's id `a.b` → the one 14.2
//     <S id="bad name"> → immediate child: 14.2 masked, but its own other
//                         condition — whitespace in a segment, 14.4 — still
//                         reports
const MASK_PREFIX =
  "<S>\nThe parent section lacks an id.\n\n" +
  '<S id="a.b">\nImmediate child: its structural check is masked by the parent missing an id.\n\n';
const MASK_GRANDCHILD =
  '<S id="zzz">\nGrandchild: checked against its parent id normally.\n</S>';
const MASK_MID = "\n</S>\n\n";
const MASK_BAD_CHILD =
  '<S id="bad name">\nImmediate child: its own non-structural condition still reports.\n</S>';
const MASK_SOURCE = `${MASK_PREFIX}${MASK_GRANDCHILD}${MASK_MID}${MASK_BAD_CHILD}\n</S>\n`;

const T1_3_6 = defineProductTest({
  id: "T1.3-6",
  title:
    "missing-id masking: immediate children of an id-less section report no 14.2, while their other conditions and the grandchildren's structural checks still report (SPEC 1.3, 14.1, 14.2)",
  run: async (product) => {
    const context =
      "T1.3-6 `build --json` over an id-less section with children";
    const findings = await findingsOf(product, MASK_SOURCE, context);
    // Exactly one 14.2 in the whole report: the grandchild's. A product that
    // fails to mask reports additional 14.2s for the immediate children
    // (`a.b` does not extend any parent id and is multi-segment against the
    // empty prefix); a product that over-masks reports none.
    assertConditionCounts(
      findings,
      { "14.1": 1, "14.2": 1, "14.4": 1 },
      context,
    );
    const ofCondition = (condition: string): Finding =>
      findings.find((finding) => finding.condition === condition)!;
    assertFindingLocated(
      ofCondition("14.1"),
      { file: "specs/A.mdx" },
      `${context}: the parent's 14.1 finding`,
    );
    // The one 14.2 must be the grandchild's — located within its construct,
    // which excludes both immediate children's constructs.
    assertFindingLocated(
      ofCondition("14.2"),
      {
        file: "specs/A.mdx",
        window: byteWindow(MASK_PREFIX, MASK_GRANDCHILD),
      },
      `${context}: the grandchild's 14.2 finding (its structural check runs against ` +
        "its parent's id normally)",
    );
    // The `bad name` child's own condition still reports, for that child.
    assertFindingLocated(
      ofCondition("14.4"),
      {
        file: "specs/A.mdx",
        window: byteWindow(
          MASK_PREFIX + MASK_GRANDCHILD + MASK_MID,
          MASK_BAD_CHILD,
        ),
      },
      `${context}: the immediate child's own 14.4 finding (other conditions are not masked)`,
    );
  },
});

/** TEST-SPEC §1.3, in canonical ID order (SUITE-02). */
export const section13Tests: readonly ProductTestEntry[] = [
  T1_3_1,
  T1_3_2,
  T1_3_3,
  T1_3_4,
  T1_3_5,
  T1_3_6,
];
