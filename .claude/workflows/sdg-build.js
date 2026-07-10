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

const COMMON = { problem: { type: 'string' }, question: { type: 'string' } }
const UNITS = { type: 'object', required: ['units'], properties: { ...COMMON, units: { type: 'array', items: { type: 'object', required: ['id', 'title', 'brief', 'files', 'sharedCore'], properties: { id: { type: 'string' }, title: { type: 'string' }, brief: { type: 'string' }, files: { type: 'array', items: { type: 'string' } }, sharedCore: { type: 'boolean' } } } } } }
const DONE = { type: 'object', required: ['done', 'summary'], properties: { ...COMMON, done: { type: 'boolean' }, summary: { type: 'string' } } }
const PANEL = { type: 'object', required: ['compliant'], properties: { ...COMMON, compliant: { type: 'boolean' }, gaps: { type: 'array', items: { type: 'object', required: ['citation', 'shortfall'], properties: { citation: { type: 'string' }, shortfall: { type: 'string' } } } } } }
const VERIFY = { type: 'object', required: ['status'], properties: { ...COMMON, status: { enum: ['green', 'red', 'pending'] }, failures: { type: 'array', items: { type: 'string' } } } }
const TRIAGE = { type: 'object', required: ['clean'], properties: { ...COMMON, clean: { type: 'boolean' }, accepted: { type: 'array', items: { type: 'string' } } } }

// PROBLEM/QUESTION exits ride on the structured returns; the Orchestrator handles them outside.
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
  const x = bail([r].filter(Boolean)); if (x) return x
}
const par = dec.units.filter(u => !u.sharedCore)
if (par.length) {
  const rs = await parallel(par.map(u => () => agent(implPrompt(u) + '\n- you are in an isolated worktree: commit to your current branch and do NOT push; integration merges you', { agentType: 'sdg-engineer', schema: DONE, isolation: 'worktree', phase: 'Implement', label: `impl:${u.id}` })))
  const x = bail(rs); if (x) return x
  const ri = await agent(MISSION('engineer/integrate.md', `- merge the unit branches from the ${par.length} parallel worktrees just completed`), { agentType: 'sdg-engineer', schema: DONE, phase: 'Implement', label: 'integrate' })
  const x2 = bail([ri].filter(Boolean)); if (x2) return x2
}

// ---------- Converge, then Review; exit only when the completion standard holds AND review is clean
let rounds = 0
while (true) {
  if (++rounds > 30) return { status: 'stalled', evidence: `no convergence after ${rounds - 1} rounds` }
  const checks = await parallel([
    ...MODULES.map(m => () => agent(`Mission file: .claude/prompts/specialist/compliance-review.md\nParameters:\n- phase: ${P}\n- scope: ${m}`, { agentType: 'sdg-specialist', schema: PANEL, phase: 'Converge', label: `panel:${m.split('/').pop()}` })),
    () => agent(`Mission file: .claude/prompts/specialist/compliance-review.md\nParameters:\n- phase: ${P}\n- scope: the core documents`, { agentType: 'sdg-specialist', schema: PANEL, phase: 'Converge', label: 'panel:core' }),
    () => agent(MISSION('engineer/verify.md'), { agentType: 'sdg-engineer', schema: VERIFY, phase: 'Converge', label: 'verify' }),
  ])
  const live = checks.filter(Boolean)
  const x = bail(live); if (x) return x
  const verify = live.find(r => r.status)
  const gaps = live.flatMap(r => r.gaps || [])
  if (verify && verify.status === 'red') gaps.push(...(verify.failures || []).map(f => ({ citation: 'failing test/check', shortfall: f })))

  if (!gaps.length && verify && verify.status === 'green') {
    // Completion standard holds — review gate.
    const t = await agent(`Mission file: .claude/prompts/specialist/code-review-triage.md\nParameters:\n- phase: ${P}\n- stage flip when clean: ${args.stageFlip || 'none'}`, { agentType: 'sdg-specialist', schema: TRIAGE, phase: 'Review', label: 'triage' })
    if (!t) return { status: 'stalled', evidence: 'triage agent died' }
    const xt = bail([t]); if (xt) return xt
    if (t.clean) return { status: 'success' }
    for (const c of t.accepted) {
      const r = await agent(MISSION('engineer/fix.md', `- accepted review comment (reply on its thread and resolve it when done):\n${c}`), { agentType: 'sdg-engineer', schema: DONE, phase: 'Review', label: 'fix:review' })
      const xr = bail([r].filter(Boolean)); if (xr) return xr
    }
    continue // re-establish the standard after review fixes
  }

  if (!gaps.length) { log(`round ${rounds}: checks ${verify ? verify.status : 'unknown'} — re-checking`); continue }
  log(`round ${rounds}: ${gaps.length} gaps`)
  for (const g of gaps) {
    const r = await agent(MISSION('engineer/fix.md', `- requirement: ${g.citation}\n- shortfall: ${g.shortfall}`), { agentType: 'sdg-engineer', schema: DONE, phase: 'Converge', label: 'fix' })
    const xr = bail([r].filter(Boolean)); if (xr) return xr
  }
}
