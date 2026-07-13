// S-5 Output adapters self-test (TEST-SPEC 17). Each H-3 adapter rejects
// documents missing required information — fed synthetic wrong-shape
// documents — rather than defaulting: rejection is a diagnosed
// HarnessAssertionError (the failure shape product-facing tests must produce
// against a stub product, H-8), never a decoded value with fabricated
// content, and never a harness crash. Every adapter also has a positive
// control (a well-shaped document decodes to exactly the modeled
// information), because an adapter that rejected everything would be equally
// wrong and certification depends on these decoders passing conforming
// output through.
//
// The same S-5 discipline covers the rest of the H-3 layer this harness
// owns: the human-report required-information matcher, the T10.1-4
// session-corruption staging transformations (shape-aware, value-blind,
// failing loudly — file untouched — on shape mismatch), and the T13.4-1
// byte-sorted-keys assertion (which must judge the *written* key order, not
// JavaScript object key order, and byte order, not UTF-16 order).

import { Buffer } from "node:buffer";
import { expect, onTestFinished, test } from "vitest";
import { HarnessAssertionError } from "../helpers/assertions.js";
import type { RunResult } from "../helpers/subprocess.js";
import {
  ITEM_STATUSES,
  assertJsonKeysByteSorted,
  assertReportMentions,
  classifyIgnoredReasons,
  conditionMention,
  decodeCoverageReport,
  decodeEdgesReport,
  decodeExportReport,
  decodeFindingsReport,
  decodeIdsReport,
  decodeIdsTreeReport,
  decodeImpactReport,
  decodeItemReport,
  decodeNextReport,
  decodeNodeMetadataSummary,
  decodeNodeReport,
  decodeNodeRowsReport,
  decodeNodeSummary,
  decodeNodeSummaryRowsReport,
  decodeReachableReport,
  decodeSessionListReport,
  decodeSessionStatusReport,
  stageBlockedByAbsentItem,
  stageBlockedByCycle,
  stageDeleteItemField,
  stageDuplicateItemEntry,
  stageGarbleCreationParameters,
  stageUnknownItemStatus,
} from "../helpers/adapters/index.js";
import { TestWorkspace } from "../helpers/workspace.js";

// --- shared machinery -------------------------------------------------------

/** Deep-clone a JSON document, remove the member at the path, return it. */
function omit(doc: unknown, ...steps: (string | number)[]): unknown {
  const copy = structuredClone(doc);
  const last = steps[steps.length - 1];
  let cursor: unknown = copy;
  for (const step of steps.slice(0, -1)) {
    cursor = (cursor as Record<string | number, unknown>)[step];
  }
  if (Array.isArray(cursor) && typeof last === "number") {
    cursor.splice(last, 1);
  } else {
    delete (cursor as Record<string | number, unknown>)[last as string];
  }
  return copy;
}

/** Deep-clone a JSON document, replace the member at the path, return it. */
function put(
  doc: unknown,
  value: unknown,
  ...steps: (string | number)[]
): unknown {
  const copy = structuredClone(doc);
  const last = steps[steps.length - 1];
  let cursor: unknown = copy;
  for (const step of steps.slice(0, -1)) {
    cursor = (cursor as Record<string | number, unknown>)[step];
  }
  (cursor as Record<string | number, unknown>)[last as string | number] = value;
  return copy;
}

function describeOutcome(value: unknown): string {
  let rendered: string;
  try {
    rendered = JSON.stringify(value) ?? String(value);
  } catch {
    rendered = String(value);
  }
  return rendered.length > 200 ? `${rendered.slice(0, 200)}…` : rendered;
}

/**
 * The call must fail as a diagnosed HarnessAssertionError (S-5: reject,
 * never default). Success and any other exception are self-test failures.
 */
function expectDiagnosed(
  label: string,
  run: () => unknown,
): HarnessAssertionError {
  let result: unknown;
  try {
    result = run();
  } catch (error) {
    if (error instanceof HarnessAssertionError) return error;
    throw new Error(
      `${label}: expected a diagnosed HarnessAssertionError, but a harness error escaped: ${String(error)}`,
    );
  }
  throw new Error(
    `${label}: expected a diagnosed HarnessAssertionError (H-3/S-5: adapters reject wrong shapes rather than defaulting), but the call succeeded with ${describeOutcome(result)}`,
  );
}

async function expectDiagnosedAsync(
  label: string,
  run: () => Promise<unknown>,
): Promise<HarnessAssertionError> {
  let result: unknown;
  try {
    result = await run();
  } catch (error) {
    if (error instanceof HarnessAssertionError) return error;
    throw new Error(
      `${label}: expected a diagnosed HarnessAssertionError, but a harness error escaped: ${String(error)}`,
    );
  }
  throw new Error(
    `${label}: expected a diagnosed HarnessAssertionError (H-3/S-5: reject, never default), but the call succeeded with ${describeOutcome(result)}`,
  );
}

// --- well-shaped documents (positive controls) ------------------------------

const EDGE_IN = {
  from: "src/login.ts#handler",
  to: "specs/A.mdx#login",
  kind: "references",
};
const EDGE_OUT = {
  from: "specs/A.mdx#login",
  to: "specs/B.mdx#account",
  kind: "depends",
};

const GOOD_NODE = {
  identity: "specs/A.mdx#login",
  sourceRange: { start: 12, end: 96 },
  ownText: "Login must work.\n",
  subtreeText: "Login must work.\n\nDetails.\n",
  hashes: {
    ownHash: "own-1",
    subtreeHash: "sub-1",
    effectiveHash: "eff-1",
    metadataHash: "meta-1",
  },
  tags: ["auth", "v2"],
  coverage: "none",
  edges: { incoming: [EDGE_IN], outgoing: [EDGE_OUT] },
};

const GOOD_ROWS = {
  nodes: [
    {
      identity: "specs/A.mdx#login",
      sourceRange: { start: 12, end: 96 },
      tags: ["auth"],
      coverage: "none",
    },
    // A root row: coverage attribute absent (T1.2-3, T11-3).
    { identity: "specs/A.mdx", sourceRange: { start: 0, end: 120 }, tags: [] },
  ],
};

const GOOD_EDGES = { edges: [EDGE_IN, EDGE_OUT] };

const GOOD_REACHABLE = {
  reachable: true,
  path: ["specs/A.mdx#login", "specs/B.mdx#account"],
};

const GOOD_IDS = {
  files: [
    { file: "specs/A.mdx", ids: ["login", "login.validCredentials"] },
    { file: "specs/B.mdx", ids: ["account"] },
  ],
};

const GOOD_IDS_TREE = {
  files: [
    {
      file: "specs/A.mdx",
      nodes: [
        {
          id: "login",
          children: [{ id: "login.validCredentials", children: [] }],
        },
      ],
    },
  ],
};

const GOOD_FINDINGS = {
  findings: [
    {
      condition: "14.2",
      message: 'expected <S id="validCredentials"> nested inside login',
      file: "specs/A.mdx",
      location: { start: 40, end: 78 },
    },
    {
      condition: "14.12",
      message: "policy rule violated",
      rule: "no-derived-to-base",
      edge: EDGE_OUT,
    },
    {
      condition: "14.9",
      message: "dependency cycle",
      cycle: ["specs/A.mdx#a", "specs/B.mdx#b", "specs/A.mdx#a"],
    },
  ],
};

