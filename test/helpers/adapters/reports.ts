// H-3 output adapters — findings and analysis reports: failing `build` /
// `check` findings (SPEC.md 14; TEST-SPEC §14), `coverage` (SPEC.md 8;
// T8.2-1), and `impact --base` (SPEC.md 5.6, 9; T9.1-1, T9.2-*, T9.3-*).
//
// Shape-aware, value-blind, fail-loud (H-3) — see query.ts for the layer's
// contract. Adjust the ASSUMED SHAPE below when the real product's output
// shape legitimately differs; never adjust values.
//
// ASSUMED SHAPE:
//   build (exit 1) / check (exit 1) →
//     { "findings": [ { "condition": "14.N", "message",
//                       "file"?, "location"?: {"start","end"},
//                       "rule"?, "edge"?: Edge, "cycle"?: [identity...] } ] }
//   coverage →
//     { "profiles": [ { "name",
//                       "counts": {"required","covered","uncovered","ignored"},
//                       "covered": [ { "identity", "path": [identity...] } ],
//                       "uncovered": [identity...],
//                       "ignored": [ { "identity", "reasons": [reason...] } ] } ] }
//   impact →
//     { "baseline"?,
//       "requirements": [ { "nodes": [identity...], "deleted": bool,
//                           "categories": [ { "category", "attributedTo": [identity...] } ] } ],
//       "code": { "direct": [ { "location", "edge": Edge, "path": [identity...] } ],
//                 "transitive": [ same ] } }

import type {
  CoverageProfileReport,
  CoverageReport,
  CoveredNode,
  Finding,
  FindingsReport,
  IgnoredNode,
  ImpactCategoryEntry,
  ImpactReport,
  ImpactRequirementEntry,
  ImpactedCodeEntry,
} from "./model.js";
import { CHANGE_CATEGORIES } from "./model.js";
import type { DecodeSite } from "./decode.js";
import {
  at,
  decodeFail,
  expectArray,
  expectBoolean,
  expectNonEmptyString,
  expectNonEmptyStringArray,
  expectNonNegativeInteger,
  expectObject,
  expectToken,
  optionalKey,
  requiredKey,
  rootSite,
} from "./decode.js";
import { decodeEdge, decodeSourceRange } from "./query.js";

/**
 * A SPEC.md §14 condition identity: `14.` followed by a condition number.
 * The token shape is spec-fixed; which condition a finding carries is a value
 * the tests assert.
 */
const CONDITION_PATTERN = /^14\.[1-9][0-9]*$/;

function decodeFinding(value: unknown, site: DecodeSite): Finding {
  const obj = expectObject(value, site);
  const conditionSite = at(site, "condition");
  const condition = expectNonEmptyString(
    requiredKey(obj, "condition", site),
    conditionSite,
  );
  if (!CONDITION_PATTERN.test(condition)) {
    decodeFail(
      conditionSite,
      'a SPEC.md 14 condition identity ("14.<n>")',
      condition,
    );
  }
  const finding: {
    condition: string;
    message: string;
    file?: string;
    location?: Finding["location"];
    rule?: string;
    edge?: Finding["edge"];
    cycle?: readonly string[];
  } = {
    condition,
    message: expectNonEmptyString(
      requiredKey(obj, "message", site),
      at(site, "message"),
    ),
  };
  const file = optionalKey(obj, "file");
  if (file !== undefined) {
    finding.file = expectNonEmptyString(file, at(site, "file"));
  }
  const location = optionalKey(obj, "location");
  if (location !== undefined) {
    finding.location = decodeSourceRange(location, at(site, "location"));
  }
  const rule = optionalKey(obj, "rule");
  if (rule !== undefined) {
    finding.rule = expectNonEmptyString(rule, at(site, "rule"));
  }
  const edge = optionalKey(obj, "edge");
  if (edge !== undefined) {
    finding.edge = decodeEdge(edge, at(site, "edge"));
  }
  const cycle = optionalKey(obj, "cycle");
  if (cycle !== undefined) {
    finding.cycle = expectNonEmptyStringArray(cycle, at(site, "cycle"));
  }
  return finding;
}

