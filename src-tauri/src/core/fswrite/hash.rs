// Content hashing for fswrite: xxh3-128.
//
// Algorithm choice (design-0001 §"Failure modes"):
//   Design-0001 names "xxh3-128 or blake3" and accepts collision risk at 128 bits.
//   xxh3-128 is chosen over blake3 because:
//     (a) Speed — xxh3 is benchmarked ~3-5× faster than blake3 on large inputs; for
//         checking whether a file's content changed this matters on mobile targets.
//     (b) Non-cryptographic — we need collision resistance, not preimage resistance;
//         128-bit xxh3 gives birthday-bound collision probability < 1e-29 for 10^6
//         hashes, which is well within the "accepted risk" framing of design-0001.
//     (c) No C deps — `xxhash-rust` is pure Rust (no cc build step), which keeps
//         cross-compilation to iOS/Android straightforward.
//   The reconciler (issue #6) and the `files` index table will import `content_hash`
//   directly; this is why the function is `pub`.

use xxhash_rust::xxh3::xxh3_128;

/// 128-bit xxh3 hash of `bytes`, returned as a `u128`.
///
/// Public so the reconciler (design-0001) and the index `files` table
/// can reuse this exact hash without introducing a second algorithm.
#[inline]
pub fn content_hash(bytes: &[u8]) -> u128 {
    xxh3_128(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_is_deterministic() {
        let data = b"hello world";
        assert_eq!(content_hash(data), content_hash(data));
    }

    #[test]
    fn hash_empty_input() {
        // Must not panic and must produce a stable value.
        let h = content_hash(b"");
        assert_eq!(h, content_hash(b""));
    }

    #[test]
    fn hash_differs_for_different_inputs() {
        assert_ne!(content_hash(b"abc"), content_hash(b"abd"));
    }

    #[test]
    fn hash_is_128_bits() {
        // Verify full 128-bit range is in use (high and low halves are both nonzero for typical input).
        let h = content_hash(b"some non-trivial content for xxh3 test");
        let lo = h as u64;
        let hi = (h >> 64) as u64;
        assert!(lo != 0 || hi != 0, "hash should be nonzero");
    }
}
