export const meta = {
  name: 'sdg-build',
  description: 'SDG engineering phase: build to full conformance (phase 9 harness / phase 10 product)',
  phases: [
    { title: 'Decompose', detail: 'derive self-contained work units from specs vs code' },
    { title: 'Implement', detail: 'core units sequentially, disjoint units in parallel worktrees, then integrate' },
    { title: 'Converge', detail: 'compliance panels + full verification until the completion standard holds' },
    { title: 'Review', detail: 'resolve code review, re-converge, exit clean' },
  ],
}

// args: { phase: 9|10, modules: string[], patchFixes?: string, stageFlip?: string }
const P = args.phase
const MODULES = args.modules || []
const MISSION = (path, extra) => `Mission file: .claude/prompts/${path}\nParameters:\n- phase: ${P}${extra ? '\n' + extra : ''}`

// Engineers never ask Developer (PROCESS.md), so only Specialist returns may carry a question.
const PROBLEM = { problem: { type: 'string' } }
const QUESTION = { question: { type: 'string' } }
const UNITS = { type: 'object', required: ['units'], properties: { ...PROBLEM, units: { type: 'array', items: { type: 'object', required: ['id', 'title', 'brief', 'files', 'sharedCore'], properties: { id: { type: 'string' }, title: { type: 'string' }, brief: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, sharedCore: { type: 'boolean' } } } } } }
const DONE = { type: 'object', required: ['done', 'summary'], properties: { ...PROBLEM, done: { type: 'boolean' }, summary: { type: 'string' } } }
const VERIFY = { type: 'object', required: ['status'], properties: { ...PROBLEM, status: { type: 'string', enum: ['green', 'red', 'pending'] }, failures: { type: 'array', items: { type: 'string' } } } }
const PANEL = { type: 'object', required: ['compliant'], properties: { ...PROBLEM, ...QUESTION, compliant: { type: 'boolean' }, gaps: { type: 'array', items: { type: 'object', required: ['citation', 'shortfall'], properties: { citation: { type: 'string' }, shortfall: { type: 'string' } } } } } }
const TRIAGE = { type: 'object', required: ['clean'], properties: { ...PROBLEM, ...QUESTION, clean: { type: 'boolean' }, accepted: { type: 'array', items: { type: 'string' } } } }

// PROBLEM/QUESTION exits ride on the structured returns; the Orchestrator handles them outside the run.
const bail = (results) => {
  for (const r of results.filter(Boolean)) {
    if (r.problem) return { status: 'problem', file: r.problem }
    if (r.question) return { status: 'question', block: r.question }
  }
  return null
}

// ---------- Decompose
phase('Decompose')
const fixesNote = args.patchFixes ? `\n- mandatory units (accepted Bug Report fixes, verbatim):\n${args.patchFixes}` : ''
const dec = await agent(MISSION('engineer/decompose.md', `- modules in scope: ${MODULES.join(', ') || 'none'}${fixesNote}`), { agentType: 'sdg-engineer', schema: UNITS, label: 'decompose' })
if (!dec) return { status: 'stalled', evidence: 'decompose agent died' }
{ const x = bail([dec]); if (x) return x }
log(`${dec.units.length} work units`)

// ---------- Implement
phase('Implement')
const implPrompt = (u) => MISSION('engineer/implement.md', `- unit: ${u.id} — ${u.title}\n- brief: ${u.brief}\n- files you own: ${u.files.join(', ')}`)
for (const u of dec.units.filter(u => u.sharedCore)) {
  const r = await agent(implPrompt(u), { agentType: 'sdg-engineer', schema: DONE, phase: 'Implement', label: `impl:${u.id}` })
  const x = bail([r]); if (x) return x
}
const par = dec.units.filter(u => !u.sharedCore)
if (par.length) {
  const rs = await parallel(par.map(u => () => agent(implPrompt(u) + '\n- you are in an isolated worktree: commit to your current branch and do NOT push; integration merges you', { agentType: 'sdg-engineer', schema: DONE, isolation: 'worktree', phase: 'Implement', label: `impl:${u.id}` })))
  const x = bail(rs); if (x) return x
  const ri = await agent(MISSION('engineer/integrate.md', `- merge the unit branches from the ${par.length} parallel worktrees just completed`), { agentType: 'sdg-engineer', schema: DONE, phase: 'Implement', label: 'integrate' })
  const x2 = bail([ri]); if (x2) return x2
}

