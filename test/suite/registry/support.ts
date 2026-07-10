// Shared staging/assertion sugar for the section registration modules in
// this directory (the product-facing suite, TEST-SPEC sections 1–16). Thin
// composition of already-self-tested harness machinery — the subprocess
// driver (S-3), the assertion protocol (H-4/H-5), and the H-3 adapters — so
// every section module stages and asserts the same way: bodies receive a
// `ProductBinding` and nothing else (C-2), run commands in their own
// workspace root (H-1/H-2), assert exact exit codes (H-5), and reject a
// product only via diagnosed assertion failures (H-8).

import type { GraphEdge } from "../../helpers/adapters/index.js";
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
