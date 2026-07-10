// TEST-SPEC §1.4 (ID segments and tags) — SUITE-03: T1.4-1 … T1.4-4.
//
// Registered product-facing bodies (C-2 "one code path"): each builds its own
// fresh workspace (H-1), drives the product strictly as a subprocess (H-2),
// asserts exact exit codes (H-5), decodes output through the H-3 adapters,
// and rejects a product only via diagnosed assertion failures (H-8).
//
// Byte-exact staging (HARNESS-01): every character under test — raw control
// bytes included — is written into the fixture's source bytes exactly as the
// arm declares it (UTF-8 encoded, no BOM, no newline translation), so the
// fixtures stay valid UTF-8 and segment/tag validity (14.4) — never source
// encoding (14.20) — is the condition at stake. In this module's own source
// the characters are constructed from hex code points (visible, tool-safe,
// immune to editor/formatter normalization); the builder encodes the
// resulting strings to the identical raw bytes.
//
// CONF-VALID in-scope: T1.4-1, T1.4-2, T1.4-4 (CERTIFICATIONS.md
// §CONF-VALID). Their fixtures stay within that entry's scope — one
// configured spec group of `.mdx` sources whose sections carry `id`/`tags`
// props only; the command surface is `build` (14.4 reporting) plus
// `query node`, decoded through the minimal identity/tags summary adapter so
// nothing beyond the entry's scoped query surface (identity, tags,
// metadataHash) is demanded of the fixture product. Certification staging
// constraints honored here:
//   - T1.4-1 stages none of U+00A0/U+0085/U+2028 (§VIOL-VALID-WIDE expects
//     T1.4-1 to keep passing under that violator);
//   - non-whitespace control characters appear only in T1.4-1's control arms
//     and T1.4-4's control tag arms (§VIOL-VALID-CTRL).
// T1.4-3 is in no certification entry's scope: it exercises the generated
// module under standard TypeScript tooling (HARNESS-05, SPEC 13.1).
//
// Location assertions follow the SUITE-02 discipline: fixtures are staged as
// prefix + offending construct + suffix with exactly known bytes, and each
// negative arm asserts the finding's location falls within the offending
// construct's end-widened byte window (support.ts `byteWindow`).

import type { Finding } from "../../helpers/adapters/index.js";
import { decodeNodeSummary } from "../../helpers/adapters/index.js";
import { fail } from "../../helpers/assertions.js";
import { defineProductTest } from "../../helpers/registry.js";
import type { ProductTestEntry } from "../../helpers/registry.js";
import type { ProductBinding } from "../../helpers/subprocess.js";
import {
  assertCompileErrorAt,
  assertNoCompileErrors,
  ConsumerProject,
} from "../../helpers/tooling.js";
import { TestWorkspace } from "../../helpers/workspace.js";
import {
  assertConditionCounts,
  assertFindingLocated,
  assertSameJson,
  buildFindings,
  buildOk,
  byteWindow,
  runJson,
} from "./support.js";

