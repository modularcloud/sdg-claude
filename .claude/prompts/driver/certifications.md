# Driver mission — refine CERTIFICATIONS.md (Phase 7)

Context: certification is the harness's red-green self-check — a certified test passes against the conformer and fails against each of its violators — and Phase 9 implements every fixture kept here, which is why selectivity is the document's defining rule. Governing PROCESS.md sections: Concepts, and Core Documents → CERTIFICATIONS.md / TEST-SPEC.md / SPEC.md.

Target: `specs/CERTIFICATIONS.md` plus its `CERTIFICATIONS-` modules.

Phase-specific duties:

- **Selectivity cuts both ways.** Apply feedback that removes unjustified fixtures as readily as feedback that adds justified ones. Reject any suggestion motivated by completeness rather than the document's selection criteria — selectivity is its defining rule.
- **Problems upstream.** Defect in TEST-SPEC.md → log to `specs/tmp/TEST-SPEC-PROBLEMS.md` (jump to Phase 6). Defect in SPEC.md → log to `specs/tmp/SPEC-PROBLEMS.md` (jump to Phase 4). End with `OUTCOME: PROBLEM — <file>`.
- **On HALT** — flip `Stage: Tests Specified` when your spawn prompt specifies it (patch flow).
