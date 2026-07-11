// TEST-SPEC §5.4 (reference canonicalization) — SUITE-18: T5.4-1, T5.4-2.
//
// Registered product-facing bodies (C-2 "one code path"): each builds its own
// fresh workspace (H-1), drives the product strictly as a subprocess (H-2),
// asserts exact exit codes (H-5), decodes output through the H-3 adapters,
// and rejects a product only via diagnosed assertion failures (H-8).
//
// SPEC 5.4: references hash as their target's canonical identity — the
// identity a backwards journal walk ends on, PAIRED with the journal position
// where it ends — never as spellings. An identity vacated by a journaled
// rename/move and later re-borne (by manual authorship or by another
// journaled rename) therefore starts a new chain: distinct nodes always have
// distinct canonical identities, and references to them never hash alike,
// while the pure operations of 6.2 change no hash at all.
//
// Conservative operationalizations (noted per H-4):
// - Impact entries: an uncategorized, undeleted node has no requirement entry
//   (SPEC 9.3 groups output by category), the interpretation the suite fixed
//   in T1.5-1 (section-1.5.ts) — "reports no categories" is asserted as an
//   empty `requirements` list, "unchanged" as the absence of any entry naming
//   the node.
// - Manual-edit staging anchors on spec-mandated rewrite forms (SPEC 6.4:
//   minimal in-place edits preserving quote style and access form;
//   double-quoted computed access where a segment is no TypeScript
//   identifier; double-quoted string literals for references converted to
//   local form). A missing or ambiguous anchor fails diagnosed — a product
//   deviating from those mandated forms legitimately fails here.
// - T5.4-2's "changes no hash" manual arms compare all four hashes of every
//   node of the (deliberately small) fixture before and after the edit; the
//   rename/move arms compare the referencing node, per the test's text.

import type {
  ImpactReport,
  ImpactRequirementEntry,
  NodeHashes,
} from "../../helpers/adapters/index.js";
import {
  decodeImpactReport,
  decodeNodeReport,
} from "../../helpers/adapters/index.js";
import { fail, parseJsonStdout } from "../../helpers/assertions.js";
import { defineProductTest } from "../../helpers/registry.js";
import type { ProductTestEntry } from "../../helpers/registry.js";
import type { ProductBinding } from "../../helpers/subprocess.js";
import { TestWorkspace } from "../../helpers/workspace.js";
import { assertSameJson, buildOk, expectExit, runJson } from "./support.js";

// Minimal declarative configuration (SPEC 7): exactly one spec group. No code
// groups exist in any fixture here, so impacted code never enters play.
const SPECS_ONLY_CONFIG = `import { defineConfig } from "xspec"

export default defineConfig({
  specs: {
    main: ["specs/**/*.mdx"]
  }
})
`;

/** Stage a fresh spec-only workspace, run `body`, dispose (H-1). */
async function withWorkspace<T>(
  files: Readonly<Record<string, string>>,
  body: (workspace: TestWorkspace) => Promise<T>,
): Promise<T> {
  const workspace = await TestWorkspace.create({
    files: { "xspec.config.ts": SPECS_ONLY_CONFIG, ...files },
  });
  try {
    return await body(workspace);
  } finally {
    await workspace.dispose();
  }
}

/** The four hashes of one node via `query node` (SPEC 11, JSON-only; 5.5). */
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

/**
 * All four hashes of several nodes, keyed by identity in the given order —
 * the whole-fixture snapshot the manual re-spelling arms compare (T5.4-2:
 * "changes no hash").
 */
async function queryHashesOf(
  product: ProductBinding,
  workspace: TestWorkspace,
  identities: readonly string[],
  context: string,
): Promise<Record<string, NodeHashes>> {
  const hashes: Record<string, NodeHashes> = {};
  for (const identity of identities) {
    hashes[identity] = await queryHashes(product, workspace, identity, context);
  }
  return hashes;
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

/** The requirement entries naming `identity` among their nodes. */
function entriesNaming(
  report: ImpactReport,
  identity: string,
): readonly ImpactRequirementEntry[] {
  return report.requirements.filter((entry) => entry.nodes.includes(identity));
}

/** An entry's category names, sorted (categories are unordered flags, 5.6). */
function categoryNames(entry: ImpactRequirementEntry): string[] {
  return entry.categories.map((category) => category.category).sort();
}

/** Read a workspace source file as UTF-8 (SPEC 1.6), failing diagnosed. */
async function readSource(
  workspace: TestWorkspace,
  rel: string,
  context: string,
): Promise<string> {
  const bytes = await workspace.readBytes(rel);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail(
      `${context}: the source file ${rel} is not valid UTF-8 (SPEC 1.6) — ` +
        `the product-rewritten source cannot be staged for a manual edit`,
    );
  }
}

