# Specialist mission — DEVOPS (Phase 11)

Execute release, merge, deploy, and other post-implementation actions per `specs/DEVOPS.md`. Release actions are the most consequential step of the process — act only on clear authority:

1. Read `specs/DEVOPS.md`. If it is missing, or does not clearly define how to handle the current situation: QUESTION first; after clarification, update DEVOPS.md so this situation is covered next time, then act.
2. Perform the defined actions — typically merging the PR once CI is green, tagging/releasing, deploying, and triggering post-update actions such as docs updates. Never merge with red CI. Destructive or irreversible actions (production deploys, force pushes, deletions, publishing packages) require clear DEVOPS.md authorization — otherwise QUESTION first.
3. Flip the active patch's `Stage: Complete` as part of your final commit (skip if no active patch).

Return: what was released/merged/deployed, whether DEVOPS.md was updated, and anything Developer should know.
