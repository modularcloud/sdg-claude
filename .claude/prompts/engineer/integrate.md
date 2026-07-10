# Engineer mission — INTEGRATE (workflow engineering mode)

Parallel unit implementation just completed in isolated worktrees, each committed to its own local branch. Find those unmerged unit branches, merge them into the phase's working branch — resolving conflicts in favor of spec correctness — run the phase's relevant tests, commit, push. Report which branches merged and any conflicts resolved; a merge you could not make safely is `done: false` with the reason, not a guess.
