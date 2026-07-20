// Shortest witness paths under the SPEC 12.0 byte tie rule.
//
// Pure core (IMPLEMENTATION Architecture: deterministic, I/O-free): the
// reachability questions that report one witness path — `query reachable`
// (SPEC 11), coverage paths (SPEC 8.2), impact propagation paths (SPEC 9.3)
// — share one algorithm. SPEC 12.0: "Where this specification calls for one
// shortest path and several shortest paths qualify, the reported one is the
// least by element-wise byte comparison of the paths' node-identity
// sequences."

import { compareBytes } from "./bytes.js";

/** Directed adjacency over graph-node identities: source → target set. */
export type Adjacency = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * Breadth-first distances (edge counts) from `start` over `adjacency`;
 * unreachable identities are absent. Iterative — never recursion-bounded.
 */
function breadthFirstDistances(
  adjacency: Adjacency,
  start: string,
): Map<string, number> {
  const distance = new Map<string, number>([[start, 0]]);
  const queue: string[] = [start];
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    const level = distance.get(current);
    if (level === undefined) {
      throw new Error("xspec internal error: BFS queue holds unseen node");
    }
    for (const next of adjacency.get(current) ?? []) {
      if (!distance.has(next)) {
        distance.set(next, level + 1);
        queue.push(next);
      }
    }
  }
  return distance;
}

/** The reversed adjacency of `adjacency`. */
function reverseAdjacency(adjacency: Adjacency): Adjacency {
  const reversed = new Map<string, Set<string>>();
  for (const [source, targets] of adjacency) {
    for (const target of targets) {
      let sources = reversed.get(target);
      if (sources === undefined) {
        reversed.set(target, (sources = new Set()));
      }
      sources.add(source);
    }
  }
  return reversed;
}

/**
 * One shortest nontrivial path from `from` to `to` over `adjacency` — the
 * inclusive node-identity sequence, `from` first and `to` last — or null
 * when none exists. A path is one or more edges; a zero-length path is not
 * one (SPEC 11), and equal endpoints report no path: a nontrivial path from
 * a node to itself would be a dependency cycle (SPEC 5.3), invalid in every
 * workspace whose answers are surfaced (SPEC 12.1, 13.3).
 *
 * Among several shortest paths the returned one is the least by
 * element-wise byte comparison of the node-identity sequences (SPEC 12.0).
 * All shortest paths share one length, so the comparison is positional, and
 * a greedy walk realizes it: with forward distances from `from` and
 * backward distances to `to`, the successors that still complete a shortest
 * path at each position are exactly the neighbors whose remaining distance
 * matches — taking the byte-least of them dominates every path diverging at
 * that position, and a completion always exists. The constructed walk has
 * the minimal length, so no identity repeats (cutting a loop would shorten
 * it), and it is a genuine path.
 */
export function shortestWitnessPath(
  adjacency: Adjacency,
  from: string,
  to: string,
): readonly string[] | null {
  if (from === to) {
    return null;
  }
  const forward = breadthFirstDistances(adjacency, from);
  const total = forward.get(to);
  if (total === undefined) {
    return null;
  }
  const backward = breadthFirstDistances(reverseAdjacency(adjacency), to);
  const path: string[] = [from];
  let current = from;
  for (let step = 1; step <= total; step += 1) {
    const remaining = total - step;
    let best: string | null = null;
    for (const next of adjacency.get(current) ?? []) {
      // Feasible successors: backward distance exactly `remaining`. Less is
      // impossible (it would beat the shortest total); more never completes
      // a shortest path from this position.
      if (backward.get(next) !== remaining) {
        continue;
      }
      if (best === null || compareBytes(next, best) < 0) {
        best = next;
      }
    }
    if (best === null) {
      // Unreachable: `to` is at distance `total`, so every prefix position
      // has a feasible successor.
      throw new Error(
        "xspec internal error: shortest-path construction found no successor",
      );
    }
    path.push(best);
    current = best;
  }
  return path;
}
