// Configuration loading (SPEC 7) — the parsing tail over ./locate.ts.
//
// SPEC 7: every command locates the configuration (see ./locate.ts; the
// configuration file's directory is the workspace root) and validates it. A
// missing or invalid configuration is a configuration error (14.14),
// reported by every command at configuration load as a usage error (exit 2,
// 12.0), preceding all source analysis.
//
// IMPLEMENTATION (Architecture): this workspace-layer module owns the I/O —
// locating and reading the file; parsing and validation are the pure core's
// (src/core/config.ts). Diagnostics never carry absolute paths (SPEC 12.0):
// findings name the configuration file by its base name, and the `--config`
// value is echoed as given.
//
// This module statically imports the TypeScript-based parser, so it is
// loaded on demand (cli/main.ts imports it dynamically): the store-backed
// read fast path (./fast-read.ts) answers without it, recovering the parsed
// configuration recorded in the graph data under the configuration file's
// content hash instead (SPEC 12.0 determinism — identical bytes parse
// identically).

import type { Configuration, ConfigurationResult } from "../core/config.js";
import { parseConfiguration } from "../core/config.js";
import type { Finding } from "../core/findings.js";
import { sha256Hex } from "../core/hash.js";
import type { LocatedWorkspace } from "./locate.js";
import { locateWorkspace } from "./locate.js";

export { CONFIG_FILE_NAME } from "./locate.js";

/** A located workspace: the loaded configuration and its root directory. */
export interface LoadedWorkspace {
  /**
   * Absolute filesystem path of the workspace root — the configuration
   * file's directory (SPEC 7). Never rendered into output (SPEC 12.0).
   */
  readonly root: string;
  /** The configuration file's base name, for diagnostics. */
  readonly configFileName: string;
  /**
   * SHA-256 (hex) of the configuration file's exact bytes — the graph
   * data's recorded-parse key (SPEC 13.3; ./fast-read.ts).
   */
  readonly configHash: string;
  readonly configuration: Configuration;
}

export type WorkspaceLoadResult =
  | { readonly ok: true; readonly workspace: LoadedWorkspace }
  | { readonly ok: false; readonly findings: readonly Finding[] };

/**
 * Parse a located configuration file's bytes into the loaded workspace
 * (SPEC 7, 14.14) — the tail of `loadWorkspace`, split out so callers that
 * already located the workspace (cli/main.ts) parse without re-locating.
 */
export function parseLocatedWorkspace(
  located: LocatedWorkspace,
): WorkspaceLoadResult {
  const parsed = parseConfigurationBytes(
    located.configBytes,
    located.configFileName,
  );
  if (!parsed.ok) {
    return { ok: false, findings: parsed.findings };
  }
  return {
    ok: true,
    workspace: {
      root: located.root,
      configFileName: located.configFileName,
      configHash: sha256Hex(located.configBytes),
      configuration: parsed.configuration,
    },
  };
}

/**
 * Locate, read, and validate the project configuration (SPEC 7, 14.14).
 * `configFlag` is the `--config <path>` value when given, resolved against
 * `cwd` (SPEC 12.0); otherwise the upward search from `cwd` applies.
 */
export async function loadWorkspace(
  cwd: string,
  configFlag: string | undefined,
): Promise<WorkspaceLoadResult> {
  const location = await locateWorkspace(cwd, configFlag);
  if (!location.ok) {
    return { ok: false, findings: location.findings };
  }
  return parseLocatedWorkspace(location.located);
}

/**
 * Decode and parse a configuration file's exact bytes (SPEC 7, 14.14) — the
 * I/O-free tail of `loadWorkspace`, shared with baseline reconstruction
 * (SPEC 6.3), which reads the configuration content as it stood at a git
 * ref instead of from the filesystem.
 */
export function parseConfigurationBytes(
  bytes: Uint8Array,
  configFileName: string,
): ConfigurationResult {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return {
      ok: false,
      findings: [
        {
          condition: 14,
          file: configFileName,
          message:
            `not valid UTF-8 — the configuration must be well-formed ` +
            `TypeScript (SPEC 7, 14.14)`,
        },
      ],
    };
  }
  // A leading byte-order mark is valid in a TypeScript file; strip it so
  // the parser sees the module text. (The SPEC 14.20 BOM rule constrains
  // discovered sources, not the configuration.)
  if (text.startsWith("\uFEFF")) text = text.slice(1);

  return parseConfiguration(text, configFileName);
}
