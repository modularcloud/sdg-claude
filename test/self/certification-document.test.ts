// The whole-document certification gate (TEST-SPEC 17 C-1). C-1 binds "for
// each fixture in specs/CERTIFICATIONS.md", so the gate's authority is the
// document itself: this test parses CERTIFICATIONS.md's fixture entries —
// `## CONF-…` headings with their `**In-scope tests:**` line, `### VIOL-…`
// headings with their `* **Certifies:**` line — and asserts the harness's
// fixture manifest (certification-fixtures.ts) equals the document: every
// fixture wired, in document order, with the document's exact in-scope and
// certified ID sets. The per-fixture verifications (certification.test.ts)
// are generated from that manifest, so together: document = manifest =
// executed certification. A fixture or ID-set change in the document that the
// harness does not mirror fails loudly here instead of letting certification
// pass while silently covering less — the document-level analogue of the
// registry's unknown-ID hard errors (C-1 vacuity guard).
//
// The parser is deliberately strict: fixture-shaped lines in unexpected
// positions, malformed headings or ID tokens, and duplicate or dangling
// entries are hard parse errors, and the expected fixture counts are pinned —
// a silent under-parse would make the gate vacuous.

import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { productTestSuite } from "../suite/registry/index.js";
import { CERTIFICATION_FIXTURES } from "./certification-fixtures.js";

const CERTIFICATIONS_PATH = fileURLToPath(
  new URL("../../specs/CERTIFICATIONS.md", import.meta.url),
);

// The fixture counts CERTIFICATIONS.md currently defines. The manifest
// equality below carries the detail; these pins force a deliberate visit to
// this gate when the document's fixture set changes, and guard against a
// parser regression losing entries wholesale.
const EXPECTED_CONFORMERS = 4;
const EXPECTED_VIOLATORS = 13;

/** A violator entry as parsed from CERTIFICATIONS.md. */
interface DocumentViolator {
  readonly name: string;
  readonly certifies: readonly string[];
}

/** A conformer entry as parsed from CERTIFICATIONS.md. */
interface DocumentConformer {
  readonly name: string;
  readonly inScope: readonly string[];
  readonly violators: readonly DocumentViolator[];
}

// Heading and field shapes exactly as CERTIFICATIONS.md writes them: a
// conformer heading carries a title after an em dash, a violator heading is
// the bare name, and both ID-list lines end with a period.
const CONFORMER_HEADING = /^## (CONF-[A-Z0-9]+) — \S/;
const VIOLATOR_NAME = /^VIOL-[A-Z0-9]+(?:-[A-Z0-9]+)+$/;
const IN_SCOPE_PREFIX = "**In-scope tests:** ";
const CERTIFIES_PREFIX = "* **Certifies:** ";

// TEST-SPEC test-ID notation, mirrored from the registry's registration
// guard (test/helpers/registry.ts, deliberately module-private there).
const TEST_ID = /^(?:T[1-9]\d*(?:\.(?:0|[1-9]\d*))?-[1-9]\d*|P-[1-9]\d*)$/;

/** Parse a period-terminated, comma-separated TEST-SPEC ID list. */
function parseIdList(context: string, text: string): readonly string[] {
  if (!text.endsWith(".")) {
    throw new Error(
      `CERTIFICATIONS.md parse: ${context}: expected the ID list to end with ` +
        `a period, got ${JSON.stringify(text)}.`,
    );
  }
  const ids = text
    .slice(0, -1)
    .split(",")
    .map((token) => token.trim());
  const seen = new Set<string>();
  for (const id of ids) {
    if (!TEST_ID.test(id)) {
      throw new Error(
        `CERTIFICATIONS.md parse: ${context}: ${JSON.stringify(id)} is not ` +
          `TEST-SPEC test-ID notation (T<section>-<n> or P-<n>).`,
      );
    }
    if (seen.has(id)) {
      throw new Error(
        `CERTIFICATIONS.md parse: ${context}: duplicate test ID ${id}.`,
      );
    }
    seen.add(id);
  }
  return ids;
}