const GOOD_COVERAGE = {
  profiles: [
    {
      name: "core",
      counts: { required: 3, covered: 1, uncovered: 1, ignored: 1 },
      covered: [
        {
          identity: "specs/B.mdx#account",
          path: ["specs/A.mdx#login", "specs/B.mdx#account"],
        },
      ],
      uncovered: ["specs/B.mdx#account.close"],
      ignored: [{ identity: "specs/B.mdx", reasons: ["root node"] }],
    },
  ],
};

const GOOD_IMPACT = {
  baseline: "a1b2c3d",
  requirements: [
    {
      nodes: ["specs/A.mdx#login"],
      deleted: false,
      categories: [{ category: "changed", attributedTo: [] }],
    },
    {
      // A collapsed ancestor chain (T9.3-1) and a deleted entry (T9.3-3).
      nodes: ["specs/A.mdx", "specs/A.mdx#login"],
      deleted: true,
      categories: [
        { category: "descendant-changed", attributedTo: ["specs/A.mdx#login"] },
      ],
    },
  ],
  code: {
    direct: [
      {
        location: "src/login.ts#handler",
        edge: EDGE_IN,
        path: ["specs/A.mdx#login"],
      },
    ],
    transitive: [],
  },
};

const GOOD_SESSION_LIST = {
  sessions: [
    {
      name: "B",
      corrupt: false,
      strategy: "audit",
      counts: { unresolved: 2, updated: 1 },
    },
    { name: "a", corrupt: true },
  ],
};

const GOOD_SESSION_STATUS = {
  items: [
    {
      id: "item-1",
      kind: "subtree-coherence",
      scope: "specs/A.mdx#login",
      status: "unresolved",
      blocked: false,
    },
  ],
  totals: { unresolved: 1 },
};

const GOOD_ITEM = {
  id: "item-1",
  kind: "parent-consistency",
  status: "invalidated",
  blocked: true,
  blockedBy: ["item-0"],
  reason: "changed branches under the scope node",
  note: "checked once",
  scope: {
    node: "specs/A.mdx#login",
    present: true,
    text: "Login must work.\n",
    sourceRange: { start: 12, end: 96 },
  },
  context: [
    {
      node: "specs/A.mdx#login.validCredentials",
      present: true,
      text: "Branch.\n",
    },
    // An absent node: presented with identity and presence alone (T10.7-12).
    { node: "specs/A.mdx#login.badCredentials", present: false },
  ],
  origin: [
    {
      node: "specs/A.mdx#login.validCredentials",
      before: { present: true, text: "old text\n" },
      after: { present: false },
    },
  ],
  baseline: { recorded: ["opaque", "product-shaped"] },
  current: null, // opaque member: null is a legitimate "none recorded"
};

const GOOD_NEXT = { fullyResolved: false, item: GOOD_ITEM };
const GOOD_NEXT_RESOLVED = { fullyResolved: true };

const GOOD_EXPORT = {
  name: "review-1",
  strategy: "audit",
  creationParameters: null,
  decompositions: [],
  items: [GOOD_ITEM],
};

// --- decoder table -----------------------------------------------------------

interface BadCase {
  readonly label: string;
  readonly doc: unknown;
}

interface DecoderSpec {
  readonly name: string;
  readonly decode: (doc: unknown) => unknown;
  readonly good: unknown;
  readonly verify: (decoded: never) => void;
  readonly alsoGood?: readonly {
    label: string;
    doc: unknown;
    verify?: (decoded: never) => void;
  }[];
  readonly bad: readonly BadCase[];
}

const GENERIC_BAD: readonly BadCase[] = [
  { label: "null document", doc: null },
  { label: "array document", doc: [] },
  { label: "string document", doc: "not a report" },
  { label: "number document", doc: 42 },
];