/**
 * Replace exactly one occurrence of `search` — the manual "author edits the
 * file" step of these fixtures. The anchors are spec-mandated rewrite forms
 * (SPEC 6.4), so a missing or ambiguous anchor is a diagnosed assertion
 * failure about the product's rewriting, never a harness crash (H-8).
 */
function replaceOnce(
  content: string,
  search: string,
  replacement: string,
  context: string,
): string {
  const first = content.indexOf(search);
  if (first === -1) {
    fail(
      `${context}: expected the rewritten source to contain ` +
        `${JSON.stringify(search)} exactly once (SPEC 6.4 fixes the rewritten ` +
        `form), but it does not appear; source: ${JSON.stringify(content)}`,
    );
  }
  if (content.includes(search, first + search.length)) {
    fail(
      `${context}: the anchor ${JSON.stringify(search)} appears more than once, ` +
        `so the manual edit cannot be staged unambiguously; source: ` +
        JSON.stringify(content),
    );
  }
  return (
    content.slice(0, first) + replacement + content.slice(first + search.length)
  );
}

// ---------------------------------------------------------------------------
// T5.4-1 — reintroduced identity
// ---------------------------------------------------------------------------

// Fixture 1 — the "first fixture": manual reintroduction. At the baseline N1
// bears `a`; `dep` depends on it (`d`), `e` embeds it, and `f` embeds it
// inside the twin line arm (b) compares against `g` later. After
// `rename a→b`, a new section `a` (N2) is authored with text byte-identical
// to N1's — the two targets' own hashes coincide, so nothing but the
// canonical identity pair (identity string + journal position, 5.4) can
// distinguish references to them: both bearers walk back to the same string
// `a` (N1: `b` → entry `a→b` extends the chain to `a` at the journal start;
// N2: the same entry maps `a` away, ending the walk just after it).
const REINTRO_ROOT = "specs/A.mdx";
const REINTRO_N1 = "specs/A.mdx#b"; // old-`a`, renamed
const REINTRO_N2 = "specs/A.mdx#a"; // the reintroduced identity
const REINTRO_DEP = "specs/A.mdx#dep";
const REINTRO_E = "specs/A.mdx#e";
const REINTRO_F = "specs/A.mdx#f";
const REINTRO_G = "specs/A.mdx#g";

const REINTRO_BASELINE = [
  '<S id="a">',
  "Alpha behavior.",
  "</S>",
  "",
  '<S id="dep" d={"a"}>',
  "Dep behavior.",
  "</S>",
  "",
  '<S id="e">',
  'Embeds: {text("a")}',
  "</S>",
  "",
  '<S id="f">',
  'Twin: {text("a")} end.',
  "</S>",
  "",
].join("\n");

// The manual authorship appended after the rename: N2 with text byte-identical
// to N1's (own content "Alpha behavior.\n" for both — identical tag-line
// layout, SPEC 1.6, 3), and `g`, whose own-content runs around its one
// embedding are byte-identical to `f`'s ("Twin: " and " end.\n") while the
// embedding targets N2 where `f`'s targets N1.
const REINTRO_APPENDED = [
  "",
  '<S id="a">',
  "Alpha behavior.",
  "</S>",
  "",
  '<S id="g">',
  'Twin: {text("a")} end.',
  "</S>",
  "",
].join("\n");

// Fixture 2 — the journaled variant: the vacated identity is re-borne through
// the journal (`rename a→b`, then `rename c→a`) rather than by authorship.
// `w` depends on both bearers.
const JOURNALED_W = "specs/A.mdx#w";

const JOURNALED_BASELINE = [
  '<S id="a">',
  "Alpha behavior.",
  "</S>",
  "",
  '<S id="c">',
  "Gamma behavior.",
  "</S>",
  "",
  '<S id="w" d={["a", "c"]}>',
  "Depends on both.",
  "</S>",
  "",
].join("\n");

