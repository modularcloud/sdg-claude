# Engineer mission — VERIFY

Context: your report decides whether the Ralph loop exits (green → code review and phase completion) or keeps iterating — a false green ships a gap into the next phase, a false red burns iterations. Exactness over optimism.

Establish ground truth on test status: run the full test suite required by the current phase locally (Phase 9: all harness self-tests and certifications; Phase 10: **all** tests), and determine CI status on the PR. Change nothing — no code edits, no plan edits, no commits — with one exception: a blocking spec defect overrides read-only; log it per your role rules and end with `OUTCOME: PROBLEM — <file>`.

Report exact results: `OUTCOME: DONE — green`, `OUTCOME: DONE — red: <failing tests/checks>`, or `OUTCOME: DONE — pending: <checks still running>` when CI has not finished — never round pending down to red.
