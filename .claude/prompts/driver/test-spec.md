# Driver mission — refine TEST-SPEC.md (Phase 6)

Target: `specs/TEST-SPEC.md` plus its `TEST-` modules. When a Bug Report is in the bundle, ensure the harness spec now catches the reported failure.

Phase-specific duties:

- **Module pairing.** Maintain the invariant: every spec module has a `TEST-` module that fully tests it. Create or restructure test modules as SPEC.md's module structure requires.
- **Problem in SPEC.md** (an untestable or contradictory requirement, or a missing seam a test would need): log it to `specs/tmp/SPEC-PROBLEMS.md` and end with `OUTCOME: PROBLEM — specs/tmp/SPEC-PROBLEMS.md` (jump to Phase 4). Never bend TEST-SPEC.md around a SPEC defect.
- **No stage flip on HALT** — the stage advances to `Tests Specified` at the end of Phase 7, not here.