const DECODERS: readonly DecoderSpec[] = [
  {
    name: "query node/show",
    decode: decodeNodeReport,
    good: GOOD_NODE,
    verify: (decoded: ReturnType<typeof decodeNodeReport>) => {
      expect(decoded.identity).toBe("specs/A.mdx#login");
      expect(decoded.sourceRange).toEqual({ start: 12, end: 96 });
      expect(decoded.ownText).toBe("Login must work.\n");
      expect(decoded.hashes.metadataHash).toBe("meta-1");
      expect(decoded.tags).toEqual(["auth", "v2"]);
      expect(decoded.coverage).toBe("none");
      expect(decoded.incomingEdges).toEqual([EDGE_IN]);
      expect(decoded.outgoingEdges).toEqual([EDGE_OUT]);
    },
    alsoGood: [
      {
        label: "root node: coverage attribute absent",
        doc: omit(GOOD_NODE, "coverage"),
        verify: (decoded: ReturnType<typeof decodeNodeReport>) => {
          expect(decoded.coverage).toBeUndefined();
        },
      },
      {
        label: "null coverage reads as absent (never as a fabricated value)",
        doc: put(GOOD_NODE, null, "coverage"),
        verify: (decoded: ReturnType<typeof decodeNodeReport>) => {
          expect(decoded.coverage).toBeUndefined();
        },
      },
    ],
    bad: [
      { label: "missing identity", doc: omit(GOOD_NODE, "identity") },
      { label: "empty identity", doc: put(GOOD_NODE, "", "identity") },
      { label: "missing sourceRange", doc: omit(GOOD_NODE, "sourceRange") },
      {
        label: "negative offset",
        doc: put(GOOD_NODE, -1, "sourceRange", "start"),
      },
      {
        label: "stringly-typed offset",
        doc: put(GOOD_NODE, "12", "sourceRange", "start"),
      },
      {
        label: "range with end < start",
        doc: put(GOOD_NODE, 5, "sourceRange", "end"),
      },
      { label: "missing ownText", doc: omit(GOOD_NODE, "ownText") },
      { label: "non-string ownText", doc: put(GOOD_NODE, 7, "ownText") },
      { label: "missing subtreeText", doc: omit(GOOD_NODE, "subtreeText") },
      { label: "missing hashes", doc: omit(GOOD_NODE, "hashes") },
      {
        label: "missing metadataHash",
        doc: omit(GOOD_NODE, "hashes", "metadataHash"),
      },
      { label: "empty ownHash", doc: put(GOOD_NODE, "", "hashes", "ownHash") },
      { label: "missing tags", doc: omit(GOOD_NODE, "tags") },
      { label: "non-string tag", doc: put(GOOD_NODE, [3], "tags") },
      {
        label: "wrong-typed coverage (must reject, not default to absent)",
        doc: put(GOOD_NODE, 42, "coverage"),
      },
      { label: "missing edges", doc: omit(GOOD_NODE, "edges") },
      {
        label: "missing incoming edges",
        doc: omit(GOOD_NODE, "edges", "incoming"),
      },
      {
        label: "outgoing edges not an array",
        doc: put(GOOD_NODE, {}, "edges", "outgoing"),
      },
      {
        label: "unknown edge kind",
        doc: put(GOOD_NODE, "dependz", "edges", "outgoing", 0, "kind"),
      },
      {
        label: "edge missing its target",
        doc: omit(GOOD_NODE, "edges", "incoming", 0, "to"),
      },
    ],
  },
  {
    name: "query node (identity/tags summary)",
    decode: decodeNodeSummary,
    good: GOOD_NODE,
    verify: (decoded: ReturnType<typeof decodeNodeSummary>) => {
      expect(decoded.identity).toBe("specs/A.mdx#login");
      expect(decoded.tags).toEqual(["auth", "v2"]);
    },
    alsoGood: [
      {
        // The point of the summary decoder: a document carrying only the
        // CONF-VALID-scoped query surface decodes — nothing beyond identity
        // and tags is demanded of the fixture product (CERTIFICATIONS.md
        // §CONF-VALID; T1.4-2, T1.4-4).
        label: "a document carrying only the scoped summary fields",
        doc: { identity: "specs/A.mdx#root-only", tags: [] },
        verify: (decoded: ReturnType<typeof decodeNodeSummary>) => {
          expect(decoded.identity).toBe("specs/A.mdx#root-only");
          expect(decoded.tags).toEqual([]);
        },
      },
    ],
    bad: [
      { label: "missing identity", doc: omit(GOOD_NODE, "identity") },
      { label: "empty identity", doc: put(GOOD_NODE, "", "identity") },
      { label: "missing tags", doc: omit(GOOD_NODE, "tags") },
      { label: "non-string tag", doc: put(GOOD_NODE, [3], "tags") },
    ],
  },
  {
    name: "query node (identity/tags/metadataHash summary)",
    decode: decodeNodeMetadataSummary,
    good: GOOD_NODE,
    verify: (decoded: ReturnType<typeof decodeNodeMetadataSummary>) => {
      expect(decoded.identity).toBe("specs/A.mdx#login");
      expect(decoded.tags).toEqual(["auth", "v2"]);
      expect(decoded.metadataHash).toBe("meta-1");
    },
    alsoGood: [
      {
        // The point of this summary decoder: a document carrying only the
        // CONF-VALID-scoped query surface — identity, tags, and metadataHash,
        // no other hash — decodes (CERTIFICATIONS.md §CONF-VALID; T2.6-1,
        // T2.6-2).
        label: "a document carrying only the scoped summary fields",
        doc: {
          identity: "specs/A.mdx#tagged",
          tags: ["a", "b"],
          hashes: { metadataHash: "meta-9" },
        },
        verify: (
          decoded: ReturnType<typeof decodeNodeMetadataSummary>,
        ): void => {
          expect(decoded.identity).toBe("specs/A.mdx#tagged");
          expect(decoded.tags).toEqual(["a", "b"]);
          expect(decoded.metadataHash).toBe("meta-9");
        },
      },
    ],
    bad: [
      { label: "missing identity", doc: omit(GOOD_NODE, "identity") },
      { label: "missing tags", doc: omit(GOOD_NODE, "tags") },
      { label: "missing hashes", doc: omit(GOOD_NODE, "hashes") },
      {
        label: "missing metadataHash",
        doc: omit(GOOD_NODE, "hashes", "metadataHash"),
      },
      {
        label: "empty metadataHash",
        doc: put(GOOD_NODE, "", "hashes", "metadataHash"),
      },
    ],
  },
  {
    name: "query nodes (identity/tags summary rows)",
    decode: decodeNodeSummaryRowsReport,
    good: GOOD_ROWS,
    verify: (decoded: ReturnType<typeof decodeNodeSummaryRowsReport>) => {
      expect(decoded).toEqual([
        { identity: "specs/A.mdx#login", tags: ["auth"] },
        { identity: "specs/A.mdx", tags: [] },
      ]);
    },
    alsoGood: [
      {
        // Rows carrying only the CONF-VALID-scoped surface decode: no source
        // range is demanded of a scoped fixture product (CERTIFICATIONS.md
        // §CONF-VALID; T2.6-1).
        label: "rows carrying only the scoped summary fields",
        doc: { nodes: [{ identity: "specs/A.mdx#tagged", tags: ["a", "b"] }] },
        verify: (
          decoded: ReturnType<typeof decodeNodeSummaryRowsReport>,
        ): void => {
          expect(decoded).toEqual([
            { identity: "specs/A.mdx#tagged", tags: ["a", "b"] },
          ]);
        },
      },
    ],
    bad: [
      { label: "missing nodes list", doc: {} },
      { label: "nodes not an array", doc: { nodes: {} } },
      { label: "row not an object", doc: { nodes: [7] } },
      {
        label: "row missing identity",
        doc: omit(GOOD_ROWS, "nodes", 0, "identity"),
      },
      { label: "row missing tags", doc: omit(GOOD_ROWS, "nodes", 1, "tags") },
      {
        label: "row with a non-string tag",
        doc: put(GOOD_ROWS, [3], "nodes", 0, "tags"),
      },
    ],
  },
  {
    name: "query nodes/subtree/ancestors",
    decode: decodeNodeRowsReport,
    good: GOOD_ROWS,
    verify: (decoded: ReturnType<typeof decodeNodeRowsReport>) => {
      expect(decoded).toHaveLength(2);
      expect(decoded[0].identity).toBe("specs/A.mdx#login");
      expect(decoded[0].coverage).toBe("none");
      expect(decoded[1].identity).toBe("specs/A.mdx");
      expect(decoded[1].coverage).toBeUndefined();
      expect(decoded[1].tags).toEqual([]);
    },
    bad: [
      { label: "missing nodes list", doc: {} },
      { label: "nodes not an array", doc: { nodes: {} } },
      { label: "row not an object", doc: { nodes: [7] } },
      {
        label: "row missing identity",
        doc: omit(GOOD_ROWS, "nodes", 0, "identity"),
      },
      {
        label: "row missing sourceRange",
        doc: omit(GOOD_ROWS, "nodes", 0, "sourceRange"),
      },
      { label: "row missing tags", doc: omit(GOOD_ROWS, "nodes", 1, "tags") },
      {
        label: "row with wrong-typed coverage",
        doc: put(GOOD_ROWS, false, "nodes", 0, "coverage"),
      },
    ],
  },
  {
    name: "query edges",
    decode: decodeEdgesReport,
    good: GOOD_EDGES,
    verify: (decoded: ReturnType<typeof decodeEdgesReport>) => {
      expect(decoded).toEqual([EDGE_IN, EDGE_OUT]);
    },
    bad: [
      { label: "missing edges list", doc: {} },
      { label: "edge not an object", doc: { edges: [null] } },
      { label: "edge missing from", doc: omit(GOOD_EDGES, "edges", 0, "from") },
      {
        label: "edge with empty from",
        doc: put(GOOD_EDGES, "", "edges", 0, "from"),
      },
      { label: "edge missing kind", doc: omit(GOOD_EDGES, "edges", 1, "kind") },
      {
        label: "unknown edge kind",
        doc: put(GOOD_EDGES, "linked", "edges", 1, "kind"),
      },
    ],
  },
  {
    name: "query reachable",
    decode: decodeReachableReport,
    good: GOOD_REACHABLE,
    verify: (decoded: ReturnType<typeof decodeReachableReport>) => {
      expect(decoded.reachable).toBe(true);
      expect(decoded.path).toEqual([
        "specs/A.mdx#login",
        "specs/B.mdx#account",
      ]);
    },
    alsoGood: [
      {
        label: "unreachable: no witness path",
        doc: { reachable: false },
        verify: (decoded: ReturnType<typeof decodeReachableReport>) => {
          expect(decoded.reachable).toBe(false);
          expect(decoded.path).toBeUndefined();
        },
      },
    ],
    bad: [
      { label: "missing reachable flag", doc: { path: ["a"] } },
      {
        label: "stringly-typed reachable",
        doc: put(GOOD_REACHABLE, "yes", "reachable"),
      },
      { label: "reachable without a path", doc: omit(GOOD_REACHABLE, "path") },
      {
        label: "reachable with an empty path",
        doc: put(GOOD_REACHABLE, [], "path"),
      },
      {
        label: "path with an empty identity",
        doc: put(GOOD_REACHABLE, ["a", ""], "path"),
      },
      {
        label: "unreachable yet carrying a path (contradiction)",
        doc: { reachable: false, path: ["a"] },
      },
    ],
  },
  {
    name: "ids",
    decode: decodeIdsReport,
    good: GOOD_IDS,
    verify: (decoded: ReturnType<typeof decodeIdsReport>) => {
      expect(decoded.files.map((f) => f.file)).toEqual([
        "specs/A.mdx",
        "specs/B.mdx",
      ]);
      expect(decoded.files[0].ids).toEqual(["login", "login.validCredentials"]);
    },
    bad: [
      { label: "missing files list", doc: {} },
      { label: "entry missing file", doc: omit(GOOD_IDS, "files", 0, "file") },
      { label: "entry missing ids", doc: omit(GOOD_IDS, "files", 1, "ids") },
      {
        label: "ids not an array",
        doc: put(GOOD_IDS, "login", "files", 0, "ids"),
      },
      {
        label: "empty id",
        doc: put(GOOD_IDS, ["login", ""], "files", 0, "ids"),
      },
    ],
  },
  {
    name: "ids --tree",
    decode: decodeIdsTreeReport,
    good: GOOD_IDS_TREE,
    verify: (decoded: ReturnType<typeof decodeIdsTreeReport>) => {
      expect(decoded.files[0].nodes[0].id).toBe("login");
      expect(decoded.files[0].nodes[0].children[0].id).toBe(
        "login.validCredentials",
      );
      expect(decoded.files[0].nodes[0].children[0].children).toEqual([]);
    },
    bad: [
      { label: "missing files list", doc: {} },
      {
        label: "node missing id",
        doc: omit(GOOD_IDS_TREE, "files", 0, "nodes", 0, "id"),
      },
      {
        label: "node missing children",
        doc: omit(GOOD_IDS_TREE, "files", 0, "nodes", 0, "children"),
      },
      {
        label: "nested node missing children",
        doc: omit(
          GOOD_IDS_TREE,
          "files",
          0,
          "nodes",
          0,
          "children",
          0,
          "children",
        ),
      },
      {
        label: "children not an array",
        doc: put(GOOD_IDS_TREE, {}, "files", 0, "nodes", 0, "children"),
      },
    ],
  },
  {
    name: "build/check findings",
    decode: decodeFindingsReport,
    good: GOOD_FINDINGS,
    verify: (decoded: ReturnType<typeof decodeFindingsReport>) => {
      expect(decoded.findings).toHaveLength(3);
      expect(decoded.findings[0].condition).toBe("14.2");
      expect(decoded.findings[0].file).toBe("specs/A.mdx");
      expect(decoded.findings[0].location).toEqual({ start: 40, end: 78 });
      expect(decoded.findings[1].rule).toBe("no-derived-to-base");
      expect(decoded.findings[1].edge).toEqual(EDGE_OUT);
      expect(decoded.findings[2].cycle).toEqual([
        "specs/A.mdx#a",
        "specs/B.mdx#b",
        "specs/A.mdx#a",
      ]);
    },
    bad: [
      { label: "missing findings list", doc: {} },
      {
        label: "finding missing condition",
        doc: omit(GOOD_FINDINGS, "findings", 0, "condition"),
      },
      {
        label: "condition not a 14.<n> identity",
        doc: put(GOOD_FINDINGS, "oops", "findings", 0, "condition"),
      },
      {
        label: "condition outside section 14",
        doc: put(GOOD_FINDINGS, "15.1", "findings", 0, "condition"),
      },
      {
        label: "condition 14.0 (no such condition)",
        doc: put(GOOD_FINDINGS, "14.0", "findings", 0, "condition"),
      },
      {
        label: "finding missing message",
        doc: omit(GOOD_FINDINGS, "findings", 1, "message"),
      },
      {
        label: "empty message",
        doc: put(GOOD_FINDINGS, "", "findings", 1, "message"),
      },
      {
        label: "malformed location",
        doc: put(
          GOOD_FINDINGS,
          { start: 78, end: 40 },
          "findings",
          0,
          "location",
        ),
      },
      {
        label: "wrong-typed file (must reject, not default)",
        doc: put(GOOD_FINDINGS, 9, "findings", 0, "file"),
      },
      {
        label: "edge with unknown kind",
        doc: put(GOOD_FINDINGS, "dependz", "findings", 1, "edge", "kind"),
      },
      {
        label: "cycle with empty identity",
        doc: put(GOOD_FINDINGS, [""], "findings", 2, "cycle"),
      },
    ],
  },
  {
    name: "coverage",
    decode: decodeCoverageReport,
    good: GOOD_COVERAGE,
    verify: (decoded: ReturnType<typeof decodeCoverageReport>) => {
      const profile = decoded.profiles[0];
      expect(profile.name).toBe("core");
      expect(profile.counts).toEqual({
        required: 3,
        covered: 1,
        uncovered: 1,
        ignored: 1,
      });
      expect(profile.covered[0].path).toEqual([
        "specs/A.mdx#login",
        "specs/B.mdx#account",
      ]);
      expect(profile.uncovered).toEqual(["specs/B.mdx#account.close"]);
      expect(profile.ignored[0].reasons).toEqual(["root node"]);
    },
    alsoGood: [
      {
        label: "zero profiles (T7-3: an empty report is valid)",
        doc: { profiles: [] },
        verify: (decoded: ReturnType<typeof decodeCoverageReport>) => {
          expect(decoded.profiles).toEqual([]);
        },
      },
    ],
    bad: [
      { label: "missing profiles list", doc: {} },
      {
        label: "profile missing name",
        doc: omit(GOOD_COVERAGE, "profiles", 0, "name"),
      },
      {
        label: "profile missing counts",
        doc: omit(GOOD_COVERAGE, "profiles", 0, "counts"),
      },
      {
        label: "counts missing uncovered",
        doc: omit(GOOD_COVERAGE, "profiles", 0, "counts", "uncovered"),
      },
      {
        label: "negative count",
        doc: put(GOOD_COVERAGE, -1, "profiles", 0, "counts", "covered"),
      },
      {
        label: "stringly-typed count",
        doc: put(GOOD_COVERAGE, "1", "profiles", 0, "counts", "covered"),
      },
      {
        label: "covered node missing its path",
        doc: omit(GOOD_COVERAGE, "profiles", 0, "covered", 0, "path"),
      },
      {
        label: "empty covering path",
        doc: put(GOOD_COVERAGE, [], "profiles", 0, "covered", 0, "path"),
      },
      {
        label: "ignored node missing reasons",
        doc: omit(GOOD_COVERAGE, "profiles", 0, "ignored", 0, "reasons"),
      },
      {
        label: "ignored node with zero reasons",
        doc: put(GOOD_COVERAGE, [], "profiles", 0, "ignored", 0, "reasons"),
      },
      {
        label: "uncovered entry not a string",
        doc: put(GOOD_COVERAGE, [3], "profiles", 0, "uncovered"),
      },
    ],
  },
  {
    name: "impact",
    decode: decodeImpactReport,
    good: GOOD_IMPACT,
    verify: (decoded: ReturnType<typeof decodeImpactReport>) => {
      expect(decoded.baseline).toBe("a1b2c3d");
      expect(decoded.requirements[0].categories[0].category).toBe("changed");
      expect(decoded.requirements[1].nodes).toEqual([
        "specs/A.mdx",
        "specs/A.mdx#login",
      ]);
      expect(decoded.requirements[1].deleted).toBe(true);
      expect(decoded.code.direct[0].edge).toEqual(EDGE_IN);
      expect(decoded.code.transitive).toEqual([]);
    },
    alsoGood: [
      {
        label: "no baseline echo",
        doc: omit(GOOD_IMPACT, "baseline"),
        verify: (decoded: ReturnType<typeof decodeImpactReport>) => {
          expect(decoded.baseline).toBeUndefined();
        },
      },
    ],
    bad: [
      { label: "missing requirements", doc: omit(GOOD_IMPACT, "requirements") },
      { label: "missing code groups", doc: omit(GOOD_IMPACT, "code") },
      {
        label: "code missing direct group",
        doc: omit(GOOD_IMPACT, "code", "direct"),
      },
      {
        label: "entry with zero nodes",
        doc: put(GOOD_IMPACT, [], "requirements", 0, "nodes"),
      },
      {
        label: "entry missing deleted flag",
        doc: omit(GOOD_IMPACT, "requirements", 0, "deleted"),
      },
      {
        label: "stringly-typed deleted flag",
        doc: put(GOOD_IMPACT, "no", "requirements", 0, "deleted"),
      },
      {
        label: "unknown category",
        doc: put(
          GOOD_IMPACT,
          "renamed",
          "requirements",
          0,
          "categories",
          0,
          "category",
        ),
      },
      {
        label: "category missing attribution",
        doc: omit(
          GOOD_IMPACT,
          "requirements",
          1,
          "categories",
          0,
          "attributedTo",
        ),
      },
      {
        label: "code entry missing edge",
        doc: omit(GOOD_IMPACT, "code", "direct", 0, "edge"),
      },
      {
        label: "code entry with empty path",
        doc: put(GOOD_IMPACT, [], "code", "direct", 0, "path"),
      },
      {
        label: "wrong-typed baseline (must reject, not default)",
        doc: put(GOOD_IMPACT, 7, "baseline"),
      },
    ],
  },
  {
    name: "review list",
    decode: decodeSessionListReport,
    good: GOOD_SESSION_LIST,
    verify: (decoded: ReturnType<typeof decodeSessionListReport>) => {
      expect(decoded.sessions).toHaveLength(2);
      const first = decoded.sessions[0];
      expect(first).toEqual({
        name: "B",
        corrupt: false,
        strategy: "audit",
        counts: { unresolved: 2, updated: 1 },
      });
      expect(decoded.sessions[1]).toEqual({ name: "a", corrupt: true });
    },
    bad: [
      { label: "missing sessions list", doc: {} },
      {
        label: "session missing name",
        doc: omit(GOOD_SESSION_LIST, "sessions", 0, "name"),
      },
      {
        label: "session missing corrupt flag",
        doc: omit(GOOD_SESSION_LIST, "sessions", 0, "corrupt"),
      },
      {
        label: "stringly-typed corrupt flag",
        doc: put(GOOD_SESSION_LIST, "no", "sessions", 0, "corrupt"),
      },
      {
        label: "healthy session missing strategy",
        doc: omit(GOOD_SESSION_LIST, "sessions", 0, "strategy"),
      },
      {
        label: "healthy session missing counts",
        doc: omit(GOOD_SESSION_LIST, "sessions", 0, "counts"),
      },
      {
        label: "negative count",
        doc: put(GOOD_SESSION_LIST, -2, "sessions", 0, "counts", "unresolved"),
      },
      {
        label: "corrupt session carrying fields (contradiction)",
        doc: put(GOOD_SESSION_LIST, "audit", "sessions", 1, "strategy"),
      },
    ],
  },
  {
    name: "review status",
    decode: decodeSessionStatusReport,
    good: GOOD_SESSION_STATUS,
    verify: (decoded: ReturnType<typeof decodeSessionStatusReport>) => {
      expect(decoded.items[0]).toEqual({
        id: "item-1",
        kind: "subtree-coherence",
        scope: "specs/A.mdx#login",
        status: "unresolved",
        blocked: false,
      });
      expect(decoded.totals).toEqual({ unresolved: 1 });
    },
    bad: [
      { label: "missing items list", doc: omit(GOOD_SESSION_STATUS, "items") },
      { label: "missing totals", doc: omit(GOOD_SESSION_STATUS, "totals") },
      {
        label: "row missing id",
        doc: omit(GOOD_SESSION_STATUS, "items", 0, "id"),
      },
      {
        label: "unknown item kind",
        doc: put(GOOD_SESSION_STATUS, "vibe-check", "items", 0, "kind"),
      },
      {
        label: "unknown status",
        doc: put(GOOD_SESSION_STATUS, "resolvedish", "items", 0, "status"),
      },
      {
        label: "row missing blocked state",
        doc: omit(GOOD_SESSION_STATUS, "items", 0, "blocked"),
      },
      {
        label: "stringly-typed total",
        doc: put(GOOD_SESSION_STATUS, "1", "totals", "unresolved"),
      },
    ],
  },
  {
    name: "review show (full item)",
    decode: decodeItemReport,
    good: GOOD_ITEM,
    verify: (decoded: ReturnType<typeof decodeItemReport>) => {
      expect(decoded.id).toBe("item-1");
      expect(decoded.kind).toBe("parent-consistency");
      expect(decoded.status).toBe("invalidated");
      expect(decoded.blockedBy).toEqual(["item-0"]);
      expect(decoded.note).toBe("checked once");
      expect(decoded.scope.text).toBe("Login must work.\n");
      expect(decoded.context[1]).toEqual({
        node: "specs/A.mdx#login.badCredentials",
        present: false,
      });
      expect(decoded.origin[0].before).toEqual({
        present: true,
        text: "old text\n",
      });
      expect(decoded.origin[0].after).toEqual({ present: false });
      expect(decoded.baseline).toEqual({
        recorded: ["opaque", "product-shaped"],
      });
      expect(decoded.current).toBeNull();
    },
    alsoGood: [
      {
        label: "no note (never resolved with one)",
        doc: omit(GOOD_ITEM, "note"),
        verify: (decoded: ReturnType<typeof decodeItemReport>) => {
          expect(decoded.note).toBeUndefined();
        },
      },
      {
        label: "code-impact scope: identity and presence alone (T10.7-12)",
        doc: put(
          put(
            omit(omit(GOOD_ITEM, "scope", "text"), "scope", "sourceRange"),
            "code-impact",
            "kind",
          ),
          "src/login.ts#handler",
          "scope",
          "node",
        ),
        verify: (decoded: ReturnType<typeof decodeItemReport>) => {
          expect(decoded.scope).toEqual({
            node: "src/login.ts#handler",
            present: true,
          });
        },
      },
      {
        label:
          "absent context node carrying recorded text (SPEC 10.7 provenance, T10.2-3)",
        doc: put(GOOD_ITEM, "recorded branch text\n", "context", 1, "text"),
        verify: (decoded: ReturnType<typeof decodeItemReport>) => {
          expect(decoded.context[1]).toEqual({
            node: "specs/A.mdx#login.badCredentials",
            present: false,
            text: "recorded branch text\n",
          });
        },
      },
    ],
    bad: [
      { label: "missing id", doc: omit(GOOD_ITEM, "id") },
      { label: "missing kind", doc: omit(GOOD_ITEM, "kind") },
      { label: "unknown kind", doc: put(GOOD_ITEM, "vibe-check", "kind") },
      { label: "missing status", doc: omit(GOOD_ITEM, "status") },
      { label: "unknown status", doc: put(GOOD_ITEM, "done", "status") },
      { label: "missing blocked state", doc: omit(GOOD_ITEM, "blocked") },
      { label: "missing blockedBy", doc: omit(GOOD_ITEM, "blockedBy") },
      {
        label: "blockedBy with empty id",
        doc: put(GOOD_ITEM, [""], "blockedBy"),
      },
      { label: "missing reason", doc: omit(GOOD_ITEM, "reason") },
      { label: "missing scope", doc: omit(GOOD_ITEM, "scope") },
      {
        label: "scope missing presence",
        doc: omit(GOOD_ITEM, "scope", "present"),
      },
      {
        label: "absent context node carrying a source range (contradiction)",
        doc: put(GOOD_ITEM, { start: 3, end: 9 }, "context", 1, "sourceRange"),
      },
      { label: "missing context", doc: omit(GOOD_ITEM, "context") },
      { label: "missing origin", doc: omit(GOOD_ITEM, "origin") },
      {
        label: "origin side present without text",
        doc: omit(GOOD_ITEM, "origin", 0, "before", "text"),
      },
      {
        label: "origin absent side carrying text (contradiction)",
        doc: put(GOOD_ITEM, "ghost", "origin", 0, "after", "text"),
      },
      { label: "missing baseline record", doc: omit(GOOD_ITEM, "baseline") },
      { label: "missing current record", doc: omit(GOOD_ITEM, "current") },
      {
        label: "wrong-typed note (must reject, not default)",
        doc: put(GOOD_ITEM, 42, "note"),
      },
    ],
  },
  {
    name: "review next",
    decode: decodeNextReport,
    good: GOOD_NEXT,
    verify: (decoded: ReturnType<typeof decodeNextReport>) => {
      expect(decoded.fullyResolved).toBe(false);
      expect(decoded.item?.id).toBe("item-1");
    },
    alsoGood: [
      {
        label: "fully resolved: no item in the payload (T10.7-7)",
        doc: GOOD_NEXT_RESOLVED,
        verify: (decoded: ReturnType<typeof decodeNextReport>) => {
          expect(decoded.fullyResolved).toBe(true);
          expect(decoded.item).toBeUndefined();
        },
      },
    ],
    bad: [
      { label: "missing fullyResolved flag", doc: { item: GOOD_ITEM } },
      {
        label: "not fully resolved yet no item",
        doc: { fullyResolved: false },
      },
      {
        label: "fully resolved yet carrying an item (contradiction)",
        doc: { fullyResolved: true, item: GOOD_ITEM },
      },
      { label: "item missing its id", doc: omit(GOOD_NEXT, "item", "id") },
    ],
  },
  {
    name: "review export",
    decode: decodeExportReport,
    good: GOOD_EXPORT,
    verify: (decoded: ReturnType<typeof decodeExportReport>) => {
      expect(decoded.name).toBe("review-1");
      expect(decoded.strategy).toBe("audit");
      expect(decoded.creationParameters).toBeNull();
      expect(decoded.decompositions).toEqual([]);
      expect(decoded.items).toHaveLength(1);
      expect(decoded.items[0].id).toBe("item-1");
    },
    bad: [
      { label: "missing name", doc: omit(GOOD_EXPORT, "name") },
      { label: "missing strategy", doc: omit(GOOD_EXPORT, "strategy") },
      {
        label: "missing creationParameters member",
        doc: omit(GOOD_EXPORT, "creationParameters"),
      },
      {
        label: "missing decompositions member",
        doc: omit(GOOD_EXPORT, "decompositions"),
      },
      { label: "missing items", doc: omit(GOOD_EXPORT, "items") },
      {
        label: "item missing status",
        doc: omit(GOOD_EXPORT, "items", 0, "status"),
      },
    ],
  },
];

