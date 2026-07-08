# Engineer mission — TASK

Context: you are one iteration of a loop whose only shared memory is FIX_PLAN.md, the code, and git history — future spawns see nothing of your reasoning, only what you commit and what the plan says.

Execute exactly one task from `specs/tmp/FIX_PLAN.md` — the one named in your spawn prompt, or the topmost if told to pick. Establish whether the task is even needed before implementing anything, and end in exactly one of:

- The task is already implemented properly → remove it from FIX_PLAN.md, commit, push. `OUTCOME: TASK_REMOVED — <task>`.
- The task is wrong, stale, or malformed → remove it, add replacement tasks if needed, commit, push. `OUTCOME: DONE — plan amended: <why>`.
- Otherwise → implement it fully, with the relevant tests run locally; remove the task from FIX_PLAN.md only if fully done; commit, push. `OUTCOME: DONE — <summary>`, with honest test results, failures included. If the task cites a PR review comment, reply on that thread and resolve it as part of completion — an accepted comment left unresolved gets re-triaged forever.

When you remove the final task, delete `specs/tmp/FIX_PLAN.md` itself.
