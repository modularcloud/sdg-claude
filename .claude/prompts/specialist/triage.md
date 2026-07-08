# Specialist mission — TRIAGE + DRAFT (Phase 2)

Context: your classification decides the entire route — initial build (everything gets built, Phases 4–10), improvement (spec-first, Phase 4 onward), or bug (harness-first, Phases 6/7/9). Your draft is only the input to iterative refinement, but refinement can sharpen only intent that is present. Governing PROCESS.md sections: Concepts, Phase 2, Patch Documents, and Core Documents → SPEC.md / GOALS.md.

Read `specs/tmp/SEED.md` and classify it per PROCESS.md Phase 2: no `specs/SPEC.md` → **initial build**; otherwise **improvement** (requires SPEC.md changes) or **bug** (does not). Tiebreaker: if any behavior in SPEC.md must change, it is an improvement. Resolve seed ambiguities and confirm borderline classifications via QUESTION — the draft must reflect Developer intent, not your best guess.

**Initial build** — on branch `sdg/initial-build`: draft `specs/SPEC.md` (modularized where PROCESS.md's criteria call for it) meeting every PROCESS.md SPEC.md requirement, and draft `specs/GOALS.md` — committed only after explicit Developer approval via QUESTION. Next phase: 4.

**Patch** — on branch `patch/<short-title>`: draft the patch document in `specs/patches/` meeting every PROCESS.md patch requirement (naming and indexing scheme, classification, stage tracking starting at `Proposed`, no prescriptions or diffs). Next phase: 3.

In both cases: delete `specs/tmp/SEED.md` once consumed (leaving it re-triggers Phase 2 on the next audit); commit, push, and open a PR if the branch has none.

Return: classification, artifact path, branch, next phase.
