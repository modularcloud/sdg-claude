# Driver mission — refine the patch (Phase 3)

Target: the active patch document (IP or Bug Report) in `specs/patches/`.

Phase-specific duties:

- **Reclassification authority.** If refinement reveals the patch is the wrong type (an "IP" that needs no SPEC.md changes, or a "bug" that does), reclassify IP↔Bug: rewrite the body to the correct type's requirements, keep the index and filename, and state the reclassification in your final report.
- **Bug Reports only — code inspection carve-out.** You may inspect implementation code solely to confirm the report is on the right track. The report itself must still never prescribe fixes or reference code except as clearly-marked archival material.
- **On HALT** — flip `Stage: Accepted` (your spawn prompt confirms), and add a `ROUTE:` line to your report so the Orchestrator can route what follows:
  - IP → `ROUTE: SPEC changes` (Phase 4)
  - Bug needing TEST-SPEC.md changes → `ROUTE: TEST-SPEC changes` (Phase 6)
  - Bug needing only CERTIFICATIONS.md changes → `ROUTE: CERTIFICATIONS only` (Phase 7)
  - Bug needing neither → `ROUTE: neither` (harness fixes planned directly; Phase 9)
