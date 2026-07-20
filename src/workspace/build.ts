// Build execution — the I/O half of `xspec build` (SPEC 12.1;
// IMPLEMENTATION Architecture: the workspace layer owns all I/O).
//
// The pure derivation of what a build writes is the core's
// (src/core/build.ts); this module performs the writes, strictly after the
// caller has validated the workspace (SPEC 12.1: a failed build modifies
// nothing) and the complete write set (SPEC 14.22,
// writes.ts/symlinkWritePathFindings). Every write goes through the
// workspace write layer, so each file is atomic in its observable effect
// (SPEC 13.5) and replaces whatever occupies its path (SPEC 13.4).

import type { BuildOutputs } from "../core/build.js";
import { writeGraphData } from "./graph-data.js";
import { removeDerivedFile, writeDerivedFile } from "./writes.js";

/**
 * Execute one validated build (SPEC 12.1): regenerate every derived file,
 * remove the recorded derived files no longer generated (via recorded paths
 * only, SPEC 13.3, 13.4), and store the graph data last — the record that
 * names the generated set updates only once the set exists, so an
 * interrupted build leaves at worst a stale store, which `check` reports
 * (14.10) and rebuilding resolves (SPEC 13.4).
 */
export async function executeBuildOutputs(
  root: string,
  outputs: BuildOutputs,
): Promise<void> {
  for (const file of outputs.files) {
    await writeDerivedFile(root, file.path, file.content);
  }
  for (const orphan of outputs.orphans) {
    // SPEC 13.3/13.4: orphan removal via the recorded path; a path whose
    // directory component became a symbolic link is skipped untouched
    // (writes.ts — removal never traverses a link).
    await removeDerivedFile(root, orphan);
  }
  await writeGraphData(root, outputs.graphData);
}