const T5_4_1 = defineProductTest({
  id: "T5.4-1",
  title:
    'reintroduced identities never alias: after `rename a→b` plus manual authorship of a new `a`, `impact --base` (pre-rename) reports old-`a` (now `b`) unchanged, new-`a` added-only, and the rewritten dependent without `upstream-changed`; after a journaled re-bearing (`rename c→a`) a node depending on both bearers keeps every hash and impact reports no categories; and with the two targets\' own hashes coinciding, only the journal-position pairing separates them — a byte-restored embedder manually retargeted N1→N2 is `changed`, and twin embedders of N1 (spelled "b") vs N2 (spelled "a") have differing ownHashes (SPEC 5.4, 5.5, 5.6, 6.2, 6.3)',
  run: async (product) => {
    // --- Fixture 1: manual reintroduction, plus the journal-position arms ---
    await withWorkspace(
      { [REINTRO_ROOT]: REINTRO_BASELINE },
      async (workspace) => {
        await workspace.gitInit();
        const base = await workspace.gitCommitAll("baseline");

        await expectExit(
          product,
          workspace,
          ["rename", REINTRO_ROOT, "a", "b"],
          0,
          "T5.4-1 `rename specs/A.mdx a b` (vacating the identity `a` through the journal)",
        );

        // Manual authorship (SPEC 6.6 territory is the *new* section only —
        // the rename above stays journaled): re-spell `e`'s embedding back to
        // the string "a" — its source bytes return to the baseline bytes while
        // the reference retargets from N1 to N2 (arm a) — and append N2 and
        // `g`. The rename must have rewritten `e`'s reference to "b" (minimal
        // in-place edits preserving quote style, SPEC 6.4), which the anchor
        // enforces, diagnosed.
        const renamed = await readSource(
          workspace,
          REINTRO_ROOT,
          "T5.4-1 reading the product-rewritten source after the rename",
        );
        const respelled = replaceOnce(
          renamed,
          'Embeds: {text("b")}',
          'Embeds: {text("a")}',
          'T5.4-1 re-spelling `e`\'s embedding back to "a" after authoring N2',
        );
        await workspace.file(REINTRO_ROOT, respelled + REINTRO_APPENDED);
        await buildOk(
          product,
          workspace,
          "T5.4-1 `build` over the reintroduced-identity workspace",
        );

        const impactLabel =
          "T5.4-1 `impact --base <pre-rename>` over the manually reintroduced identity";
        const impact = await impactAgainst(
          product,
          workspace,
          base,
          impactLabel,
        );

        // Old-`a` — the node now bearing `b`, mapped through the journal
        // (6.3) — is unchanged: no entry names it with any category, and it is
        // never reported deleted (it was renamed, not deleted).
        const n1Entries = entriesNaming(impact, REINTRO_N1);
        if (n1Entries.length !== 0) {
          fail(
            `${impactLabel}: old-\`a\` — the node now bearing ${REINTRO_N1}, mapped ` +
              `through the journal (SPEC 6.3) — is unchanged and must receive no ` +
              `category and no deletion report (SPEC 5.4, 6.2); got entries ` +
              JSON.stringify(n1Entries),
          );
        }

        // New-`a` reports as added: exactly one entry names the identity
        // (SPEC 9.3's twice-reported convention is for *deleted* identities
        // re-borne — N1 was renamed, not deleted, so `a` appears once), it is
        // not deleted, and an added node is `changed` only (SPEC 5.6).
        const n2Entries = entriesNaming(impact, REINTRO_N2);
        if (n2Entries.length !== 1) {
          fail(
            `${impactLabel}: the reintroduced identity ${REINTRO_N2} is a distinct ` +
              `new node reported as added — exactly one entry (a product aliasing ` +
              `it with old-\`a\`'s byte-identical content would report none; a ` +
              `deletion pairing would report two, but old-\`a\` was renamed, not ` +
              `deleted; SPEC 5.4, 5.6, 9.3); got ` +
              JSON.stringify(n2Entries),
          );
        }
        const n2Entry = n2Entries[0]!;
        assertSameJson(
          n2Entry.nodes,
          [REINTRO_N2],
          `${impactLabel}: the added node's entry covers exactly the reintroduced identity (SPEC 9.3)`,
        );
        assertSameJson(
          n2Entry.deleted,
          false,
          `${impactLabel}: the reintroduced identity reports as added, not deleted (SPEC 5.4, 9.3)`,
        );
        assertSameJson(
          categoryNames(n2Entry),
          ["changed"],
          `${impactLabel}: an added node is \`changed\` only — no category through its own hashes (SPEC 5.6)`,
        );

        // The dependent of old-`a` (its reference rewritten to "b") shows no
        // `upstream-changed`: its target's canonical identity and effectiveHash
        // are unchanged (SPEC 5.4, 6.2).
        for (const entry of entriesNaming(impact, REINTRO_DEP)) {
          if (
            entry.categories.some(
              (category) => category.category === "upstream-changed",
            )
          ) {
            fail(
              `${impactLabel}: the dependent ${REINTRO_DEP} (its \`d\` reference ` +
                `rewritten to "b") must show no \`upstream-changed\` — its target's ` +
                `canonical identity and effectiveHash are unchanged (SPEC 5.4, ` +
                `6.2); got entry ${JSON.stringify(entry)}`,
            );
          }
        }

        // Journal-position arm (a): `e`'s source bytes equal its baseline bytes
        // (the re-spelling restored them), yet its embedded reference is
        // retargeted from N1 to N2 — a retargeted embedded reference changes
        // ownHash (SPEC 5.5), so `e` is `changed`. A product canonicalizing by
        // walked-back identity string alone sees the baseline reference and the
        // current one both as "a" and reports `e` uncategorized.
        const eEntries = entriesNaming(impact, REINTRO_E);
        if (eEntries.length !== 1) {
          fail(
            `${impactLabel}: journal-position arm (a) — ${REINTRO_E}'s source bytes ` +
              `equal its baseline bytes while its embedded reference is retargeted ` +
              `N1→N2, so exactly one entry reports it (SPEC 5.4, 5.5); a product ` +
              `canonicalizing by walked-back identity string alone reports it ` +
              `uncategorized; got entries ${JSON.stringify(eEntries)}`,
          );
        }
        const eEntry = eEntries[0]!;
        assertSameJson(
          eEntry.deleted,
          false,
          `${impactLabel}: ${REINTRO_E} is present on both sides`,
        );
        if (
          !eEntry.categories.some((category) => category.category === "changed")
        ) {
          fail(
            `${impactLabel}: ${REINTRO_E} must be \`changed\` — a retargeted embedded ` +
              `reference changes ownHash even with source bytes equal to the ` +
              `baseline's, because the two bearers of "a" have distinct canonical ` +
              `identity pairs (SPEC 5.4, 5.5); got categories ` +
              JSON.stringify(categoryNames(eEntry)),
          );
        }

        // The arms' stated precondition, asserted as a control: N2 was authored
        // with text byte-identical to N1's, and a node's own identity is no
        // input to its ownHash (5.5 hashes the own content sequence), so the
        // two targets' own hashes coincide — nothing but the identity pair can
        // distinguish references to them.
        const controlLabel = "T5.4-1 own-hash coincidence control";
        const n1Hashes = await queryHashes(
          product,
          workspace,
          REINTRO_N1,
          controlLabel,
        );
        const n2Hashes = await queryHashes(
          product,
          workspace,
          REINTRO_N2,
          controlLabel,
        );
        if (n1Hashes.ownHash !== n2Hashes.ownHash) {
          fail(
            `${controlLabel}: N2 (${REINTRO_N2}) is authored with text byte-identical ` +
              `to N1 (${REINTRO_N1}), and ownHash hashes the own content sequence — ` +
              `identical input, identical hash (SPEC 5.5) — so the two targets' own ` +
              `hashes must coincide, leaving only the canonical identity pair (5.4) ` +
              `to distinguish the arms' references; got ` +
              `${JSON.stringify(n1Hashes.ownHash)} vs ${JSON.stringify(n2Hashes.ownHash)}`,
          );
        }

        // Journal-position arm (b): `f` and `g` have byte-identical own-content
        // runs around one embedding each — `f` embedding N1 (spelled "b"), `g`
        // embedding N2 (spelled "a"). References to distinct nodes never hash
        // alike (SPEC 5.4), so their ownHashes differ; string-only
        // canonicalization walks both references back to the string "a" and
        // makes them equal.
        const twinLabel = "T5.4-1 journal-position arm (b), twin embedders";
        const fHashes = await queryHashes(
          product,
          workspace,
          REINTRO_F,
          twinLabel,
        );
        const gHashes = await queryHashes(
          product,
          workspace,
          REINTRO_G,
          twinLabel,
        );
        if (fHashes.ownHash === gHashes.ownHash) {
          fail(
            `${twinLabel}: ${REINTRO_F} embeds N1 (spelled "b") and ${REINTRO_G} ` +
              `embeds N2 (spelled "a") between byte-identical own-content runs — ` +
              `references to distinct nodes never hash alike (SPEC 5.4), so their ` +
              `ownHashes must differ; a product canonicalizing by walked-back ` +
              `identity string alone makes them equal; both reported ` +
              JSON.stringify(fHashes.ownHash),
          );
        }
      },
    );

    // --- Fixture 2: the journaled variant — `a` re-borne via `rename c→a` ---
    await withWorkspace(
      { [REINTRO_ROOT]: JOURNALED_BASELINE },
      async (workspace) => {
        await workspace.gitInit();
        const base = await workspace.gitCommitAll("baseline");
        await buildOk(
          product,
          workspace,
          "T5.4-1 `build` over the journaled-variant baseline",
        );
        const before = await queryHashes(
          product,
          workspace,
          JOURNALED_W,
          "T5.4-1 journaled variant, before the renames:",
        );

        await expectExit(
          product,
          workspace,
          ["rename", REINTRO_ROOT, "a", "b"],
          0,
          "T5.4-1 journaled variant: `rename specs/A.mdx a b` (vacating `a`)",
        );
        await expectExit(
          product,
          workspace,
          ["rename", REINTRO_ROOT, "c", "a"],
          0,
          "T5.4-1 journaled variant: `rename specs/A.mdx c a` (re-bearing the " +
            "vacated identity through the journal)",
        );

        // The node that depended on both bearers — its references now spelled
        // "b" and "a" — keeps every hash: the walks recover the same
        // canonical identity pairs as at the baseline (SPEC 5.4, 6.2).
        const after = await queryHashes(
          product,
          workspace,
          JOURNALED_W,
          "T5.4-1 journaled variant, after the renames:",
        );
        assertSameJson(
          after,
          before,
          `T5.4-1 journaled variant: every hash of ${JOURNALED_W} is unchanged — ` +
            `the two bearers of the string "a" keep distinct canonical ` +
            `identities and journaled renames change no hash (SPEC 5.4, 6.2)`,
        );

        // Impact against the pre-rename baseline reports no categories: both
        // renames are pure and nothing else changed (SPEC 6.2, 6.3) — no
        // requirement entry exists (the T1.5-1 convention: uncategorized,
        // undeleted nodes have no entry).
        const impactLabel =
          "T5.4-1 journaled variant: `impact --base <pre-rename>`";
        const impact = await impactAgainst(
          product,
          workspace,
          base,
          impactLabel,
        );
        if (impact.requirements.length !== 0) {
          fail(
            `${impactLabel}: journaled renames are pure and nothing else changed, ` +
              `so impact against the pre-rename baseline reports no categories — ` +
              `no requirement entries (SPEC 5.4, 6.2, 6.3); a product aliasing ` +
              `the re-borne "a" across the baseline (or not mapping identities ` +
              `through the journal) reports spurious changes/additions/deletions; ` +
              `got ${JSON.stringify(impact.requirements)}`,
          );
        }
      },
    );
  },
});

