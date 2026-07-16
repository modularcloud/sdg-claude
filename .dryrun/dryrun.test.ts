// Scratch dry-run (not part of the harness): enumerate the P-10 trials the
// fixed CI seed set produces (3 runs per seed, matching the registration) and
// report menu coverage plus model-consistency checks.

import { test } from "vitest";
import {
  checkProperty,
  DEFAULT_PROPERTY_SEEDS,
} from "/home/user/sdg-claude/test/helpers/property.js";
import type {
  P10Episode,
  P10Trial,
} from "/home/user/sdg-claude/test/suite/registry/section-16-p10.js";
import {
  genP10Trial,
  renderP10Trial,
} from "/home/user/sdg-claude/test/suite/registry/section-16-p10.js";

test("P-10 generator coverage over the fixed seeds", async () => {
  const trials: P10Trial[] = [];
  await checkProperty(
    "P-10 dry run",
    genP10Trial,
    (trial) => {
      trials.push(trial);
    },
    { runs: 3, env: {} },
  );

  // Model-consistency replay: renames target existing top ids at the current
  // path; moves start from the current path with fresh destinations.
  let filePath = "specs/A.mdx";
  let topIds: string[];
  const problems: string[] = [];
  for (const [trialIndex, trial] of trials.entries()) {
    filePath = "specs/A.mdx";
    topIds = ["a", "g"];
    const seen = new Set<string>([filePath]);
    for (const [index, episode] of trial.episodes.entries()) {
      const where = `trial ${trialIndex} episode ${index}`;
      if (episode.kind === "rename") {
        if (episode.file !== filePath) {
          problems.push(`${where}: rename file ${episode.file} != ${filePath}`);
        }
        const at = topIds.indexOf(episode.oldId);
        if (at < 0) {
          problems.push(`${where}: rename old id ${episode.oldId} not in ${topIds.join()}`);
        }
        if (topIds.includes(episode.newId)) {
          problems.push(`${where}: rename new id ${episode.newId} collides`);
        }
        if (episode.fate === "complete" && at >= 0) topIds[at] = episode.newId;
      } else if (episode.kind === "move") {
        if (episode.from !== filePath) {
          problems.push(`${where}: move from ${episode.from} != ${filePath}`);
        }
        if (seen.has(episode.to)) {
          problems.push(`${where}: move destination ${episode.to} reused`);
        }
        seen.add(episode.to);
        if (episode.fate === "complete") filePath = episode.to;
      }
    }
  }

  // Coverage accounting.
  const count = new Map<string, number>();
  const bump = (key: string): void => {
    count.set(key, (count.get(key) ?? 0) + 1);
  };
  let episodeTotal = 0;
  for (const trial of trials) {
    bump(`episodes=${String(trial.episodes.length)}`);
    for (const episode of trial.episodes) {
      episodeTotal += 1;
      bump(`kind:${episode.kind}`);
      bump(`fate:${episode.kind}/${episode.fate}`);
      if (episode.kind === "resolve") {
        bump(`status:${episode.status}`);
        if (episode.fate === "releaseKill") {
          bump(`delay:${String(episode.killDelayMs)}ms`);
        }
      }
      for (const i of episode.heldReads) bump(`held:${String(i)}`);
      for (const i of episode.straddleReads) bump(`straddle:${String(i)}`);
    }
  }

  console.info(`trials: ${String(trials.length)}, episodes: ${String(episodeTotal)}`);
  console.info(
    [...count.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${k}=${String(v)}`)
      .join("\n"),
  );
  console.info("sample renders:");
  for (const trial of trials.slice(0, 4)) console.info(renderP10Trial(trial));
  console.info(`seeds: ${DEFAULT_PROPERTY_SEEDS.join(", ")}`);

  const required = [
    "kind:resolve",
    "kind:rename",
    "kind:move",
    "fate:resolve/complete",
    "fate:resolve/heldKill",
    "fate:resolve/releaseKill",
    "fate:rename/complete",
    "fate:rename/heldKill",
    "fate:move/complete",
    "fate:move/heldKill",
    "status:no-change",
    "status:updated",
    "status:skipped",
    "held:0",
    "held:1",
    "held:2",
    "held:3",
    "held:4",
    "straddle:0",
    "straddle:1",
    "straddle:2",
    "straddle:3",
    "straddle:4",
  ];
  for (const key of required) {
    if ((count.get(key) ?? 0) === 0) problems.push(`coverage gap: ${key}`);
  }
  const delays = [...count.keys()].filter((k) => k.startsWith("delay:"));
  if (delays.length < 2) {
    problems.push(`coverage gap: only ${String(delays.length)} distinct kill delays`);
  }

  if (problems.length > 0) {
    throw new Error(`dry-run problems:\n${problems.join("\n")}`);
  }
});