for (const spec of DECODERS) {
  test(`S-5: ${spec.name} adapter decodes well-shaped documents to the asserted information`, () => {
    spec.verify(spec.decode(spec.good) as never);
    for (const variant of spec.alsoGood ?? []) {
      const decoded = spec.decode(variant.doc);
      variant.verify?.(decoded as never);
    }
  });

  test(`S-5: ${spec.name} adapter rejects wrong-shape documents rather than defaulting`, () => {
    for (const bad of [...GENERIC_BAD, ...spec.bad]) {
      const failure = expectDiagnosed(`${spec.name}: ${bad.label}`, () =>
        spec.decode(bad.doc),
      );
      // Every rejection names the adapter and is a test error, not a default.
      expect(failure.message).toContain("adapter");
    }
  });
}

test("S-5: decoder context labels surface in diagnoses (two-document compares stay tellable-apart)", () => {
  const failure = expectDiagnosed("labelled decode", () =>
    decodeNodeReport(null, "second run"),
  );
  expect(failure.message).toContain("second run");
});

// --- human-report matcher ----------------------------------------------------

function syntheticResult(stdout: string, stderr = ""): RunResult {
  const stdoutBytes = Buffer.from(stdout, "utf8");
  const stderrBytes = Buffer.from(stderr, "utf8");
  return {
    exitCode: 1,
    signal: null,
    stdout,
    stderr,
    stdoutBytes,
    stderrBytes,
    commandLine: "`stand-in check` [synthetic result]",
  };
}

