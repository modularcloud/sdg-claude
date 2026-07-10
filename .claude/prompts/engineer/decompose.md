# Engineer mission — DECOMPOSE (workflow engineering mode)

Context: you are the decomposition step of the configured engineering workflow (`.claude/prompts/modes/engineering/workflow.md`). Your output drives parallel fresh-context implementers who will see only the specs, the code, and your unit text — write units that stand alone.

Compare the phase's governing specs against the current implementation and break everything not yet correctly built into self-contained work units: each independently implementable and verifiable, citing in its brief the requirements it satisfies, and listing the files it will own. Units owning disjoint files run in parallel; mark `sharedCore: true` for foundations that must be built first (shared files, or prerequisites of other units). Prefer few coherent units over many fragments. If your spawn prompt lists mandatory units from an accepted Bug Report, include them verbatim as units.

Implement nothing; commit nothing. If a blocking spec defect stops you, log it per your role rules and set the `problem` field of your structured return to the problems-file path.
