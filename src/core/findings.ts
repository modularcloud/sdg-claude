// The validation-finding data model.
//
// IMPLEMENTATION (cross-cutting rules): every validation failure is
// represented as data carrying its SPEC 14 condition number and exit class;
// reports are built as data and rendered once per output form (human, JSON)
// by the CLI layer. SPEC 14: reported errors are actionable — they identify
// the file, location, and correction — and when several conditions are
// present, each is reported, not only the first.

import type { ByteRange } from "./bytes.js";

/**
 * SPEC 12.0: exit codes partition all outcomes — 0 success, 1 findings
 * (source, workspace, and operation validation failures), 2 usage and
 * configuration errors.
 */
export type ExitCode = 0 | 1 | 2;

/** SPEC 14: the defined error conditions, numbered 1–22. */
export type ConditionNumber =
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9
  | 10
  | 11
  | 12
  | 13
  | 14
  | 15
  | 16
  | 17
  | 18
  | 19
  | 20
  | 21
  | 22;

interface ConditionInfo {
  /** The condition's short name, from its SPEC 14 entry. */
  readonly name: string;
  /**
   * The exit class of a command reporting the condition: 1 for findings;
   * 2 for condition 14, which is a usage error preceding all source analysis
   * (SPEC 14.14, 12.0).
   */
  readonly exitClass: 1 | 2;
}

/** The SPEC 14 condition table: short name and exit class per condition. */
export const CONDITIONS: Readonly<Record<ConditionNumber, ConditionInfo>> = {
  1: { name: "missing ID", exitClass: 1 },
  2: { name: "invalid structural ID", exitClass: 1 },
  3: { name: "duplicate ID", exitClass: 1 },
  4: { name: "invalid segment or tag", exitClass: 1 },
  5: { name: "unknown dependency", exitClass: 1 },
  6: { name: "unknown text target", exitClass: 1 },
  7: { name: "unknown TypeScript reference", exitClass: 1 },
  8: { name: "invalid argument", exitClass: 1 },
  9: { name: "cycle", exitClass: 1 },
  10: { name: "stale generated output", exitClass: 1 },
  11: { name: "cross-module text call", exitClass: 1 },
  12: { name: "policy violation", exitClass: 1 },
  13: { name: "journal error", exitClass: 1 },
  14: { name: "configuration error", exitClass: 2 },
  15: { name: "invalid import", exitClass: 1 },
  16: { name: "invalid construct", exitClass: 1 },
  17: { name: "invalid prop", exitClass: 1 },
  18: { name: "unsupported node usage", exitClass: 1 },
  19: { name: "invalid source path", exitClass: 1 },
  20: { name: "unparseable source", exitClass: 1 },
  21: { name: "corrupt review session", exitClass: 1 },
  22: { name: "symbolic link in a write path", exitClass: 1 },
};

/**
 * One validation failure, carried as data and rendered later by the CLI.
 * The structured fields identify the file and location; `message` (with
 * `correction`, when separate) states what is wrong and how to correct it,
 * satisfying SPEC 14's actionability requirement as data.
 */
export interface Finding {
  /** SPEC 14 condition number, 1–22. */
  readonly condition: ConditionNumber;
  /** What is wrong — actionable, stating the correction unless `correction` carries it (SPEC 14). */
  readonly message: string;
  /** The correction, when stated separately from `message` (SPEC 14). */
  readonly correction?: string;
  /** Workspace-relative `/`-separated path of the concerned file (SPEC 1.5). */
  readonly file?: string;
  /** Byte-offset range locating the finding inside `file` (SPEC 1.7 form). */
  readonly range?: ByteRange;
  /** 1-based line of a location, e.g. a parse failure's (SPEC 14.20). */
  readonly line?: number;
  /** 1-based column of a location, in that line's Unicode code points. */
  readonly column?: number;
}

/** The exit class of a finding's condition (SPEC 12.0, 14.14). */
export function conditionExitClass(condition: ConditionNumber): 1 | 2 {
  return CONDITIONS[condition].exitClass;
}

/** The short SPEC 14 name of a condition (e.g. 14 → "configuration error"). */
export function conditionName(condition: ConditionNumber): string {
  return CONDITIONS[condition].name;
}
