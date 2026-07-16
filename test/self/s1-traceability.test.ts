// S-1 Traceability self-check (TEST-SPEC 17): the H-7 map is complete and
// well-formed. H-7 fixes the map's key universe — SPEC.md's unnumbered
// preamble, every numbered subsection, and the body text of the sections
// that carry requirements outside their subsections — so this test derives
// the universe from SPEC.md's own headings (strictly parsed, like the
// CERTIFICATIONS.md gate in certification-document.test.ts: a silent
// under-parse would make the check vacuous) and asserts:
//
//   - every H-7 key has at least one mapped test (no unmapped keys);
//   - every passage a test maps to is an H-7 key (no dangling references);
//   - the map's domain is exactly the implemented product-facing tests —
//     no entry without an implemented test, no implemented test missing
//     (the conservative extension: registry = map, both directions).
//
// A SPEC.md structural change (new section or subsection) therefore fails
// here loudly: either the universe pins below stop holding or the new key
// has no mapped test — both demand a deliberate visit to the map
// (test/suite/registry/traceability.ts) and to H-7's key rule.

import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { compareProductTestIds } from "../helpers/registry.js";
import { productTestSuite } from "../suite/registry/index.js";
import {
  H7_TRACEABILITY,
  SPEC_BODY_TEXT_KEY_SECTIONS,
} from "../suite/registry/traceability.js";

const SPEC_PATH = fileURLToPath(
  new URL("../../specs/SPEC.md", import.meta.url),
);

/** The preamble's passage key (H-7). */
const PREAMBLE_KEY = "preamble";

// The universe SPEC.md currently defines. H-7's section lists (the body-text
// sections above; sections covered through their subsections) enumerate over
// exactly sections 1–15, and the full universe is preamble + 60 subsections
// + 10 body keys. The detail is derived from the document below; these pins
// force a deliberate visit when SPEC.md's structure changes and guard
// against a parser regression losing headings wholesale.
const EXPECTED_SECTION_COUNT = 15;
const EXPECTED_KEY_COUNT = 71;

// Heading shapes exactly as SPEC.md writes them: a section heading is
// `## <n>. <title>`, a subsection heading `### <n>.<m> <title>`, numbers
// without leading zeros. Anything else `##`/`###`-shaped is a parse error.
const SECTION_HEADING = /^## (0|[1-9]\d*)\. \S/;
const SUBSECTION_HEADING = /^### (0|[1-9]\d*)\.(0|[1-9]\d*) \S/;

interface SpecSection {
  readonly major: number;
  readonly minors: number[];
}

/**
 * Parse SPEC.md's heading structure into the H-7 key universe. Strict by
 * design: malformed or misplaced headings, non-consecutive numbering, an
 * empty preamble, and a section left without any key are hard errors.
 */
