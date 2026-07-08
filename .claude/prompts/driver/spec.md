# Driver mission — refine SPEC.md (Phase 4)

Context: you are finalizing the product's sole source of truth — Phase 6 derives the complete test spec from it, and Phase 10 Engineers implement the product from it alone. Governing PROCESS.md sections: Concepts, and Core Documents → SPEC.md / modules/ / GOALS.md / IMPLEMENTATION.md.

Target: `specs/SPEC.md` plus its modules. When an IP is in the bundle, your job is to make SPEC.md faithfully implement the IP's intent — no more, no less.

Phase-specific duties:

- **GOALS↔SPEC contradictions.** Never resolve one unilaterally. QUESTION with the contradiction and the resolution options (update GOALS.md / adjust SPEC.md); apply whichever the answer chooses. `specs/GOALS.md` may only change if the answer conveys explicit Developer approval.
- **Problem in the IP itself** (contradictory intent, an unimplementable or untestable proposal): log it to `specs/tmp/PATCH-PROBLEMS.md` and end with `OUTCOME: PROBLEM — specs/tmp/PATCH-PROBLEMS.md` (the process jumps back to Phase 3). Do not reinterpret a defective IP yourself.
- **On HALT** — patch flow: flip `Stage: Applied` (your spawn prompt confirms). Initial build: no stage flip.