test("S-5: human-report matcher accepts a report carrying all required information", () => {
  const report =
    'error 14.2 in specs/A.mdx at 40..78: expected <S id="validCredentials"> nested inside login\n';
  assertReportMentions(
    report,
    ["specs/A.mdx", "validCredentials", conditionMention("14.2")],
    "well-formed report",
  );
  // RunResult form reads stdout (12.0: findings are stdout content).
  assertReportMentions(
    syntheticResult(report, "unrelated stderr noise"),
    ["specs/A.mdx"],
    "RunResult form",
  );
});

test("S-5: human-report matcher rejects reports missing required information", () => {
  const failure = expectDiagnosed("missing mention", () =>
    assertReportMentions(
      "something failed somewhere\n",
      ["specs/A.mdx", conditionMention("14.2")],
      "incomplete report",
    ),
  );
  expect(failure.message).toContain("specs/A.mdx");
  expect(failure.message).toContain("incomplete report");

  // Matching stderr content must not satisfy a stdout assertion.
  expectDiagnosed("mention only on stderr", () =>
    assertReportMentions(
      syntheticResult("ok\n", "specs/A.mdx\n"),
      ["specs/A.mdx"],
      "stderr is not the report stream",
    ),
  );

  // A mention-less assertion checks nothing and is itself a defect.
  expectDiagnosed("empty mention list", () =>
    assertReportMentions("anything", [], "empty assertion"),
  );
});