// Minimal declarative configuration (SPEC 7): exactly one spec group — the
// CONF-VALID scope.
const SPECS_ONLY_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  }
})
`;

// --- character classes under test (SPEC 1.4, exact) -------------------------

/** `U+XXXX` rendering for arm names and diagnostics. */
function codePointName(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

/** The character under test placed between two ordinary letters. */
function between(codePoint: number): string {
  return `a${String.fromCodePoint(codePoint)}b`;
}

/** SPEC 1.4's whitespace class — exactly these six characters. */
const WHITESPACE_CHARACTERS: readonly (readonly [number, string])[] = [
  [0x0009, "tab"],
  [0x000a, "line feed"],
  [0x000b, "vertical tab"],
  [0x000c, "form feed"],
  [0x000d, "carriage return"],
  [0x0020, "space"],
];

/** Control-class representatives (SPEC 1.4: U+0000–U+001F and U+007F). */
const CONTROL_REPRESENTATIVES: readonly number[] = [0x0000, 0x001f, 0x007f];

/** The forbidden segment names of SPEC 1.4, all five. */
const FORBIDDEN_NAMES: readonly string[] = [
  "$",
  "__proto__",
  "prototype",
  "constructor",
  "then",
];

/**
 * The boundary code points SPEC 1.4 excludes from both character classes:
 * U+00A0 (no-break space), U+0085 (next line), U+2028 (line separator).
 */
const BOUNDARY_CODE_POINTS: readonly (readonly [number, string])[] = [
  [0x00a0, "no-break space"],
  [0x0085, "next line"],
  [0x2028, "line separator"],
];

// --- shared staging ----------------------------------------------------------

// Shared fixture template: a valid sibling first, so each offending construct
// is a proper sub-range of the file and the location assertions have teeth.
// Arms differ from one another only in the one segment or tag under test.
const SIBLING = '<S id="ok">\nA valid sibling section.\n</S>\n\n';

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

/**
 * Run one negative arm over the shared template: `build --json` reports
 * exactly one finding, condition 14.4, located within the offending
 * construct's byte window (SPEC 14: file, location, condition identity).
 */
async function expectSingle144(
  product: ProductBinding,
  construct: string,
  context: string,
): Promise<void> {
  const findings = await findingsOf(
    product,
    `${SIBLING}${construct}\n`,
    context,
  );
  assertConditionCounts(findings, { "14.4": 1 }, context);
  assertFindingLocated(
    findings[0]!,
    { file: "specs/A.mdx", window: byteWindow(SIBLING, construct) },
    `${context}: the 14.4 finding`,
  );
}

// --- T1.4-1 ------------------------------------------------------------------

// The segment-validity matrix. Every representative is staged as its raw
// character between two ordinary letters (or as the whole segment, for the
// forbidden names). U+00A0, U+0085, and U+2028 belong to neither 1.4 class
// and are deliberately absent from this test — they are T1.4-2's (and
// §VIOL-VALID-WIDE's) subject.
interface SegmentArm {
  /** Which SPEC 1.4 rule this segment violates (failure diagnostics). */
  readonly name: string;
  readonly segment: string;
}

const INVALID_SEGMENT_ARMS: readonly SegmentArm[] = [
  { name: '"#" in a segment', segment: "a#b" },
  ...WHITESPACE_CHARACTERS.map(([codePoint, label]) => ({
    name: `whitespace ${codePointName(codePoint)} (${label}) in a segment`,
    segment: between(codePoint),
  })),
  ...CONTROL_REPRESENTATIVES.map((codePoint) => ({
    name: `control character ${codePointName(codePoint)} in a segment`,
    segment: between(codePoint),
  })),
  ...FORBIDDEN_NAMES.map((name) => ({
    name: `forbidden name "${name}" as a segment`,
    segment: name,
  })),
];

function segmentConstruct(segment: string): string {
  return `<S id="${segment}">\nSection with the segment under test.\n</S>`;
}

// Empty segment, nested spelling: `a..b` is reachable only via the chain
// `a` → `a.` → `a..b`, where every level adds exactly one segment — 1.3 is
// satisfied and the empty segment (1.4 → 14.4) is the only condition staged.
// Both `a.` and `a..b` contain an empty segment; whether a product reports
// the violation once or per offending ID is not fixed by SPEC 14, so one or
// two findings are accepted — each must be 14.4 and located within the outer
// offending construct (which contains the inner one).
const EMPTY_NESTED_PREFIX = `${SIBLING}<S id="a">\nAlpha.\n\n`;
const EMPTY_NESTED_CONSTRUCT = [
  '<S id="a.">',
  "Introduces the empty segment.",
  "",
  '<S id="a..b">',
  "Nested under the empty segment.",
  "</S>",
  "</S>",
].join("\n");
const EMPTY_NESTED_SOURCE = `${EMPTY_NESTED_PREFIX}${EMPTY_NESTED_CONSTRUCT}\n</S>\n`;

const T1_4_1 = defineProductTest({
  id: "T1.4-1",
  title:
    'segment validity matrix: empty segments (`a..b` via nesting and a lone `id=""`), `#`, each whitespace character, each control-class representative, and each forbidden name fail with 14.4 (SPEC 1.4, 14.4)',
  run: async (product) => {
    // Template control: the base workspace differs from every negative arm
    // only in the one segment, so each arm's 14.4 is attributable to the
    // segment alone, not to the template.
    const control = await TestWorkspace.create({
      files: {
        "xspec.config.ts": SPECS_ONLY_CONFIG,
        "specs/A.mdx": `${SIBLING}${segmentConstruct("okseg")}\n`,
      },
    });
    try {
      await buildOk(
        product,
        control,
        "T1.4-1 `build` of the base template with a valid segment",
      );
    } finally {
      await control.dispose();
    }

    // Empty segment via nesting (`a..b`).
    const nestedContext =
      "T1.4-1 `build --json` over the nested empty segment (`a` -> `a.` -> `a..b`)";
    const nested = await TestWorkspace.create({
      files: {
        "xspec.config.ts": SPECS_ONLY_CONFIG,
        "specs/A.mdx": EMPTY_NESTED_SOURCE,
      },
    });
    try {
      const findings = await buildFindings(product, nested, nestedContext);
      const conditions = findings.map((finding) => finding.condition);
      if (
        findings.length < 1 ||
        findings.length > 2 ||
        conditions.some((condition) => condition !== "14.4")
      ) {
        fail(
          `${nestedContext}: expected the empty segment to report condition 14.4 — one ` +
            `finding, or one per offending ID (\`a.\` and \`a..b\` both contain it) — and ` +
            `nothing else (the nesting keeps 1.3 satisfied); got ${JSON.stringify(conditions)}`,
        );
      }
      const window = byteWindow(EMPTY_NESTED_PREFIX, EMPTY_NESTED_CONSTRUCT);
      for (const finding of findings) {
        assertFindingLocated(
          finding,
          { file: "specs/A.mdx", window },
          `${nestedContext}: a 14.4 finding`,
        );
      }
    } finally {
      await nested.dispose();
    }

    // Empty segment as a lone empty id: one empty segment, so 1.3's
    // exactly-one-segment top-level rule holds and 14.4 alone reports.
    await expectSingle144(
      product,
      '<S id="">\nLone empty id.\n</S>',
      'T1.4-1 `build --json` over a lone empty `id=""`',
    );

    for (const arm of INVALID_SEGMENT_ARMS) {
      await expectSingle144(
        product,
        segmentConstruct(arm.segment),
        `T1.4-1 \`build --json\` with ${arm.name}`,
      );
    }
  },
});

