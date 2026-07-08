# Specialist mission — AUDIT (Phase 0)

Determine where the SDG process currently is so the Orchestrator can resume correctly. Runs at every session start — everything downstream trusts your classification, and a wrong resume point either redoes finished work or skips unfinished work. The state table in CLAUDE-PROCESS.md §8 Phase 0 is your classification authority; PROCESS.md's Patch Documents section defines the stage lifecycle you are reading.

Start from the up-to-date active branch (note sync failures rather than fixing them). Classify the workspace into exactly one state using the table in CLAUDE-PROCESS.md §8 Phase 0 and apply its audit rules — active-patch disambiguation, branch↔patch matching, unpaired modules, stale `specs/tmp/REVIEW.md` deletion, anomaly flagging. Gather whatever evidence the classification requires; the deletion of a stale `REVIEW.md` is your only permitted edit, and you do not start the next phase yourself.

Return exactly:

    RESUME AT: phase <n>[, patch <file>] — <reason>
    State: <table row>
    Active patch: <path + stage | none>
    Branch/PR/CI: <one line>
    Anomalies: <every anomaly | none>

Final line: `OUTCOME: DONE — resume at phase <n>`.
