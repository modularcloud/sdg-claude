// The `xspec` package entry: the `defineConfig` export that
// `xspec.config.ts` imports (SPEC 7; IMPLEMENTATION Distribution). The
// configuration is declarative — the product parses `xspec.config.ts`
// statically and never executes or imports it (SPEC 7) — so `defineConfig`
// is an identity function: its value to consumers is the type checking and
// editor support they get while authoring the configuration. The types
// below mirror the SPEC 7 schema; the authoritative validation is the
// product's static one (14.14).

/** SPEC 7.3: the `markdown` key. */
export interface XspecMarkdownConfig {
  /** Whether pure Markdown files are emitted (SPEC 7.3). */
  readonly emit: boolean;
  /**
   * Optional directory, relative to the workspace root and resolving
   * within it, into which emitted files are redirected preserving
   * workspace-relative paths (SPEC 7.3).
   */
  readonly outDir?: string;
}

/** SPEC 7.4: one named coverage profile. */
export interface XspecCoverageProfile {
  /** Unique profile name. */
  readonly name: string;
  /** Spec group whose requirements must be covered. */
  readonly target: string;
  /** When present, restricts the target set by tags; must not be empty. */
  readonly targetTags?: readonly string[];
  /** `"leaves"` (default) restricts the target set to childless nodes. */
  readonly targets?: "leaves" | "all";
  /** Spec or code group counting as the coverage boundary. */
  readonly boundary: string;
  /** Required exactly when `boundary` names both a spec and a code group. */
  readonly boundaryKind?: "spec" | "code";
  readonly mode: "direct" | "transitive";
  /** Subset of the dependency edge kinds; defaults to all three. */
  readonly edgeKinds?: readonly ("depends" | "embeds" | "references")[];
}

/** SPEC 7.5: a selector matches by exactly one of group, files, or tags. */
export type XspecPolicySelector =
  | {
      readonly group: string;
      /** Required exactly when the name is both a spec and a code group. */
      readonly kind?: "spec" | "code";
    }
  | { readonly files: string }
  | { readonly tags: readonly string[] };

/** SPEC 7.5: one named policy rule constraining dependency edges. */
export interface XspecPolicyRule {
  /** Unique rule name. */
  readonly name: string;
  readonly type: "forbidden" | "allowedOnly";
  readonly from: XspecPolicySelector;
  readonly to: XspecPolicySelector;
  /** Subset of the dependency edge kinds; defaults to all three. */
  readonly kinds?: readonly ("depends" | "embeds" | "references")[];
}

/** SPEC 7: the `defineConfig` argument. */
export interface XspecConfig {
  /** Named groups of xspec source files, each a list of globs (SPEC 7.1). */
  readonly specs: Readonly<Record<string, readonly string[]>>;
  /** Named groups of TypeScript source files (SPEC 7.2). */
  readonly code?: Readonly<Record<string, readonly string[]>>;
  readonly markdown?: XspecMarkdownConfig;
  readonly coverage?: readonly XspecCoverageProfile[];
  readonly policy?: readonly XspecPolicyRule[];
}

/**
 * SPEC 7: `xspec.config.ts` default-exports one call to this function,
 * whose sole argument is statically literal. Identity at runtime; the
 * configuration is only ever read statically by xspec.
 */
export function defineConfig<T extends XspecConfig>(config: T): T {
  return config;
}