/**
 * Parse CERTIFICATIONS.md's fixture entries. Strict by design (see the
 * module header): everything the gate compares must come out of the document
 * or fail loudly trying.
 */
function parseCertificationsDocument(
  markdown: string,
): readonly DocumentConformer[] {
  interface OpenViolator {
    readonly name: string;
    certifies: readonly string[] | null;
  }
  interface OpenConformer {
    readonly name: string;
    inScope: readonly string[] | null;
    readonly violators: DocumentViolator[];
  }

  const conformers: DocumentConformer[] = [];
  let conformer: OpenConformer | null = null;
  let violator: OpenViolator | null = null;

  const closeViolator = (): void => {
    const closed = violator;
    if (closed === null) return;
    const owner = conformer;
    if (owner === null) {
      throw new Error(
        `CERTIFICATIONS.md parse: internal: open violator §${closed.name} ` +
          `without an open conformer.`,
      );
    }
    if (closed.certifies === null) {
      throw new Error(
        `CERTIFICATIONS.md parse: §${closed.name} has no ` +
          `"* **Certifies:**" line.`,
      );
    }
    owner.violators.push({ name: closed.name, certifies: closed.certifies });
    violator = null;
  };

  const closeConformer = (): void => {
    closeViolator();
    const closed = conformer;
    if (closed === null) return;
    if (closed.inScope === null) {
      throw new Error(
        `CERTIFICATIONS.md parse: §${closed.name} has no ` +
          `"**In-scope tests:**" line.`,
      );
    }
    conformers.push({
      name: closed.name,
      inScope: closed.inScope,
      violators: closed.violators,
    });
    conformer = null;
  };

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trimEnd();

    if (line.startsWith("## ")) {
      closeConformer();
      if (line.slice(3).startsWith("CONF-")) {
        const match = CONFORMER_HEADING.exec(line);
        const name = match?.[1];
        if (name === undefined) {
          throw new Error(
            `CERTIFICATIONS.md parse: malformed conformer heading ` +
              `${JSON.stringify(line)} — expected "## CONF-<NAME> — <title>".`,
          );
        }
        conformer = { name, inScope: null, violators: [] };
      }
      // Any other `## ` heading (e.g. `## Exclusions`) lies outside the
      // fixture entries; fixture-shaped lines there are parse errors below.
      continue;
    }

    if (line.startsWith("### ")) {
      const name = line.slice(4);
      if (conformer === null) {
        if (VIOLATOR_NAME.test(name)) {
          throw new Error(
            `CERTIFICATIONS.md parse: violator heading §${name} outside any ` +
              `conformer entry.`,
          );
        }
        continue;
      }
      closeViolator();
      if (!VIOLATOR_NAME.test(name)) {
        throw new Error(
          `CERTIFICATIONS.md parse: subheading ${JSON.stringify(line)} inside ` +
            `§${conformer.name} is not a "### VIOL-…" violator heading.`,
        );
      }
      violator = { name, certifies: null };
      continue;
    }

    if (line.startsWith(IN_SCOPE_PREFIX)) {
      if (conformer === null || violator !== null) {
        throw new Error(
          `CERTIFICATIONS.md parse: "In-scope tests" line outside a ` +
            `conformer entry's own body: ${JSON.stringify(line)}.`,
        );
      }
      if (conformer.inScope !== null) {
        throw new Error(
          `CERTIFICATIONS.md parse: §${conformer.name} has a second ` +
            `"In-scope tests" line.`,
        );
      }
      conformer.inScope = parseIdList(
        `§${conformer.name} in-scope tests`,
        line.slice(IN_SCOPE_PREFIX.length),
      );
      continue;
    }

    if (line.startsWith(CERTIFIES_PREFIX)) {
      if (violator === null) {
        throw new Error(
          `CERTIFICATIONS.md parse: "Certifies" line outside a violator ` +
            `entry: ${JSON.stringify(line)}.`,
        );
      }
      if (violator.certifies !== null) {
        throw new Error(
          `CERTIFICATIONS.md parse: §${violator.name} has a second ` +
            `"Certifies" line.`,
        );
      }
      violator.certifies = parseIdList(
        `§${violator.name} certifies`,
        line.slice(CERTIFIES_PREFIX.length),
      );
      continue;
    }
  }
  closeConformer();

  if (conformers.length === 0) {
    throw new Error(
      "CERTIFICATIONS.md parse: no conformer entries found — the " +
        "whole-document gate would be vacuous.",
    );
  }
  // Fixture names are the comparison keys: duplicates would make the
  // manifest equality ambiguous.
  const names = new Set<string>();
  for (const entry of conformers) {
    for (const name of [
      entry.name,
      ...entry.violators.map((viol) => viol.name),
    ]) {
      if (names.has(name)) {
        throw new Error(
          `CERTIFICATIONS.md parse: duplicate fixture name §${name}.`,
        );
      }
      names.add(name);
    }
  }
  return conformers;
}

