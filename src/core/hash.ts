// Hashing primitive.
//
// SPEC 5.5: each requirement node's four hashes are deterministic for
// identical input, and hash inputs are framed so that distinct sequences of
// components (runs, identities, hashes) never yield the same input.
// IMPLEMENTATION "Hashing": SHA-256 from node:crypto, hex-encoded, with
// length-prefixed component framing to make hash inputs injective.

import { createHash } from "node:crypto";

const encoder = new TextEncoder();

/**
 * SHA-256, hex-encoded, of a component sequence under injective framing:
 * each component contributes an 8-byte big-endian byte-length prefix followed
 * by its bytes (strings enter as UTF-8). The framed input parses back to
 * exactly one component sequence, so distinct sequences — different splits,
 * orderings, or arities included — never yield the same hash input
 * (SPEC 5.5). Composite structures hash their parts first and pass the hex
 * digests as components, which framing keeps distinct from raw content.
 */
export function hashComponents(
  components: readonly (string | Uint8Array)[],
): string {
  const hash = createHash("sha256");
  const prefix = new Uint8Array(8);
  const prefixView = new DataView(prefix.buffer);
  for (const component of components) {
    const bytes =
      typeof component === "string" ? encoder.encode(component) : component;
    prefixView.setBigUint64(0, BigInt(bytes.length));
    hash.update(prefix);
    hash.update(bytes);
  }
  return hash.digest("hex");
}
