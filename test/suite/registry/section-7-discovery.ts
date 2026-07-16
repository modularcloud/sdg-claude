// TEST-SPEC §7 discovery (glob semantics, symbolic links, discovery
// boundaries) — SUITE-27: T7-4…T7-6. Configuration basics (T7-1…T7-3) live in
// section-7-basics.ts; the §7.1–7.5 tests belong to later tasks.
//
// Registered product-facing bodies (C-2 "one code path"): each builds its own
// fresh workspace (H-1), drives the product strictly as a subprocess (H-2),
// asserts exact exit codes (H-5), decodes reports through the H-3 adapters,
// and rejects a product only via diagnosed assertion failures (H-8).
//
// SPEC 7: globs support exactly `*` (any possibly empty run of bytes within
// one path segment), `?` (one byte within a segment), and `**` (any number of
// whole segments, including none) — every other character is a literal;
// matching is byte-wise (workspace-relative paths as their UTF-8 bytes) and
// case-sensitive; a path segment beginning with `.` is matched only by a
// pattern segment written with a leading `.`; patterns resolve relative to
// the configuration file's directory, and one resolving outside the workspace
// root is a configuration error (14.14). Discovery never follows symbolic
// links; derived files are never sources (13.4); imports resolve references
// but never add files to the workspace (2.1, else 14.15); a no-match group
// and an empty `specs`/`code` map are valid with zero sources.
//
// Observation: `ids --json` (12.3) — requirement IDs grouped by file identify
// every discovered source together with its parsed content, so a wrongly
// discovered path surfaces as an extra listing entry (or as the validation
// failure its discovery causes) and a wrongly missed path as an absent one.
// Every discovered fixture file is a valid single-section source carrying an
// ID unique in its workspace, and every decoy (a file that must NOT be
// discovered) is equally valid with its own unique ID: a product that wrongly
// discovers a decoy lists it cleanly instead of crashing, keeping failures
// diagnosed (H-8). T7-4 and T7-5 never run `build`, so the only
// product-written path is graph data under `.xspec/` (13.3), which no fixture
// pattern can reach: none names `.xspec/`, no staged name carries `.xspec.`,
// `markdown` is absent, and wildcards never match the dot segment — the
// CERTIFICATIONS.md CONF-DISC staging constraints for these two tests.
//
// Conservative operationalizations (H-3/H-4):
// - Listing comparisons sort both sides bytewise by file path: these tests
//   assert discovery membership; the report's file ordering is 12.3's own
//   contract, asserted by T12.3-1.
// - The é.mdx byte-semantics arms are gated to the Linux leg by T7-4's own
//   text: Linux file names are byte strings, so the staged two-byte code
//   point reaches the matcher verbatim; other platforms' filesystems
//   normalize or re-case names, so the staged bytes are not portable.
// - T7-5 runs `ids` once over one workspace holding every link arm; the
//   invocation is wrapped so a failure to complete — a discovery hang on the
//   staged symlink cycle, killed by the subprocess driver's timeout (H-8) —
//   is reported as a diagnosed assertion failure: nontermination is exactly
//   the product defect that arm tests (SPEC 7).
// - 14.14 contract: `expectConfigurationError` (shared, ./support.ts).

import { Buffer } from "node:buffer";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { decodeIdsReport } from "../../helpers/adapters/index.js";
import {
  assertExitCode,
  fail,
  parseJsonStdout,
} from "../../helpers/assertions.js";
import { defineProductTest } from "../../helpers/registry.js";
import type { ProductTestEntry } from "../../helpers/registry.js";
import type { ProductBinding, RunResult } from "../../helpers/subprocess.js";
import { runProduct } from "../../helpers/subprocess.js";
import { TestWorkspace } from "../../helpers/workspace.js";
import type { WorkspaceDecl } from "../../helpers/workspace.js";
import {
  assertConditionCounts,
  assertFindingLocated,
  assertSameJson,
  buildFindings,
  buildOk,
  byteWindow,
  expectConfigurationError,
} from "./support.js";

// ---------------------------------------------------------------------------
// Shared fixture material
// ---------------------------------------------------------------------------

