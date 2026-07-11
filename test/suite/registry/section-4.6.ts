// TEST-SPEC §4.6 (code locations and attribution) — SUITE-16: T4.6-1 … T4.6-4.
//
// Registered product-facing bodies (C-2 "one code path"): each builds its own
// fresh workspace (H-1), drives the product strictly as a subprocess (H-2),
// asserts exact exit codes (H-5), decodes reports through the H-3 adapters,
// and rejects a product only via diagnosed assertion failures (H-8). Files
// under `src/` are discovered code-group sources (SPEC 7.2), so `build`
// analyzes their spec-module usage and `query edges` exposes the recorded
// edges with their attributed source locations (SPEC 4.6, 11).
//
// Attribution is observed through edge sources: each staged reference targets
// a placement-dedicated spec section, so the workspace's complete per-kind
// edge set — asserted with `query edges --kinds` — pins every placement's
// attributed unit exactly, and any extra, missing, or misattributed edge
// (e.g. one sourced at a `#`-named unit, T4.6-3) fails the set equality.
//
// Conservative operationalizations (noted per H-4 — wording is free, so only
// the stated observables are asserted):
// - T4.6-1 "markers' `references` edges and `text(...)` calls' `embeds`
//   edges attribute to the same innermost enclosing named unit": both
//   expected edge sets are built from one placement table — each placement
//   stages its marker and its `text(...)` call in the same syntactic
//   position, targeting the same section — so the two set-equality
//   assertions accept only a product attributing both forms to the table's
//   one unit per placement.
// - T4.6-4 "coverage boundary membership": SPEC 8 covers a target when a
//   permitted path exists from a boundary node to it, and 8.2 reports one
//   shortest covering path as a node-identity sequence (12.0) — from the
//   boundary node to the target, so in `direct` mode (single edge) the path
//   is exactly [boundary unit, target]. With each target reached by exactly
//   one edge, every reported path is forced; the `@2` units must appear as
//   the boundary members of their targets' paths.

import type { GraphEdge } from "../../helpers/adapters/index.js";
import {
  decodeCoverageReport,
  decodeEdgesReport,
} from "../../helpers/adapters/index.js";
import type { ProductTestEntry } from "../../helpers/registry.js";
import { defineProductTest } from "../../helpers/registry.js";
import type { ProductBinding } from "../../helpers/subprocess.js";
import { TestWorkspace } from "../../helpers/workspace.js";
import {
  assertEdgeSetEqual,
  assertSameJson,
  buildOk,
  runJson,
} from "./support.js";

// One spec group plus one code group (SPEC 7.2): TypeScript files under
// `src/` are discovered code sources, so `build` analyzes their spec-module
// usage (4, 4.5, 4.6).
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

/** Workspace-wide `query edges --kinds <kind>`, decoded (SPEC 11). */
async function queryEdgesOfKind(
  product: ProductBinding,
  workspace: TestWorkspace,
  kind: string,
  context: string,
): Promise<readonly GraphEdge[]> {
  const label = `${context} \`query edges --kinds ${kind}\``;
  return decodeEdgesReport(
    await runJson(
      product,
      workspace,
      ["query", "edges", "--kinds", kind],
      label,
    ),
    label,
  );
}

/** `query edges --from <graph-node>`, decoded (SPEC 11). */
async function queryEdgesFrom(
  product: ProductBinding,
  workspace: TestWorkspace,
  from: string,
  context: string,
): Promise<readonly GraphEdge[]> {
  const label = `${context} \`query edges --from ${from}\``;
  return decodeEdgesReport(
    await runJson(
      product,
      workspace,
      ["query", "edges", "--from", from],
      label,
    ),
    label,
  );
}

// ---------------------------------------------------------------------------
// T4.6-1 — the attribution matrix over all named-unit forms
// ---------------------------------------------------------------------------

/** Which of the two reference forms a placement stages. */
type PlacementForms = "both" | "marker-only" | "text-only";

