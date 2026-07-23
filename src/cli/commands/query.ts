// `xspec query` (SPEC 11): set-level, JSON-only access to the graph — the
// full read path.
//
// A single JSON document is `query`'s only output form, with or without
// `--json` (SPEC 11, 12.0) — including the findings report of a failed
// refresh (SPEC 13.3), which is standard-output content like a failed
// `build`'s. The six subcommands' validation, ordering, and rendering live
// in ./query-core.ts, shared byte for byte with the store-backed fast path
// (./query-fast.ts): this handler is the SPEC 13.3 refresh-on-read side —
// it runs when no verified store can answer (cli/main.ts tries the fast
// path first), prepares the refreshed analysis, and answers through the
// analysis-backed view (./analysis-view.ts).

import type { ExitCode } from "../../core/findings.js";
import type { Invocation } from "../args.js";
import type { CommandContext } from "../io.js";
import { prepareGraphForRead } from "../prepare.js";
import { analysisQueryView } from "./analysis-view.js";
import { answerQuery, prevalidateQuery } from "./query-core.js";
import { groupsViewOfConfiguration } from "./query-groups.js";

/** The `query` command handler — all six subcommands (SPEC 11). */
export async function queryCommand(
  invocation: Invocation,
  context: CommandContext,
): Promise<ExitCode> {
  const { stdout, stderr } = context;
  const groups = groupsViewOfConfiguration(context.workspace.configuration);

  // SPEC 11: configuration-level flag validation precedes source analysis,
  // like its 14.14 counterparts (query-core.ts).
  const prevalidated = prevalidateQuery(invocation, groups, stderr);
  if (!prevalidated.ok) {
    return prevalidated.exit;
  }

  // SPEC 13.3: refresh-on-read, then answer. SPEC 11: a single JSON
  // document is `query`'s only output form, with or without `--json` — the
  // findings report of a failed refresh included, so the prepare step runs
  // with JSON output forced on.
  const prepared = await prepareGraphForRead(
    { ...invocation, json: true },
    context,
  );
  if (!prepared.ok) {
    return prepared.exit;
  }
  return answerQuery(
    invocation,
    analysisQueryView(prepared.analysis),
    groups,
    stdout,
    stderr,
  );
}