// ---------- Converge, then Review: exit only when the completion standard holds AND review is clean
const PANELS = [
  ...MODULES.map(m => ({ scope: m, label: `panel:${m.split('/').pop()}` })),
  { scope: 'the core documents', label: 'panel:core' },
]
const panel = (p) => agent(`Mission file: .claude/prompts/specialist/compliance-review.md\nParameters:\n- phase: ${P}\n- scope: ${p.scope}`, { agentType: 'sdg-specialist', schema: PANEL, phase: 'Converge', label: p.label })
const verify = (ciOnly) => agent(MISSION('engineer/verify.md', ciOnly ? '- CI-only: nothing changed since your last local run; report CI status alone' : ''), { agentType: 'sdg-engineer', schema: VERIFY, phase: 'Converge', label: ciOnly ? 'verify:ci' : 'verify' })
const fix = (detail, ph) => agent(MISSION('engineer/fix.md', detail), { agentType: 'sdg-engineer', schema: DONE, phase: ph, label: ph === 'Review' ? 'fix:review' : 'fix' })

let rounds = 0
while (true) {
  if (++rounds > 30) return { status: 'stalled', evidence: `no convergence after ${rounds - 1} rounds` }
  const results = await parallel([...PANELS.map(p => () => panel(p)), () => verify(false)])
  { const x = bail(results); if (x) return x }
  const panels = results.slice(0, PANELS.length)
  let v = results[PANELS.length]
  // Waiting on CI never re-runs the panels: re-check CI alone (a dead verifier re-runs in full).
  for (let i = 0; i < 3 && (!v || v.status === 'pending'); i++) {
    v = await verify(Boolean(v))
    const x = bail([v]); if (x) return x
  }
  if (!v || v.status === 'pending') return { status: 'stalled', evidence: 'verification never settled (CI pending, or the verifier kept failing)' }

  const gaps = panels.flatMap(p => (p && p.gaps) || [])
  if (v.status === 'red') {
    const failures = v.failures && v.failures.length ? v.failures : ['verification red without itemized failures: investigate']
    gaps.push(...failures.map(f => ({ citation: 'failing test/check', shortfall: f })))
  }

  if (!gaps.length) {
    // The standard holds only on complete, affirmative verdicts: a dead or non-committal panelist establishes nothing.
    if (!panels.every(p => p && p.compliant)) { log(`round ${rounds}: incomplete compliance verdicts, re-auditing`); continue }
    const t = await agent(`Mission file: .claude/prompts/specialist/code-review-triage.md\nParameters:\n- phase: ${P}\n- stage flip when clean: ${args.stageFlip || 'none'}`, { agentType: 'sdg-specialist', schema: TRIAGE, phase: 'Review', label: 'triage' })
    if (!t) return { status: 'stalled', evidence: 'triage agent died' }
    { const x = bail([t]); if (x) return x }
    if (t.clean) return { status: 'success' }
    for (const c of t.accepted || []) {
      const r = await fix(`- accepted review comment (reply on its thread and resolve it when done):\n${c}`, 'Review')
      const x = bail([r]); if (x) return x
    }
    continue // re-establish the standard after review fixes
  }

  log(`round ${rounds}: ${gaps.length} gaps`)
  for (const g of gaps) {
    const r = await fix(`- requirement: ${g.citation}\n- shortfall: ${g.shortfall}`, 'Converge')
    const x = bail([r]); if (x) return x
  }
}
