// Self-write token registry.
//
// Design reference:
//   docs/tech/design-0001-index-and-reconciliation.md §"Interfaces":
//     "Self-originated writes carry a token so the reconciler can skip re-notifying
//      the originating view."
//   docs/tech/design-0004-ipc-boundary.md §"Self-write token":
//     "write_entry returns the token recorded by the reconciler (design-0001) so the
//      originating view ignores its own echo while other views still refresh."
//
// Token semantics:
//   - Issued with `issue_token(path)` → returns an opaque `WriteToken`.
//   - Internally recorded: (path, content_hash, issued_at).
//   - The reconciler calls `consume_if_match(path, content_hash)` when it sees a file
//     event for `path`.  Returns `true` (and removes the record) when the hash matches
//     a pending token that has not expired.  Returns `false` otherwise.
//   - Single-consume: a token is removed on the first matching consume call.
//   - Expiry: tokens older than the configured TTL (default 10 seconds) are never matched
//     and are lazily pruned on the next registry operation.
//
// Thread safety: `TokenRegistry` wraps a `Mutex`-protected table so the reconciler
// (running on a background thread) and the write path (any thread) can safely share it.
//
// The `WriteToken` value is an opaque handle returned to the caller.  It carries no
// sensitive information; it is safe to send across IPC (it's a u64 sequence number).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::core::fswrite::hash::content_hash;

/// Default TTL for a self-write token.
pub const DEFAULT_TOKEN_TTL: Duration = Duration::from_secs(10);

/// Opaque token returned by `issue_token`.
///
/// Safe to serialize and send to the UI layer; the UI echoes it back so the reconciler
/// can call `consume_if_match` with the matching content hash.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct WriteToken(u64);

impl WriteToken {
    /// Raw sequence number (for IPC serialization).
    pub fn as_u64(self) -> u64 {
        self.0
    }
}

impl std::fmt::Display for WriteToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "WriteToken({})", self.0)
    }
}

/// A thread-safe registry of pending self-write tokens.
pub struct TokenRegistry {
    ttl: Duration,
    inner: Mutex<RegistryInner>,
}

struct RegistryInner {
    next_seq: u64,
    // keyed by canonical path string for cross-thread send safety
    records: HashMap<PathBuf, Vec<TokenRecord>>,
}

struct TokenRecord {
    // Stored for future use (e.g. listing pending tokens by ID for diagnostics).
    #[allow(dead_code)]
    token: WriteToken,
    content_hash: u128,
    issued_at: Instant,
}

impl TokenRegistry {
    /// Create a registry with the given TTL.
    pub fn new(ttl: Duration) -> Self {
        TokenRegistry {
            ttl,
            inner: Mutex::new(RegistryInner {
                next_seq: 1,
                records: HashMap::new(),
            }),
        }
    }

    /// Create a registry with `DEFAULT_TOKEN_TTL`.
    pub fn with_default_ttl() -> Self {
        Self::new(DEFAULT_TOKEN_TTL)
    }

    /// Issue a token for `path` with `bytes` as the content being written.
    ///
    /// The token is recorded; call `consume_if_match` from the reconciler when
    /// the corresponding file event arrives.
    pub fn issue_token(&self, path: &Path, bytes: &[u8]) -> WriteToken {
        let hash = content_hash(bytes);
        let mut guard = self.inner.lock().expect("token registry mutex poisoned");
        let token = WriteToken(guard.next_seq);
        guard.next_seq += 1;
        guard
            .records
            .entry(path.to_path_buf())
            .or_default()
            .push(TokenRecord {
                token,
                content_hash: hash,
                issued_at: Instant::now(),
            });
        token
    }

    /// Test whether a pending token matches `(path, content_bytes)`.
    ///
    /// Returns `true` and removes the matching record when:
    ///   - There is a pending token for `path` whose `content_hash` matches `bytes`.
    ///   - That token was issued within the registry's TTL.
    ///
    /// Returns `false` if no match is found (this was an external edit).
    ///
    /// Lazily expires stale tokens on every call.
    pub fn consume_if_match(&self, path: &Path, bytes: &[u8]) -> bool {
        let hash = content_hash(bytes);
        let now = Instant::now();
        let ttl = self.ttl;
        let mut guard = self.inner.lock().expect("token registry mutex poisoned");
        let records = match guard.records.get_mut(path) {
            Some(v) => v,
            None => return false,
        };

        // Prune expired first.
        records.retain(|r| now.duration_since(r.issued_at) <= ttl);

        // Find first matching hash.
        if let Some(pos) = records.iter().position(|r| r.content_hash == hash) {
            records.remove(pos);
            if records.is_empty() {
                guard.records.remove(path);
            }
            return true;
        }
        false
    }

