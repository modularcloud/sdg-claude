// Configuration location and loading (SPEC 7).
//
// SPEC 7: every command locates the configuration by upward search for
// `xspec.config.ts` from the working directory, or uses the path given by
// the global `--config <path>` option — a filesystem path resolved against
// the working directory (SPEC 12.0). The configuration file's directory is
// the workspace root. A missing or invalid configuration is a configuration
// error (14.14), reported by every command at configuration load as a
// usage error (exit 2, 12.0), preceding all source analysis.
//
// IMPLEMENTATION (Architecture): this workspace-layer module owns the I/O —
// locating and reading the file; parsing and validation are the pure core's
// (src/core/config.ts). Diagnostics never carry absolute paths (SPEC 12.0):
// findings name the configuration file by its base name, and the `--config`
// value is echoed as given.

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { Configuration, ConfigurationResult } from "../core/config.js";
import { parseConfiguration } from "../core/config.js";
import type { Finding } from "../core/findings.js";

/** SPEC 7: the configuration file name the upward search looks for. */
export const CONFIG_FILE_NAME = "xspec.config.ts";

/** A located workspace: the loaded configuration and its root directory. */
export interface LoadedWorkspace {
  /**
   * Absolute filesystem path of the workspace root — the configuration
   * file's directory (SPEC 7). Never rendered into output (SPEC 12.0).
   */
  readonly root: string;
  /** The configuration file's base name, for diagnostics. */
  readonly configFileName: string;
  readonly configuration: Configuration;
}

export type WorkspaceLoadResult =
  | { readonly ok: true; readonly workspace: LoadedWorkspace }
  | { readonly ok: false; readonly findings: readonly Finding[] };

function failure(message: string, file?: string): WorkspaceLoadResult {
  return { ok: false, findings: [{ condition: 14, message, file }] };
}

/** Whether a plain-stat of the path reaches a regular file. */
async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await fsp.stat(candidate)).isFile();
  } catch {
    return false;
  }
}

/**
 * SPEC 7: upward search for `xspec.config.ts` from the working directory.
 * Returns the found file's absolute path, or undefined when the search
 * exhausts at the filesystem root.
 */
async function searchUpward(startDir: string): Promise<string | undefined> {
  let dir = startDir;
  for (;;) {
    const candidate = path.join(dir, CONFIG_FILE_NAME);
    if (await isFile(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
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
  let configPath: string;
  let configFileName: string;
  if (configFlag !== undefined) {
    configPath = path.resolve(cwd, configFlag);
    configFileName = path.basename(configPath);
    if (!(await isFile(configPath))) {
      return failure(
        `--config ${configFlag}: no configuration file exists at this ` +
          `path, resolved against the working directory (SPEC 7, 12.0)`,
      );
    }
  } else {
    const found = await searchUpward(path.resolve(cwd));
    if (found === undefined) {
      return failure(
        `no ${CONFIG_FILE_NAME} found by upward search from the working ` +
          `directory — create one in the project root or pass --config ` +
          `<path> (SPEC 7)`,
      );
    }
    configPath = found;
    configFileName = CONFIG_FILE_NAME;
  }

  let bytes: Uint8Array;
  try {
    bytes = await fsp.readFile(configPath);
  } catch {
    return failure(
      `the configuration file cannot be read (SPEC 7)`,
      configFileName,
    );
  }
  const parsed = parseConfigurationBytes(bytes, configFileName);
  if (!parsed.ok) {
    return { ok: false, findings: parsed.findings };
  }
  return {
    ok: true,
    workspace: {
      root: path.dirname(configPath),
      configFileName,
      configuration: parsed.configuration,
    },
  };
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
