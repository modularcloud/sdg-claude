// Shared helpers of the graph-reading command handlers (`query`, `show`,
// `ids`, and later graph consumers — SPEC 11, 12.3, 12.4).
//
// IMPLEMENTATION (Architecture): the cli layer owns rendering and the
// exit-code taxonomy; these helpers keep every command's usage-error
// reporting and JSON emission identical. The one node-report document of
// `query node` and `show --json` (SPEC 12.4) lives in ./query-core.ts.

import * as path from "node:path";
import type { JsonObject, JsonValue } from "../../core/canonical-json.js";
import { canonicalJson } from "../../core/canonical-json.js";
import type { ByteRange } from "../../core/bytes.js";
import {
  containsControl,
  containsWhitespace,
  FORBIDDEN_SEGMENT_NAMES,
} from "../../core/text.js";
import type { TestHoldSpec } from "../../workspace/lock.js";
import type { Invocation } from "../args.js";
import { flagValue } from "../args.js";
import type { CliWriter } from "../io.js";

/**
 * SPEC 12.0: usage errors — unknown identities, unknown groups, invalid
 * flag values — exit 2 with the diagnostic on standard error and nothing on
 * standard output (the exit-2 error prevents emitting the single JSON
 * document). Diagnostics echo argv tokens and static text only, keeping
 * output byte-deterministic (SPEC 12.0).
 */
export function usageError(
  stderr: CliWriter,
  command: string,
  message: string,
): 2 {
  stderr.write(`xspec: ${command}: ${message}\n`);
  return 2;
}

/** SPEC 12.0: emit the single JSON document — the entire standard output. */
export function emitDocument(stdout: CliWriter, document: JsonValue): 0 {
  stdout.write(canonicalJson(document));
  return 0;
}

/**
 * The invocation's `--test-hold <path>` value as the workspace layer's hold
 * spec, or undefined when the flag was not given. SPEC 12.0/13.5: the value
 * is a filesystem path resolved against the working directory; the verbatim
 * token is kept for diagnostics (argv tokens only — never resolved paths).
 */
export function testHoldSpecOf(
  invocation: Invocation,
  cwd: string,
): TestHoldSpec | undefined {
  const given = flagValue(invocation, "--test-hold");
  if (given === undefined) {
    return undefined;
  }
  return { given, absolutePath: path.resolve(cwd, given) };
}

/**
 * Why `id` is not a valid requirement ID (SPEC 1.4), or null when it is.
 * Shared by `rename` and the section form of `move` (SPEC 6.4, 6.5: the new
 * ID is valid). Segment splitting on `.` makes the no-`.` rule structural;
 * each segment must be non-empty, free of `#`, whitespace, and control
 * characters, and none of the forbidden names.
 */
export function requirementIdProblem(id: string): string | null {
  for (const segment of id.split(".")) {
    if (segment.length === 0) {
      return "it has an empty segment";
    }
    if (FORBIDDEN_SEGMENT_NAMES.has(segment)) {
      return (
        `its segment ${JSON.stringify(segment)} is one of the forbidden ` +
        `names ("$", "__proto__", "prototype", "constructor", "then")`
      );
    }
    if (segment.includes("#")) {
      return `its segment ${JSON.stringify(segment)} contains "#"`;
    }
    if (containsWhitespace(segment)) {
      return `its segment ${JSON.stringify(segment)} contains whitespace`;
    }
    if (containsControl(segment)) {
      return `its segment ${JSON.stringify(segment)} contains a control character`;
    }
  }
  return null;
}

/** A source range (SPEC 1.7) as JSON data. */
export function rangeJson(range: ByteRange): JsonObject {
  return { start: range.start, end: range.end };
}