// ---------------------------------------------------------------------------
// T5.4-2 — spelling never hashes
// ---------------------------------------------------------------------------

// Rename fixture: `r` references `b` in dot-access imported form. `b-2` is a
// valid ID segment (SPEC 1.4: `-` is neither `.`, `#`, whitespace, control,
// nor a forbidden name) but no TypeScript identifier, so `rename b b-2`
// cannot keep the dot form and MUST rewrite to double-quoted computed access
// (SPEC 6.4); `rename b-2 b3` keeps the computed form (6.4 preserves access
// form where it can be kept). The manual arm then re-spells computed → dot.
const SPELLING_R = "specs/A.mdx#r";
const SPELLING_A_SOURCE = [
  'import B from "./B.xspec"',
  "",
  '<S id="r" d={B.b}>',
  "Referrer behavior.",
  "</S>",
  "",
].join("\n");
const SPELLING_B_SOURCE = ['<S id="b">', "Target behavior.", "</S>", ""].join(
  "\n",
);

// Move fixture: `r` references `t` as a local string. The section-form move
// of `t` to another file converts local string → imported form; the move back
// converts imported form → (double-quoted, SPEC 6.4) local string. `t` is
// staged so none of its own-content bytes lie on the straddling tag lines, so
// the moves keep its ownHash (SPEC 6.2) and `r`'s effectiveHash comparison
// isolates spelling. The manual arm then re-spells the local string between
// the two static quote styles (SPEC 2.4).
const MOVE_T = "specs/A.mdx#t";
const MOVE_R = "specs/A.mdx#r";
const MOVE_A_SOURCE = [
  '<S id="t">',
  "Target behavior.",
  "</S>",
  "",
  '<S id="r" d={"t"}>',
  "Referrer behavior.",
  "</S>",
  "",
].join("\n");