// --- T1.4-2 ------------------------------------------------------------------

/** One section per boundary code point; IDs differ in the middle character. */
const BOUNDARY_SEGMENT_IDS: readonly string[] = BOUNDARY_CODE_POINTS.map(
  ([codePoint]) => between(codePoint),
);

const BOUNDARY_SEGMENTS_SOURCE = BOUNDARY_CODE_POINTS.map(
  ([codePoint, label]) =>
    `<S id="${between(codePoint)}">\nSegment containing the ${label} character.\n</S>\n`,
).join("\n");

const T1_4_2 = defineProductTest({
  id: "T1.4-2",
  title:
    "segments containing U+00A0, U+0085, and U+2028 are valid — SPEC 1.4 excludes them from both character classes: builds succeed and the nodes are queryable by identity (SPEC 1.4)",
  run: async (product) => {
    const workspace = await TestWorkspace.create({
      files: {
        "xspec.config.ts": SPECS_ONLY_CONFIG,
        "specs/A.mdx": BOUNDARY_SEGMENTS_SOURCE,
      },
    });
    try {
      await buildOk(
        product,
        workspace,
        "T1.4-2 `build` over segments containing U+00A0, U+0085, and U+2028",
      );
      for (const id of BOUNDARY_SEGMENT_IDS) {
        const identity = `specs/A.mdx#${id}`;
        const label = `T1.4-2 \`query node\` addressing ${JSON.stringify(identity)}`;
        const summary = decodeNodeSummary(
          await runJson(product, workspace, ["query", "node", identity], label),
          label,
        );
        if (summary.identity !== identity) {
          fail(
            `${label}: the node must be queryable by its identity (SPEC 1.4, 1.5); ` +
              `expected identity ${JSON.stringify(identity)}, got ` +
              JSON.stringify(summary.identity),
          );
        }
      }
    } finally {
      await workspace.dispose();
    }
  },
});

// --- T1.4-3 ------------------------------------------------------------------

// A valid non-identifier segment, exposed via bracket notation in the
// generated module (SPEC 2.4/4.1) — exercised under standard TypeScript
// tooling with no xspec runtime dependency (SPEC 13.1, HARNESS-05). The
// bracket consumer must compile cleanly (the property type-checks and
// resolves); the dot consumer must fail at `login` — `SPEC.login-v2` parses
// as `(SPEC.login) - v2`, so no dot spelling can name the `login-v2`
// property, and against a conforming skeleton `login` is no property at all.
// The pair also discriminates an `any`-typed default export (both consumers
// would compile, but the dot consumer would carry no error at `login`).
const DASH_SEGMENT_SOURCE = '<S id="login-v2">\nDashed segment.\n</S>\n';

const BRACKET_CONSUMER = [
  'import SPEC from "./specs/A.xspec";',
  "",
  'SPEC["login-v2"];',
  "",
].join("\n");

const DOT_CONSUMER = [
  'import SPEC from "./specs/A.xspec";',
  "",
  "SPEC.login-v2;",
  "",
].join("\n");

