// The configuration's stored plain form (SPEC 13.3; core/graph-data.ts).
//
// The graph data records the parsed configuration together with the
// configuration file's content hash, and the store-backed read fast path
// (workspace/fast-read.ts) recovers the `Configuration` from that record
// instead of re-parsing when the current file's bytes hash identically —
// sound because parsing is a pure function of the file's bytes (SPEC 12.0:
// identical bytes parse identically). This module is the round trip:
// `configurationToStored` projects a `Configuration` onto plain JSON data
// (compiled globs reduce to their patterns), and `configurationFromStored`
// validates that data structurally and recompiles every pattern under the
// exact modes the parser used (SPEC 7: group patterns in plain mode; a
// policy `files` selector in capture-from mode for `from`, capture-to for
// `to` — core/config.ts). Anything structurally off — or any pattern that
// no longer compiles — yields null, and the caller falls back to the full
// parse; the fast path treats null as "no recorded parse".
//
// Pure core (IMPLEMENTATION Architecture): data in, data out, no I/O — and
// deliberately free of core/config.ts value imports, so loading this module
// never loads the TypeScript compiler.

import type { JsonValue } from "./canonical-json.js";
import type {
  Configuration,
  ConfiguredGroup,
  CoverageProfile,
  DependencyEdgeKind,
  MarkdownSettings,
  PolicyRule,
  PolicySelector,
} from "./config.js";
import type { GlobMode } from "./glob.js";
import { compileGlob } from "./glob.js";

/** The stored plain form of one configured group: its name and patterns. */
interface StoredGroup {
  readonly name: string;
  readonly patterns: readonly string[];
}

function groupToStored(group: ConfiguredGroup): JsonValue {
  return { name: group.name, patterns: [...group.patterns] };
}

function selectorToStored(selector: PolicySelector): JsonValue {
  switch (selector.selector) {
    case "group":
      return {
        selector: "group",
        group: selector.group,
        groupKind: selector.groupKind,
      };
    case "files":
      return { selector: "files", pattern: selector.pattern };
    case "tags":
      return { selector: "tags", tags: [...selector.tags] };
  }
}

/**
 * Project a parsed configuration onto plain JSON data (the graph data's
 * recorded parse, SPEC 13.3). Compiled globs reduce to the patterns they
 * were compiled from; everything else is already plain.
 */
export function configurationToStored(configuration: Configuration): JsonValue {
  return {
    specGroups: configuration.specGroups.map(groupToStored),
    codeGroups: configuration.codeGroups.map(groupToStored),
    markdown:
      configuration.markdown === undefined
        ? null
        : {
            emit: configuration.markdown.emit,
            outDir: configuration.markdown.outDir ?? null,
          },
    coverage: configuration.coverage.map((profile): JsonValue => ({
      name: profile.name,
      target: profile.target,
      targetTags:
        profile.targetTags === undefined ? null : [...profile.targetTags],
      targets: profile.targets,
      boundary: profile.boundary,
      boundaryKind: profile.boundaryKind,
      mode: profile.mode,
      edgeKinds: [...profile.edgeKinds],
    })),
    policy: configuration.policy.map((rule): JsonValue => ({
      name: rule.name,
      type: rule.type,
      from: selectorToStored(rule.from),
      to: selectorToStored(rule.to),
      kinds: [...rule.kinds],
    })),
  };
}

// ---------------------------------------------------------------------------
// Reconstruction (structural validation; anything else yields null)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    out.push(item);
  }
  return out;
}

const EDGE_KIND_VALUES: ReadonlySet<string> = new Set([
  "depends",
  "embeds",
  "references",
]);

function parseEdgeKinds(value: unknown): DependencyEdgeKind[] | null {
  const items = parseStringArray(value);
  if (items === null || items.length === 0) return null;
  for (const item of items) {
    if (!EDGE_KIND_VALUES.has(item)) return null;
  }
  return items as DependencyEdgeKind[];
}

function parseStoredGroup(value: unknown): StoredGroup | null {
  if (!isRecord(value)) return null;
  const name = value["name"];
  const patterns = parseStringArray(value["patterns"]);
  if (typeof name !== "string" || patterns === null) return null;
  return { name, patterns };
}

/** Recompile one stored group under the parser's plain mode (SPEC 7). */
function groupFromStored(stored: StoredGroup): ConfiguredGroup | null {
  const globs = [];
  for (const pattern of stored.patterns) {
    const compiled = compileGlob(pattern, "plain");
    if (!compiled.ok) return null;
    globs.push(compiled.glob);
  }
  return { name: stored.name, patterns: stored.patterns, globs };
}