function parseH7KeyUniverse(markdown: string): ReadonlySet<string> {
  const sections: SpecSection[] = [];
  let sawTitle = false;
  let preambleHasContent = false;
  let inFence = false;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trimEnd();

    // Fenced code blocks are content, never headings (SPEC.md's examples
    // hold `#`-bearing shell and MDX lines).
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (line.startsWith("# ") && !line.startsWith("## ")) {
      if (sawTitle) {
        throw new Error(
          `SPEC.md parse: second document title ${JSON.stringify(line)}.`,
        );
      }
      sawTitle = true;
      continue;
    }

    if (line.startsWith("## ") && !line.startsWith("### ")) {
      const match = SECTION_HEADING.exec(line);
      if (match === null) {
        throw new Error(
          `SPEC.md parse: malformed section heading ${JSON.stringify(line)} — ` +
            `expected "## <n>. <title>".`,
        );
      }
      const major = Number(match[1]);
      const expected = sections.length + 1;
      if (major !== expected) {
        throw new Error(
          `SPEC.md parse: section heading ${JSON.stringify(line)} out of ` +
            `order — expected section ${expected}.`,
        );
      }
      sections.push({ major, minors: [] });
      continue;
    }

    if (line.startsWith("### ")) {
      const match = SUBSECTION_HEADING.exec(line);
      if (match === null) {
        throw new Error(
          `SPEC.md parse: malformed subsection heading ` +
            `${JSON.stringify(line)} — expected "### <n>.<m> <title>".`,
        );
      }
      const section = sections.at(-1);
      if (section === undefined) {
        throw new Error(
          `SPEC.md parse: subsection heading ${JSON.stringify(line)} before ` +
            `any section heading.`,
        );
      }
      const major = Number(match[1]);
      const minor = Number(match[2]);
      if (major !== section.major) {
        throw new Error(
          `SPEC.md parse: subsection heading ${JSON.stringify(line)} inside ` +
            `section ${section.major}.`,
        );
      }
      const last = section.minors.at(-1);
      // Minors are consecutive; a section's first subsection is .0 or .1
      // (12.0 Global conventions is the one .0 today).
      const valid =
        last === undefined ? minor === 0 || minor === 1 : minor === last + 1;
      if (!valid) {
        throw new Error(
          `SPEC.md parse: subsection heading ${JSON.stringify(line)} out of ` +
            `order after ${section.major}.${last ?? "(none)"}.`,
        );
      }
      section.minors.push(minor);
      continue;
    }

    if (!sawTitle && line !== "") {
      throw new Error(
        `SPEC.md parse: content before the document title: ` +
          `${JSON.stringify(line)}.`,
      );
    }
    if (sawTitle && sections.length === 0 && line !== "") {
      preambleHasContent = true;
    }
  }

  if (inFence) {
    throw new Error("SPEC.md parse: unterminated code fence.");
  }
  if (!sawTitle) {
    throw new Error("SPEC.md parse: no document title found.");
  }
  if (!preambleHasContent) {
    throw new Error(
      "SPEC.md parse: the unnumbered preamble is empty — H-7 keys it, so an " +
        "empty preamble means the document moved and the key rule is stale.",
    );
  }
  if (sections.length !== EXPECTED_SECTION_COUNT) {
    throw new Error(
      `SPEC.md parse: found ${sections.length} numbered sections, expected ` +
        `${EXPECTED_SECTION_COUNT} — H-7's key rule enumerates sections ` +
        `1–${EXPECTED_SECTION_COUNT}; revisit it and the traceability map.`,
    );
  }

  const bodyKeySections = new Set(SPEC_BODY_TEXT_KEY_SECTIONS);
  const universe = new Set<string>([PREAMBLE_KEY]);
  for (const section of sections) {
    // Every section carries at least one key: its body text (when H-7 lists
    // it) or its subsections (H-7: sections 1, 2, 6, 12, and 13 carry no
    // requirements outside their subsections and are covered through them).
    if (section.minors.length === 0 && !bodyKeySections.has(section.major)) {
      throw new Error(
        `SPEC.md parse: section ${section.major} has no subsections and is ` +
          `not an H-7 body-text section — it would carry no key at all; ` +
          `H-7's key rule is stale.`,
      );
    }
    if (bodyKeySections.has(section.major)) {
      universe.add(String(section.major));
    }
    for (const minor of section.minors) {
      universe.add(`${section.major}.${minor}`);
    }
  }
  return universe;
}

function specKeyUniverse(): ReadonlySet<string> {
  return parseH7KeyUniverse(fs.readFileSync(SPEC_PATH, "utf8"));
}

test("SPEC.md parses into the pinned H-7 key universe (H-7, S-1)", () => {
  const universe = specKeyUniverse();
  expect(
    universe.size,
    "the H-7 key universe derived from SPEC.md's headings — a mismatch " +
      "means SPEC.md's structure changed (revisit H-7's key rule and the " +
      "traceability map) or the parser lost headings",
  ).toBe(EXPECTED_KEY_COUNT);
});

test("every H-7 key is mapped by at least one test (S-1: no unmapped keys)", () => {
  const mapped = new Set<string>();
  for (const passages of Object.values(H7_TRACEABILITY)) {
    for (const key of passages) mapped.add(key);
  }
  const unmapped = [...specKeyUniverse()].filter((key) => !mapped.has(key));
  expect(
    unmapped,
    "every SPEC.md passage key must be covered by at least one test (H-7); " +
      "an unmapped key is untracked specification surface",
  ).toEqual([]);
});

test("every mapped passage is an H-7 key of the current SPEC.md (S-1: no dangling references)", () => {
  const universe = specKeyUniverse();
  const problems: string[] = [];
  for (const [id, passages] of Object.entries(H7_TRACEABILITY)) {
    if (passages.length === 0) {
      problems.push(`${id}: empty passage list`);
      continue;
    }
    const seen = new Set<string>();
    for (const key of passages) {
      if (!universe.has(key)) {
        problems.push(`${id}: ${JSON.stringify(key)} is no H-7 key`);
      }
      if (seen.has(key)) {
        problems.push(`${id}: duplicate passage key ${JSON.stringify(key)}`);
      }
      seen.add(key);
    }
  }
  expect(
    problems,
    "a test mapping to a nonexistent SPEC.md passage (or a degenerate " +
      "entry) is a dangling reference (S-1)",
  ).toEqual([]);
});

test("the map's domain is exactly the implemented product-facing tests (S-1: registry = map)", () => {
  const mapIds = Object.keys(H7_TRACEABILITY).sort(compareProductTestIds);
  expect(
    mapIds,
    "the traceability map must cover every implemented product-facing test " +
      "and name only implemented tests — an entry without a test is a " +
      "dangling reference, a test without an entry is untracked (S-1)",
  ).toEqual([...productTestSuite.ids()]);
});
