// Shared staging/assertion sugar for the section registration modules in
// this directory (the product-facing suite, TEST-SPEC sections 1–16). Thin
// composition of already-self-tested harness machinery — the subprocess
// driver (S-3), the assertion protocol (H-4/H-5), and the H-3 adapters — so
// every section module stages and asserts the same way: bodies receive a
// `ProductBinding` and nothing else (C-2), run commands in their own
// workspace root (H-1/H-2), assert exact exit codes (H-5), and reject a
// product only via diagnosed assertion failures (H-8).

import { Buffer } from "node:buffer";
import type { Finding, GraphEdge } from "../../helpers/adapters/index.js";
import { decodeFindingsReport } from "../../helpers/adapters/index.js";
import {
  assertExitCode,
  fail,
  parseJsonStdout,
} from "../../helpers/assertions.js";
import type { ProductBinding, RunResult } from "../../helpers/subprocess.js";
import { runProduct } from "../../helpers/subprocess.js";
import type { TestWorkspace } from "../../helpers/workspace.js";

/** Run one product command with the workspace root as working directory. */
export async function runCli(
  product: ProductBinding,
  workspace: TestWorkspace,
  argv: readonly string[],
): Promise<RunResult> {
  return await runProduct(product, { cwd: workspace.root, argv });
}

/** Run a command and assert its exact exit code (H-5). */
export async function expectExit(
  product: ProductBinding,
  workspace: TestWorkspace,
  argv: readonly string[],
  exitCode: number,
  context: string,
): Promise<RunResult> {
  const result = await runCli(product, workspace, argv);
  assertExitCode(result, exitCode, context);
  return result;
}

/** `xspec build` over the staged workspace must succeed (exit 0). */
export async function buildOk(
  product: ProductBinding,
  workspace: TestWorkspace,
  context: string,
): Promise<RunResult> {
  return await expectExit(product, workspace, ["build"], 0, context);
}

/**
 * Run a command expecting exit 0 and exactly one JSON document as the entire
 * stdout (H-5; SPEC.md 12.0), returned parsed for adapter decoding.
 */
export async function runJson(
  product: ProductBinding,
  workspace: TestWorkspace,
  argv: readonly string[],
  context: string,
): Promise<unknown> {
  const result = await expectExit(product, workspace, argv, 0, context);
  return parseJsonStdout(result, context);
}

/**
 * Run `build --json` over a workspace staged with validation errors: assert
 * exit 1 (findings are exit-1 outcomes, SPEC.md 12.0; H-5) with exactly one
 * JSON document as the entire stdout, decoded as the findings report (H-3).
 */
export async function buildFindings(
  product: ProductBinding,
  workspace: TestWorkspace,
  context: string,
): Promise<readonly Finding[]> {
  const result = await expectExit(
    product,
    workspace,
    ["build", "--json"],
    1,
    context,
  );
  return decodeFindingsReport(parseJsonStdout(result, context), context)
    .findings;
}

/**
 * Assert the exact multiset of SPEC.md 14 condition identities present in a
 * findings report (`{"14.2": 1, ...}`): every condition staged in the fixture
 * is reported — none masked away, none phantom, none double-reported (§14:
 * when several error conditions are present, each is reported).
 */
export function assertConditionCounts(
  findings: readonly Finding[],
  expected: Readonly<Record<string, number>>,
  context: string,
): void {
  const counts: Record<string, number> = {};
  for (const finding of findings) {
    counts[finding.condition] = (counts[finding.condition] ?? 0) + 1;
  }
  const render = (record: Readonly<Record<string, number>>): string[] =>
    Object.entries(record)
      .map(([condition, count]) => `${condition} x${String(count)}`)
      .sort();
  assertSameJson(
    render(counts),
    render(expected),
    `${context}: reported condition identities (SPEC.md 14)`,
  );
}

/**
 * A staged construct's byte window within a `prefix + construct + suffix`
 * fixture whose parts are known exactly: the construct's own byte range,
 * end-widened by one byte so a product reporting a line-granular location
 * (last construct line plus its terminator) still passes. Fixtures keep every
 * other staged construct outside the widened window, so a finding attributed
 * to the wrong construct fails.
 */
export function byteWindow(
  prefix: string,
  construct: string,
): { start: number; end: number } {
  const start = Buffer.byteLength(prefix, "utf8");
  return { start, end: start + Buffer.byteLength(construct, "utf8") + 1 };
}

/** What a finding must identify about its source (SPEC.md 14 preamble). */
export interface FindingSourceExpectation {
  /** The workspace-relative, `/`-separated source file (SPEC.md 1.5, 14). */
  readonly file: string;
  /**
   * Byte window the finding's location must fall within — as computed by the
   * caller from its fixture's exact bytes (typically the offending
   * construct's own range, end-widened where the caller tolerates a
   * line-granular location).
   */
  readonly window?: { readonly start: number; readonly end: number };
}

/**
 * Assert a finding identifies its source: the file it names, a location, and
 * optionally that the location falls within the offending construct's byte
 * window (SPEC.md 14: errors identify the file, location, and correction).
 */
export function assertFindingLocated(
  finding: Finding,
  expected: FindingSourceExpectation,
  context: string,
): void {
  if (finding.file !== expected.file) {
    fail(
      `${context}: the finding must name the workspace-relative source file ` +
        `(SPEC.md 14, 1.5); expected ${JSON.stringify(expected.file)}, got ` +
        `${JSON.stringify(finding.file)} (message: ${JSON.stringify(finding.message)})`,
    );
  }
  if (finding.location === undefined) {
    fail(
      `${context}: the finding must carry a location (SPEC.md 14: errors identify ` +
        `the file, location, and correction); got none (message: ` +
        `${JSON.stringify(finding.message)})`,
    );
  }
  const { window } = expected;
  if (
    window !== undefined &&
    (finding.location.start < window.start || finding.location.end > window.end)
  ) {
    fail(
      `${context}: the finding's location [${String(finding.location.start)}, ` +
        `${String(finding.location.end)}) must fall within the offending construct's ` +
        `byte window [${String(window.start)}, ${String(window.end)}] (message: ` +
        `${JSON.stringify(finding.message)})`,
    );
  }
}

function renderJson(value: unknown): string {
  return value === undefined ? "undefined" : JSON.stringify(value);
}

/**
 * Diagnosed deep equality over JSON-safe values (arrays are order-sensitive;
 * callers sort first where SPEC.md fixes no order).
 */
export function assertSameJson(
  actual: unknown,
  expected: unknown,
  context: string,
): void {
  const actualRendered = renderJson(actual);
  const expectedRendered = renderJson(expected);
  if (actualRendered === expectedRendered) return;
  fail(
    `${context}: values differ\n` +
      `  actual:   ${actualRendered}\n` +
      `  expected: ${expectedRendered}`,
  );
}

/**
 * The identities of reported rows/entries, sorted bytewise — for comparisons
 * where SPEC.md fixes membership but no particular order.
 */
export function sortedIdentities(
  rows: readonly { readonly identity: string }[],
): string[] {
  return rows.map((row) => row.identity).sort();
}

/**
 * Order-insensitive graph-edge set comparison (SPEC.md 5.2: edges of each
 * kind form a set), diagnosed with a readable rendering of both sides.
 */
export function assertEdgeSetEqual(
  actual: readonly GraphEdge[],
  expected: readonly GraphEdge[],
  context: string,
): void {
  const render = (edges: readonly GraphEdge[]): string[] =>
    edges.map((edge) => `${edge.kind}: ${edge.from} -> ${edge.to}`).sort();
  assertSameJson(render(actual), render(expected), context);
}