function parseDocument(): readonly DocumentConformer[] {
  return parseCertificationsDocument(
    fs.readFileSync(CERTIFICATIONS_PATH, "utf8"),
  );
}

test("CERTIFICATIONS.md defines exactly 4 conformers and 13 violators (C-1 whole-document gate)", () => {
  const document = parseDocument();
  expect(
    {
      conformers: document.length,
      violators: document.reduce(
        (count, entry) => count + entry.violators.length,
        0,
      ),
    },
    "the pinned fixture counts of CERTIFICATIONS.md — a mismatch means the " +
      "document's fixture set changed (mirror it in certification-fixtures.ts " +
      "and update these pins) or the parser silently lost entries",
  ).toEqual({
    conformers: EXPECTED_CONFORMERS,
    violators: EXPECTED_VIOLATORS,
  });
});

test("the fixture manifest equals CERTIFICATIONS.md: every fixture wired with the document's ID sets (C-1)", () => {
  const manifest = CERTIFICATION_FIXTURES.map((entry) => ({
    name: entry.name,
    inScope: [...entry.inScope],
    violators: entry.violators.map((viol) => ({
      name: viol.name,
      certifies: [...viol.certifies],
    })),
  }));
  expect(
    manifest,
    "certification-fixtures.ts must mirror CERTIFICATIONS.md exactly — same " +
      "fixtures, same document order, same in-scope and certified ID sets " +
      "verbatim (C-1: certification runs against each fixture in the document)",
  ).toEqual(parseDocument());
});

test("every CERTIFICATIONS.md in-scope test is implemented in the product-test registry (C-1)", () => {
  const missing = parseDocument().flatMap((entry) =>
    entry.inScope
      .filter((id) => !productTestSuite.has(id))
      .map((id) => `§${entry.name}: ${id}`),
  );
  expect(
    missing,
    "an in-scope test named by CERTIFICATIONS.md but not registered in the " +
      "product-test manifest would make its certification vacuous (C-1)",
  ).toEqual([]);
});

test("every violator's certified set lies within its conformer's in-scope set (C-1)", () => {
  // Non-empty certified sets are parser-enforced (parseIdList and the
  // dangling-entry checks), so only the subset relation is asserted here.
  const outside = parseDocument().flatMap((entry) =>
    entry.violators.flatMap((viol) =>
      viol.certifies
        .filter((id) => !entry.inScope.includes(id))
        .map((id) => `§${viol.name}: ${id}`),
    ),
  );
  expect(
    outside,
    "a certified test outside its fixture's in-scope set could never be " +
      "observed failing (C-1)",
  ).toEqual([]);
});

test("every manifest fixture executable exists (C-2 binding, invocable in CI without network)", () => {
  const missing: string[] = [];
  for (const entry of CERTIFICATION_FIXTURES) {
    const bindings = [
      entry.binding(),
      ...entry.violators.map((viol) => viol.binding()),
    ];
    for (const binding of bindings) {
      for (const file of binding.requiredFiles ?? []) {
        if (!fs.existsSync(file)) {
          missing.push(`${binding.label}: ${file}`);
        }
      }
    }
  }
  expect(
    missing,
    "every CERTIFICATIONS.md fixture executable must exist for certification " +
      "to run it",
  ).toEqual([]);
});
