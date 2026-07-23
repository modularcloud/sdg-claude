// Configuration location (SPEC 7) — the I/O-light head of workspace
// loading, separated from parsing so commands can locate and read the
// configuration file without loading the TypeScript-based parser
// (core/config.ts): every command locates the configuration by upward
// search for `xspec.config.ts` from the working directory, or uses the
// path given by the global `--config <path>` option — a filesystem path
// resolved against the working directory (SPEC 12.0). The configuration
// file's directory is the workspace root. A missing configuration is a
// configuration error (14.14), reported by every command as a usage error
// (exit 2, 12.0) preceding all source analysis.
//
// The store-backed read fast path (./fast-read.ts) starts from this
// module's result: with the configuration file's exact bytes in hand, a
// stored parse recorded under the same content hash substitutes for
// re-parsing (SPEC 12.0 determinism — identical bytes parse identically),
// which is what lets a fresh-store read skip the parser module entirely.

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { Finding } from "../core/findings.js";

/** SPEC 7: the configuration file name the upward search looks for. */
export const CONFIG_FILE_NAME = "xspec.config.ts";

/** A located workspace: the configuration file found and read, unparsed. */
export interface LocatedWorkspace {
  /**
   * Absolute filesystem path of the workspace root — the configuration
   * file's directory (SPEC 7). Never rendered into output (SPEC 12.0).
   */
  readonly root: string;
  /** The configuration file's base name, for diagnostics. */
  readonly configFileName: string;
  /** The configuration file's exact bytes. */
  readonly configBytes: Uint8Array;
}

export type WorkspaceLocateResult =
  | { readonly ok: true; readonly located: LocatedWorkspace }
  | { readonly ok: false; readonly findings: readonly Finding[] };

function failure(message: string, file?: string): WorkspaceLocateResult {
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
 * Locate and read the project configuration file (SPEC 7, 14.14) without
 * parsing it. `configFlag` is the `--config <path>` value when given,
 * resolved against `cwd` (SPEC 12.0); otherwise the upward search from
 * `cwd` applies.
 */
export async function locateWorkspace(
  cwd: string,
  configFlag: string | undefined,
): Promise<WorkspaceLocateResult> {
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
  return {
    ok: true,
    located: {
      root: path.dirname(configPath),
      configFileName,
      configBytes: bytes,
    },
  };
}
