// Workspace/fixture builder for the xspec test harness (TEST-SPEC H-1, S-2,
// E-6). Harness machinery only: this module never imports product code; the
// workspaces it builds are handed to the product strictly through the
// subprocess driver (TEST-SPEC H-2).
//
// - Every test builds a fresh, self-contained workspace in a unique temporary
//   directory (`fs.mkdtemp` under the OS temp directory), so tests share no
//   mutable state and two harness instances can run concurrently on one
//   machine (H-1). The workspace root is a `work/` subdirectory of that
//   temporary directory; builder-internal scratch (the isolated git HOME and
//   global-config file) lives beside the root, never inside it, so the root
//   contains exactly the declared entries.
// - The builder writes exactly the declared bytes (S-2): string contents are
//   encoded as UTF-8 with no newline translation (CRLF/CR/lone-CR preserved,
//   BOMs kept), byte contents are written verbatim (invalid UTF-8 included),
//   paths may be declared as raw byte strings for non-UTF-8 file names (Linux
//   staging, TEST-SPEC T1.5-2), and symbolic-link targets are stored verbatim
//   — dangling, cyclic, and workspace-external targets are legitimate
//   declarations (T7-5, T13.4-6).
// - Git fixtures are scripted with pinned, platform-independent author and
//   committer identities and timestamps (E-6), so identical scripts realize
//   identical commit hashes on every platform and CI leg. Every git
//   invocation runs with ambient configuration disabled: no system or global
//   config, an isolated HOME, and all inherited `GIT_*` environment dropped.

import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const SLASH = 0x2f; // "/"
const DOT = 0x2e; // "."

/**
 * A workspace-relative path. Strings use `/` separators on every platform;
 * `Uint8Array` declares the path as raw bytes (`/`-separated, i.e. 0x2f) for
 * file names that are not valid UTF-8 — meaningful on Linux, where file names
 * are byte strings (TEST-SPEC T1.5-2).
 */
export type RelPath = string | Uint8Array;

/**
 * Declared file contents. Strings are encoded as UTF-8 exactly as written —
 * no newline translation, no BOM handling; `Uint8Array` contents are written
 * verbatim.
 */
export type FileContents = string | Uint8Array;

/** Declarative form of a workspace's initial content. */
export interface WorkspaceDecl {
  /** Regular files: workspace-relative path → exact contents. */
  readonly files?: Readonly<Record<string, FileContents>>;
  /** Symbolic links: workspace-relative link path → verbatim target. */
  readonly symlinks?: Readonly<Record<string, string>>;
  /** Directories created explicitly (parents of files are implicit). */
  readonly dirs?: readonly string[];
}

export interface GitPerson {
  readonly name: string;
  readonly email: string;
}

export interface GitCommitOptions {
  /** Defaults to the pinned fixture identity. */
  readonly author?: GitPerson;
  /** Defaults to `author`. */
  readonly committer?: GitPerson;
  /**
   * A git date (e.g. `"1700000000 +0000"`). Defaults to a pinned value
   * derived from the commit's index in this workspace, so identical scripts
   * yield identical timestamps — and identical commit hashes — everywhere.
   */
  readonly authorDate?: string;
  /** Defaults to `authorDate`. */
  readonly committerDate?: string;
}

/** Pinned fixture identity (E-6: platform-independent commit metadata). */
export const GIT_FIXTURE_PERSON: GitPerson = {
  name: "xspec fixture",
  email: "fixture@xspec.invalid",
};

/** Pinned timestamp base: commit N of a workspace gets base + 60·N seconds. */
export const GIT_FIXTURE_EPOCH_SECONDS = 1_700_000_000;

export type EntryKind = "file" | "dir" | "symlink" | "other" | "absent";

export class TestWorkspace {
  /** The unique temporary directory owning this workspace. */
  readonly tempRoot: string;
  /** The workspace root — the directory handed to the product (H-1). */
  readonly root: string;

  private gitCommitCount = 0;
  private gitScratch: Promise<{ home: string; configFile: string }> | undefined;

  private constructor(tempRoot: string, root: string) {
    this.tempRoot = tempRoot;
    this.root = root;
  }

  /**
   * Create a fresh workspace in a unique temporary directory and populate it
   * with the declared entries (directories, then files, then symlinks).
   */
  static async create(decl: WorkspaceDecl = {}): Promise<TestWorkspace> {
    const tempRoot = await fsp.mkdtemp(
      path.join(os.tmpdir(), "xspec-harness-"),
    );
    const root = path.join(tempRoot, "work");
    await fsp.mkdir(root);
    const workspace = new TestWorkspace(tempRoot, root);
    for (const dir of decl.dirs ?? []) {
      await workspace.dir(dir);
    }
    for (const [rel, contents] of Object.entries(decl.files ?? {})) {
      await workspace.file(rel, contents);
    }
    for (const [rel, target] of Object.entries(decl.symlinks ?? {})) {
      await workspace.symlink(rel, target);
    }
    return workspace;
  }

