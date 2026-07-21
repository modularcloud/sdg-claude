// Argument parsing for the xspec CLI.
//
// IMPLEMENTATION (Key libraries): no CLI framework — the SPEC 12.0 flag rules
// are implemented in-repo because their semantics are pinned exactly by the
// specification. IMPLEMENTATION (Architecture): the cli layer owns argument
// parsing, command dispatch, and the exit-code taxonomy.
//
// The grammar, from SPEC 12.0 and the per-command forms (6.4, 6.5, 8.2, 9,
// 10.7, 11, 12.1–12.5):
//
// - The first argv element names a command from the known table (12.5):
//   `build`, `check`, `ids`, `show`, `coverage`, `impact`, `review`, `query`,
//   `rename`, `move`. `review` and `query` take a subcommand as the next
//   element. Unknown commands and subcommands are usage errors (12.0).
// - Tokens beginning `--` are flags; a value flag consumes the following
//   element, verbatim, as its value. The specification writes only the
//   space-separated form, so a token like `--config=x` is an unknown flag.
// - Every command supports the global `--json` and `--config <path>` (12.0).
// - A flag may be given at most once per invocation; repetition is a usage
//   error, identical values included (12.0).
// - List-valued flags (`--kinds`) take one comma-separated value (12.0, 11).
// - All other tokens are positional arguments, checked against the command's
//   arity; a missing required argument or an unexpected extra argument is a
//   usage error (12.0: "missing required flags or arguments").
// - Argument values are interpreted as UTF-8; a value that is not valid
//   UTF-8 is a usage error (12.0).
//
// Every parse failure is a usage error: exit 2, diagnostic on stderr, and an
// empty standard output — under `--json` the exit-2 error prevents emitting
// the single JSON document (12.0), and no report is defined for exit-2
// outcomes in human form either. Diagnostics echo only argv tokens and static
// text, never resolved filesystem paths, keeping all output byte-deterministic
// for identical input (12.0: no absolute paths, no environment-dependent
// content).

/** One flag a command accepts, and how its value (if any) is validated. */
interface FlagSpec {
  /** The flag token, leading `--` included (e.g. `"--base"`). */
  readonly name: string;
  /** Whether the flag consumes the following argv element as its value. */
  readonly takesValue: boolean;
  /** Diagnostic name of the value (e.g. `"<git-ref>"`). */
  readonly valueName?: string;
  /** SPEC 12.0: missing required flags are usage errors. */
  readonly required?: boolean;
  /** Enumerated whole-value set; any other value is a usage error. */
  readonly allowed?: readonly string[];
  /**
   * Marks a list-valued flag (SPEC 12.0): the value is one comma-separated
   * list whose every element must be in this set.
   */
  readonly list?: readonly string[];
}

/** One command (or `review`/`query` subcommand) of the SPEC 12.5 table. */
interface CommandSpec {
  /** Dispatch key and diagnostic prefix: `"build"`, `"review create"`, … */
  readonly path: string;
  /** Positional-argument names in order (e.g. `["<name>", "<item-id>"]`). */
  readonly positionals: readonly string[];
  /** How many trailing positionals are optional (default none). */
  readonly optionalPositionals?: number;
  /** Command-specific flags; the SPEC 12.0 globals are added for every command. */
  readonly flags: readonly FlagSpec[];
  /**
   * Groups of flags of which exactly one must be given — SPEC 10.7: `review
   * create` requires exactly one of `--base`, `--strategy`, `--coverage`;
   * none or more than one is a usage error (12.0).
   */
  readonly exactlyOneOf?: readonly (readonly string[])[];
}

/** SPEC 12.0: every command supports `--json` and `--config <path>` (7). */
const GLOBAL_FLAGS: readonly FlagSpec[] = [
  { name: "--json", takesValue: false },
  { name: "--config", takesValue: true, valueName: "<path>" },
];

/** SPEC 5.2: the four edge kinds (`query edges --kinds` filters over all). */
const ALL_EDGE_KINDS: readonly string[] = [
  "contains",
  "depends",
  "embeds",
  "references",
];

/**
 * SPEC 11: `query reachable --kinds` accepts only the three dependency edge
 * kinds — `contains` is an invalid flag value (12.0).
 */