const T1_4_3 = defineProductTest({
  id: "T1.4-3",
  title:
    'a non-identifier segment like `login-v2` is valid; the generated module exposes it via bracket notation — `SPEC["login-v2"]` type-checks and resolves, dot access is a type error (SPEC 1.4, 2.4, 4.1)',
  run: async (product) => {
    const workspace = await TestWorkspace.create({
      files: {
        "xspec.config.ts": SPECS_ONLY_CONFIG,
        "specs/A.mdx": DASH_SEGMENT_SOURCE,
      },
    });
    try {
      await buildOk(
        product,
        workspace,
        "T1.4-3 `build` over the non-identifier segment `login-v2`",
      );
      await workspace.file("consumer.ts", BRACKET_CONSUMER);
      await workspace.file("dot-consumer.ts", DOT_CONSUMER);
      const bracket = await ConsumerProject.load({
        rootDir: workspace.root,
        rootFiles: ["consumer.ts"],
      });
      assertNoCompileErrors(
        bracket,
        'T1.4-3 consumer accessing SPEC["login-v2"] via bracket notation (SPEC 2.4, 4.1)',
      );
      const dot = await ConsumerProject.load({
        rootDir: workspace.root,
        rootFiles: ["dot-consumer.ts"],
      });
      assertCompileErrorAt(
        dot,
        dot.locate("dot-consumer.ts", "SPEC.login-v2", {
          charOffset: "SPEC.".length,
        }),
        {},
        "T1.4-3 dot access to the non-identifier segment (`SPEC.login-v2` cannot name " +
          "the `login-v2` property — a type error, SPEC 1.4/4.1)",
      );
    } finally {
      await workspace.dispose();
    }
  },
});

// --- T1.4-4 ------------------------------------------------------------------

// Tags follow the segment rules except `.` is allowed. The boundary code
// points of T1.4-2 apply to tags too — and since none of the three is 1.4
// whitespace, 2.6 splitting must not split on them: each staged value is
// exactly one tag, asserted exactly (a product splitting on U+00A0 would
// report two tags; §VIOL-VALID-WIDE rejects the value outright at `build`).
// The empty and whitespace rules of 1.4 admit no invalid-tag fixture: `tags`
// splits on runs of 1.4 whitespace with leading/trailing whitespace ignored
// (2.6), so no tag token can be empty or contain whitespace — whitespace-only
// values behave as omitted (T2.6-2), and the whitespace control characters
// U+0009–U+000D are split away as separators.
interface TagArm {
  readonly name: string;
  readonly tag: string;
}

const VALID_TAG_ARMS: readonly TagArm[] = [
  { name: 'a tag containing "." (valid for tags)', tag: "a.b" },
  ...BOUNDARY_CODE_POINTS.map(([codePoint, label]) => ({
    name: `a tag containing ${codePointName(codePoint)} (${label})`,
    tag: between(codePoint),
  })),
];

const INVALID_TAG_ARMS: readonly TagArm[] = [
  { name: 'a tag containing "#"', tag: "a#b" },
  { name: 'a tag that is the forbidden name "__proto__"', tag: "__proto__" },
  ...([0x0000, 0x007f] as const).map((codePoint) => ({
    name: `a tag containing the non-whitespace control character ${codePointName(codePoint)}`,
    tag: between(codePoint),
  })),
];

function taggedConstruct(tags: string): string {
  return `<S id="sec" tags="${tags}">\nTagged section.\n</S>`;
}

const T1_4_4 = defineProductTest({
  id: "T1.4-4",
  title:
    "tags: `.` is valid; `#`, a forbidden name, and non-whitespace control characters fail with 14.4; the T1.4-2 boundary code points are valid in tags and never split (SPEC 1.4, 2.6, 14.4)",
  run: async (product) => {
    for (const arm of VALID_TAG_ARMS) {
      const workspace = await TestWorkspace.create({
        files: {
          "xspec.config.ts": SPECS_ONLY_CONFIG,
          "specs/A.mdx": `${SIBLING}${taggedConstruct(arm.tag)}\n`,
        },
      });
      try {
        await buildOk(product, workspace, `T1.4-4 \`build\` with ${arm.name}`);
        const label = `T1.4-4 \`query node specs/A.mdx#sec\` (${arm.name})`;
        const summary = decodeNodeSummary(
          await runJson(
            product,
            workspace,
            ["query", "node", "specs/A.mdx#sec"],
            label,
          ),
          label,
        );
        assertSameJson(
          summary.tags,
          [arm.tag],
          `${label}: exactly the one staged tag — valid per SPEC 1.4, and not split ` +
            "(2.6 splits only on 1.4 whitespace, which excludes this code point)",
        );
      } finally {
        await workspace.dispose();
      }
    }
    for (const arm of INVALID_TAG_ARMS) {
      await expectSingle144(
        product,
        taggedConstruct(arm.tag),
        `T1.4-4 \`build --json\` with ${arm.name}`,
      );
    }
  },
});

/** TEST-SPEC §1.4, in canonical ID order (SUITE-03). */
export const section14Tests: readonly ProductTestEntry[] = [
  T1_4_1,
  T1_4_2,
  T1_4_3,
  T1_4_4,
];