/** One syntactic placement of the T4.6-1 matrix. */
interface AttributionPlacement {
  /** The TEST-SPEC arm (diagnostics only). */
  readonly name: string;
  /** The expected attributed code location — the edges' `from` (SPEC 4.6). */
  readonly unit: string;
  /** The placement's dedicated target section in `specs/U.mdx`. */
  readonly target: string;
  readonly forms: PlacementForms;
}

// The placement table drives the spec document and both expected edge sets;
// the fixture sources below stage, per placement, the marker `SPEC.<target>;`
// and/or the call `text(SPEC.<target>);` in the placement's syntactic
// position (consistency enforced at module load, below). The class `static`
// block arm is marker-only and the plain non-function property initializer
// arm is text-only, exactly as TEST-SPEC words them — an initializer is no
// statement position, so no marker can be staged there (SPEC 4.5).
const T4_6_1_PLACEMENTS: readonly AttributionPlacement[] = [
  {
    name: "file top level (attributed to the file)",
    unit: "src/app.ts",
    target: "file",
    forms: "both",
  },
  {
    name: "inside a function declaration",
    unit: "src/app.ts#fnDecl",
    target: "fndecl",
    forms: "both",
  },
  {
    name: "in a class static block (binds no name — bare class unit)",
    unit: "src/app.ts#Service",
    target: "staticblock",
    forms: "marker-only",
  },
  {
    name: "in a plain non-function property initializer (bare class unit)",
    unit: "src/app.ts#Service",
    target: "plainprop",
    forms: "text-only",
  },
  {
    name: "a class member property initialized with an arrow function",
    unit: "src/app.ts#Service.arrowProp",
    target: "arrowprop",
    forms: "both",
  },
  {
    name: "a class member property initialized with a function expression",
    unit: "src/app.ts#Service.fnProp",
    target: "fnprop",
    forms: "both",
  },
  {
    name:
      "a class member property initialized with a class expression (staged " +
      "in the class expression's static block, which binds no name)",
    unit: "src/app.ts#Service.classProp",
    target: "classprop",
    forms: "both",
  },
  {
    name: "a class method (nested chain Class.method)",
    unit: "src/app.ts#Service.method",
    target: "method",
    forms: "both",
  },
  {
    name: "a getter",
    unit: "src/app.ts#Service.reader",
    target: "getter",
    forms: "both",
  },
  {
    name: "a setter",
    unit: "src/app.ts#Service.writer",
    target: "setter",
    forms: "both",
  },
  {
    name: "a variable declaration initialized with an arrow function",
    unit: "src/app.ts#varArrow",
    target: "vararrow",
    forms: "both",
  },
  {
    name: "a variable declaration initialized with a function expression",
    unit: "src/app.ts#varFn",
    target: "varfn",
    forms: "both",
  },
  {
    name:
      "a variable declaration initialized with a class expression (staged " +
      "in the class expression's static block)",
    unit: "src/app.ts#VarClass",
    target: "varclass",
    forms: "both",
  },
  {
    name: "directly inside a namespace",
    unit: "src/app.ts#ns",
    target: "ns",
    forms: "both",
  },
  {
    name: "inside a function declared in a namespace (nested chain ns.fn)",
    unit: "src/app.ts#ns.fn",
    target: "nsfn",
    forms: "both",
  },
  {
    name:
      "directly inside a dotted namespace (namespace A.B declares one unit " +
      "per dot-separated name)",
    unit: "src/app.ts#A.B",
    target: "dotted",
    forms: "both",
  },
  {
    name: "inside a function declared in a dotted namespace (A.B.f)",
    unit: "src/app.ts#A.B.f",
    target: "dottedfn",
    forms: "both",
  },
  {
    name: "inside a named default export",
    unit: "src/named.ts#namedDefault",
    target: "nameddefault",
    forms: "both",
  },
];

// One flat leaf section per placement (SPEC 1.3: a top-level section's ID is
// exactly one segment), generated from the table so targets never drift.
const T4_6_1_SPEC_SOURCE = T4_6_1_PLACEMENTS.map(
  (placement) =>
    `<S id="${placement.target}">\n` +
    `Target for the ${placement.target} placement.\n` +
    `</S>\n`,
).join("\n");

