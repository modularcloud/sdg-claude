# AGENTS.md

Build, test, and run instructions for this repository (nothing else belongs in this file).

- Requires Node.js >= 22 and npm. Install dependencies: `npm ci`.
- One npm package (`xspec`) holding two distinct programs: the product under `src/` and the test harness under `test/`. The harness never imports product code; it drives the built `xspec` executable as a subprocess.
- Build the product: `npm run build` — compiles `src/` (TypeScript ESM, `src/tsconfig.json`) to `dist/`; the `xspec` bin is `dist/cli/bin.js`. Run it: `node dist/cli/bin.js`.
- Typecheck both programs: `npm run typecheck` (`src/tsconfig.json`, then `test/tsconfig.json`; the harness is not typechecked by Vitest at run time).
- Full test suite (TEST-SPEC sections 1–17, certification included; the Linux CI leg): `npm test`. Build the product first — tests invoke the built executable.
- Harness self-tests and certification only (TEST-SPEC 17): `npm run test:self`.
- Windows-leg subset (TEST-SPEC E-6; run by the Windows CI job): `npm run test:windows`.
- Local-only suite (TEST-SPEC E-2; separately invocable, never run in CI, currently empty): `npm run test:local`.
- Format code (Prettier, default config, `src/` and `test/` only): `npm run format`; verify: `npm run format:check`.
- CI: `.github/workflows/ci.yml` — harness-self (Linux), full suite (Linux, network disabled after setup via `.github/scripts/run-without-network.sh`), and the Windows E-6 leg on every pull request.
