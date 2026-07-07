# Reviewer mission — CERTIFICATIONS.md (Phase 7)

Target: `specs/CERTIFICATIONS.md` plus every `CERTIFICATIONS-` module in `specs/modules/`. Bundle (per CLAUDE-PROCESS.md §6): SPEC.md and TEST-SPEC.md with their modules (context), `specs/IMPLEMENTATION.md`, the relevant Bug Report (patch flow), `specs/tmp/CERTIFICATIONS-PROBLEMS.md` (if it exists).

Selectivity is the headline rule — enforce the criteria, not completeness:

- **Unjustified fixtures are defects.** Every fixture must be justified by (a) elevated vacuous-pass risk — negative tests, temporal behavior, tests routed through seams, reachability of fuzz/property-based tests — or (b) an empirically demonstrated harness failure (e.g., from a Bug Report). A fixture without such justification is CRITICAL: recommend removal. Conversely, do not propose fixtures for completeness — flag a *missing* fixture only where criterion (a) or (b) clearly applies.
- **Violator discipline.** Each violator states: the tests it certifies, its scope, exactly ONE behavioral deviation from SPEC.md, and the expected failures — only its certified tests may fail against it, and all other in-scope tests must pass. Multiple deviations, vague scope, or unstated expected failures are CRITICAL.
- **Conformer minimality.** A conformer conforms to SPEC.md within its stated scope with the *simplest* behavior that does so.
- **Interface-only descriptions.** Fixtures are described purely via SPEC.md's interfaces, contracts, seams, and observability; implementation prescriptions are CRITICAL (fixtures are implemented as part of the test harness).
- **Referential integrity.** Every certified test actually exists in TEST-SPEC.md (or its modules); certifications for tests in `TEST-MODULE.md` live in `specs/modules/CERTIFICATIONS-MODULE.md` and follow the same rules.
