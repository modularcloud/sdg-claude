# Reviewer mission — SPEC.md (Phase 4)

Context: SPEC.md is the product's sole source of truth. Downstream, Phase 6 must derive a complete blackbox test spec from it, and Phase 10 Engineers must implement the product from it alone — judge fitness for those two uses, not just rule compliance. Governing PROCESS.md sections: Concepts, and Core Documents → SPEC.md / modules/ / GOALS.md / IMPLEMENTATION.md.

Target: `specs/SPEC.md` plus every module in `specs/modules/` not prefixed `TEST-` or `CERTIFICATIONS-`. Bundle (per CLAUDE-PROCESS.md §6): `specs/IMPLEMENTATION.md` (if it exists), `specs/GOALS.md`, the relevant IP (patch flow), `specs/tmp/SPEC-PROBLEMS.md` (if it exists).

Press hardest on:

- **Implementation leakage.** Languages, frameworks, storage engines, libraries, internal architecture, wire formats chosen for convenience rather than required as contract — any of it is CRITICAL. The spec defines behaviors and contracts only.
- **Blackbox testability.** Every requirement must be reachable through the defined interface, contracts, test seams, or observability behaviors. A requirement with no E2E route to observe it is CRITICAL. Check that test seams are specified without introducing security vulnerabilities.
- **Contract locality.** The full consumer-facing interface/contract lives in SPEC.md itself — never in modules. Modules must not redefine, restate, or extend it; SPEC.md must not reference module internals — it reasons only about interfaces/contracts.
- **Module topology.** Top-level modules link back to SPEC.md; child modules link to their parents; no links between non-parent modules; all module files flat in `specs/modules/`. Each module must be valid as if pasted inline into SPEC.md.
- **Modularity fit.** Loosely coupled components belong in their own modules — flag sections that should be split out, and existing modules that should not be (tightly coupled content masquerading as a module).
- **Edge-case coverage.** Unhandled cases — error paths, boundary values, empty/oversized inputs, ordering and concurrency, restart/recovery, and the like — are IMPORTANT; any that leave behavior ambiguous are CRITICAL.
- **GOALS.md conformance.** Every goal must be satisfiable by the spec; a contradiction with GOALS.md is CRITICAL.
- **IP fidelity (patch flow).** The spec changes must implement the IP's intent exactly — flag both unimplemented intent and unrequested drift.
- **Self-containment and hygiene.** No references to prior versions of itself, no migration content (unless migration is a supported product feature), no tests or testing strategy, no links to non-module files, no verbosity, no contradictions between core and modules.
- **Parallelism.** SHOULD be specified so multiple instances can run on the same machine — flag specification choices that prevent it.
