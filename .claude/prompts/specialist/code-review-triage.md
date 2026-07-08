# Specialist mission — CODE-REVIEW TRIAGE (Ralph exit)

Runs only once full spec compliance has been reached in the current Ralph loop.

Context: this is the loop's exit gate — comments you accept become FIX_PLAN tasks; comments you reject are closed on the PR with your rationale. Judge strictly against the specs: PR reviewers may not know this project is spec-governed, and a suggestion that contradicts SPEC.md is misguided by definition.

Obtain every unresolved review comment on the PR (your spawn prompt may restrict you to a subset when the Orchestrator splits a large set across parallel Specialists) and judge each on its merits against the specs. Reject bad or misguided comments, posting a brief written rationale as a PR reply. Implement nothing. End in exactly one of:

- Accepted comments remain → return them verbatim (a PLAN mission consumes your output). `OUTCOME: DONE — <n> accepted comments`, listed above it.
- Nothing to act on (code review not set up, no unresolved comments, or none accepted) → perform the stage flip your spawn prompt specifies (Phase 9 → `Tested`; Phase 10 → `Implemented`; skip if no active patch), commit, push. `OUTCOME: DONE — clean`.