function selectorFromStored(
  value: unknown,
  filesMode: GlobMode,
): PolicySelector | null {
  if (!isRecord(value)) return null;
  switch (value["selector"]) {
    case "group": {
      const group = value["group"];
      const groupKind = value["groupKind"];
      if (
        typeof group !== "string" ||
        (groupKind !== "spec" && groupKind !== "code")
      ) {
        return null;
      }
      return { selector: "group", group, groupKind };
    }
    case "files": {
      const pattern = value["pattern"];
      if (typeof pattern !== "string") return null;
      const compiled = compileGlob(pattern, filesMode);
      if (!compiled.ok) return null;
      return { selector: "files", pattern, glob: compiled.glob };
    }
    case "tags": {
      const tags = parseStringArray(value["tags"]);
      if (tags === null || tags.length === 0) return null;
      return { selector: "tags", tags };
    }
    default:
      return null;
  }
}

function coverageFromStored(value: unknown): CoverageProfile | null {
  if (!isRecord(value)) return null;
  const name = value["name"];
  const target = value["target"];
  const boundary = value["boundary"];
  const targets = value["targets"];
  const boundaryKind = value["boundaryKind"];
  const mode = value["mode"];
  const targetTagsRaw = value["targetTags"];
  const edgeKinds = parseEdgeKinds(value["edgeKinds"]);
  if (
    typeof name !== "string" ||
    typeof target !== "string" ||
    typeof boundary !== "string" ||
    (targets !== "leaves" && targets !== "all") ||
    (boundaryKind !== "spec" && boundaryKind !== "code") ||
    (mode !== "direct" && mode !== "transitive") ||
    edgeKinds === null
  ) {
    return null;
  }
  let targetTags: readonly string[] | undefined;
  if (targetTagsRaw !== null) {
    const parsed = parseStringArray(targetTagsRaw);
    if (parsed === null || parsed.length === 0) return null;
    targetTags = parsed;
  }
  return {
    name,
    target,
    ...(targetTags === undefined ? {} : { targetTags }),
    targets,
    boundary,
    boundaryKind,
    mode,
    edgeKinds,
  };
}

function policyFromStored(value: unknown): PolicyRule | null {
  if (!isRecord(value)) return null;
  const name = value["name"];
  const type = value["type"];
  // SPEC 7.5 (core/config.ts): a rule's `from` compiles in capture-from
  // mode, its `to` in capture-to mode.
  const from = selectorFromStored(value["from"], "capture-from");
  const to = selectorFromStored(value["to"], "capture-to");
  const kinds = parseEdgeKinds(value["kinds"]);
  if (
    typeof name !== "string" ||
    (type !== "forbidden" && type !== "allowedOnly") ||
    from === null ||
    to === null ||
    kinds === null
  ) {
    return null;
  }
  return { name, type, from, to, kinds };
}

/**
 * Reconstruct a `Configuration` from its stored plain form — null when the
 * data is not structurally the shape `configurationToStored` writes or any
 * pattern no longer compiles. The result equals the original parse for any
 * store this product wrote (the projection loses only compiled globs, and
 * recompilation is deterministic — SPEC 12.0).
 */
export function configurationFromStored(value: unknown): Configuration | null {
  if (!isRecord(value)) return null;

  const specGroupsRaw = value["specGroups"];
  const codeGroupsRaw = value["codeGroups"];
  if (!Array.isArray(specGroupsRaw) || !Array.isArray(codeGroupsRaw)) {
    return null;
  }
  const specGroups: ConfiguredGroup[] = [];
  for (const raw of specGroupsRaw) {
    const stored = parseStoredGroup(raw);
    const group = stored === null ? null : groupFromStored(stored);
    if (group === null) return null;
    specGroups.push(group);
  }
  const codeGroups: ConfiguredGroup[] = [];
  for (const raw of codeGroupsRaw) {
    const stored = parseStoredGroup(raw);
    const group = stored === null ? null : groupFromStored(stored);
    if (group === null) return null;
    codeGroups.push(group);
  }

  let markdown: MarkdownSettings | undefined;
  const markdownRaw = value["markdown"];
  if (markdownRaw !== null) {
    if (!isRecord(markdownRaw)) return null;
    const emit = markdownRaw["emit"];
    const outDir = markdownRaw["outDir"];
    if (typeof emit !== "boolean") return null;
    if (outDir !== null && typeof outDir !== "string") return null;
    markdown = { emit, ...(outDir === null ? {} : { outDir }) };
  }

  const coverageRaw = value["coverage"];
  const policyRaw = value["policy"];
  if (!Array.isArray(coverageRaw) || !Array.isArray(policyRaw)) return null;
  const coverage: CoverageProfile[] = [];
  for (const raw of coverageRaw) {
    const profile = coverageFromStored(raw);
    if (profile === null) return null;
    coverage.push(profile);
  }
  const policy: PolicyRule[] = [];
  for (const raw of policyRaw) {
    const rule = policyFromStored(raw);
    if (rule === null) return null;
    policy.push(rule);
  }

  return {
    specGroups,
    codeGroups,
    ...(markdown === undefined ? {} : { markdown }),
    coverage,
    policy,
  };
}