const T4_6_1_APP_SOURCE = [
  'import SPEC, { text } from "../specs/U.xspec";',
  "",
  "SPEC.file;",
  "text(SPEC.file);",
  "",
  "function fnDecl(): void {",
  "  SPEC.fndecl;",
  "  text(SPEC.fndecl);",
  "}",
  "",
  "class Service {",
  "  static {",
  "    SPEC.staticblock;",
  "  }",
  "",
  "  plainProp = text(SPEC.plainprop);",
  "",
  "  arrowProp = () => {",
  "    SPEC.arrowprop;",
  "    text(SPEC.arrowprop);",
  "  };",
  "",
  "  fnProp = function () {",
  "    SPEC.fnprop;",
  "    text(SPEC.fnprop);",
  "  };",
  "",
  "  classProp = class {",
  "    static {",
  "      SPEC.classprop;",
  "      text(SPEC.classprop);",
  "    }",
  "  };",
  "",
  "  method(): void {",
  "    SPEC.method;",
  "    text(SPEC.method);",
  "  }",
  "",
  "  get reader(): string {",
  "    SPEC.getter;",
  "    text(SPEC.getter);",
  '    return "reader";',
  "  }",
  "",
  "  set writer(value: string) {",
  "    SPEC.setter;",
  "    text(SPEC.setter);",
  "    void value;",
  "  }",
  "}",
  "",
  "const varArrow = () => {",
  "  SPEC.vararrow;",
  "  text(SPEC.vararrow);",
  "};",
  "",
  "const varFn = function (): void {",
  "  SPEC.varfn;",
  "  text(SPEC.varfn);",
  "};",
  "",
  "const VarClass = class {",
  "  static {",
  "    SPEC.varclass;",
  "    text(SPEC.varclass);",
  "  }",
  "};",
  "",
  "namespace ns {",
  "  SPEC.ns;",
  "  text(SPEC.ns);",
  "",
  "  export function fn(): void {",
  "    SPEC.nsfn;",
  "    text(SPEC.nsfn);",
  "  }",
  "}",
  "",
  "namespace A.B {",
  "  SPEC.dotted;",
  "  text(SPEC.dotted);",
  "",
  "  export function f(): void {",
  "    SPEC.dottedfn;",
  "    text(SPEC.dottedfn);",
  "  }",
  "}",
  "",
].join("\n");

// A file holds at most one default export, so the named-default arm lives in
// its own discovered code file.
const T4_6_1_NAMED_SOURCE = [
  'import SPEC, { text } from "../specs/U.xspec";',
  "",
  "export default function namedDefault(): void {",
  "  SPEC.nameddefault;",
  "  text(SPEC.nameddefault);",
  "}",
  "",
].join("\n");

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

// Module-load consistency guard (a harness defect, never a product failure):
// each placement's staged forms in the hand-written sources must match its
// table row — the marker statement `SPEC.<target>;` and the call
// `text(SPEC.<target>);` each exactly once when staged, never otherwise. The
// trailing `;` / `);` keeps needles from matching longer target names or the
// other form.
{
  const staged = T4_6_1_APP_SOURCE + T4_6_1_NAMED_SOURCE;
  for (const placement of T4_6_1_PLACEMENTS) {
    const markers = countOccurrences(staged, `SPEC.${placement.target};`);
    const texts = countOccurrences(staged, `text(SPEC.${placement.target});`);
    const expectMarker = placement.forms !== "text-only" ? 1 : 0;
    const expectText = placement.forms !== "marker-only" ? 1 : 0;
    if (markers !== expectMarker || texts !== expectText) {
      throw new Error(
        `T4.6-1 fixture broke: placement "${placement.name}" ` +
          `(target ${placement.target}, forms ${placement.forms}) staged ` +
          `${String(markers)} marker(s) and ${String(texts)} text call(s) — ` +
          `fix the placement table or the sources in section-4.6.ts`,
      );
    }
  }
}

const T4_6_1_EXPECTED_REFERENCES: readonly GraphEdge[] =
  T4_6_1_PLACEMENTS.filter((placement) => placement.forms !== "text-only").map(
    (placement): GraphEdge => ({
      from: placement.unit,
      to: `specs/U.mdx#${placement.target}`,
      kind: "references",
    }),
  );