const DEPENDENCY_EDGE_KINDS: readonly string[] = [
  "depends",
  "embeds",
  "references",
];

/** SPEC 13.5: every mutating command accepts `--test-hold <path>`. */
const TEST_HOLD_FLAG: FlagSpec = {
  name: "--test-hold",
  takesValue: true,
  valueName: "<path>",
};

/**
 * The known command table (SPEC 12.5), in specification order. Argument
 * forms: `build` 12.1, `check` 12.2, `ids` 12.3, `show` 12.4, `coverage` 8.2,
 * `impact` 9, `review` 10.7, `query` 11, `rename` 6.4, `move` 6.5.
 */
const COMMANDS: readonly CommandSpec[] = [
  // SPEC 12.1.
  { path: "build", positionals: [], flags: [] },
  // SPEC 12.2.
  { path: "check", positionals: [], flags: [] },
  // SPEC 12.3: `--tree`, `--file <glob>`, `--unreferenced`.
  {
    path: "ids",
    positionals: [],
    flags: [
      { name: "--tree", takesValue: false },
      { name: "--file", takesValue: true, valueName: "<glob>" },
      { name: "--unreferenced", takesValue: false },
    ],
  },
  // SPEC 12.4: `show <node>`.
  { path: "show", positionals: ["<node>"], flags: [] },
  // SPEC 8.2: `coverage` runs all profiles, `coverage <name>` one; `--check`.
  {
    path: "coverage",
    positionals: ["<name>"],
    optionalPositionals: 1,
    flags: [{ name: "--check", takesValue: false }],
  },
  // SPEC 9: `impact --base <git-ref>`.
  {
    path: "impact",
    positionals: [],
    flags: [
      {
        name: "--base",
        takesValue: true,
        valueName: "<git-ref>",
        required: true,
      },
    ],
  },
  // SPEC 10.7: the eight review subcommands.
  {
    path: "review create",
    positionals: [],
    flags: [
      { name: "--base", takesValue: true, valueName: "<ref>" },
      // SPEC 10.7: any `--strategy` value other than `audit` is a usage error.
      {
        name: "--strategy",
        takesValue: true,
        valueName: "<strategy>",
        allowed: ["audit"],
      },
      { name: "--coverage", takesValue: true, valueName: "<profile>" },
      { name: "--name", takesValue: true, valueName: "<name>", required: true },
      TEST_HOLD_FLAG,
    ],
    exactlyOneOf: [["--base", "--strategy", "--coverage"]],
  },
  { path: "review list", positionals: [], flags: [] },
  { path: "review status", positionals: ["<name>"], flags: [] },
  { path: "review next", positionals: ["<name>"], flags: [] },
  { path: "review show", positionals: ["<name>", "<item-id>"], flags: [] },
  {
    path: "review split",
    positionals: ["<name>", "<item-id>"],
    flags: [TEST_HOLD_FLAG],
  },
  {
    path: "review resolve",
    positionals: ["<name>", "<item-id>"],
    flags: [
      // SPEC 10.7: `--status` accepts `updated`, `no-change`, and `skipped`;
      // any other value is a usage error.
      {
        name: "--status",
        takesValue: true,
        valueName: "<status>",
        required: true,
        allowed: ["updated", "no-change", "skipped"],
      },
      { name: "--note", takesValue: true, valueName: "<text>" },
      TEST_HOLD_FLAG,
    ],
  },
  { path: "review export", positionals: ["<name>"], flags: [] },
  // SPEC 11: the six query subcommands.
  { path: "query node", positionals: ["<node>"], flags: [] },
  {
    path: "query nodes",
    positionals: [],
    flags: [
      { name: "--group", takesValue: true, valueName: "<g>" },
      { name: "--file", takesValue: true, valueName: "<glob>" },
      { name: "--tag", takesValue: true, valueName: "<t>" },
      // SPEC 11: `--coverage required|none`.
      {
        name: "--coverage",
        takesValue: true,
        valueName: "required|none",
        allowed: ["required", "none"],
      },
    ],
  },
  {
    path: "query edges",
    positionals: [],
    flags: [
      { name: "--from", takesValue: true, valueName: "<graph-node>" },
      { name: "--to", takesValue: true, valueName: "<graph-node>" },
      // SPEC 11: `edges --kinds` filters over all four kinds.
      {
        name: "--kinds",
        takesValue: true,
        valueName: "<kinds>",
        list: ALL_EDGE_KINDS,
      },
    ],
  },
  { path: "query subtree", positionals: ["<node>"], flags: [] },
  { path: "query ancestors", positionals: ["<node>"], flags: [] },
  {
    path: "query reachable",
    positionals: [],
    flags: [
      {
        name: "--from",
        takesValue: true,
        valueName: "<graph-node>",
        required: true,
      },
      {
        name: "--to",
        takesValue: true,
        valueName: "<graph-node>",
        required: true,
      },
      {
        name: "--kinds",
        takesValue: true,
        valueName: "<kinds>",
        list: DEPENDENCY_EDGE_KINDS,
      },
    ],
  },
  // SPEC 6.4: `rename <file> <old-id> <new-id>`.
  {
    path: "rename",
    positionals: ["<file>", "<old-id>", "<new-id>"],
    flags: [TEST_HOLD_FLAG],
  },
  // SPEC 6.5: `move <old-file> <new-file>` or
  // `move <file>#<id> <target-file>#<new-id>` — two positionals either way.
  { path: "move", positionals: ["<old>", "<new>"], flags: [TEST_HOLD_FLAG] },
];