/** A minimal valid single-section source: one node `<id>` under the root. */
function mdxSection(id: string): string {
  return `<S id="${id}">\nText for ${id}.\n</S>\n`;
}

/**
 * A declarative configuration (SPEC 7) whose `specs` map holds exactly the
 * given groups. Group names are non-computed identifier keys; patterns are
 * rendered as static string literals.
 */
function specGroupsConfig(
  groups: Readonly<Record<string, readonly string[]>>,
): string {
  const entries = Object.entries(groups)
    .map(
      ([name, patterns]) =>
        `    ${name}: [${patterns.map((p) => JSON.stringify(p)).join(", ")}]`,
    )
    .join(",\n");
  return `import { defineConfig } from "xspec"\n\nexport default defineConfig({\n  specs: {\n${entries}\n  }\n})\n`;
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

/** One `{file, ids}` listing entry (the ids report's flat form, 12.3). */
interface ListingEntry {
  readonly file: string;
  readonly ids: readonly string[];
}

/** Copy of a listing sorted bytewise by file path (module header: membership
 * is these tests' subject; the report's own ordering is T12.3-1's). */
function sortedListing(entries: readonly ListingEntry[]): ListingEntry[] {
  return entries
    .map((entry) => ({ file: entry.file, ids: entry.ids }))
    .sort((a, b) =>
      Buffer.compare(Buffer.from(a.file, "utf8"), Buffer.from(b.file, "utf8")),
    );
}

/**
 * Run `ids --json` (12.3) and assert the discovered set: exit 0 with exactly
 * one JSON document, whose file/ID listing equals `expected` up to file order
 * (compared bytewise-sorted on both sides).
 */
async function expectDiscovered(
  product: ProductBinding,
  workspace: TestWorkspace,
  expected: readonly ListingEntry[],
  context: string,
  cwd?: string,
): Promise<void> {
  const result = await runProduct(product, {
    cwd: cwd ?? workspace.root,
    argv: ["ids", "--json"],
  });
  assertExitCode(
    result,
    0,
    `${context} — the workspace's discovered sources are all valid, so ` +
      `\`ids\` answers (SPEC 12.3, 13.3)`,
  );
  const report = decodeIdsReport(parseJsonStdout(result, context), context);
  assertSameJson(
    sortedListing(report.files),
    sortedListing(expected),
    `${context}: the discovered set — requirement IDs grouped by file, ` +
      `compared bytewise-sorted by path (SPEC 12.3; membership per SPEC 7)`,
  );
}

// ---------------------------------------------------------------------------
// T7-4 — glob semantics
// ---------------------------------------------------------------------------

// One discovery probe: a staged file and whether the configured patterns must
// match it. Every probe file is a valid single-section source with a unique
// ID (module header), so the discovered set is asserted as an exact listing.
interface DiscoveryProbe {
  readonly path: string;
  readonly id: string;
  readonly discovered: boolean;
}

function probeFiles(probes: readonly DiscoveryProbe[]): Record<string, string> {
  const files: Record<string, string> = {};
  for (const probe of probes) {
    files[probe.path] = mdxSection(probe.id);
  }
  return files;
}

function expectedListing(probes: readonly DiscoveryProbe[]): ListingEntry[] {
  return probes
    .filter((probe) => probe.discovered)
    .map((probe) => ({ file: probe.path, ids: [probe.id] }));
}

// The wildcard/dot/literal semantics workspace: one group per probe
// directory, directories mutually disjoint so no probe's match can mask
// another group's (mis)behavior. SPEC 7's grammar, arm by arm.
const SEMANTICS_GROUPS: Readonly<Record<string, readonly string[]>> = {
  // `*`: any possibly empty run of bytes within ONE segment.
  star: ["star/a*.mdx"],
  // `?`: exactly one byte within a segment.
  oneByte: ["q/?.mdx"],
  // `**`: any number of whole segments, including none.
  segments: ["deep/**/z.mdx"],
  // Dot-segment rule: wildcards never match a leading dot (T7-4's three
  // stated probes: `a/**/b.mdx` vs `a/.h/b.mdx`, `*` vs `.hidden`, `?x` vs
  // `.x`)...
  dotDoubleStar: ["dota/**/b.mdx"],
  dotStar: ["dotb/*.mdx"],
  dotQuestion: ["dotc/?x.mdx"],
  // ...while a pattern segment written with a leading `.` does match one.
  dotLiteral: ["dotd/.h/b.mdx"],
  dotPrefixed: ["dote/.*.mdx"],
  // Literal metacharacters (SPEC 7: every character outside `*`/`?`/`**` is a
  // literal): `[1]`, `{a,c}`, `!`, `+(x)` match exactly the file names
  // containing those characters — never what a character-class,
  // brace-expansion, negation, or extglob dialect would match.
  literalBrackets: ["litbr/a[1].mdx"],
  literalBraces: ["litbrace/b{a,c}.mdx"],
  literalBang: ["litbang/!x.mdx"],
  literalExtglob: ["litext/+(x).mdx"],
};

const SEMANTICS_PROBES: readonly DiscoveryProbe[] = [
  // `*` — empty run, multi-byte run, literal prefix, segment confinement.
  { path: "star/a.mdx", id: "s1", discovered: true },
  { path: "star/abc.mdx", id: "s2", discovered: true },
  { path: "star/b.mdx", id: "s3", discovered: false },
  // `star/a*.mdx` has two segments; a `*` crossing `/` (a naive regex `.*`)
  // would wrongly reach this three-segment path.
  { path: "star/ax/y.mdx", id: "s4", discovered: false },
  // `?` — exactly one byte, not two.
  { path: "q/a.mdx", id: "q1", discovered: true },
  { path: "q/ab.mdx", id: "q2", discovered: false },
  // `**` — zero, one, and two whole segments; never a partial segment.
  { path: "deep/z.mdx", id: "d1", discovered: true },
  { path: "deep/m/z.mdx", id: "d2", discovered: true },
  { path: "deep/m/n/z.mdx", id: "d3", discovered: true },
  { path: "deep/mz.mdx", id: "d4", discovered: false },
  // Dot-segment rule, negative: `**`, `*`, and `?` never match a leading dot.
  { path: "dota/h/b.mdx", id: "t1", discovered: true },
  { path: "dota/.h/b.mdx", id: "t2", discovered: false },
  { path: "dotb/plain.mdx", id: "t3", discovered: true },
  { path: "dotb/.hidden.mdx", id: "t4", discovered: false },
  { path: "dotc/ax.mdx", id: "t5", discovered: true },
  { path: "dotc/.x.mdx", id: "t6", discovered: false },
  // Dot-segment rule, positive: a pattern segment written with a leading `.`
  // does match — literally (`.h`) and with a trailing wildcard (`.*.mdx`).
  { path: "dotd/.h/b.mdx", id: "t7", discovered: true },
  { path: "dote/.hidden.mdx", id: "t8", discovered: true },
  // Literal `[1]`: the bracket-bearing name matches; the name a
  // character-class dialect would match does not.
  { path: "litbr/a[1].mdx", id: "l1", discovered: true },
  { path: "litbr/a1.mdx", id: "l2", discovered: false },
  // Literal `{a,c}`: the brace-bearing name matches; brace-expansion
  // candidates do not.
  { path: "litbrace/b{a,c}.mdx", id: "l3", discovered: true },
  { path: "litbrace/ba.mdx", id: "l4", discovered: false },
  { path: "litbrace/bc.mdx", id: "l5", discovered: false },
  // Literal `!`: the bang-bearing name matches; a negation dialect
  // ("everything but x.mdx") would instead match the sibling.
  { path: "litbang/!x.mdx", id: "l6", discovered: true },
  { path: "litbang/y.mdx", id: "l7", discovered: false },
  // Literal `+(x)`: the extglob-looking name matches; what extglob `+(x)`
  // (one or more `x`) would match does not.
  { path: "litext/+(x).mdx", id: "l8", discovered: true },
  { path: "litext/x.mdx", id: "l9", discovered: false },
  { path: "litext/xx.mdx", id: "l10", discovered: false },
];

// Single-casing case-sensitivity probes (T7-4: stageable on any filesystem —
// each path exists in exactly one casing, so nothing collides on
// case-insensitive filesystems): a group whose only pattern is `SPECS/*.mdx`
// over a workspace directory `specs/` holding `A.mdx` discovers zero sources
// (rerun on the Windows leg, E-6/CI-01), and a file-level twin (`specs2/b.mdx`
// over `specs2/B.mdx`) likewise. The control group pins that discovery ran.
const CASING_GROUPS: Readonly<Record<string, readonly string[]>> = {
  probe: ["SPECS/*.mdx"],
  fileProbe: ["specs2/b.mdx"],
  control: ["ctl/*.mdx"],
};

const CASING_PROBES: readonly DiscoveryProbe[] = [
  { path: "specs/A.mdx", id: "a", discovered: false },
  { path: "specs2/B.mdx", id: "b", discovered: false },
  { path: "ctl/C.mdx", id: "c", discovered: true },
];

/**
 * T7-4's single-casing glob probe as one shared code path: called by the
 * registered T7-4 body on the suite leg and rerun verbatim by the Windows leg
 * (TEST-SPEC E-6; test/windows/e6-subset.test.ts). Glob matching is
 * case-sensitive on every platform (SPEC 7, 12.0): `SPECS/*.mdx` over
 * `specs/A.mdx` (and `specs2/b.mdx` over `specs2/B.mdx`) discovers nothing —
 * on a case-insensitive filesystem a product matching globs through
 * filesystem lookups wrongly discovers the file. Each path is staged in
 * exactly one casing, so the fixture stages identically everywhere.
 */
export async function runT74SingleCasingGlobProbe(
  product: ProductBinding,
): Promise<void> {
  await withWorkspace(
    {
      files: {
        "xspec.config.ts": specGroupsConfig(CASING_GROUPS),
        ...probeFiles(CASING_PROBES),
      },
    },
    async (workspace) => {
      await expectDiscovered(
        product,
        workspace,
        expectedListing(CASING_PROBES),
        "T7-4 (single-casing case-sensitivity probes: SPECS/*.mdx over " +
          "specs/A.mdx, specs2/b.mdx over specs2/B.mdx) `ids --json`",
      );
    },
  );
}

// Byte-semantics probes (T7-4, Linux leg — module header): `é` is U+00E9,
// two bytes (0xC3 0xA9) in UTF-8, one character. Paths match as their UTF-8
// bytes (SPEC 7), so `?` (one byte) must NOT match `é.mdx` while `??` (two
// bytes) and `*` must — a character-semantics matcher decides all three the
// other way. The `?`-arm runs in its own workspace: discovery is the union
// over groups, so sharing a workspace with the `??`/`*` groups would mask a
// wrong `?` match.
const BYTE_ONE_GROUPS: Readonly<Record<string, readonly string[]>> = {
  one: ["bytes/?.mdx"],
};
const BYTE_ONE_PROBES: readonly DiscoveryProbe[] = [
  { path: "bytes/é.mdx", id: "etwo", discovered: false },
  { path: "bytes/x.mdx", id: "xone", discovered: true },
];
const BYTE_TWO_GROUPS: Readonly<Record<string, readonly string[]>> = {
  two: ["bytes/??.mdx"],
  anyRun: ["bytes2/*.mdx"],
};
const BYTE_TWO_PROBES: readonly DiscoveryProbe[] = [
  { path: "bytes/é.mdx", id: "e1", discovered: true },
  { path: "bytes2/é.mdx", id: "e2", discovered: true },
];

// Configuration-directory resolution (T7-4: all paths resolve relative to the
// configuration file's directory): run from `sub/`, whose own `sub/specs/`
// holds a source the root configuration's `specs/*.mdx` must NOT see — a
// product resolving globs against the working directory instead of the
// configuration file's directory lists `specs/B.mdx` (id `nested`) in place
// of `specs/A.mdx` (id `roota`).
const CONFIG_DIR_GROUPS: Readonly<Record<string, readonly string[]>> = {
  main: ["specs/*.mdx"],
};
const CONFIG_DIR_PROBES: readonly DiscoveryProbe[] = [
  { path: "specs/A.mdx", id: "roota", discovered: true },
  { path: "sub/specs/B.mdx", id: "nested", discovered: false },
];

// Outside-root patterns (SPEC 7: a pattern that resolves outside the
// workspace root is a configuration error, 14.14) — a plain `../` escape and
// a `..` traversal buried mid-pattern. Each fixture also stages a valid group
// and source, so a product that ignores or no-match-treats the escaping
// pattern proceeds to a successful run (exit 0) and fails the exit-2
// assertion — never exits 2 for a side reason.
const OUTSIDE_ROOT_PATTERNS: readonly string[] = [
  "../outside/*.mdx",
  "specs/../../outside/*.mdx",
];

const T7_4 = defineProductTest({
  id: "T7-4",
  title:
    "glob semantics: `*`/`?`/`**` per SPEC 7, byte-wise case-sensitive " +
    "matching incl. the single-casing SPECS/specs probe and the Linux-leg " +
    "é.mdx byte probes, the dot-segment rule, literal metacharacters " +
    "([1], {a,c}, !, +(x)), configuration-directory-relative resolution, " +
    "and outside-root patterns as configuration errors (SPEC 7, 14.14)",
  run: async (product) => {
    // Wildcard, dot-segment, and literal-metacharacter semantics — disjoint
    // per-directory groups over one workspace, asserted as one exact set.
    await withWorkspace(
      {
        files: {
          "xspec.config.ts": specGroupsConfig(SEMANTICS_GROUPS),
          ...probeFiles(SEMANTICS_PROBES),
        },
      },
      async (workspace) => {
        await expectDiscovered(
          product,
          workspace,
          expectedListing(SEMANTICS_PROBES),
          "T7-4 (wildcard/dot/literal semantics) `ids --json`",
        );
      },
    );

    // Case-sensitive matching: the single-casing probes discover nothing;
    // the control group proves discovery ran. Shared code path with the
    // Windows-leg rerun (E-6/CI-01).
    await runT74SingleCasingGlobProbe(product);

    // Patterns resolve relative to the configuration file's directory, not
    // the working directory.
    await withWorkspace(
      {
        files: {
          "xspec.config.ts": specGroupsConfig(CONFIG_DIR_GROUPS),
          ...probeFiles(CONFIG_DIR_PROBES),
        },
      },
      async (workspace) => {
        await expectDiscovered(
          product,
          workspace,
          expectedListing(CONFIG_DIR_PROBES),
          "T7-4 (globs resolve against the configuration file's directory) " +
            "`ids --json` run from sub/",
          workspace.path("sub"),
        );
      },
    );

    // Byte semantics — Linux leg per T7-4's own text (module header).
    if (process.platform === "linux") {
      await withWorkspace(
        {
          files: {
            "xspec.config.ts": specGroupsConfig(BYTE_ONE_GROUPS),
            ...probeFiles(BYTE_ONE_PROBES),
          },
        },
        async (workspace) => {
          await expectDiscovered(
            product,
            workspace,
            expectedListing(BYTE_ONE_PROBES),
            "T7-4 (byte semantics, Linux leg: `?` is one byte, so " +
              "bytes/?.mdx does not match the two-byte é.mdx) `ids --json`",
          );
        },
      );
      await withWorkspace(
        {
          files: {
            "xspec.config.ts": specGroupsConfig(BYTE_TWO_GROUPS),
            ...probeFiles(BYTE_TWO_PROBES),
          },
        },
        async (workspace) => {
          await expectDiscovered(
            product,
            workspace,
            expectedListing(BYTE_TWO_PROBES),
            "T7-4 (byte semantics, Linux leg: `??` — two bytes — and `*` " +
              "both match é.mdx) `ids --json`",
          );
        },
      );
    }

    // A pattern resolving outside the workspace root → 14.14 (exit 2).
    for (const pattern of OUTSIDE_ROOT_PATTERNS) {
      await withWorkspace(
        {
          files: {
            "xspec.config.ts": specGroupsConfig({
              main: ["specs/*.mdx"],
              escape: [pattern],
            }),
            "specs/A.mdx": mdxSection("a"),
          },
        },
        async (workspace) => {
          await expectConfigurationError(
            product,
            workspace,
            ["build"],
            `T7-4 (pattern ${JSON.stringify(pattern)} resolves outside the ` +
              `workspace root) \`build --json\``,
          );
        },
      );
    }
  },
});

// ---------------------------------------------------------------------------
// T7-5 — symbolic links
// ---------------------------------------------------------------------------

// One workspace holds every T7-5 arm (SPEC 7: discovery never follows
// symbolic links — to a file or a directory, broken or not — so symlinked,
// cyclic, or workspace-external content never enters the discovered set):
//
//   real/R.mdx                     regular source — positive control
//   links/file-link.mdx  → ../targets/T.mdx      glob-matched file symlink to
//                                                an existing workspace file:
//                                                never discovered
//   links/external.mdx   → ../../outside/X.mdx   glob-matched file symlink to
//                                                content outside the
//                                                workspace root: never enters
//                                                the discovered set
//   links/broken.mdx     → missing.mdx           dangling link: ignored
//   links/dir            → ../realdir            directory symlink: never
//                                                traversed, so realdir/D.mdx
//                                                is not discovered as
//                                                links/dir/D.mdx
//   cyc/self             → .                     directory symlink cycle of
//                                                length one: discovery of
//                                                cyc/ must terminate
//   cyc/C.mdx                                    regular source inside the
//                                                cycle directory — proves
//                                                cyc/ was scanned
//
// targets/T.mdx and realdir/D.mdx are matched by no pattern; every link
// target holds a valid single-section source with its own unique ID, so a
// link-following product lists the extra files cleanly (diagnosed listing
// mismatch, not a crash) — and VIOL-DISC-SYMLINK fails exactly this way
// (CERTIFICATIONS.md: by assertion, not by hang).
const SYMLINK_GROUPS: Readonly<Record<string, readonly string[]>> = {
  real: ["real/*.mdx"],
  links: ["links/**/*.mdx"],
  cycle: ["cyc/**/*.mdx"],
};

const SYMLINK_EXPECTED: readonly ListingEntry[] = [
  { file: "cyc/C.mdx", ids: ["c"] },
  { file: "real/R.mdx", ids: ["r"] },
];

const T7_5 = defineProductTest({
  id: "T7-5",
  title:
    "symbolic links: a symlinked file matched by a glob is not discovered, " +
    "a symlinked directory is not traversed, broken links are ignored, a " +
    "symlink cycle does not hang discovery, and workspace-external content " +
    "behind a link never enters the discovered set (SPEC 7)",
  run: async (product) => {
    await withWorkspace(
      {
        files: {
          "xspec.config.ts": specGroupsConfig(SYMLINK_GROUPS),
          "real/R.mdx": mdxSection("r"),
          "targets/T.mdx": mdxSection("t"),
          "realdir/D.mdx": mdxSection("d"),
          "cyc/C.mdx": mdxSection("c"),
        },
      },
      async (workspace) => {
        // Links staged explicitly so directory links carry the Windows
        // link-type hint (ignored on POSIX; the suite's CI leg is Linux).
        await workspace.symlink("links/file-link.mdx", "../targets/T.mdx");
        await workspace.symlink("links/broken.mdx", "missing.mdx");
        await workspace.symlink("links/dir", "../realdir", "dir");
        await workspace.symlink("cyc/self", ".", "dir");
        // Workspace-external content: a valid source OUTSIDE the workspace
        // root (beside it in the test-owned temporary directory, disposed
        // with the workspace), reachable only through the link.
        const outside = path.join(workspace.tempRoot, "outside");
        await fsp.mkdir(outside, { recursive: true });
        await fsp.writeFile(path.join(outside, "X.mdx"), mdxSection("x"));
        await workspace.symlink("links/external.mdx", "../../outside/X.mdx");

        const context = "T7-5 `ids --json` over the symbolic-link workspace";
        const result: RunResult = await runProduct(product, {
          cwd: workspace.root,
          argv: ["ids", "--json"],
        }).catch((error: unknown) =>
          // Module header: a run that fails to complete — the staged symlink
          // cycle hanging discovery until the subprocess driver kills it —
          // is the tested defect, diagnosed here (SPEC 7; H-8).
          fail(
            `${context}: discovery must terminate without following ` +
              `symbolic links — in particular, the staged symlink cycle ` +
              `(cyc/self -> .) must not hang it (SPEC 7); the invocation ` +
              `did not complete: ` +
              (error instanceof Error ? error.message : String(error)),
          ),
        );
        assertExitCode(
          result,
          0,
          `${context} — symlinked files are never discovered, symlinked ` +
            `directories never traversed, and broken links ignored, so the ` +
            `workspace holds only its two valid regular sources and \`ids\` ` +
            `answers (SPEC 7, 12.3)`,
        );
        const report = decodeIdsReport(
          parseJsonStdout(result, context),
          context,
        );
        assertSameJson(
          sortedListing(report.files),
          sortedListing(SYMLINK_EXPECTED),
          `${context}: exactly the two regular sources are discovered — no ` +
            `file symlink (workspace-internal or external target), no ` +
            `directory-symlink content, no broken link (SPEC 7)`,
        );
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T7-6 — discovery boundaries
// ---------------------------------------------------------------------------

// Exclusion arms (SPEC 13.4: derived files are never sources — paths whose
// file name contains `.xspec.`, files under `.xspec/`, and files at the
// configured Markdown emit destinations are excluded from every group), all
// staged over spec groups (the CERTIFICATIONS.md CONF-DISC staging
// constraint; `code` appears in this test only as the empty map):
//
//   specs/A.mdx        the one real source (id `a`)
//   specs/A.md         user-authored file at A.mdx's emit destination —
//                      emission enabled and never yet run, so classification
//                      is by configuration alone (7.3); matched by `specs/*`
//                      but excluded: not discovered, and no 14.19 despite
//                      lacking `.mdx`
//   specs/B.xspec.mdx  valid `.mdx` content at a `.xspec.`-bearing name,
//                      matched by `specs/*`: excluded
//   .xspec/direct.mdx  valid `.mdx` content under `.xspec/`, matched by a
//                      pattern spelling the dot segment literally
//                      (`.xspec/*.mdx`, past the dot-segment rule): excluded
//
// The `build` between the two listings regenerates derived files (12.1) —
// afterwards `specs/*` also matches the generated `A.xspec.*` module and
// companions and the emitted `specs/A.md`, all of which stay excluded, so
// the discovered set is unchanged.
const EXCLUSION_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/*"],
    inside: [".xspec/*.mdx"]
  },
  markdown: { emit: true }
})
`;

const EXCLUSION_EXPECTED: readonly ListingEntry[] = [
  { file: "specs/A.mdx", ids: ["a"] },
];

// Import arms (SPEC 2.1/7: imports resolve references between files but
// never add files to the workspace — the designated file must already be a
// discovered source of a configured spec group, else 14.15).
const IMPORT_NEG_LINE = 'import U from "../other/unlisted.xspec"';
const IMPORT_NEG_SOURCE = `${IMPORT_NEG_LINE}\n\n<S id="a">\nAlpha behavior.\n</S>\n`;
const IMPORT_POS_SOURCE = `import B from "./sub/B.xspec"\n\n<S id="a">\nAlpha behavior.\n</S>\n`;

const T7_6 = defineProductTest({
  id: "T7-6",
  title:
    "discovery boundaries: derived files (`.xspec.` names, `.xspec/` " +
    "paths, enabled Markdown emit destinations) are never discovered as " +
    "sources even when globs match them; an import never adds an unmatched " +
    "file (14.15); a no-match group and empty specs/code maps are valid " +
    "with zero sources (SPEC 7, 13.4, 2.1)",
  run: async (product) => {
    // (a) Derived-file exclusion, before and after a `build`.
    await withWorkspace(
      {
        files: {
          "xspec.config.ts": EXCLUSION_CONFIG,
          "specs/A.mdx": mdxSection("a"),
          "specs/A.md": "User-authored file at the emit destination.\n",
          "specs/B.xspec.mdx": mdxSection("b"),
          ".xspec/direct.mdx": mdxSection("d"),
        },
      },
      async (workspace) => {
        await expectDiscovered(
          product,
          workspace,
          EXCLUSION_EXPECTED,
          "T7-6 (derived-file exclusion, before any build: emission " +
            "enabled but never run — destinations classified by " +
            "configuration alone, 7.3) `ids --json`",
        );
        await buildOk(
          product,
          workspace,
          "T7-6 (derived-file exclusion): `build` — the excluded files are " +
            "no sources, and writing derived files replaces whatever " +
            "occupies their paths (SPEC 12.1, 13.4)",
        );
        await expectDiscovered(
          product,
          workspace,
          EXCLUSION_EXPECTED,
          "T7-6 (derived-file exclusion, after build: the generated " +
            "`A.xspec.*` files and the emitted specs/A.md now exist and " +
            "are matched by specs/* — still excluded, 13.4) `ids --json`",
        );
      },
    );

    // (b) An import never adds an unmatched file: other/unlisted.mdx exists
    // on disk and the specifier resolves to it against the importing file's
    // directory (2.1), but no group matches it — so the import is invalid
    // (14.15, exit 1) instead of the file entering the workspace (a product
    // that adds import targets builds successfully and fails the exit-code
    // assertion).
    await withWorkspace(
      {
        files: {
          "xspec.config.ts": specGroupsConfig({ main: ["specs/*.mdx"] }),
          "specs/A.mdx": IMPORT_NEG_SOURCE,
          "other/unlisted.mdx": mdxSection("u"),
        },
      },
      async (workspace) => {
        const context =
          "T7-6 (import of an existing but unmatched file) `build --json`";
        const findings = await buildFindings(product, workspace, context);
        assertConditionCounts(findings, { "14.15": 1 }, context);
        assertFindingLocated(
          findings[0]!,
          { file: "specs/A.mdx", window: byteWindow("", IMPORT_NEG_LINE) },
          `${context}: the 14.15 finding`,
        );
      },
    );

    // (b') The positive control: the same import shape whose target IS a
    // discovered source (resolved against the importing file's directory)
    // is valid — and the discovered set is exactly the glob matches, the
    // import adding nothing.
    await withWorkspace(
      {
        files: {
          "xspec.config.ts": specGroupsConfig({ main: ["specs/**/*.mdx"] }),
          "specs/A.mdx": IMPORT_POS_SOURCE,
          "specs/sub/B.mdx": mdxSection("b"),
        },
      },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T7-6 (import of a discovered source): `build` — the specifier " +
            "resolves against the importing file's directory to a " +
            "discovered source, so the import is valid (SPEC 2.1)",
        );
        await expectDiscovered(
          product,
          workspace,
          [
            { file: "specs/A.mdx", ids: ["a"] },
            { file: "specs/sub/B.mdx", ids: ["b"] },
          ],
          "T7-6 (import of a discovered source) `ids --json`",
        );
      },
    );

    // (c) A group whose globs match no files is valid: zero sources from it,
    // discovery otherwise unaffected.
    await withWorkspace(
      {
        files: {
          "xspec.config.ts": specGroupsConfig({
            main: ["specs/*.mdx"],
            vacant: ["vacant/**/*.mdx"],
          }),
          "specs/A.mdx": mdxSection("a"),
        },
      },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T7-6 (no-match group): `build` — a group whose globs match no " +
            "files is valid (SPEC 7)",
        );
        await expectDiscovered(
          product,
          workspace,
          [{ file: "specs/A.mdx", ids: ["a"] }],
          "T7-6 (no-match group) `ids --json`",
        );
      },
    );

    // (d) Empty `specs` and `code` maps are valid with zero sources: the
    // staged notes/N.mdx belongs to no group (there are none), so discovery
    // yields nothing and both commands still succeed.
    await withWorkspace(
      {
        files: {
          "xspec.config.ts": `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {},
  code: {}
})
`,
          "notes/N.mdx": mdxSection("n"),
        },
      },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T7-6 (empty specs/code maps): `build` — a specs or code map " +
            "with no groups is valid; discovery yields zero sources " +
            "(SPEC 7)",
        );
        await expectDiscovered(
          product,
          workspace,
          [],
          "T7-6 (empty specs/code maps) `ids --json`",
        );
      },
    );
  },
});

/** TEST-SPEC §7 discovery T7-4…T7-6, in canonical ID order (SUITE-27). */
export const section7DiscoveryTests: readonly ProductTestEntry[] = [
  T7_4,
  T7_5,
  T7_6,
];