  /**
   * Resolve a workspace-relative string path to an absolute native path,
   * refusing any path that escapes the workspace root (a builder-bug guard:
   * fixtures are self-contained by definition, H-1).
   */
  path(rel: string): string {
    const abs = path.resolve(this.root, rel);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) {
      throw new Error(
        `workspace-relative path escapes the workspace root: ${JSON.stringify(rel)}`,
      );
    }
    return abs;
  }

  /** Write a regular file with exactly the declared bytes, creating parents. */
  async file(rel: RelPath, contents: FileContents): Promise<void> {
    const abs = this.resolve(rel);
    await ensureParent(abs);
    const data =
      typeof contents === "string" ? Buffer.from(contents, "utf8") : contents;
    await fsp.writeFile(abs, data);
  }

  /** Create a directory (and parents). */
  async dir(rel: string): Promise<void> {
    await fsp.mkdir(this.path(rel), { recursive: true });
  }

  /**
   * Create a symbolic link whose target is stored verbatim — never resolved,
   * never validated: dangling, cyclic, and workspace-external targets are
   * legitimate declarations (T7-5, T13.4-6). `kind` is the Windows link-type
   * hint; it is ignored on POSIX platforms.
   */
  async symlink(
    rel: string,
    target: string,
    kind: "file" | "dir" = "file",
  ): Promise<void> {
    const abs = this.path(rel);
    await ensureParent(abs);
    await fsp.symlink(target, abs, kind);
  }

  /** Read a file's exact bytes (follows symlinks, like the product would). */
  async readBytes(rel: RelPath): Promise<Uint8Array> {
    return await fsp.readFile(this.resolve(rel));
  }

  /** Directory entry names as raw bytes, sorted bytewise (deterministic). */
  async readdirBytes(rel: RelPath = "."): Promise<Uint8Array[]> {
    const names = await fsp.readdir(this.resolve(rel), { encoding: "buffer" });
    return names.sort(Buffer.compare);
  }

  /** Directory entry names as UTF-8 strings, sorted (deterministic). */
  async readdirNames(rel = "."): Promise<string[]> {
    const names = await fsp.readdir(this.path(rel));
    return names.sort();
  }

  /** A symbolic link's target, exactly as stored. */
  async linkTarget(rel: string): Promise<string> {
    return await fsp.readlink(this.path(rel));
  }

  /** What occupies a path, without following symlinks. */
  async kind(rel: RelPath): Promise<EntryKind> {
    let stats;
    try {
      stats = await fsp.lstat(this.resolve(rel));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return "absent";
      }
      throw error;
    }
    if (stats.isSymbolicLink()) return "symlink";
    if (stats.isDirectory()) return "dir";
    if (stats.isFile()) return "file";
    return "other";
  }

  /**
   * Initialize a git repository at the workspace root with a fixed initial
   * branch name and newline handling pinned off, independent of the machine
   * and platform (E-6).
   */
  async gitInit(): Promise<void> {
    await this.runGit(["init", "--quiet", "-b", "main"]);
    await this.runGit(["config", "core.autocrlf", "false"]);
  }

  /**
   * Stage everything and commit with pinned, platform-independent identities
   * and timestamps (E-6). Returns the commit hash. Defaults make identical
   * scripts produce identical hashes in any directory, on any platform.
   */
  async gitCommitAll(
    message: string,
    options: GitCommitOptions = {},
  ): Promise<string> {
    const author = options.author ?? GIT_FIXTURE_PERSON;
    const committer = options.committer ?? author;
    const authorDate =
      options.authorDate ??
      `${GIT_FIXTURE_EPOCH_SECONDS + 60 * this.gitCommitCount} +0000`;
    const committerDate = options.committerDate ?? authorDate;
    this.gitCommitCount += 1;
    await this.runGit(["add", "-A"]);
    await this.runGit(["commit", "--quiet", "--allow-empty", "-m", message], {
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_AUTHOR_DATE: authorDate,
      GIT_COMMITTER_NAME: committer.name,
      GIT_COMMITTER_EMAIL: committer.email,
      GIT_COMMITTER_DATE: committerDate,
    });
    const { stdout } = await this.runGit(["rev-parse", "HEAD"]);
    return stdout.trim();
  }

  /**
   * Run an arbitrary git command in the workspace root under the isolated,
   * pinned git environment. Throws (with stderr) on nonzero exit.
   */
  async git(
    args: readonly string[],
  ): Promise<{ stdout: string; stderr: string }> {
    return await this.runGit(args);
  }

  /** Remove the workspace and all builder scratch. Safe to call twice. */
  async dispose(): Promise<void> {
    try {
      await fsp.rm(this.tempRoot, {
        recursive: true,
        force: true,
        maxRetries: 2,
      });
    } catch {
      // Read-only entries (git object files on Windows) block deletion; make
      // the tree writable and retry once, loudly this time.
      await makeTreeWritable(Buffer.from(this.tempRoot));
      await fsp.rm(this.tempRoot, {
        recursive: true,
        force: true,
        maxRetries: 2,
      });
    }
  }

  private resolve(rel: RelPath): string | Buffer {
    if (typeof rel === "string") {
      return this.path(rel);
    }
    const bytes = Buffer.from(rel);
    assertValidBytePath(bytes);
    return Buffer.concat([Buffer.from(this.root), Buffer.from([SLASH]), bytes]);
  }

  private gitScratchDirs(): Promise<{ home: string; configFile: string }> {
    this.gitScratch ??= (async () => {
      const home = path.join(this.tempRoot, "git-home");
      await fsp.mkdir(path.join(home, ".config"), { recursive: true });
      const configFile = path.join(this.tempRoot, "git-config");
      await fsp.writeFile(configFile, "");
      return { home, configFile };
    })();
    return this.gitScratch;
  }

  private async runGit(
    args: readonly string[],
    identityEnv: Readonly<Record<string, string>> = {},
  ): Promise<{ stdout: string; stderr: string }> {
    const { home, configFile } = await this.gitScratchDirs();
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      const upper = key.toUpperCase();
      // Ambient git control variables and the ident fallback must not leak
      // into fixtures (E-6: platform- and machine-independent commits).
      if (upper.startsWith("GIT_") || upper === "EMAIL") continue;
      env[key] = value;
    }
    Object.assign(env, {
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: configFile,
      GIT_CEILING_DIRECTORIES: this.tempRoot,
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
      ...identityEnv,
    });
    try {
      const { stdout, stderr } = await execFileAsync("git", args, {
        cwd: this.root,
        env,
        timeout: 60_000,
        maxBuffer: 16 * 1024 * 1024,
      });
      return { stdout, stderr };
    } catch (error) {
      const failure = error as {
        stderr?: string;
        code?: number | string;
        killed?: boolean;
      };
      const reason = failure.killed
        ? "killed (timeout)"
        : `exit ${String(failure.code ?? "unknown")}`;
      throw new Error(
        `git ${args.join(" ")} failed in ${this.root} (${reason}): ${failure.stderr ?? String(error)}`,
      );
    }
  }
}

