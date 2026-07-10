// Hand-written, non-xspec fixture project for the S-4 self-test of the
// TypeScript tooling driver (TEST-SPEC 17 S-4; test/helpers/tooling.ts).
// S-4 pins exact offsets, lines, and columns in these files via substring
// markers — any edit here must keep test/self/s4-typescript-tooling.test.ts
// in step.

/** Builds the standard greeting for a name. */
export function greet(name: string): string {
  return `Hello, ${name}!`;
}
