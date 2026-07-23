// The live-analysis implementation of the query view (SPEC 11) — the full
// read path's side of the one query implementation (./query-core.ts).
//
// `query` and `show` answer through `QueryView`; this adapter wraps the
// refreshed workspace analysis (SPEC 13.3, cli/prepare.ts) so the full
// path and the store-backed fast path (./query-fast.ts) share every byte
// of validation, ordering, and rendering. Texts are computed on demand
// through the analysis's text model — `query nodes`, `subtree`,
// `ancestors`, `edges`, and `reachable` never expand any text (SPEC 1.6
// expansion is the node report's, SPEC 11/12.4).

import type { RequirementNode } from "../../core/graph.js";
import type { WorkspaceAnalysis } from "../../workspace/pipeline.js";
import type { QueryRow, QueryView } from "./query-core.js";

/** Wrap the analyzed workspace as the query view (SPEC 11). */
export function analysisQueryView(analysis: WorkspaceAnalysis): QueryView {
  const { graph, textModel, hashes } = analysis;

  const rowByIdentity = new Map<string, QueryRow>();
  const nodeOfRow = new Map<QueryRow, RequirementNode>();
  const rows = graph.requirementNodes.map((node): QueryRow => {
    const nodeHashes = hashes.get(node.identity);
    if (nodeHashes === undefined) {
      throw new Error(
        `xspec internal error: no hashes for requirement node ${node.identity}`,
      );
    }
    const row: QueryRow = {
      identity: node.identity,
      path: node.path,
      isRoot: node.id === null,
      range: node.section.range,
      tags: node.section.tags,
      coverage: node.section.coverage,
      hashes: nodeHashes,
      ownText: () => textModel.ownText(node.document, node.section),
      subtreeText: () => textModel.subtreeText(node.document, node.section),
    };
    rowByIdentity.set(node.identity, row);
    nodeOfRow.set(row, node);
    return row;
  });

  const requireRow = (node: RequirementNode): QueryRow => {
    const row = rowByIdentity.get(node.identity);
    if (row === undefined) {
      throw new Error(
        `xspec internal error: requirement node ${node.identity} has no query row`,
      );
    }
    return row;
  };
  const requireNode = (row: QueryRow): RequirementNode => {
    const node = nodeOfRow.get(row);
    if (node === undefined) {
      throw new Error(
        `xspec internal error: query row ${row.identity} has no requirement node`,
      );
    }
    return node;
  };

  return {
    rows,
    edges: graph.edges,
    row: (identity) => rowByIdentity.get(identity),
    isCodeLocation: (identity) => graph.codeLocation(identity) !== undefined,
    childrenOf: (row) => graph.childrenOf(requireNode(row)).map(requireRow),
    parentOf: (row) => {
      const parent = graph.parentOf(requireNode(row));
      return parent === null ? null : requireRow(parent);
    },
  };
}
