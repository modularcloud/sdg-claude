# Reviewer mission — TEST-SPEC.md (Phase 6)

Target: `specs/TEST-SPEC.md` plus every `TEST-` module in `specs/modules/`. Bundle (per CLAUDE-PROCESS.md §6): SPEC.md with its modules (context), `specs/IMPLEMENTATION.md`, the relevant Bug Report (patch flow), `specs/tmp/TEST-SPEC-PROBLEMS.md` (if it exists).

Press hardest on:

- **Total coverage.** Every SPEC.md requirement and edge case — modules included — must have at least one blackbox E2E test; missing coverage is CRITICAL.
- **Blackbox purity.** Tests may rely only on the interfaces, contracts, seams, and observability behaviors defined in SPEC.md. Any test that assumes implementation internals is CRITICAL.
- **No requirement drift.** A test enforcing behavior SPEC.md does not require adds a requirement (CRITICAL); a softened or missing assertion removes one (CRITICAL).
- **Red-green compatibility.** The harness must be implementable and runnable before the product exists — tests fail red against a missing product rather than being unspecifiable or unrunnable.
- **Self-testing.** Certification against CERTIFICATIONS.md must be the primary self-test; internal self-tests only for harness behavior certification cannot exercise.
- **Negative and property-based testing.** SHOULD include negative tests and fuzz/property-based tests where appropriate — flag their absence where the behavior surface calls for them.
- **Third-party dependencies.** External hosted services are tested by simulation or against the real service (never production keys) when safe and reasonable to do so.
- **CI discipline.** SHOULD run in GitHub CI; tests that cannot run in CI must be specified as local-only tests, never skipped.
- **Module pairing.** Every spec module has a `TEST-` module that fully tests it — still entering through the whole product's E2E surface, and never testing requirements outside its module. Flag unpaired or overreaching modules.
- **Bug Report fidelity (patch flow).** The suggested update must make the harness catch the reported failure.
- **Parallelism.** SHOULD allow multiple harness instances to run concurrently on the same machine.