    /// Number of pending (non-expired) tokens across all paths.  For testing only.
    #[cfg(test)]
    pub fn pending_count(&self) -> usize {
        let now = Instant::now();
        let ttl = self.ttl;
        let guard = self.inner.lock().expect("token registry mutex poisoned");
        guard
            .records
            .values()
            .flat_map(|v| v.iter())
            .filter(|r| now.duration_since(r.issued_at) <= ttl)
            .count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn p(s: &str) -> PathBuf {
        PathBuf::from(s)
    }

    #[test]
    fn issue_returns_unique_tokens() {
        let reg = TokenRegistry::with_default_ttl();
        let t1 = reg.issue_token(&p("/a/b.md"), b"content1");
        let t2 = reg.issue_token(&p("/a/b.md"), b"content2");
        assert_ne!(t1, t2);
    }

    #[test]
    fn consume_matches_correct_hash() {
        let reg = TokenRegistry::with_default_ttl();
        reg.issue_token(&p("/notes/a.md"), b"hello");
        assert!(reg.consume_if_match(&p("/notes/a.md"), b"hello"));
    }

    #[test]
    fn consume_returns_false_for_wrong_content() {
        let reg = TokenRegistry::with_default_ttl();
        reg.issue_token(&p("/notes/a.md"), b"hello");
        assert!(!reg.consume_if_match(&p("/notes/a.md"), b"different content"));
    }

    #[test]
    fn consume_returns_false_for_wrong_path() {
        let reg = TokenRegistry::with_default_ttl();
        reg.issue_token(&p("/notes/a.md"), b"hello");
        assert!(!reg.consume_if_match(&p("/notes/b.md"), b"hello"));
    }

    #[test]
    fn token_is_single_consume() {
        let reg = TokenRegistry::with_default_ttl();
        reg.issue_token(&p("/notes/a.md"), b"hello");
        assert!(reg.consume_if_match(&p("/notes/a.md"), b"hello"));
        // Second consume must return false.
        assert!(!reg.consume_if_match(&p("/notes/a.md"), b"hello"));
    }

    #[test]
    fn multiple_tokens_for_same_path() {
        let reg = TokenRegistry::with_default_ttl();
        reg.issue_token(&p("/notes/a.md"), b"v1");
        reg.issue_token(&p("/notes/a.md"), b"v2");
        assert_eq!(reg.pending_count(), 2);
        assert!(reg.consume_if_match(&p("/notes/a.md"), b"v1"));
        assert_eq!(reg.pending_count(), 1);
        assert!(reg.consume_if_match(&p("/notes/a.md"), b"v2"));
        assert_eq!(reg.pending_count(), 0);
    }

    #[test]
    fn token_expires_after_ttl() {
        // Use a very short TTL (1ms) so we can test expiry without sleeping long.
        let reg = TokenRegistry::new(Duration::from_millis(1));
        reg.issue_token(&p("/notes/a.md"), b"hello");

        // Spin until 2ms have passed.
        let start = Instant::now();
        while start.elapsed() < Duration::from_millis(2) {
            std::hint::spin_loop();
        }

        // Expired token must not match.
        assert!(!reg.consume_if_match(&p("/notes/a.md"), b"hello"));
    }

    #[test]
    fn pending_count_zero_after_all_consumed() {
        let reg = TokenRegistry::with_default_ttl();
        reg.issue_token(&p("/a.md"), b"x");
        reg.issue_token(&p("/b.md"), b"y");
        reg.consume_if_match(&p("/a.md"), b"x");
        reg.consume_if_match(&p("/b.md"), b"y");
        assert_eq!(reg.pending_count(), 0);
    }

    #[test]
    fn write_token_as_u64_roundtrips() {
        let t = WriteToken(42);
        assert_eq!(t.as_u64(), 42);
    }

    #[test]
    fn concurrent_issue_and_consume() {
        // Smoke test: many threads issuing and consuming must not deadlock or panic.
        use std::sync::Arc;

        let reg = Arc::new(TokenRegistry::with_default_ttl());
        let n = 8usize;
        let mut handles = Vec::with_capacity(n * 2);

        for i in 0..n {
            let r = Arc::clone(&reg);
            let path = format!("/notes/{i}.md");
            handles.push(std::thread::spawn(move || {
                let content = format!("content{i}");
                let p = PathBuf::from(&path);
                r.issue_token(&p, content.as_bytes());
            }));
        }
        for h in handles.drain(..) {
            h.join().expect("thread panicked");
        }

        // Now consume all.
        for i in 0..n {
            let r = Arc::clone(&reg);
            let path = format!("/notes/{i}.md");
            handles.push(std::thread::spawn(move || {
                let content = format!("content{i}");
                let p = PathBuf::from(&path);
                // May or may not match depending on timing, but must not panic.
                let _ = r.consume_if_match(&p, content.as_bytes());
            }));
        }
        for h in handles {
            h.join().expect("thread panicked");
        }
    }
}
