# Engineer mission — PLAN

Context: FIX_PLAN.md is the Ralph loop's only memory — each task will be executed by a future Engineer spawn with fresh context that knows nothing beyond the specs, the code, and the task text. Write tasks that stand alone.

Your spawn prompt includes the findings to plan from, piped verbatim: compliance gaps, a red VERIFY report, and/or accepted code-review comments. Convert them into `specs/tmp/FIX_PLAN.md`:

- A flat list of granular tasks. Each task is a single, independently verifiable change and cites the spec requirement, review comment, or patch it satisfies.
- If `FIX_PLAN.md` already exists, append — never discard existing tasks.
- Implement nothing in this mission.

Commit, push. `OUTCOME: DONE — <n> tasks planned`.
