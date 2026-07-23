// `xspec query` — the store-backed fast path (SPEC 13.3; the full path is
// ./query.ts).
//
// cli/main.ts calls this before loading the full pipeline: when the stored
// graph data verifies against the current workspace bytes
// (workspace/fast-read.ts — every recorded derivation input matches), the
// six subcommands answer from the store through the same `answerQuery`
// implementation the full path uses (./query-core.ts), byte for byte.
// A null return means "no verified store" — the caller falls back to the
// full path, whose behavior is exactly the SPEC 13.3 refresh-on-read. The
// fast path performs no writes: a verified store needs no refresh.

import type { ExitCode } from "../../core/findings.js";
import type { GraphData } from "../../core/graph-data.js";
import type { LocatedWorkspace } from "../../workspace/locate.js";
import { storeIndexes, verifyStoreForRead } from "../../workspace/fast-read.js";
import type { Invocation } from "../args.js";
import type { CliWriter } from "../io.js";
import type { QueryRow, QueryView } from "./query-core.js";
import { answerQuery, prevalidateQuery } from "./query-core.js";
import { groupsViewOfConfiguration } from "./query-groups.js";

/** Wrap verified stored graph data as the query view (SPEC 11). */
function storeQueryView(data: GraphData): QueryView {
  const indexes = storeIndexes(data);
  const rows = data.snapshot.requirements.map((stored): QueryRow => ({
    identity: stored.identity,
    path: stored.path,
    isRoot: stored.id === null,
    range: stored.range,
    tags: stored.tags,
    coverage: stored.coverage,
    hashes: stored.hashes,
    ownText: () => stored.ownText,
    subtreeText: () => stored.subtreeText,
  }));
  const rowByIdentity = new Map(rows.map((row) => [row.identity, row]));
  const requireRow = (identity: string): QueryRow => {
    const row = rowByIdentity.get(identity);
    if (row === undefined) {
      throw new Error(
        `xspec internal error: stored graph data names no requirement node ${identity}`,
      );
    }
    return row;
  };
  return {
    rows,
    edges: data.snapshot.edges,
    row: (identity) => rowByIdentity.get(identity),
    isCodeLocation: (identity) => indexes.codeIdentities.has(identity),
    childrenOf: (row) =>
      (indexes.childIdentities.get(row.identity) ?? []).map(requireRow),
    parentOf: (row) => {
      const parent = indexes.parentIdentity.get(row.identity);
      return parent === undefined ? null : requireRow(parent);
    },
  };
}

/**
 * Answer a `query` subcommand from the verified store, or return null when
 * no store verifies (the caller falls back to the full path). SPEC 11: a
 * single JSON document is `query`'s only output form; the flag validation
 * of `query nodes` precedes the answer exactly as on the full path.
 */
export async function tryFastQuery(
  invocation: Invocation,
  located: LocatedWorkspace,
  stdout: CliWriter,
  stderr: CliWriter,
): Promise<ExitCode | null> {
  const verified = await verifyStoreForRead(located);
  if (verified === null) {
    return null;
  }
  const groups = groupsViewOfConfiguration(verified.configuration);
  const prevalidated = prevalidateQuery(invocation, groups, stderr);
  if (!prevalidated.ok) {
    return prevalidated.exit;
  }
  return answerQuery(
    invocation,
    storeQueryView(verified.data),
    groups,
    stdout,
    stderr,
  );
}
