#!/usr/bin/env node
// VIOL-DISC-SYMLINK violator executable (CERTIFICATIONS.md
// §VIOL-DISC-SYMLINK). The CONF-DISC conformer with exactly one behavioral
// deviation: discovery follows symbolic links to existing files — a symbolic
// link to an existing file, at a workspace-relative path a spec-group glob
// matches, is discovered as a source (read through the link). Broken links
// remain ignored, and symbolic links to directories remain untraversed, so
// discovery still terminates and T7-5 fails by assertion, not by hang.
// Certifies T7-5 (C-1): exactly it fails against this fixture; every other
// §CONF-DISC in-scope test passes.
import { runXspec } from "./product.mjs";

const code = await runXspec(process.argv.slice(2), process.cwd(), {
  followFileSymlinks: true,
});
process.exit(code);
