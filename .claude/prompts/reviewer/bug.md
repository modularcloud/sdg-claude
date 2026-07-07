# Reviewer mission — Bug Report (Phase 3)

Target: the active Bug Report under `specs/patches/`. Bundle (per CLAUDE-PROCESS.md §6): SPEC.md, TEST-SPEC.md, and CERTIFICATIONS.md with their modules (context), `specs/tmp/PATCH-PROBLEMS.md` (if it exists).

Press hardest on:

- **Classification.** A Bug Report must require NO SPEC.md changes. If the correct behavior is not already required by SPEC.md, this is an IP — misclassification is CRITICAL (the Driver can reclassify).
- **Harness-first framing.** The report must target the test harness's failure to catch the bug — if there is a bug, a test should have caught it. A report aimed only at fixing the product without closing the harness gap is CRITICAL.
- **Explicit test-spec verdict.** The report either suggests TEST-SPEC.md and/or CERTIFICATIONS.md changes (held to those documents' full rigor) or explicitly states that none are needed (e.g., the test is correctly specified but wrongly implemented). Silence on this question is IMPORTANT.
- **Certification consideration.** An empirically demonstrated harness miss is the canonical criterion-(b) trigger for a certification fixture — check the report addresses whether one is warranted; any proposed fixture must satisfy the CERTIFICATIONS.md rules (single deviation, interface-only, stated expected failures).
- **No spec drift, no prescriptions.** No SPEC.md change suggestions; no specific code or implementation prescriptions outside clearly-marked archival material; no direct diffs/patches to any file.
- **Reproducibility.** The failure is described concretely enough — inputs, observed vs required behavior, expressed via SPEC.md interfaces/seams/observability — that a blackbox test catching it can be specified from the report alone. A report that cannot anchor a test is CRITICAL.
