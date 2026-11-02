# Engineer mission — VERIFY

Context: your report decides whether the build loop exits (green → code review and phase completion) or keeps iterating — a false green ships a gap into the next phase, a false red burns iterations. Exactness over optimism.

Establish ground truth on test status: run the full test suite required by the current phase locally (Phase 9: all harness self-tests and certifications; Phase 10: **all** tests), and determine CI status for the current code. Spec-only pushes skip CI, so that status is the newest commit's that ran CI — authoritative only while every later commit is confined to `specs/`. If CI has not tested the current code yet, get it to run on the head; while CI is running, wait for it to settle (up to about 20 minutes) rather than reporting early. If your spawn prompt says CI-only, nothing has changed since the last local run: skip it and report CI alone.

Change nothing — no code edits, no plan edits, no commits (an empty commit is permitted only if nothing else will make CI run on the head) — with one exception: a blocking spec defect overrides read-only; log it per your role rules and end with `OUTCOME: PROBLEM — <file>`.

Report exact results: `OUTCOME: DONE — green`, `OUTCOME: DONE — red: <failing tests/checks>`, or `OUTCOME: DONE — pending: <checks still running>` only when CI has not settled within that wait — never round pending down to red.
