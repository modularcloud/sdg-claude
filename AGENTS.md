# AGENTS.md

Build, test, and run instructions for this repository (nothing else belongs in this file).

- Requires Node.js >= 22 and npm. Install dependencies: `npm ci`.
- One npm package (`xspec`) holding two distinct programs: the product under `src/` and the test harness under `test/`. The harness never imports product code; it drives the built `xspec` executable as a subprocess.
- Build the product: `npm run build` — compiles `src/` (TypeScript ESM, `src/tsconfig.json`) to `dist/`; the `xspec` bin is `dist/cli/bin.js`. Run it: `node dist/cli/bin.js`.
- Typecheck both programs: `npm run typecheck` (`src/tsconfig.json`, then `test/tsconfig.json`; the harness is not typechecked by Vitest at run time). `test/fixtures/` is excluded from the harness typecheck: fixture projects are data compiled or executed at test run time and may contain deliberate type errors (e.g. the S-4 fixture).
- Consumer fixture programs are compiled through the harness's TypeScript tooling driver (`test/helpers/tooling.ts`), which resolves `@types/node` from this repository's own `node_modules` — `npm ci` (dev dependencies included) must have run for consumer compilation to work.
- Full test suite (TEST-SPEC sections 1–17, certification included; the Linux CI leg): `npm test`. Build the product first — tests invoke the built executable.
- Running tests also requires the system `git` executable on PATH: harness fixtures script local git repositories (`test/helpers/workspace.ts`). No git configuration is needed — the builder isolates all ambient git config and identity.
- Harness self-tests and certification only (TEST-SPEC 17): `npm run test:self`.
- Windows-leg subset (TEST-SPEC E-6; run by the Windows CI job): `npm run test:windows`.
- Local-only suite (TEST-SPEC E-2; separately invocable, never run in CI, currently empty): `npm run test:local`.
- Property tests (TEST-SPEC 16; machinery in `test/helpers/property.ts`) run a fixed seed set by default — the CI mode, fully deterministic. To rerun with a specific seed: `XSPEC_PROPERTY_SEED=<uint32 from the failure message>`. Optional randomized local mode: `XSPEC_PROPERTY_SEED=random` (each property reports its seed for replay). Never set the variable in CI.
- Format code (Prettier, default config, `src/` and `test/` only): `npm run format`; verify: `npm run format:check`.
- CI: `.github/workflows/ci.yml` — harness-self (Linux), full suite (Linux, network disabled after setup via `.github/scripts/run-without-network.sh`), and the Windows E-6 leg on every pull request.