/**
 * A failing `build`'s validation errors or `check`'s findings (exit 1,
 * stdout). Every finding carries its SPEC.md 14 condition identity and a
 * message; file, location, rule, edge, and cycle path are decoded when
 * present and asserted for presence by the tests that require them (T14-1).
 */
export function decodeFindingsReport(
  doc: unknown,
  context?: string,
): FindingsReport {
  const site = rootSite("build/check findings", context);
  const obj = expectObject(doc, site);
  const findingsSite = at(site, "findings");
  const findings = expectArray(
    requiredKey(obj, "findings", site),
    findingsSite,
  ).map((element, index) => decodeFinding(element, at(findingsSite, index)));
  return { findings };
}

function decodeCoveredNode(value: unknown, site: DecodeSite): CoveredNode {
  const obj = expectObject(value, site);
  const pathSite = at(site, "path");
  const path = expectNonEmptyStringArray(
    requiredKey(obj, "path", site),
    pathSite,
  );
  if (path.length === 0) {
    decodeFail(pathSite, "a non-empty covering path", obj["path"]);
  }
  return {
    identity: expectNonEmptyString(
      requiredKey(obj, "identity", site),
      at(site, "identity"),
    ),
    path,
  };
}

function decodeIgnoredNode(value: unknown, site: DecodeSite): IgnoredNode {
  const obj = expectObject(value, site);
  const reasonsSite = at(site, "reasons");
  const reasons = expectNonEmptyStringArray(
    requiredKey(obj, "reasons", site),
    reasonsSite,
  );
  if (reasons.length === 0) {
    decodeFail(
      reasonsSite,
      "at least one ignored reason (all applicable reasons are reported, T8.2-1)",
      obj["reasons"],
    );
  }
  return {
    identity: expectNonEmptyString(
      requiredKey(obj, "identity", site),
      at(site, "identity"),
    ),
    reasons,
  };
}

function decodeCoverageProfile(
  value: unknown,
  site: DecodeSite,
): CoverageProfileReport {
  const obj = expectObject(value, site);
  const countsSite = at(site, "counts");
  const counts = expectObject(requiredKey(obj, "counts", site), countsSite);
  const count = (key: string): number =>
    expectNonNegativeInteger(
      requiredKey(counts, key, countsSite),
      at(countsSite, key),
    );
  const coveredSite = at(site, "covered");
  const ignoredSite = at(site, "ignored");
  return {
    name: expectNonEmptyString(
      requiredKey(obj, "name", site),
      at(site, "name"),
    ),
    counts: {
      required: count("required"),
      covered: count("covered"),
      uncovered: count("uncovered"),
      ignored: count("ignored"),
    },
    covered: expectArray(requiredKey(obj, "covered", site), coveredSite).map(
      (element, index) => decodeCoveredNode(element, at(coveredSite, index)),
    ),
    uncovered: expectNonEmptyStringArray(
      requiredKey(obj, "uncovered", site),
      at(site, "uncovered"),
    ),
    ignored: expectArray(requiredKey(obj, "ignored", site), ignoredSite).map(
      (element, index) => decodeIgnoredNode(element, at(ignoredSite, index)),
    ),
  };
}

/**
 * `coverage` (T8.2-1): all profiles by default (zero profiles is a valid,
 * empty report — T7-3), one when named; per profile the counts, every
 * covered node with one shortest covering path, every uncovered node's
 * identity, and every ignored node with all applicable reasons in the fixed
 * order. `--check` and `--json` carry the same information.
 */
