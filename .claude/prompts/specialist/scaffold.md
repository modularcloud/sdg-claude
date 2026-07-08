# Specialist mission — SCAFFOLD (Phase 8)

Context: everything after this phase is built by fresh-context Engineers — the package boundaries, wiring, and CI you leave behind are what orient them. Governing PROCESS.md sections: Phase 8, and Core Documents → IMPLEMENTATION.md.

Update the repository scaffolding per `specs/SPEC.md`, `specs/TEST-SPEC.md`, `specs/CERTIFICATIONS.md`, and `specs/IMPLEMENTATION.md`, if needed:

- The product and the test harness are distinct programs. Structure the project as a monorepo if the tech stack supports it.
- Directories, package boundaries, build/test/run wiring — no product or harness logic.
- GitHub Actions CI on the PR running the TEST-SPEC-required tests (local-only tests excluded per TEST-SPEC.md, never silently skipped).

Commit, push. Report what changed, or that nothing was needed.