const T4_6_1_EXPECTED_EMBEDS: readonly GraphEdge[] = T4_6_1_PLACEMENTS.filter(
  (placement) => placement.forms !== "marker-only",
).map((placement): GraphEdge => ({
  from: placement.unit,
  to: `specs/U.mdx#${placement.target}`,
  kind: "embeds",
}));

const T4_6_1 = defineProductTest({
  id: "T4.6-1",
  title:
    "markers and `text(...)` calls attribute to the innermost enclosing named unit — file top level to the file; function declarations, class methods, getters, setters, function-, arrow-, and class-valued class properties and variables, namespaces, and a named default export to `path#unit` with the dot-joined chain outermost first (`Service.method`, `ns.fn`); a class static block and a plain non-function property initializer to the bare class unit; `namespace A.B` declares one unit per dot-separated name — with each placement's `references` and `embeds` edges sourced at the same unit (SPEC 4.6, 4.5, 4.3)",
  run: async (product) => {
    await withWorkspace(
      SPEC_AND_CODE_CONFIG,
      {
        "specs/U.mdx": T4_6_1_SPEC_SOURCE,
        "src/app.ts": T4_6_1_APP_SOURCE,
        "src/named.ts": T4_6_1_NAMED_SOURCE,
      },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T4.6-1 `build` over the attribution-matrix workspace (every " +
            "staged use is sanctioned, SPEC 4.5)",
        );
        // The complete per-kind edge sets: every placement's edge originates
        // at exactly the table's unit, and nothing else records edges — a
        // misattributed, extra, or missing edge fails the set equality. Both
        // expected sets carry the same `from` per placement, so passing both
        // assertions is passing the same-innermost-unit clause (SPEC 4.6).
        assertEdgeSetEqual(
          await queryEdgesOfKind(product, workspace, "references", "T4.6-1"),
          T4_6_1_EXPECTED_REFERENCES,
          "T4.6-1 every marker's `references` edge is sourced at the " +
            "innermost enclosing named unit — the file at top level, the " +
            "dot-joined chain outermost first inside named units, the bare " +
            "class unit from its static block (SPEC 4.6, 4.5)",
        );
        assertEdgeSetEqual(
          await queryEdgesOfKind(product, workspace, "embeds", "T4.6-1"),
          T4_6_1_EXPECTED_EMBEDS,
          "T4.6-1 every `text(...)` call's `embeds` edge is sourced at the " +
            "same innermost enclosing named unit as the placement's marker; " +
            "the plain non-function property initializer attributes to the " +
            "bare class unit — such a property is not a named unit " +
            "(SPEC 4.6, 4.3)",
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T4.6-2 — anonymous default export: the unit is named `default`
// ---------------------------------------------------------------------------

const T4_6_2_SPEC_SOURCE =
  '<S id="anon">\nTarget for the anonymous default placement.\n</S>\n';

const T4_6_2_APP_SOURCE = [
  'import SPEC from "../specs/U.xspec";',
  "",
  "export default function (): void {",
  "  SPEC.anon;",
  "}",
  "",
].join("\n");

const T4_6_2 = defineProductTest({
  id: "T4.6-2",
  title:
    "a marker inside an anonymous default-exported function is attributed to `path#default` — a default export's unit name is `default` when the exported construct is anonymous (SPEC 4.6)",
  run: async (product) => {
    await withWorkspace(
      SPEC_AND_CODE_CONFIG,
      {
        "specs/U.mdx": T4_6_2_SPEC_SOURCE,
        "src/anon.ts": T4_6_2_APP_SOURCE,
      },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T4.6-2 `build` over the anonymous-default workspace",
        );
        const expected: readonly GraphEdge[] = [
          {
            from: "src/anon.ts#default",
            to: "specs/U.mdx#anon",
            kind: "references",
          },
        ];
        assertEdgeSetEqual(
          await queryEdgesOfKind(product, workspace, "references", "T4.6-2"),
          expected,
          "T4.6-2 the marker inside the anonymous default-exported " +
            "function is attributed to `path#default`, and nothing else " +
            "records a `references` edge (SPEC 4.6)",
        );
        // The `default` unit is an addressable graph node (SPEC 11).
        assertEdgeSetEqual(
          await queryEdgesFrom(
            product,
            workspace,
            "src/anon.ts#default",
            "T4.6-2",
          ),
          expected,
          "T4.6-2 `src/anon.ts#default` addresses the anonymous default " +
            "export's unit, whose complete edge set is the marker's edge " +
            "(SPEC 4.6, 11)",
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T4.6-3 — not named units: nearest enclosing named unit or the file
// ---------------------------------------------------------------------------

// Every construct here fails to statically bind a plain identifier
// (SPEC 4.6): an IIFE (twice — once at top level, once inside a named
// function, so both fallback outcomes are exercised), a function stored via a
// destructuring binding, and computed-, string-literal-, numeric-literal-,
// and private-named members of class `Carrier`. Each marker targets its own
// section, so the complete `references` edge set pins each arm's attribution
// — in particular, an edge sourced at a `#`-named unit such as
// `src/app.ts#Carrier.#priv` fails the equality.
const T4_6_3_SPEC_SOURCE = [
  '<S id="iife">',
  "Target for the top-level IIFE placement.",
  "</S>",
  "",
  '<S id="hosted">',
  "Target for the IIFE nested in a named function.",
  "</S>",
  "",
  '<S id="destr">',
  "Target for the destructuring-stored function.",
  "</S>",
  "",
  '<S id="computed">',
  "Target for the computed-name class member.",
  "</S>",
  "",
  '<S id="strname">',
  "Target for the string-literal-name class member.",
  "</S>",
  "",
  '<S id="numname">',
  "Target for the numeric-literal-name class member.",
  "</S>",
  "",
  '<S id="priv">',
  "Target for the private-name class member.",
  "</S>",
  "",
].join("\n");

const T4_6_3_APP_SOURCE = [
  'import SPEC from "../specs/N.xspec";',
  "",
  "(function () {",
  "  SPEC.iife;",
  "})();",
  "",
  "function host(): void {",
  "  (() => {",
  "    SPEC.hosted;",
  "  })();",
  "}",
  "",
  "const { helper } = {",
  "  helper: () => {",
  "    SPEC.destr;",
  "  },",
  "};",
  "",
  'const memberKey = "computedMember";',
  "",
  "class Carrier {",
  "  [memberKey]() {",
  "    SPEC.computed;",
  "  }",
  "",
  '  "string name"() {',
  "    SPEC.strname;",
  "  }",
  "",
  "  123() {",
  "    SPEC.numname;",
  "  }",
  "",
  "  #priv(): void {",
  "    SPEC.priv;",
  "  }",
  "}",
  "",
].join("\n");

const T4_6_3 = defineProductTest({
  id: "T4.6-3",
  title:
    "markers inside constructs that are not named units — an IIFE, a function stored via destructuring, and computed-name, string-literal-name, numeric-literal-name (`123() {}`), and private (`#priv() {}`) class members — attribute to the nearest enclosing named unit or the file; the private-member arm attributes to the bare class unit, never to a `#`-named unit (SPEC 4.6)",
  run: async (product) => {
    await withWorkspace(
      SPEC_AND_CODE_CONFIG,
      {
        "specs/N.mdx": T4_6_3_SPEC_SOURCE,
        "src/app.ts": T4_6_3_APP_SOURCE,
      },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T4.6-3 `build` over the not-named-units workspace",
        );
        assertEdgeSetEqual(
          await queryEdgesOfKind(product, workspace, "references", "T4.6-3"),
          [
            // Top-level IIFE: no named unit encloses it — the file.
            { from: "src/app.ts", to: "specs/N.mdx#iife", kind: "references" },
            // IIFE inside `host`: the anonymous arrow binds no name, so the
            // nearest enclosing named unit is the function declaration.
            {
              from: "src/app.ts#host",
              to: "specs/N.mdx#hosted",
              kind: "references",
            },
            // Destructuring binds no named unit, and an object-literal
            // property is no class member — the file.
            {
              from: "src/app.ts",
              to: "specs/N.mdx#destr",
              kind: "references",
            },
            // The four member arms: computed, string-literal, numeric-
            // literal, and private names bind no plain identifier, so each
            // marker attributes to the bare class unit — for `#priv` never
            // to a `#`-named unit.
            {
              from: "src/app.ts#Carrier",
              to: "specs/N.mdx#computed",
              kind: "references",
            },
            {
              from: "src/app.ts#Carrier",
              to: "specs/N.mdx#strname",
              kind: "references",
            },
            {
              from: "src/app.ts#Carrier",
              to: "specs/N.mdx#numname",
              kind: "references",
            },
            {
              from: "src/app.ts#Carrier",
              to: "specs/N.mdx#priv",
              kind: "references",
            },
          ],
          "T4.6-3 markers inside not-named-units attribute to the nearest " +
            "enclosing named unit or the file: the top-level IIFE and the " +
            "destructuring-stored function to the file, the nested IIFE to " +
            "its hosting function, and every oddly-named class member to " +
            "the bare class unit — never to a `#`-named unit (SPEC 4.6)",
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T4.6-4 — duplicate chains: 1-based document-order `@2` suffix
// ---------------------------------------------------------------------------

// One direct-mode coverage profile over the same groups, so each `@2` unit
// must also surface as the boundary member of its target's covering path
// (SPEC 7.4, 8; `boundaryKind` inferred — the group names are unambiguous).
const T4_6_4_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  },
  code: {
    app: ["src/**/*.ts"]
  },
  coverage: [
    {
      name: "units",
      target: "main",
      boundary: "app",
      mode: "direct"
    }
  ]
})
`;

const T4_6_4_SPEC_SOURCE = [
  '<S id="viagetter">',
  "Target of the getter marker.",
  "</S>",
  "",
  '<S id="viasetter">',
  "Target of the setter marker.",
  "</S>",
  "",
  '<S id="first">',
  "Target of the first sibling-scope declaration.",
  "</S>",
  "",
  '<S id="second">',
  "Target of the second sibling-scope declaration.",
  "</S>",
  "",
].join("\n");

// Two duplicate chains in one file (SPEC 4.6): the getter/setter pair `value`
// in class `Pair` (chain `Pair.value` twice), and the variable `worker` —
// a named unit each time — declared in two sibling top-level blocks, which
// bind no name and so leave both chains as the bare `worker`. Document order:
// the getter precedes the setter, the first block precedes the second, so
// each second occurrence is `@2` (1-based; the first stays unsuffixed).
const T4_6_4_APP_SOURCE = [
  'import SPEC from "../specs/D.xspec";',
  "",
  "class Pair {",
  "  get value(): string {",
  "    SPEC.viagetter;",
  '    return "current";',
  "  }",
  "",
  "  set value(next: string) {",
  "    SPEC.viasetter;",
  "    void next;",
  "  }",
  "}",
  "",
  "{",
  "  const worker = () => {",
  "    SPEC.first;",
  "  };",
  "  worker();",
  "}",
  "",
  "{",
  "  const worker = () => {",
  "    SPEC.second;",
  "  };",
  "  worker();",
  "}",
  "",
].join("\n");

const T4_6_4_GETTER_EDGE: GraphEdge = {
  from: "src/dup.ts#Pair.value",
  to: "specs/D.mdx#viagetter",
  kind: "references",
};
const T4_6_4_SETTER_EDGE: GraphEdge = {
  from: "src/dup.ts#Pair.value@2",
  to: "specs/D.mdx#viasetter",
  kind: "references",
};
const T4_6_4_FIRST_EDGE: GraphEdge = {
  from: "src/dup.ts#worker",
  to: "specs/D.mdx#first",
  kind: "references",
};
const T4_6_4_SECOND_EDGE: GraphEdge = {
  from: "src/dup.ts#worker@2",
  to: "specs/D.mdx#second",
  kind: "references",
};

const T4_6_4 = defineProductTest({
  id: "T4.6-4",
  title:
    "when the same unit chain occurs more than once in a file — a getter/setter pair, two same-named declarations in sibling scopes — the second occurrence in document order is `path#unit@2` (1-based, the first unsuffixed), asserted via `query edges` and as coverage boundary membership (SPEC 4.6, 8, 11)",
  run: async (product) => {
    await withWorkspace(
      T4_6_4_CONFIG,
      {
        "specs/D.mdx": T4_6_4_SPEC_SOURCE,
        "src/dup.ts": T4_6_4_APP_SOURCE,
      },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T4.6-4 `build` over the duplicate-chains workspace",
        );

        // The complete `references` edge set: first occurrences unsuffixed,
        // each second occurrence carrying the 1-based `@2` suffix.
        assertEdgeSetEqual(
          await queryEdgesOfKind(product, workspace, "references", "T4.6-4"),
          [
            T4_6_4_GETTER_EDGE,
            T4_6_4_SETTER_EDGE,
            T4_6_4_FIRST_EDGE,
            T4_6_4_SECOND_EDGE,
          ],
          "T4.6-4 duplicate unit chains disambiguate with the 1-based " +
            "document-order suffix: the getter keeps `Pair.value` and the " +
            "setter is `Pair.value@2`; the first sibling-scope `worker` is " +
            "unsuffixed and the second is `worker@2` (SPEC 4.6)",
        );

        // Each `@2` identity is an addressable graph node (SPEC 11:
        // `path#unit@N`), reached by `query edges --from`.
        assertEdgeSetEqual(
          await queryEdgesFrom(
            product,
            workspace,
            "src/dup.ts#Pair.value@2",
            "T4.6-4",
          ),
          [T4_6_4_SETTER_EDGE],
          "T4.6-4 `src/dup.ts#Pair.value@2` addresses the setter — the " +
            "second occurrence of the `Pair.value` chain — whose complete " +
            "edge set is its marker's edge (SPEC 4.6, 11)",
        );
        assertEdgeSetEqual(
          await queryEdgesFrom(
            product,
            workspace,
            "src/dup.ts#worker@2",
            "T4.6-4",
          ),
          [T4_6_4_SECOND_EDGE],
          "T4.6-4 `src/dup.ts#worker@2` addresses the second sibling-scope " +
            "declaration, whose complete edge set is its marker's edge " +
            "(SPEC 4.6, 11)",
        );

        // Coverage boundary membership: in the direct-mode profile each
        // target is reached by exactly one edge, so its one shortest
        // covering path is forced to [boundary unit, target] — the `@2`
        // units appear as boundary members (SPEC 8, 8.2).
        const coverageLabel = "T4.6-4 `coverage --json`";
        const coverage = decodeCoverageReport(
          await runJson(
            product,
            workspace,
            ["coverage", "--json"],
            coverageLabel,
          ),
          coverageLabel,
        );
        assertSameJson(
          coverage.profiles.map((profile) => profile.name),
          ["units"],
          `${coverageLabel}: the one configured profile runs (SPEC 8.2)`,
        );
        const profile = coverage.profiles[0]!;
        assertSameJson(
          [...profile.uncovered].sort(),
          [],
          `${coverageLabel}: every required node is covered by its ` +
            "marker's edge (SPEC 8)",
        );
        assertSameJson(
          profile.covered
            .map((node) => `${node.identity} <= ${node.path.join(" > ")}`)
            .sort(),
          [
            "specs/D.mdx#first <= src/dup.ts#worker > specs/D.mdx#first",
            "specs/D.mdx#second <= src/dup.ts#worker@2 > specs/D.mdx#second",
            "specs/D.mdx#viagetter <= src/dup.ts#Pair.value > " +
              "specs/D.mdx#viagetter",
            "specs/D.mdx#viasetter <= src/dup.ts#Pair.value@2 > " +
              "specs/D.mdx#viasetter",
          ],
          `${coverageLabel}: each covered target's one covering path runs ` +
            "from its marker's unit — the `@2` identities appearing as the " +
            "boundary members of their targets' paths (SPEC 4.6, 8, 8.2)",
        );
      },
    );
  },
});

/** TEST-SPEC §4.6, in canonical ID order (SUITE-16). */
export const section46Tests: readonly ProductTestEntry[] = [
  T4_6_1,
  T4_6_2,
  T4_6_3,
  T4_6_4,
];