export function decodeCoverageReport(
  doc: unknown,
  context?: string,
): CoverageReport {
  const site = rootSite("coverage", context);
  const obj = expectObject(doc, site);
  const profilesSite = at(site, "profiles");
  const profiles = expectArray(
    requiredKey(obj, "profiles", site),
    profilesSite,
  ).map((element, index) =>
    decodeCoverageProfile(element, at(profilesSite, index)),
  );
  return { profiles };
}

function decodeImpactCategory(
  value: unknown,
  site: DecodeSite,
): ImpactCategoryEntry {
  const obj = expectObject(value, site);
  return {
    category: expectToken(
      requiredKey(obj, "category", site),
      CHANGE_CATEGORIES,
      at(site, "category"),
    ),
    attributedTo: expectNonEmptyStringArray(
      requiredKey(obj, "attributedTo", site),
      at(site, "attributedTo"),
    ),
  };
}

function decodeImpactRequirementEntry(
  value: unknown,
  site: DecodeSite,
): ImpactRequirementEntry {
  const obj = expectObject(value, site);
  const nodesSite = at(site, "nodes");
  const nodes = expectNonEmptyStringArray(
    requiredKey(obj, "nodes", site),
    nodesSite,
  );
  if (nodes.length === 0) {
    decodeFail(
      nodesSite,
      "at least one node identity (an entry covers one node or a collapsed chain, T9.3-1)",
      obj["nodes"],
    );
  }
  const categoriesSite = at(site, "categories");
  return {
    nodes,
    deleted: expectBoolean(
      requiredKey(obj, "deleted", site),
      at(site, "deleted"),
    ),
    categories: expectArray(
      requiredKey(obj, "categories", site),
      categoriesSite,
    ).map((element, index) =>
      decodeImpactCategory(element, at(categoriesSite, index)),
    ),
  };
}

function decodeImpactedCodeEntry(
  value: unknown,
  site: DecodeSite,
): ImpactedCodeEntry {
  const obj = expectObject(value, site);
  const pathSite = at(site, "path");
  const path = expectNonEmptyStringArray(
    requiredKey(obj, "path", site),
    pathSite,
  );
  if (path.length === 0) {
    decodeFail(pathSite, "a non-empty witness path (T9.3-2)", obj["path"]);
  }
  return {
    location: expectNonEmptyString(
      requiredKey(obj, "location", site),
      at(site, "location"),
    ),
    edge: decodeEdge(requiredKey(obj, "edge", site), at(site, "edge")),
    path,
  };
}

/**
 * `impact --base` (T9.1-1, T9.2-*, T9.3-*): requirement-level entries with
 * the 5.6 categories and attributions (an entry may cover a collapsed
 * ancestor chain, T9.3-1; deleted nodes flagged), plus the directly and
 * transitively impacted code groups, each entry with its minimized witness
 * edge and path.
 */
export function decodeImpactReport(
  doc: unknown,
  context?: string,
): ImpactReport {
  const site = rootSite("impact", context);
  const obj = expectObject(doc, site);
  const requirementsSite = at(site, "requirements");
  const codeSite = at(site, "code");
  const code = expectObject(requiredKey(obj, "code", site), codeSite);
  const codeGroup = (key: string): ImpactedCodeEntry[] => {
    const groupSite = at(codeSite, key);
    return expectArray(requiredKey(code, key, codeSite), groupSite).map(
      (element, index) =>
        decodeImpactedCodeEntry(element, at(groupSite, index)),
    );
  };
  const report: {
    baseline?: string;
    requirements: readonly ImpactRequirementEntry[];
    code: ImpactReport["code"];
  } = {
    requirements: expectArray(
      requiredKey(obj, "requirements", site),
      requirementsSite,
    ).map((element, index) =>
      decodeImpactRequirementEntry(element, at(requirementsSite, index)),
    ),
    code: { direct: codeGroup("direct"), transitive: codeGroup("transitive") },
  };
  const baseline = optionalKey(obj, "baseline");
  if (baseline !== undefined) {
    report.baseline = expectNonEmptyString(baseline, at(site, "baseline"));
  }
  return report;
}