test("S-5: conditionMention distinguishes 14.2 from 14.20 in both directions", () => {
  expect(conditionMention("14.2").test("error 14.2: bad structure")).toBe(true);
  expect(conditionMention("14.2").test("ends with 14.2.")).toBe(true);
  expect(conditionMention("14.2").test("error 14.20: encoding")).toBe(false);
  expect(conditionMention("14.2").test("version 114.2")).toBe(false);
  expect(conditionMention("14.20").test("error 14.20: encoding")).toBe(true);
  expect(conditionMention("14.20").test("error 14.2: structure")).toBe(false);
  expectDiagnosed("not a condition identity", () => conditionMention("15.1"));
});

test("S-5: ignored-reason classifier maps SPEC 8.2 reason spellings in order and rejects the unrecognizable", () => {
  // SPEC.md 8.2's own phrasings classify, order-preserving (the fixed order
  // is the tests' value assertion, T8.2-1).
  expect(
    classifyIgnoredReasons(
      [
        "root node",
        'coverage="none"',
        'non-leaf under targets: "leaves"',
        "lacking every targetTags tag",
      ],
      "spec phrasings",
    ),
  ).toEqual(["root", "coverage-none", "non-leaf", "lacking-tags"]);

  // A reason matching no pattern is unrecognizable required information —
  // rejected loudly, never defaulted (H-3).
  const unknown = expectDiagnosed("unclassifiable reason", () =>
    classifyIgnoredReasons(["excluded"], "unknown token"),
  );
  expect(unknown.message).toContain("unknown token");

  // A reason matching more than one pattern is ambiguous — equally rejected.
  expectDiagnosed("ambiguous reason", () =>
    classifyIgnoredReasons(["root has none"], "ambiguous token"),
  );
});

