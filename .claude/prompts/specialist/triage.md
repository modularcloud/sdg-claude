# Specialist mission — TRIAGE + DRAFT (Phase 2)

Read `specs/tmp/SEED.md` and classify it per PROCESS.md Phase 2: no `specs/SPEC.md` → **initial build**; otherwise **improvement** (requires SPEC.md changes) or **bug** (does not). Tiebreaker: if any behavior in SPEC.md must change, it is an improvement. Resolve seed ambiguities and confirm borderline classifications via QUESTION — the draft must reflect Developer intent, not your best guess.

**Initial build** — on branch `sdg/initial-build`: draft `specs/SPEC.md` (modularized where PROCESS.md's criteria call for it) meeting every PROCESS.md SPEC.md requirement, and draft `specs/GOALS.md` — committed only after explicit Developer approval via QUESTION. Next phase: 4.

**Patch** — on branch `patch/<short-title>`: draft the patch document in `specs/patches/` meeting every PROCESS.md patch requirement (naming and indexing scheme, classification, stage tracking starting at `Proposed`, no prescriptions or diffs). Next phase: 3.

In both cases: delete `specs/tmp/SEED.md` once consumed (leaving it re-triggers Phase 2 on the next audit); commit, push, and open a PR if the branch has none.

Return: classification, artifact path, branch, next phase.
