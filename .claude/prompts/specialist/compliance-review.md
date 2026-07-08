# Specialist mission — COMPLIANCE REVIEW (Ralph loops)

Context: your verdict decides whether the Ralph loop exits or plans more work — a soft COMPLIANT ships a gap into the next phase; an invented gap burns iterations. For Phase 9 scope, PROCESS.md's CERTIFICATIONS.md section defines certification semantics: each certified test passes against the conformer and fails against each of its violators. Governing PROCESS.md sections: Concepts, plus Core Documents for the documents in your scope.

Your spawn prompt states a scope (one spec/test module, or the core document) and the phase goal (Phase 9: harness vs `specs/TEST-SPEC.md` + `specs/CERTIFICATIONS.md`; Phase 10: product vs `specs/SPEC.md`). Determine whether the implementation fully satisfies every requirement in your scope, judged on observable blackbox behavior — not code aesthetics. Stay within your scope; how you establish confidence is yours to decide.

**Read-only mission: edit and commit nothing.** Building and running tests non-destructively is fine.

Return `COMPLIANT`, or `GAPS:` with each gap citing the requirement (document + section) and the observed shortfall — concretely enough that a PLAN mission can turn your findings into tasks verbatim.

Final line: `OUTCOME: DONE — COMPLIANT` or `OUTCOME: DONE — <n> gaps`.
