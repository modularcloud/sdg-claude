// Shared assertion protocol for the xspec test harness (TEST-SPEC H-4, H-5,
// H-8; SPEC.md 12.0). Harness machinery only: no product imports, no test
// framework dependence — assertions throw `HarnessAssertionError`, which any
// runner (Vitest, the certification runner) reports as a test failure.
//
// - H-4: where SPEC.md fixes bytes, tests assert byte equality — these
//   helpers compare exact bytes and normalize nothing (no newline
//   translation, no encoding cleanup, no trimming). Failures are diagnosed
//   with the first differing offset and a hex + printable window of both
//   sides.
// - H-5: every test asserts the exact exit code and, where relevant, the
//   stdout/stderr separation of SPEC.md 12.0 — `assertExitCode`,
//   `assertStdoutEmpty`/`assertStderrEmpty`, `parseJsonStdout` (stdout is
//   exactly one JSON document), and `assertJsonOutputConvention` (one JSON
//   document on exit 0/1; empty stdout on exit 2; anything else diagnosed).
// - H-8: a `HarnessAssertionError` is the harness's *diagnosed assertion
//   failure* — the failure shape every product-facing test must produce
//   against a missing or stub product. Anything else thrown is a harness
//   error, which the S-7 sweep treats as a defect. Missing product-written
//   files therefore fail through `fail(...)` here, never as raw ENOENT.

import { Buffer } from "node:buffer";
import * as fsp from "node:fs/promises";
import type { RunResult } from "./subprocess.js";
import { summarizeResult } from "./subprocess.js";

/**
 * A diagnosed assertion failure (H-8). Product-facing tests fail against a
 * stub product by throwing exactly this type (directly or through the helpers
 * below); any other exception escaping a test body is a harness error.
 */
export class HarnessAssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessAssertionError";
  }
}

/** Throw a diagnosed assertion failure (H-8). */
export function fail(message: string): never {
  throw new HarnessAssertionError(message);
}

/** View assertion input as bytes: strings are UTF-8, byte inputs are as-is. */
export function asBytes(data: string | Uint8Array): Uint8Array {
  return typeof data === "string" ? Buffer.from(data, "utf8") : data;
}

/** Exact byte equality (strings compared via their UTF-8 encoding). */
export function bytesEqual(
  a: string | Uint8Array,
  b: string | Uint8Array,
): boolean {
  return Buffer.compare(asBytes(a), asBytes(b)) === 0;
}

/**
 * Assert exact byte equality (H-4, normalizing nothing). `context` names what
 * is being compared, so the failure is self-diagnosing.
 */
export function assertBytesEqual(
  actual: string | Uint8Array,
  expected: string | Uint8Array,
  context: string,
): void {
  const actualBytes = asBytes(actual);
  const expectedBytes = asBytes(expected);
  if (Buffer.compare(actualBytes, expectedBytes) === 0) return;
  fail(
    `${context}: bytes are not equal (H-4, normalizing nothing)\n` +
      describeByteDifference(actualBytes, expectedBytes),
  );
}

/**
 * Assert a file holds exactly the expected bytes. An unreadable or missing
 * file — e.g. a product-written file a stub never wrote — is a diagnosed
 * assertion failure (H-8), not a harness crash.
 */
export async function assertFileBytes(
  absPath: string,
  expected: string | Uint8Array,
  context?: string,
): Promise<void> {
  const ctx = context ?? `file ${absPath}`;
  const actual = await readFileDiagnosed(absPath, ctx);
  assertBytesEqual(actual, expected, ctx);
}

/** Assert two files hold identical bytes (both must be readable, diagnosed). */
export async function assertFilesEqual(
  absActual: string,
  absExpected: string,
  context?: string,
): Promise<void> {
  const ctx = context ?? `file ${absActual} vs file ${absExpected}`;
  const actual = await readFileDiagnosed(absActual, ctx);
  const expected = await readFileDiagnosed(absExpected, ctx);
  if (Buffer.compare(actual, expected) === 0) return;
  fail(
    `${ctx}: file bytes are not equal (H-4)\n` +
      describeByteDifference(actual, expected),
  );
}

/**
 * Assert the exact exit code of a run (H-5). A signal death is never "an exit
 * code" and always fails, diagnosed with the run's command line and streams.
 */
export function assertExitCode(
  result: RunResult,
  expected: number,
  context?: string,
): void {
  const prefix = context === undefined ? "" : `${context}: `;
  if (result.signal !== null) {
    fail(
      `${prefix}expected exit code ${String(expected)} from ${result.commandLine}, but the process died by signal: ${summarizeResult(result)}`,
    );
  }
  if (result.exitCode !== expected) {
    fail(
      `${prefix}expected exit code ${String(expected)} from ${result.commandLine}, got ${summarizeResult(result)}`,
    );
  }
}

/** Assert stdout is byte-empty (H-5 stream separation). */
export function assertStdoutEmpty(result: RunResult, context?: string): void {
  assertStreamEmpty(result, "stdout", context);
}

/** Assert stderr is byte-empty (H-5 stream separation). */
export function assertStderrEmpty(result: RunResult, context?: string): void {
  assertStreamEmpty(result, "stderr", context);
}

/**
 * Assert stdout is exactly one JSON document — the entire standard output
 * parses as a single document (surrounding insignificant whitespace included;
 * a trailing newline after the document is still one document) — and return
 * it parsed. Empty stdout, invalid UTF-8, concatenated documents, and any
 * non-JSON contamination fail diagnosed (H-5; SPEC.md 12.0).
 */
