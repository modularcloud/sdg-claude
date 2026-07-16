// The H-7 traceability map (TEST-SPEC 0 H-7; checked by S-1,
// test/self/s1-traceability.test.ts): the harness's machine-readable record
// mapping every implemented product-facing test (the registry, ./index.ts)
// to the SPEC.md passage(s) it covers.
//
// Passage-key vocabulary (H-7 fixes it):
//
//   "preamble"          SPEC.md's unnumbered document preamble (the content
//                       between the title and `## 1.`).
//   "<major>.<minor>"   a numbered subsection heading (`### 4.5 …`).
//   "<major>"           a numbered section's own body text outside its
//                       subsections. Per H-7 exactly sections 3, 4, 5, 7, 8,
//                       9, 10, 11, 14, and 15 carry requirements there (for
//                       3, 11, 14, and 15 — which have no subsections — the
//                       key spans the whole section body); sections 1, 2, 6,
//                       12, and 13 carry no requirements outside their
//                       subsections and are covered through them.
//
// Construction (what to maintain when tests change):
//
// - Home passage: a test's TEST-SPEC section mirrors SPEC.md's numbering, so
//   `T<sec>-<n>` maps to passage `<sec>` (`T7-1` → "7", `T4.5-3` → "4.5").
//   TEST-SPEC's combined heading §5.1–5.2 spans two SPEC.md passages: its one
//   test T5.2-1 exercises node kinds, edge kinds, and the project-wide graph
//   over spec and code groups, so it maps to "5", "5.1", and "5.2".
// - Section 16's property tests (P-*) have no SPEC.md section 16; each maps
//   to the passages whose invariants it asserts per its TEST-SPEC entry.
// - "14": SPEC.md 14 defines the validation conditions, so a test asserting
//   a numbered condition (14.x) covers passage "14" wherever it lives.
//   TEST-SPEC 14's per-condition record ("the H-7 map is the complete
//   record") is carried here at H-7's passage granularity, the T7-1..T7.5-1
//   range resolved to the entries that assert a condition (T7-5 asserts
//   none).
// - Alias entries: TEST-SPEC's pointer-only tests are not separately
//   implemented, so their coverage rides on the implementing tests —
//   T12.0-10 ("covered by T6.4-4/T6.5-5, T6.3-4") puts "12.0" on those
//   three; T12.1-2 ("T7.5-6") puts "12.1" on T7.5-6; T13.4-7 ("T7-6") puts
//   "13.4" on T7-6.
// - "preamble": per H-7's own citation, T12.0-11 (git is read-only) and
//   T12.0-12 (git-less operation) cover the preamble's git contract; its
//   no-network clause is enforced at CI level (E-1), which needs no map
//   entry.
// - Other cross-section keys mirror TEST-SPEC's stated coverage: T1.2-3
//   asserts the root exclusions of 8.1/8.2; T7.4-2 asserts the required-set
//   restrictions of 8.1 via coverage runs; T8-5's one-workspace sweep
//   asserts 8.1's exclusion list; and section 10's body (the review
//   mechanism/strategy split and the three built-in strategies) is exercised
//   by T10.5-1, T10.6-1 (generation per strategy), T10.7-1 (strategy
//   selection at `create`), and T10.7-4 (coverage sessions).
//
// A passage listed for a test is asserted by that test; the map lists each
// test's primary passage(s), not every rule it touches in passing. S-1 fails
// on: an H-7 key no test maps to; a mapped key that is no H-7 key of the
// current SPEC.md; a map entry whose test is not implemented; an implemented
// product-facing test missing here (domain = registry, both directions).

/**
 * SPEC.md sections whose own body text outside their subsections carries
 * requirements — the body-text passage keys of the H-7 universe (H-7 fixes
 * the list; S-1 derives the rest of the universe from SPEC.md's headings).
 */
export const SPEC_BODY_TEXT_KEY_SECTIONS: readonly number[] = [
  3, 4, 5, 7, 8, 9, 10, 11, 14, 15,
];

/**
 * The H-7 map: implemented product-facing test ID → SPEC.md passage keys in
 * document order. Domain: exactly the registry (S-1-checked).
 */