/** Create the parent directory chain for an absolute (string or byte) path. */
async function ensureParent(abs: string | Buffer): Promise<void> {
  if (typeof abs === "string") {
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    return;
  }
  // Byte paths always contain the root/rel joiner slash.
  await fsp.mkdir(abs.subarray(0, abs.lastIndexOf(SLASH)), { recursive: true });
}

/**
 * Byte paths are workspace-relative by construction: no leading `/`, no NUL,
 * and no `.`/`..`/empty segments (they cannot be normalized safely and could
 * alias or escape the root).
 */
function assertValidBytePath(bytes: Buffer): void {
  if (bytes.length === 0) {
    throw new Error("byte path is empty");
  }
  if (bytes[0] === SLASH) {
    throw new Error(
      "byte path must be workspace-relative (leading '/' forbidden)",
    );
  }
  if (bytes.includes(0)) {
    throw new Error("byte path contains a NUL byte");
  }
  let start = 0;
  for (let i = 0; i <= bytes.length; i += 1) {
    if (i === bytes.length || bytes[i] === SLASH) {
      const segment = bytes.subarray(start, i);
      if (segment.length === 0) {
        throw new Error("byte path contains an empty segment");
      }
      if (segment.length === 1 && segment[0] === DOT) {
        throw new Error("byte path contains a '.' segment");
      }
      if (segment.length === 2 && segment[0] === DOT && segment[1] === DOT) {
        throw new Error("byte path contains a '..' segment");
      }
      start = i + 1;
    }
  }
}

/** Best-effort recursive chmod so `rm` can delete read-only entries. */
async function makeTreeWritable(dir: Buffer): Promise<void> {
  await fsp.chmod(dir, 0o700).catch(() => undefined);
  const names = await fsp
    .readdir(dir, { encoding: "buffer" })
    .catch(() => undefined);
  if (!names) return;
  for (const name of names) {
    const child = Buffer.concat([dir, Buffer.from([SLASH]), name]);
    const stats = await fsp.lstat(child).catch(() => undefined);
    if (!stats) continue;
    if (stats.isDirectory()) {
      await makeTreeWritable(child);
    } else if (stats.isFile()) {
      await fsp.chmod(child, 0o600).catch(() => undefined);
    }
  }
}
