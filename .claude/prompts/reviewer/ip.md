# Reviewer mission — Improvement Proposal (Phase 3)

Target: the active IP under `specs/patches/`. Bundle (per CLAUDE-PROCESS.md §6): `specs/GOALS.md`, SPEC.md with its modules, `specs/tmp/PATCH-PROBLEMS.md` (if it exists).

Press hardest on:

- **Classification.** An IP must require SPEC.md changes. If the proposal could be satisfied without touching SPEC.md, it is a Bug Report — misclassification is CRITICAL (the Driver can reclassify).
- **No test-spec smuggling.** Any suggested change to TEST-SPEC.md is CRITICAL — IPs must not suggest them.
- **SPEC-level rigor.** The suggested SPEC.md changes must hold to SPEC.md's own bar: behavioral, implementation-agnostic, edge-case aware, blackbox-testable, and free of contradictions against the existing spec.
- **No prescriptions.** No specific code or implementation details outside clearly-marked archival material (which is preserved but non-authoritative), and no direct diffs/patches to any file — including SPEC.md itself.
- **GOALS.md compatibility.** A proposal that would force SPEC.md to contradict GOALS.md is CRITICAL and must be called out explicitly.
- **Completeness of intent.** Motivation summary present; stage tracked; the proposed behavior change specified tightly enough that Phase 4 can apply it without guessing. Vague intent that Phase 4 would have to invent is IMPORTANT at minimum.
