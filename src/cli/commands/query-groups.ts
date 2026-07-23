// The configured groups as `query nodes` flag validation reads them
// (SPEC 11; ./query-core.ts `GroupsView`) — one projection for both read
// paths: the full path projects the parsed configuration, the fast path
// the configuration reconstructed from the store's recorded parse
// (core/config-data.ts), so `--group` validation cannot drift between
// them. Type-only configuration import: loading this module never loads
// the TypeScript-based parser.

import type { Configuration } from "../../core/config.js";
import type { GroupsView } from "./query-core.js";

/** Project a configuration onto the groups view (SPEC 11, 14.14). */
export function groupsViewOfConfiguration(
  configuration: Configuration,
): GroupsView {
  return {
    specGroups: configuration.specGroups.map((group) => ({
      name: group.name,
      globs: group.globs,
    })),
    codeGroupNames: new Set(
      configuration.codeGroups.map((group) => group.name),
    ),
  };
}