export function parseJsonStdout(result: RunResult, context?: string): unknown {
  const prefix = context === undefined ? "" : `${context}: `;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(result.stdoutBytes);
  } catch {
    return fail(
      `${prefix}stdout of ${result.commandLine} is not valid UTF-8, so it is not one JSON document (H-5): ${renderStream(result.stdoutBytes)}`,
    );
  }
  if (result.stdoutBytes.length === 0) {
    return fail(
      `${prefix}expected exactly one JSON document as the entire stdout of ${result.commandLine}, but stdout is empty — ${summarizeResult(result)}`,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    return fail(
      `${prefix}stdout of ${result.commandLine} is not exactly one JSON document (H-5; SPEC.md 12.0): ${(error as Error).message}; stdout: ${renderStream(result.stdoutBytes)}`,
    );
  }
}

/**
 * Assert the full `--json` stream convention of SPEC.md 12.0 / H-5 for a run:
 * exit 0 or 1 → stdout is exactly one JSON document (returned parsed);
 * exit 2 → stdout is byte-empty (returns undefined). Any other exit code —
 * a stub's unexpected code included — or a signal death fails diagnosed.
 */
export function assertJsonOutputConvention(
  result: RunResult,
  context?: string,
): unknown {
  const prefix = context === undefined ? "" : `${context}: `;
  if (result.signal !== null) {
    fail(
      `${prefix}${result.commandLine} died by signal instead of exiting (SPEC.md 12.0 commands exit 0, 1, or 2): ${summarizeResult(result)}`,
    );
  }
  switch (result.exitCode) {
    case 2:
      if (result.stdoutBytes.length > 0) {
        fail(
          `${prefix}under --json, stdout must be empty on exit 2 (H-5; usage/configuration diagnostics belong on stderr), but ${result.commandLine} wrote ${String(result.stdoutBytes.length)} bytes to stdout: ${renderStream(result.stdoutBytes)}`,
        );
      }
      return undefined;
    case 0:
    case 1:
      return parseJsonStdout(result, context);
    default:
      return fail(
        `${prefix}exit code ${String(result.exitCode)} from ${result.commandLine} is outside the SPEC.md 12.0 partition (0 success, 1 findings, 2 usage/configuration) — ${summarizeResult(result)}`,
      );
  }
}

/**
 * Diagnose where two byte sequences first differ: offset, lengths, and a
 * hex + printable window of each side around the difference.
 */
export function describeByteDifference(
  a: Uint8Array,
  b: Uint8Array,
  labelA = "actual",
  labelB = "expected",
): string {
  const offset = firstDifferenceOffset(a, b);
  const width = Math.max(labelA.length, labelB.length);
  return [
    `first difference at byte offset ${String(offset)} (${labelA}: ${String(a.length)} bytes, ${labelB}: ${String(b.length)} bytes)`,
    `  ${labelA.padEnd(width)}: ${renderWindow(a, offset)}`,
    `  ${labelB.padEnd(width)}: ${renderWindow(b, offset)}`,
  ].join("\n");
}

function assertStreamEmpty(
  result: RunResult,
  stream: "stdout" | "stderr",
  context?: string,
): void {
  const bytes = stream === "stdout" ? result.stdoutBytes : result.stderrBytes;
  if (bytes.length === 0) return;
  const prefix = context === undefined ? "" : `${context}: `;
  fail(
    `${prefix}expected empty ${stream} from ${result.commandLine} (H-5 stream separation), got ${String(bytes.length)} bytes: ${renderStream(bytes)}`,
  );
}

async function readFileDiagnosed(
  absPath: string,
  context: string,
): Promise<Buffer> {
  try {
    return await fsp.readFile(absPath);
  } catch (error) {
    return fail(
      `${context}: expected a readable regular file at ${absPath}, but reading it failed: ${(error as Error).message} (H-8: a file the product should have written but did not is a diagnosed assertion failure, not a harness crash)`,
    );
  }
}

function firstDifferenceOffset(a: Uint8Array, b: Uint8Array): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) {
    if (a[i] !== b[i]) return i;
  }
  return shared; // The shorter side is a strict prefix of the longer one.
}

const WINDOW_RADIUS = 12;

function renderWindow(bytes: Uint8Array, offset: number): string {
  if (bytes.length === 0) return "<empty>";
  const start = Math.max(0, offset - WINDOW_RADIUS);
  const end = Math.min(bytes.length, offset + WINDOW_RADIUS + 1);
  const parts: string[] = [];
  if (start > 0) parts.push("…");
  for (let i = start; i < end; i += 1) {
    const hex = bytes[i].toString(16).padStart(2, "0");
    parts.push(i === offset ? `[${hex}]` : hex);
  }
  if (end < bytes.length) parts.push("…");
  if (offset >= bytes.length) parts.push("[past end]");
  const printable = JSON.stringify(
    Buffer.from(bytes.subarray(start, end)).toString("utf8"),
  );
  return `${parts.join(" ")} ${printable}`;
}

const STREAM_EXCERPT_LIMIT = 512;

function renderStream(bytes: Uint8Array): string {
  if (bytes.length === 0) return "<empty>";
  const text = JSON.stringify(
    Buffer.from(bytes.subarray(0, STREAM_EXCERPT_LIMIT)).toString("utf8"),
  );
  return bytes.length > STREAM_EXCERPT_LIMIT
    ? `${text}… (${String(bytes.length)} bytes total)`
    : text;
}