export const H7_TRACEABILITY: Readonly<Record<string, readonly string[]>> = {
  "T1.1-1": ["1.1"],
  "T1.1-2": ["1.1"],
  "T1.1-3": ["1.1"],
  "T1.2-1": ["1.2"],
  "T1.2-2": ["1.2"],
  "T1.2-3": ["1.2", "8.1", "8.2"],
  "T1.3-1": ["1.3", "14"],
  "T1.3-2": ["1.3", "14"],
  "T1.3-3": ["1.3", "14"],
  "T1.3-4": ["1.3", "14"],
  "T1.3-5": ["1.3", "14"],
  "T1.3-6": ["1.3", "14"],
  "T1.4-1": ["1.4", "14"],
  "T1.4-2": ["1.4"],
  "T1.4-3": ["1.4"],
  "T1.4-4": ["1.4", "14"],
  "T1.5-1": ["1.5"],
  "T1.5-2": ["1.5", "14"],
  "T1.5-3": ["1.5"],
  "T1.6-1": ["1.6"],
  "T1.6-2": ["1.6"],
  "T1.6-3": ["1.6"],
  "T1.6-4": ["1.6"],
  "T1.6-5": ["1.6", "14"],
  "T1.7-1": ["1.7"],
  "T2.1-1": ["2.1"],
  "T2.1-2": ["2.1", "14"],
  "T2.1-3": ["2.1", "14"],
  "T2.1-4": ["2.1"],
  "T2.1-5": ["2.1", "14"],
  "T2.2-1": ["2.2"],
  "T2.2-2": ["2.2"],
  "T2.2-3": ["2.2"],
  "T2.2-4": ["2.2"],
  "T2.2-5": ["2.2"],
  "T2.3-1": ["2.3"],
  "T2.3-2": ["2.3"],
  "T2.4-1": ["2.4"],
  "T2.4-2": ["2.4", "14"],
  "T2.4-3": ["2.4", "14"],
  "T2.4-4": ["2.4"],
  "T2.5-1": ["2.5"],
  "T2.5-2": ["2.5"],
  "T2.5-3": ["2.5", "14"],
  "T2.6-1": ["2.6"],
  "T2.6-2": ["2.6"],
  "T2.6-3": ["2.6"],
  "T2.7-1": ["2.7", "14"],
  "T2.7-2": ["2.7"],
  "T2.7-3": ["2.7", "14"],
  "T3-1": ["3"],
  "T3-2": ["3"],
  "T3-3": ["3"],
  "T3-4": ["3"],
  "T3-5": ["3"],
  "T3-6": ["3"],
  "T4-1": ["4"],
  "T4-2": ["4", "14"],
  "T4-3": ["4"],
  "T4-4": ["4"],
  "T4.1-1": ["4.1"],
  "T4.1-2": ["4.1"],
  "T4.1-3": ["4.1"],
  "T4.2-1": ["4.2"],
  "T4.2-2": ["4.2"],
  "T4.2-3": ["4.2"],
  "T4.2-4": ["4.2"],
  "T4.3-1": ["4.3"],
  "T4.3-2": ["4.3", "14"],
  "T4.4-1": ["4.4", "14"],
  "T4.4-2": ["4.4"],
  "T4.5-1": ["4.5"],
  "T4.5-2": ["4.5"],
  "T4.5-3": ["4.5", "14"],
  "T4.5-4": ["4.5"],
  "T4.5-5": ["4.5", "14"],
  "T4.5-6": ["4.5"],
  "T4.5-7": ["4.5"],
  "T4.6-1": ["4.6"],
  "T4.6-2": ["4.6"],
  "T4.6-3": ["4.6"],
  "T4.6-4": ["4.6"],
  "T5.2-1": ["5", "5.1", "5.2"],
  "T5.3-1": ["5.3", "14"],
  "T5.3-2": ["5.3", "14"],
  "T5.4-1": ["5.4"],
  "T5.4-2": ["5.4"],
  "T5.5-1": ["5.5"],
  "T5.5-2": ["5.5"],
  "T5.5-3": ["5.5"],
  "T5.5-4": ["5.5"],
  "T5.5-5": ["5.5"],
  "T5.5-6": ["5.5"],
  "T5.6-1": ["5.6"],
  "T5.6-2": ["5.6"],
  "T5.6-3": ["5.6"],
  "T5.6-4": ["5.6"],
  "T5.6-5": ["5.6"],
  "T5.6-6": ["5.6"],
  "T6.1-1": ["6.1"],
  "T6.1-2": ["6.1"],
  "T6.1-3": ["6.1", "14"],
  "T6.2-1": ["6.2"],
  "T6.2-2": ["6.2"],
  "T6.2-3": ["6.2"],
  "T6.2-4": ["6.2"],
  "T6.3-1": ["6.3"],
  "T6.3-2": ["6.3"],
  "T6.3-3": ["6.3"],
  "T6.3-4": ["6.3", "12.0"],
  "T6.4-1": ["6.4"],
  "T6.4-2": ["6.4"],
  "T6.4-3": ["6.4"],
  "T6.4-4": ["6.4", "12.0"],
  "T6.4-5": ["6.4"],
  "T6.4-6": ["6.4"],
  "T6.4-7": ["6.4"],
  "T6.5-1": ["6.5"],
  "T6.5-2": ["6.5"],
  "T6.5-3": ["6.5"],
  "T6.5-4": ["6.5"],
  "T6.5-5": ["6.5", "12.0"],
  "T6.5-6": ["6.5"],
  "T6.6-1": ["6.6"],
  "T7-1": ["7", "14"],
  "T7-2": ["7", "14"],
  "T7-3": ["7", "14"],
  "T7-4": ["7", "14"],
  "T7-5": ["7"],
  "T7-6": ["7", "13.4", "14"],
  "T7.1-1": ["7.1", "14"],
  "T7.2-1": ["7.2", "14"],
  "T7.3-1": ["7.3", "14"],
  "T7.4-1": ["7.4", "14"],
  "T7.4-2": ["7.4", "8.1"],
  "T7.5-1": ["7.5", "14"],
  "T7.5-2": ["7.5", "14"],
  "T7.5-3": ["7.5"],
  "T7.5-4": ["7.5"],
  "T7.5-5": ["7.5"],
  "T7.5-6": ["7.5", "12.1", "14"],
  "T8-1": ["8"],
  "T8-2": ["8"],
  "T8-3": ["8"],
  "T8-4": ["8"],
  "T8-5": ["8", "8.1"],
  "T8.2-1": ["8.2"],
  "T9-1": ["9"],
  "T9.1-1": ["9.1"],
  "T9.2-1": ["9.2"],
  "T9.2-2": ["9.2"],
  "T9.2-3": ["9.2"],
  "T9.2-4": ["9.2"],
  "T9.2-5": ["9.2"],
  "T9.3-1": ["9.3"],
  "T9.3-2": ["9.3"],
  "T9.3-3": ["9.3"],
  "T10.1-1": ["10.1"],
  "T10.1-2": ["10.1"],
  "T10.1-3": ["10.1"],
  "T10.1-4": ["10.1", "14"],
  "T10.2-1": ["10.2"],
  "T10.2-2": ["10.2"],
  "T10.2-3": ["10.2"],
  "T10.2-4": ["10.2"],
  "T10.3-1": ["10.3"],
  "T10.3-2": ["10.3"],
  "T10.4-1": ["10.4"],
  "T10.4-2": ["10.4"],
  "T10.4-3": ["10.4"],
  "T10.4-4": ["10.4"],
  "T10.4-5": ["10.4"],
  "T10.5-1": ["10", "10.5"],
  "T10.5-2": ["10.5"],
  "T10.5-3": ["10.5"],
  "T10.5-4": ["10.5"],
  "T10.5-5": ["10.5"],
  "T10.5-6": ["10.5"],
  "T10.6-1": ["10", "10.6"],
  "T10.6-2": ["10.6"],
  "T10.6-3": ["10.6"],
  "T10.7-1": ["10", "10.7"],
  "T10.7-2": ["10.7"],
  "T10.7-3": ["10.7"],
  "T10.7-4": ["10", "10.7"],
  "T10.7-5": ["10.7"],
  "T10.7-6": ["10.7"],
  "T10.7-7": ["10.7"],
  "T10.7-8": ["10.7"],
  "T10.7-9": ["10.7"],
  "T10.7-10": ["10.7"],
  "T10.7-11": ["10.7"],
  "T10.7-12": ["10.7"],
  "T11-1": ["11"],
  "T11-2": ["11"],
  "T11-3": ["11"],
  "T11-4": ["11"],
  "T11-5": ["11"],
  "T11-6": ["11"],
  "T11-7": ["11"],
  "T12.0-1": ["12.0"],
  "T12.0-2": ["12.0"],
  "T12.0-3": ["12.0"],
  "T12.0-4": ["12.0"],
  "T12.0-5": ["12.0"],
  "T12.0-6": ["12.0"],
  "T12.0-7": ["12.0"],
  "T12.0-8": ["12.0"],
  "T12.0-9": ["12.0"],
  "T12.0-11": ["preamble", "12.0"],
  "T12.0-12": ["preamble", "12.0"],
  "T12.1-1": ["12.1"],
  "T12.1-3": ["12.1"],
  "T12.1-4": ["12.1"],
  "T12.2-1": ["12.2"],
  "T12.2-2": ["12.2", "14"],
  "T12.2-3": ["12.2"],
  "T12.3-1": ["12.3"],
  "T12.3-2": ["12.3"],
  "T12.4-1": ["12.4"],
  "T12.5-1": ["12.5"],
  "T13.1-1": ["13.1"],
  "T13.1-2": ["13.1"],
  "T13.2-1": ["13.2"],
  "T13.3-1": ["13.3"],
  "T13.3-2": ["13.3"],
  "T13.3-3": ["13.3"],
  "T13.3-4": ["13.3"],
  "T13.4-1": ["13.4"],
  "T13.4-2": ["13.4"],
  "T13.4-3": ["13.4"],
  "T13.4-4": ["13.4"],
  "T13.4-5": ["13.4"],
  "T13.4-6": ["13.4", "14"],
  "T13.5-1": ["13.5"],
  "T13.5-2": ["13.5"],
  "T13.5-3": ["13.5"],
  "T13.5-4": ["13.5"],
  "T13.5-5": ["13.5"],
  "T13.5-6": ["13.5"],
  "T13.5-7": ["13.5"],
  "T14-1": ["14"],
  "T14-2": ["14"],
  "T14-3": ["14"],
  "T14-4": ["14"],
  "T14-5": ["14"],
  "T15-1": ["15"],
  "P-1": ["1.4", "2.6"],
  "P-2": ["3"],
  "P-3": ["1.6", "3"],
  "P-4": ["5.5"],
  "P-5": ["6.2", "6.4", "6.5"],
  "P-6": ["6.3", "9.1"],
  "P-7": ["7", "7.5"],
  "P-8": ["12.0", "12.1"],
  "P-9": ["10.1", "10.4", "10.7"],
  "P-10": ["6.1", "13.5"],
};