// --- T10.1-4 session-corruption staging ---------------------------------------

const SESSION_REL = ".xspec/reviews/s.json";

/** A synthetic well-shaped stored session (per the layer's assumed shape). */
const WELL_SHAPED_SESSION = {
  creationParameters: { strategy: "audit" },
  items: [
    {
      blockedBy: [],
      id: "i1",
      kind: "subtree-coherence",
      scope: "specs/A.mdx#a",
      status: "unresolved",
    },
    {
      blockedBy: ["i1"],
      id: "i2",
      kind: "subtree-coherence",
      scope: "specs/A.mdx",
      status: "updated",
    },
  ],
  name: "s",
};

async function sessionWorkspace(doc: unknown): Promise<{
  workspace: TestWorkspace;
  file: string;
  read: () => Promise<Record<string, unknown>>;
}> {
  const workspace = await TestWorkspace.create({
    files: { [SESSION_REL]: `${JSON.stringify(doc, null, 2)}\n` },
  });
  onTestFinished(() => workspace.dispose());
  const file = workspace.path(SESSION_REL);
  return {
    workspace,
    file,
    read: async () => {
      const bytes = await workspace.readBytes(SESSION_REL);
      return JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<
        string,
        unknown
      >;
    },
  };
}

type SessionItems = Record<string, unknown>[];
const itemsOf = (doc: Record<string, unknown>): SessionItems =>
  doc["items"] as SessionItems;

test("S-5: staging duplicates an item entry (duplicate ids; distinct-id variant for same kind and scope)", async () => {
  const duplicated = await sessionWorkspace(WELL_SHAPED_SESSION);
  await stageDuplicateItemEntry(duplicated.file);
  const withDuplicate = itemsOf(await duplicated.read());
  expect(withDuplicate).toHaveLength(3);
  expect(withDuplicate[2]).toEqual(withDuplicate[0]); // same id, same fields

  const fresh = await sessionWorkspace(WELL_SHAPED_SESSION);
  await stageDuplicateItemEntry(fresh.file, { distinctId: true });
  const withFreshId = itemsOf(await fresh.read());
  expect(withFreshId).toHaveLength(3);
  expect(withFreshId[2]["id"]).not.toBe(withFreshId[0]["id"]);
  const ids = withFreshId.map((item) => item["id"]);
  expect(new Set(ids).size).toBe(ids.length); // no duplicate-id state staged
  expect({ ...withFreshId[2], id: withFreshId[0]["id"] }).toEqual(
    withFreshId[0],
  );
});

test("S-5: staging rewrites a status to an unknown value (value-blind)", async () => {
  const { file, read } = await sessionWorkspace(WELL_SHAPED_SESSION);
  await stageUnknownItemStatus(file);
  const items = itemsOf(await read());
  const status = items[0]["status"];
  expect(typeof status).toBe("string");
  expect(status).not.toBe("unresolved");
  expect(ITEM_STATUSES as readonly string[]).not.toContain(status);
  expect(items[1]["status"]).toBe("updated"); // only the staged item changed
});

test("S-5: staging redirects blockedBy into a cycle, using only ids the session bears", async () => {
  const twoItems = await sessionWorkspace(WELL_SHAPED_SESSION);
  await stageBlockedByCycle(twoItems.file);
  const items = itemsOf(await twoItems.read());
  expect(items[0]["blockedBy"]).toEqual(["i2"]);
  expect(items[1]["blockedBy"]).toEqual(["i1"]);

  const single = await sessionWorkspace({
    ...WELL_SHAPED_SESSION,
    items: [structuredClone(WELL_SHAPED_SESSION.items[0])],
  });
  await stageBlockedByCycle(single.file);
  const selfCycle = itemsOf(await single.read());
  expect(selfCycle[0]["blockedBy"]).toEqual(["i1"]);
});

test("S-5: staging redirects blockedBy at an id no item bears", async () => {
  const { file, read } = await sessionWorkspace(WELL_SHAPED_SESSION);
  await stageBlockedByAbsentItem(file);
  const items = itemsOf(await read());
  const blockedBy = items[0]["blockedBy"] as string[];
  expect(blockedBy).toHaveLength(1);
  const ids = items.map((item) => item["id"]);
  expect(ids).not.toContain(blockedBy[0]);
});

test("S-5: staging deletes a named item field", async () => {
  const { file, read } = await sessionWorkspace(WELL_SHAPED_SESSION);
  await stageDeleteItemField(file, "status");
  const items = itemsOf(await read());
  expect(Object.hasOwn(items[0], "status")).toBe(false);
  expect(items[0]["id"]).toBe("i1"); // the rest of the entry is intact
  expect(Object.hasOwn(items[1], "status")).toBe(true);
});

test("S-5: staging garbles recorded creation parameters by structural type flip", async () => {
  const objectRecorded = await sessionWorkspace(WELL_SHAPED_SESSION);
  await stageGarbleCreationParameters(objectRecorded.file);
  const flippedToScalar = await objectRecorded.read();
  expect(typeof flippedToScalar["creationParameters"]).toBe("string");

  const scalarRecorded = await sessionWorkspace({
    ...WELL_SHAPED_SESSION,
    creationParameters: "abc123",
  });
  await stageGarbleCreationParameters(scalarRecorded.file);
  const flippedToObject = await scalarRecorded.read();
  expect(typeof flippedToObject["creationParameters"]).toBe("object");
  expect(flippedToObject["creationParameters"]).not.toBeNull();
});

test("S-5: every staged corruption leaves the file one well-formed JSON document", async () => {
  // Unparseable bytes are a separate, shape-independent corrupt state staged
  // directly by tests — these transformations must each inject exactly their
  // one corruption, so the staged file stays parseable (checked by `read`).
  for (const stage of [
    stageDuplicateItemEntry,
    stageUnknownItemStatus,
    stageBlockedByCycle,
    stageBlockedByAbsentItem,
    (file: string) => stageDeleteItemField(file, "kind"),
    stageGarbleCreationParameters,
  ]) {
    const { file, read } = await sessionWorkspace(WELL_SHAPED_SESSION);
    await stage(file);
    await read(); // throws if the staged file is not one JSON document
  }
});