const T5_4_2 = defineProductTest({
  id: "T5.4-2",
  title:
    "spelling never hashes: rename-performed rewrites between equivalent spellings (dot → double-quoted computed access for a non-identifier segment, computed form kept and re-spelled) and move-performed local string ↔ imported form conversions leave the referencing node's hashes unchanged, and manual re-spelling of a reference to the same target in a different static form (computed → dot; double- → single-quoted local string) changes no hash on any node (rebuild and compare `query node` hashes; SPEC 2.4, 5.4, 5.5, 6.2, 6.4, 6.5)",
  run: async (product) => {
    // --- Rename fixture: dot ↔ computed access of the same target ---
    await withWorkspace(
      { "specs/A.mdx": SPELLING_A_SOURCE, "specs/B.mdx": SPELLING_B_SOURCE },
      async (workspace) => {
        await buildOk(
          product,
          workspace,
          "T5.4-2 `build` over the dot-access referencing workspace",
        );
        const before = await queryHashes(
          product,
          workspace,
          SPELLING_R,
          "T5.4-2 before any rewrite:",
        );

        // dot → computed, performed by rename: the new segment is no
        // TypeScript identifier, so the dot form cannot be kept and the
        // rewritten part is double-quoted computed access (SPEC 6.4).
        await expectExit(
          product,
          workspace,
          ["rename", "specs/B.mdx", "b", "b-2"],
          0,
          "T5.4-2 `rename specs/B.mdx b b-2` (dot access cannot be kept)",
        );
        const afterDotToComputed = await readSource(
          workspace,
          "specs/A.mdx",
          "T5.4-2 reading the source after the dot→computed rewrite",
        );
        if (!afterDotToComputed.includes('B["b-2"]')) {
          fail(
            `T5.4-2: renaming \`b\` to the non-identifier segment \`b-2\` must ` +
              `rewrite the dot access \`B.b\` to double-quoted computed access ` +
              `\`B["b-2"]\` (SPEC 6.4); rewritten source: ` +
              JSON.stringify(afterDotToComputed),
          );
        }
        assertSameJson(
          await queryHashes(
            product,
            workspace,
            SPELLING_R,
            "T5.4-2 after the dot→computed rewrite:",
          ),
          before,
          "T5.4-2 the referencing node's hashes are unchanged by the " +
            "rename-performed dot→computed re-spelling (SPEC 5.4, 6.2)",
        );

        // The computed form is kept when it can be (SPEC 6.4 preserves access
        // form): renaming `b-2 → b3` re-spells the segment inside the
        // computed access; hashes stay unchanged.
        await expectExit(
          product,
          workspace,
          ["rename", "specs/B.mdx", "b-2", "b3"],
          0,
          "T5.4-2 `rename specs/B.mdx b-2 b3` (computed access kept)",
        );
        assertSameJson(
          await queryHashes(
            product,
            workspace,
            SPELLING_R,
            "T5.4-2 after the second rename:",
          ),
          before,
          "T5.4-2 the referencing node's hashes are unchanged by the second " +
            "rename-performed re-spelling (SPEC 5.4, 6.2)",
        );

        // Manual re-spelling, computed → dot (same target, both static
        // forms, SPEC 2.4): rebuild and compare — no hash changes on any
        // node of the fixture.
        const nodeSet = [
          "specs/A.mdx",
          SPELLING_R,
          "specs/B.mdx",
          "specs/B.mdx#b3",
        ];
        const preManual = await queryHashesOf(
          product,
          workspace,
          nodeSet,
          "T5.4-2 before the manual computed→dot re-spelling:",
        );
        const current = await readSource(
          workspace,
          "specs/A.mdx",
          "T5.4-2 reading the source for the manual computed→dot re-spelling",
        );
        await workspace.file(
          "specs/A.mdx",
          replaceOnce(
            current,
            'B["b3"]',
            "B.b3",
            "T5.4-2 manually re-spelling the computed access to dot access",
          ),
        );
        await buildOk(
          product,
          workspace,
          "T5.4-2 rebuild after the manual computed→dot re-spelling",
        );
        assertSameJson(
          await queryHashesOf(
            product,
            workspace,
            nodeSet,
            "T5.4-2 after the manual computed→dot re-spelling:",
          ),
          preManual,
          "T5.4-2 manual re-spelling of a reference (same target, computed → " +
            "dot access) changes no hash on any node (SPEC 2.4, 5.4)",
        );
      },
    );

    // --- Move fixture: local string ↔ imported form via a move ---
    await withWorkspace({ "specs/A.mdx": MOVE_A_SOURCE }, async (workspace) => {
      await buildOk(
        product,
        workspace,
        "T5.4-2 `build` over the local-string referencing workspace",
      );
      const before = await queryHashes(
        product,
        workspace,
        MOVE_R,
        "T5.4-2 before any move:",
      );

      // local string → imported form: the section-form move relocates the
      // target out of the file, so the reference must be rewritten to
      // imported form with an added import (SPEC 6.5).
      await expectExit(
        product,
        workspace,
        ["move", MOVE_T, "specs/B.mdx#t"],
        0,
        "T5.4-2 `move specs/A.mdx#t specs/B.mdx#t` (local → imported form)",
      );
      assertSameJson(
        await queryHashes(
          product,
          workspace,
          MOVE_R,
          "T5.4-2 after the local→imported conversion:",
        ),
        before,
        "T5.4-2 the referencing node's hashes are unchanged by the " +
          "move-performed local string → imported form conversion (SPEC 5.4, " +
          "6.2, 6.5)",
      );

      // imported form → local string: moving the target back into the
      // referencing file converts the reference to a double-quoted local
      // string and removes the now-unreferenced import (SPEC 6.4, 6.5).
      await expectExit(
        product,
        workspace,
        ["move", "specs/B.mdx#t", MOVE_T],
        0,
        "T5.4-2 `move specs/B.mdx#t specs/A.mdx#t` (imported → local form)",
      );
      assertSameJson(
        await queryHashes(
          product,
          workspace,
          MOVE_R,
          "T5.4-2 after the imported→local conversion:",
        ),
        before,
        "T5.4-2 the referencing node's hashes are unchanged by the " +
          "move-performed imported form → local string conversion (SPEC 5.4, " +
          "6.2, 6.5)",
      );

      // Manual re-spelling, double- → single-quoted local string (same
      // target; both are static string literals, SPEC 2.4): rebuild and
      // compare — no hash changes on any node of the file.
      const nodeSet = ["specs/A.mdx", MOVE_R, MOVE_T];
      const preManual = await queryHashesOf(
        product,
        workspace,
        nodeSet,
        "T5.4-2 before the manual quote-style re-spelling:",
      );
      const current = await readSource(
        workspace,
        "specs/A.mdx",
        "T5.4-2 reading the source for the manual quote-style re-spelling",
      );
      await workspace.file(
        "specs/A.mdx",
        replaceOnce(
          current,
          'd={"t"}',
          "d={'t'}",
          "T5.4-2 manually re-spelling the local string between quote styles " +
            "(the move back must have produced a double-quoted local " +
            "reference, SPEC 6.4)",
        ),
      );
      await buildOk(
        product,
        workspace,
        "T5.4-2 rebuild after the manual quote-style re-spelling",
      );
      assertSameJson(
        await queryHashesOf(
          product,
          workspace,
          nodeSet,
          "T5.4-2 after the manual quote-style re-spelling:",
        ),
        preManual,
        "T5.4-2 manual re-spelling of a reference (same target, double- → " +
          "single-quoted static string) changes no hash on any node (SPEC " +
          "2.4, 5.4)",
      );
    });
  },
});

/** TEST-SPEC §5.4, in canonical ID order (SUITE-18). */
export const section54Tests: readonly ProductTestEntry[] = [T5_4_1, T5_4_2];
