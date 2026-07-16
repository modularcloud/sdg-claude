#!/usr/bin/env node
// VIOL-VALID-CTRL violator executable (CERTIFICATIONS.md §VIOL-VALID-CTRL).
// The CONF-VALID conformer with exactly one behavioral deviation: the
// control-character rule of SPEC 1.4 is not enforced for code points outside
// the whitespace class — segments and tags containing U+0000–U+0008,
// U+000E–U+001F, or U+007F are accepted as valid. Whitespace characters
// (U+0009–U+000D, U+0020) remain rejected in segments, and tag splitting is
// unchanged. Certifies T1.4-1, T1.4-4, and P-1 (C-1): exactly they fail
// against this fixture; every other §CONF-VALID in-scope test passes.
import { runXspec } from "./product.mjs";

const code = await runXspec(process.argv.slice(2), process.cwd(), {
  acceptNonWhitespaceControls: true,
});
process.exit(code);