/** Every dispatch key (`CommandSpec.path`), in specification order. */
export const COMMAND_PATHS: readonly string[] = COMMANDS.map(
  (spec) => spec.path,
);

/** A parsed flag value: boolean presence, one value, or a `--kinds` list. */
export type FlagValue = true | string | readonly string[];

/** A successfully parsed invocation, ready for dispatch. */
export interface Invocation {
  /** The matched command's dispatch key (`CommandSpec.path`). */
  readonly command: string;
  /** Positional arguments in order. */
  readonly positionals: readonly string[];
  /** SPEC 12.0: the global `--json` flag. */
  readonly json: boolean;
  /**
   * SPEC 12.0: the global `--config <path>` value, a filesystem path to be
   * resolved against the working directory; absent when the flag was not
   * given.
   */
  readonly config?: string;
  /** Command-specific flags as given (globals are carried in `json`/`config`). */
  readonly flags: ReadonlyMap<string, FlagValue>;
}

export type ParseResult =
  | { readonly ok: true; readonly invocation: Invocation }
  | { readonly ok: false; readonly message: string };

function usageError(message: string): ParseResult {
  return { ok: false, message: `xspec: ${message}` };
}

/**
 * SPEC 12.0: argument values are interpreted as UTF-8, and a value that is
 * not valid UTF-8 is a usage error. Node materializes `process.argv` by
 * decoding the OS argument bytes as UTF-8 with U+FFFD substituted for every
 * invalid sequence, so invalid input bytes are observable only as U+FFFD in
 * the decoded string: a value containing U+FFFD is indistinguishable from
 * mis-decoded bytes and is treated as not valid UTF-8. A lone surrogate
 * (which no UTF-8 decode produces, but an in-process caller could pass) has
 * no UTF-8 encoding and is rejected the same way.
 *
 * Exported for `move` (SPEC 6.5): the parser exempts `move`'s positionals —
 * a destination path that is not valid UTF-8 is one of 6.5's destination
 * *refusals* (exit 1), not a usage error, so the command classifies its own
 * arguments with this same predicate.
 */
export function isValidUtf8ArgumentValue(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit === 0xfffd) return false;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** `"build, check, ids, …"` for diagnostics, in specification order. */
function commandNameList(): string {
  const names: string[] = [];
  for (const spec of COMMANDS) {
    const name = spec.path.split(" ")[0]!;
    if (!names.includes(name)) names.push(name);
  }
  return names.join(", ");
}

/** Subcommand names of a command group, in specification order. */
function subcommandNameList(group: ReadonlyMap<string, CommandSpec>): string {
  return [...group.keys()].join(", ");
}

/** The command table keyed by name; `review`/`query` hold subcommand maps. */
function buildTable(): ReadonlyMap<
  string,
  CommandSpec | Map<string, CommandSpec>
