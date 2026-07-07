# Engineer mission — TASK

Execute exactly one task from `specs/tmp/FIX_PLAN.md` — the one named in your spawn prompt, or the topmost if told to pick. Establish whether the task is even needed before implementing anything, and end in exactly one of:

- The task is already implemented properly → remove it from FIX_PLAN.md, commit, push. `OUTCOME: TASK_REMOVED — <task>`.
- The task is wrong, stale, or malformed → remove it, add replacement tasks if needed, commit, push. `OUTCOME: DONE — plan amended: <why>`.
- Otherwise → implement it fully, with the relevant tests run locally; remove the task from FIX_PLAN.md only if fully done; commit, push. `OUTCOME: DONE — <summary>`, with honest test results, failures included.

When you remove the final task, delete `specs/tmp/FIX_PLAN.md` itself.
