# Observer — tracker (progress telemetry)

Selected via `observer: tracker` in `.claude/sdg-config.md`. Streams run progress to an external dashboard. Strictly fail-open: emission must never block, delay, retry-loop, or alter the process — if the endpoint is unreachable or misconfigured, note it once as an anomaly and continue without further mention.

## Transport

Events are JSON, POSTed fire-and-forget by the Orchestrator (e.g. `curl -m 5 -X POST "$SDG_OBSERVER_URL" -H "content-type: application/json" -H "authorization: Bearer $SDG_OBSERVER_TOKEN" -d @-`). Endpoint and token come from the environment: `SDG_OBSERVER_URL` (required) and `SDG_OBSERVER_TOKEN` (optional). If `SDG_OBSERVER_URL` is unset, the observer is dormant — emit nothing, mention nothing.

## Event schema (v1 — the dashboard's ingest contract)

```json
{
  "v": 1,
  "run": "<owner/repo#branch>",
  "ts": "<ISO 8601>",
  "kind": "status | summary",
  "event": "<see below>",
  "phase": 0,
  "patch": "<specs/patches/... or null>",
  "iteration": null,
  "summary": "<prose — kind: summary only>",
  "ask": "<pending question text — event: blocked only>"
}
```

## Events

**Status** — constructed and sent by the Orchestrator directly from its own bookkeeping (no content, no judgment):

- `phase-start` — entering a phase
- `iteration` — a refinement or build round completed (`iteration` = count)
- `answered` — a pending ASK was answered; work resumed
- `recovered` — an agent was revived or replaced after an infrastructure failure
- `session-resume` — Phase 0 resumed an interrupted run

**Summary** — composed by a forked Observer subagent, relayed verbatim by the Orchestrator:

- `phase-complete` — what the phase produced
- `blocked` — an ASK was posted; the question rides verbatim in `ask`
- `problem-jump` — a refinement was reverted; which document and why, in one sentence
- `run-complete` — the run finished; overall summary

In workflow engineering mode, Phases 9–10 emit at invocation boundaries (`phase-start`, then `phase-complete` or the blocked/problem exit); intra-run progress is visible in the workflow UI.

## Observer fork (summary events)

Spawn a fork: "Read `.claude/prompts/modes/observers/tracker.md` and act as Observer for event `<event>`, phase `<n>`." The fork inherits the conversation, so it has the context to summarize truthfully. Compose `summary` as one to three plain-language sentences a Developer glancing at a dashboard wants: what was done, notable decisions, what happens next — no process jargon (phase numbers and paths ride in the structured fields, not the prose). Return ONLY the JSON event payload, nothing else; the Orchestrator posts it verbatim. Touch no files; never address Developer; if you cannot see the conversation, return the payload with `"summary": "unavailable"` rather than inventing one.