interface StagingRejection {
  readonly label: string;
  /** Raw file contents; undefined = no file at the path. */
  readonly contents: string | Uint8Array | undefined;
  readonly stage: (file: string) => Promise<void>;
}

const STAGING_REJECTIONS: readonly StagingRejection[] = [
  {
    label: "no session file at the path (the product never wrote one)",
    contents: undefined,
    stage: stageDuplicateItemEntry,
  },
  {
    label: "invalid UTF-8 bytes",
    contents: Uint8Array.from([0x7b, 0xff, 0xfe, 0x7d]),
    stage: stageUnknownItemStatus,
  },
  {
    label: "unparseable JSON",
    contents: '{"items": [',
    stage: stageBlockedByCycle,
  },
  {
    label: "top-level array instead of an object",
    contents: "[]",
    stage: stageDuplicateItemEntry,
  },
  {
    label: "no items member",
    contents: '{"name": "s"}',
    stage: stageUnknownItemStatus,
  },
  {
    label: "items not an array",
    contents: '{"items": {}}',
    stage: stageBlockedByAbsentItem,
  },
  {
    label: "zero items where the transformation needs one",
    contents: '{"items": []}',
    stage: stageDuplicateItemEntry,
  },
  {
    label: "item entry not an object",
    contents: '{"items": [7]}',
    stage: stageDuplicateItemEntry,
  },
  {
    label: "item without a string id",
    contents: '{"items": [{"status": "unresolved", "blockedBy": []}]}',
    stage: stageDuplicateItemEntry,
  },
  {
    label: "item without a status member",
    contents: '{"items": [{"id": "i1", "blockedBy": []}]}',
    stage: stageUnknownItemStatus,
  },
  {
    label: "item without a blockedBy member",
    contents: '{"items": [{"id": "i1", "status": "unresolved"}]}',
    stage: stageBlockedByCycle,
  },
  {
    label: "blockedBy not an array",
    contents:
      '{"items": [{"id": "i1", "status": "unresolved", "blockedBy": "i2"}]}',
    stage: stageBlockedByAbsentItem,
  },
  {
    label: "deleting a field the entry does not carry",
    contents:
      '{"items": [{"id": "i1", "status": "unresolved", "blockedBy": []}]}',
    stage: (file) => stageDeleteItemField(file, "note"),
  },
  {
    label: "no creationParameters member to garble",
    contents: '{"items": []}',
    stage: stageGarbleCreationParameters,
  },
];

test("S-5: staging fails loudly on shape mismatch and leaves the file untouched", async () => {
  for (const rejection of STAGING_REJECTIONS) {
    const workspace = await TestWorkspace.create(
      rejection.contents === undefined
        ? { dirs: [".xspec/reviews"] }
        : { files: { [SESSION_REL]: rejection.contents } },
    );
    onTestFinished(() => workspace.dispose());
    const file = workspace.path(SESSION_REL);
    const failure = await expectDiagnosedAsync(rejection.label, () =>
      rejection.stage(file),
    );
    expect(failure.message).toContain("session-corruption staging");
    if (rejection.contents !== undefined) {
      const after = await workspace.readBytes(SESSION_REL);
      const before =
        typeof rejection.contents === "string"
          ? Buffer.from(rejection.contents, "utf8")
          : Buffer.from(rejection.contents);
      expect(Buffer.compare(Buffer.from(after), before)).toBe(0);
    }
  }
});

// --- T13.4-1 sorted-keys assertion --------------------------------------------

test("S-5: sorted-keys assertion accepts byte-sorted documents of any shape", () => {
  const sorted = [
    "{}",
    "[]",
    '"scalar"',
    "42",
    "null",
    '{"a": 1, "b": {"a": [{"x": 0, "y": {}}], "b": -1.5e3}, "c": true}',
    // Byte order, not numeric order: "1" (0x31) sorts before "9" (0x39), so
    // "10" precedes "9" — JavaScript objects would reorder these keys
    // numerically, which is exactly why the check scans the document text.
    '{"10": 0, "9": 1}',
    // Escaped spellings resolve before comparing: "a" is "a" < "b".
    '{"\\u0061": 0, "b": 1}',
    // UTF-8 byte order, not UTF-16 code-unit order: U+FFFD (EF BF BD) sorts
    // before U+10000 (F0 90 80 80), while UTF-16 compares them the other way
    // around (FFFD > D800 DC00).
    '{"\\ufffd": 0, "\\ud800\\udc00": 1}',
    ' \t\r\n {"a": 0} \n',
    '[{"a": 0, "b": 1}, {"a": 2}]',
  ];
  for (const doc of sorted) {
    assertJsonKeysByteSorted(doc, `sorted vector ${JSON.stringify(doc)}`);
  }
  // Byte input decodes as UTF-8 first.
  assertJsonKeysByteSorted(
    Buffer.from('{"a": 0, "é": 1}', "utf8"),
    "byte input",
  );
});

test("S-5: sorted-keys assertion rejects out-of-order keys wherever they nest", () => {
  const unsorted: readonly { label: string; doc: string }[] = [
    { label: "top-level swap", doc: '{"b": 0, "a": 1}' },
    { label: "nested object", doc: '{"a": {"z": 0, "b": 1}}' },
    { label: "object inside an array", doc: '[{"b": 0, "a": 1}]' },
    {
      label: "integer-like keys in numeric (not byte) order",
      doc: '{"9": 0, "10": 1}', // JSON.parse would report these sorted
    },
    {
      label: "escaped spelling hiding the real order",
      doc: '{"\\u0062": 0, "a": 1}', // raw "\\u0062" < "a", decoded "b" > "a"
    },
    {
      label: "UTF-16 order passed off as byte order",
      doc: '{"\\ud800\\udc00": 0, "\\ufffd": 1}',
    },
    { label: "duplicate key", doc: '{"a": 0, "a": 1}' },
  ];
  for (const { label, doc } of unsorted) {
    const failure = expectDiagnosed(label, () =>
      assertJsonKeysByteSorted(doc, label),
    );
    expect(failure.message).toContain(label);
    expect(failure.message).toContain("T13.4-1");
  }
  // The diagnosis names where the offense sits.
  const located = expectDiagnosed("path in diagnosis", () =>
    assertJsonKeysByteSorted('{"a": {"z": 0, "b": 1}}', "path check"),
  );
  expect(located.message).toContain("$.a");
});

test("S-5: sorted-keys assertion fails loudly on anything but one JSON document", () => {
  const malformed: readonly { label: string; doc: string | Uint8Array }[] = [
    { label: "empty input", doc: "" },
    { label: "whitespace only", doc: " \n\t" },
    { label: "truncated object", doc: '{"a": 0' },
    { label: "two concatenated documents", doc: '{"a": 0}{"b": 1}' },
    { label: "single-quoted key", doc: "{'a': 0}" },
    { label: "unquoted key", doc: "{a: 0}" },
    { label: "trailing comma", doc: '{"a": 0,}' },
    { label: "bad escape", doc: '{"a": "\\q"}' },
    { label: "bad \\u escape", doc: '{"a": "\\u00g0"}' },
    { label: "unescaped control character", doc: '{"a": "\u0001"}' },
    { label: "leading-zero number", doc: '{"a": 01}' },
    { label: "bare word", doc: "nope" },
    { label: "invalid UTF-8 bytes", doc: Uint8Array.from([0x22, 0xff, 0x22]) },
  ];
  for (const { label, doc } of malformed) {
    expectDiagnosed(label, () => assertJsonKeysByteSorted(doc, label));
  }
});
