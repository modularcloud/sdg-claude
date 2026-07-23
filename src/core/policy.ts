// Policy evaluation (SPEC 7.5) — the pure derivation of `xspec check`'s
// policy-violation findings (SPEC 14.12).
//
// SPEC 7.5: named policy rules constrain which dependency edges may exist,
// evaluated over dependency edges of the rule's kinds. A selector matches
// nodes (or code locations) by exactly one of `{ group }` (with a resolved
// spec/code kind), `{ files: <glob> }`, or `{ tags: [...] }` (carrying at
// least one listed tag). In `files` selectors the `from` pattern MAY bind
// capture wildcards `$1`…`$9` and the `to` pattern MAY reference them — a
// `to` containing captures matches only targets whose expansion agrees with
// the captured values (core/glob.ts owns the disambiguation).
//
// Semantics:
// - `forbidden`: any edge whose source matches `from` and whose target
//   matches `to` is a violation.
// - `allowedOnly`: every edge whose source matches `from` MUST have a
//   target matching `to`; each edge that does not is a violation.
//
// Violations are findings reported by `xspec check` — and only `check`:
// `build` does not evaluate policy (SPEC 12.1, 14.12) — each carrying the
// rule name and the offending edge, causing exit 1. Root nodes participate:
// root-sourced and root-targeted dependency edges remain ordinary
// dependency edges for policy (SPEC 8), unlike coverage.
//
// Pure core (IMPLEMENTATION Architecture): a total, deterministic function
// of (configuration, graph) — rules in configuration order, edges in the
// graph's fixed (source, kind, target) order (SPEC 12.0).

import type { Configuration, PolicyRule, PolicySelector } from "./config.js";
import type { Finding } from "./findings.js";
import type { CaptureValues, CompiledGlob } from "./glob.js";
import type { GraphEdge, GraphNode, WorkspaceGraph } from "./graph.js";

/** The empty capture assignment (a `from` without captures binds none). */
const NO_CAPTURES: CaptureValues = new Map();

/**
 * The compiled globs of the configured group a selector names, under the
 * selector's resolved kind (SPEC 7.5). Configuration validation guarantees
 * the group exists with that kind (SPEC 14.14), so absence is an internal
 * error, never a finding.
 */
function groupGlobs(
  configuration: Configuration,
  kind: "spec" | "code",
  name: string,
): readonly CompiledGlob[] {
  const groups =
    kind === "spec" ? configuration.specGroups : configuration.codeGroups;
  const group = groups.find((candidate) => candidate.name === name);
  if (group === undefined) {
    throw new Error(
      `xspec internal error: policy selector references unknown ${kind} ` +
        `group '${name}'`,
    );
  }
  return group.globs;
}

/**
 * SPEC 7.5: does a `from` selector match this node — and with which capture
 * assignment? Returns the (possibly empty) captured values on a match, null
 * on none.
 *
 * - `group`: nodes of spec groups (requirement nodes, roots included) or
 *   code locations of code groups, by the group's globs over the node's
 *   file path.
 * - `files`: any node whose file path the glob matches; captures bind under
 *   the SPEC 7.5 shortest-match disambiguation.
 * - `tags`: nodes carrying at least one listed tag. Only non-root
 *   requirement nodes carry tags (SPEC 2.6, 1.2), so code locations and
 *   roots never match.
 */
function matchFrom(
  configuration: Configuration,
  selector: PolicySelector,
  node: GraphNode,
): CaptureValues | null {
  switch (selector.selector) {
    case "group": {
      const wanted = selector.groupKind === "spec" ? "requirement" : "code";
      if (node.kind !== wanted) return null;
      const globs = groupGlobs(
        configuration,
        selector.groupKind,
        selector.group,
      );
      return globs.some((glob) => glob.matches(node.path)) ? NO_CAPTURES : null;
    }
    case "files":
      return selector.glob.match(node.path);
    case "tags":
      return node.kind === "requirement" &&
        node.section.tags.some((tag) => selector.tags.includes(tag))
        ? NO_CAPTURES
        : null;
  }
}

/**
 * SPEC 7.5: does a `to` selector match this node, under the `from` side's
 * captured values? `files` selectors compile in capture-to mode: each `$n`
 * matches exactly the captured bytes (expansion agreement); group and tags
 * selectors ignore the captures.
 */
function matchTo(
  configuration: Configuration,
  selector: PolicySelector,
  node: GraphNode,
  captures: CaptureValues,
): boolean {
  switch (selector.selector) {
    case "group": {
      const wanted = selector.groupKind === "spec" ? "requirement" : "code";
      if (node.kind !== wanted) return false;
      const globs = groupGlobs(
        configuration,
        selector.groupKind,
        selector.group,
      );
      return globs.some((glob) => glob.matches(node.path));
    }
    case "files":
      return selector.glob.matchesWith(node.path, captures);
    case "tags":
      return (
        node.kind === "requirement" &&
        node.section.tags.some((tag) => selector.tags.includes(tag))
      );
  }
}

/** SPEC 14.12: one policy-violation finding — rule name plus offending edge. */
function violationFinding(rule: PolicyRule, edge: GraphEdge): Finding {
  const description =
    rule.type === "forbidden"
      ? `its source matches "from" and its target matches "to" of the ` +
        `forbidden rule`
      : `its source matches "from" but its target does not match "to" of ` +
        `the allowedOnly rule`;
  return {
    condition: 12,
    message:
      `policy violation: rule "${rule.name}": the ${edge.kind} edge ` +
      `${edge.source} -> ${edge.target} violates the rule — ${description} ` +
      `(SPEC 7.5); remove or redirect the dependency, or revise the rule ` +
      `in the configuration (SPEC 14.12)`,
    rule: rule.name,
    edge: { kind: edge.kind, source: edge.source, target: edge.target },
  };
}

/**
 * Evaluate every configured policy rule over the workspace graph's
 * dependency edges (SPEC 7.5): one finding per (rule, offending edge) pair,
 * rules in configuration order, edges in the graph's (source, kind, target)
 * order — deterministic (SPEC 12.0). The graph's collapsed edge set carries
 * each (source, kind, target) once (SPEC 5.2), so no pair repeats.
 */
export function evaluatePolicy(
  configuration: Configuration,
  graph: WorkspaceGraph,
): Finding[] {
  const findings: Finding[] = [];
  for (const rule of configuration.policy) {
    const kinds = new Set<string>(rule.kinds);
    for (const edge of graph.edges) {
      // SPEC 7.5: evaluated over dependency edges of the rule's kinds —
      // `contains` is structural and can never be configured (SPEC 14.14).
      if (!kinds.has(edge.kind)) continue;
      const source = graph.node(edge.source);
      const target = graph.node(edge.target);
      if (source === undefined || target === undefined) {
        // Unreachable for an assembled graph: edges connect existing
        // nodes (core/graph.ts). Skipped defensively — a policy finding
        // must never rest on a node the graph does not carry.
        continue;
      }
      const captures = matchFrom(configuration, rule.from, source);
      if (captures === null) continue;
      const targetMatches = matchTo(configuration, rule.to, target, captures);
      // SPEC 7.5: `forbidden` flags from-and-to matches; `allowedOnly`
      // flags from-matching edges whose target does not match `to`.
      const violates =
        rule.type === "forbidden" ? targetMatches : !targetMatches;
      if (violates) {
        findings.push(violationFinding(rule, edge));
      }
    }
  }
  return findings;
}