> {
  const table = new Map<string, CommandSpec | Map<string, CommandSpec>>();
  for (const spec of COMMANDS) {
    const words = spec.path.split(" ");
    if (words.length === 1) {
      table.set(spec.path, spec);
      continue;
    }
    const [command, subcommand] = [words[0]!, words[1]!];
    const existing = table.get(command);
    const group =
      existing instanceof Map ? existing : new Map<string, CommandSpec>();
    group.set(subcommand, spec);
    table.set(command, group);
  }
  return table;
}

const TABLE = buildTable();

/**
 * Parse one invocation's argv (the elements after the executable name)
 * against the SPEC 12.0 conventions and the SPEC 12.5 command table. Returns
 * the parsed invocation, or the usage-error diagnostic the caller must write
 * to stderr before exiting 2 (12.0).
 */
export function parseArgv(argv: readonly string[]): ParseResult {
  // SPEC 12.0: argument values are interpreted as UTF-8, and a value that is
  // not valid UTF-8 is a usage error. Checked per token below, because the
  // `move` command's positionals are exempt (SPEC 6.5: a destination path
  // that is not valid UTF-8 is a destination refusal, exit 1 — the command
  // classifies it; a non-UTF-8 origin names no discovered source and stays
  // in the usage-error class through the existence check).
  const nonUtf8 = (indexInArgv: number): ParseResult =>
    usageError(
      `argument ${String(indexInArgv + 1)} is not valid UTF-8 — argument ` +
        `values are interpreted as UTF-8`,
    );

  if (argv.length === 0) {
    return usageError(
      `missing command (expected one of: ${commandNameList()})`,
    );
  }
  const commandToken = argv[0]!;
  if (!isValidUtf8ArgumentValue(commandToken)) {
    return nonUtf8(0);
  }
  if (commandToken.startsWith("--")) {
    return usageError(
      `expected a command before any flags (expected one of: ` +
        `${commandNameList()})`,
    );
  }
  const entry = TABLE.get(commandToken);
  if (entry === undefined) {
    return usageError(
      `unknown command '${commandToken}' (expected one of: ` +
        `${commandNameList()})`,
    );
  }

  let spec: CommandSpec;
  let tokens: readonly string[];
  if (entry instanceof Map) {
    const subToken = argv.length > 1 ? argv[1]! : undefined;
    if (subToken === undefined || subToken.startsWith("--")) {
      return usageError(
        `${commandToken}: missing subcommand (expected one of: ` +
          `${subcommandNameList(entry)})`,
      );
    }
    if (!isValidUtf8ArgumentValue(subToken)) {
      return nonUtf8(1);
    }
    const subcommand = entry.get(subToken);
    if (subcommand === undefined) {
      return usageError(
        `${commandToken}: unknown subcommand '${subToken}' (expected one ` +
          `of: ${subcommandNameList(entry)})`,
      );
    }
    spec = subcommand;
    tokens = argv.slice(2);
  } else {
    spec = entry;
    tokens = argv.slice(1);
  }

  const flagSpecs = new Map<string, FlagSpec>();
  for (const flag of GLOBAL_FLAGS) flagSpecs.set(flag.name, flag);
  for (const flag of spec.flags) flagSpecs.set(flag.name, flag);

  const seen = new Set<string>();
  const flags = new Map<string, FlagValue>();
  const positionals: string[] = [];
  let json = false;
  let config: string | undefined;

  // Argv index of a token: `tokens` is argv minus the command (and
  // subcommand) tokens, so the offset restores the original position for
  // the non-UTF-8 diagnostics.
  const tokenOffset = argv.length - tokens.length;
  // SPEC 6.5: `move`'s positional arguments are exempt from the parse-level
  // UTF-8 usage check (see `isValidUtf8ArgumentValue`); flags and their
  // values keep it.
  const utf8ExemptPositionals = spec.path === "move";

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!token.startsWith("--")) {
      if (!utf8ExemptPositionals && !isValidUtf8ArgumentValue(token)) {
        return nonUtf8(tokenOffset + index);
      }
      positionals.push(token);
      continue;
    }
    if (!isValidUtf8ArgumentValue(token)) {
      return nonUtf8(tokenOffset + index);
    }
    const flag = flagSpecs.get(token);
    if (flag === undefined) {
      // SPEC 12.0: unknown flags are usage errors.
      return usageError(`${spec.path}: unknown flag '${token}'`);
    }
    // SPEC 12.0: a flag may be given at most once per invocation; repeating a
    // flag is a usage error — identical values included.
    if (seen.has(token)) {
      return usageError(
        `${spec.path}: flag '${token}' given more than once — a flag may be ` +
          `given at most once per invocation`,
      );
    }
    seen.add(token);
    if (!flag.takesValue) {
      if (token === "--json") json = true;
      else flags.set(token, true);
      continue;
    }
    index += 1;
    if (index >= tokens.length) {
      return usageError(
        `${spec.path}: flag '${token}' requires a value` +
          (flag.valueName === undefined ? "" : ` ${flag.valueName}`),
      );
    }
    const value = tokens[index]!;
    if (!isValidUtf8ArgumentValue(value)) {
      return nonUtf8(tokenOffset + index);
    }
    if (flag.list !== undefined) {
      // SPEC 12.0: list-valued flags take one comma-separated value; an
      // element outside the flag's set is an invalid flag value.
      const elements = value.split(",");
      for (const element of elements) {
        if (!flag.list.includes(element)) {
          return usageError(
            `${spec.path}: invalid value '${value}' for '${token}' — one ` +
              `comma-separated list of: ${flag.list.join(", ")}`,
          );
        }
      }
      flags.set(token, elements);
      continue;
    }
    if (flag.allowed !== undefined && !flag.allowed.includes(value)) {
      // SPEC 12.0: invalid flag values are usage errors.
      return usageError(
        `${spec.path}: invalid value '${value}' for '${token}' (expected ` +
          `one of: ${flag.allowed.join(", ")})`,
      );
    }
    if (token === "--config") config = value;
    else flags.set(token, value);
  }

  // SPEC 12.0: missing required flags are usage errors.
  for (const flag of spec.flags) {
    if (flag.required === true && !seen.has(flag.name)) {
      return usageError(
        `${spec.path}: missing required flag '${flag.name}'` +
          (flag.valueName === undefined ? "" : ` ${flag.valueName}`),
      );
    }
  }
  // SPEC 10.7 (via `exactlyOneOf`): exactly one of the group must be given.
  for (const group of spec.exactlyOneOf ?? []) {
    const given = group.filter((name) => seen.has(name));
    if (given.length !== 1) {
      return usageError(
        `${spec.path}: exactly one of ${group.join(", ")} is required` +
          (given.length === 0 ? "" : ` (got ${given.join(" and ")})`),
      );
    }
  }
  // SPEC 12.0: missing required arguments are usage errors; an argument the
  // command's form does not define is one too.
  const minimum = spec.positionals.length - (spec.optionalPositionals ?? 0);
  if (positionals.length < minimum) {
    return usageError(
      `${spec.path}: missing required argument ` +
        `${spec.positionals[positionals.length]!}`,
    );
  }
  if (positionals.length > spec.positionals.length) {
    return usageError(
      `${spec.path}: unexpected argument ` +
        `'${positionals[spec.positionals.length]!}'`,
    );
  }

  return {
    ok: true,
    invocation: { command: spec.path, positionals, json, config, flags },
  };
}

/** The value of a value flag, or undefined when it was not given. */
export function flagValue(
  invocation: Invocation,
  name: string,
): string | undefined {
  const value = invocation.flags.get(name);
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(
      `flag '${name}' of '${invocation.command}' is not a value flag`,
    );
  }
  return value;
}

/** Whether a boolean flag was given. */
export function flagPresent(invocation: Invocation, name: string): boolean {
  const value = invocation.flags.get(name);
  if (value === undefined) return false;
  if (value !== true) {
    throw new Error(
      `flag '${name}' of '${invocation.command}' is not a boolean flag`,
    );
  }
  return true;
}

/** The elements of a list-valued flag, or undefined when it was not given. */
export function flagList(
  invocation: Invocation,
  name: string,
): readonly string[] | undefined {
  const value = invocation.flags.get(name);
  if (value === undefined) return undefined;
  if (value === true || typeof value === "string") {
    throw new Error(
      `flag '${name}' of '${invocation.command}' is not a list-valued flag`,
    );
  }
  return value;
}
