// Line-ending policy helper.
//
// Spec reference: docs/spec/0006-markdown-editor.md §"Edge cases / Mixed line endings":
//   "Normalize to \n on write; preserve the user's original on read until first write."
//
// Contract (callers must honour):
//   `normalize_for_write` is called ONLY when the caller has determined that the buffer
//   was edited by the app.  It MUST NOT be called on content that was read and forwarded
//   unmodified — doing so would violate the "no silent rewrite" rule from spec 0006.
//   This function is intentionally dumb: it trusts the caller's "was edited" judgement.
//
// Trailing whitespace / BOM preservation (spec 0006 §"Edge cases"):
//   This function normalizes CR+LF and lone CR to LF only.  It does NOT strip trailing
//   whitespace or remove a BOM.  Those must be preserved unless the user edited that
//   specific line (the caller is responsible for passing only content the user touched).

/// Normalize line endings to `\n` in `text`.
///
/// Replaces `\r\n` (Windows CRLF) and lone `\r` (old Mac CR) with `\n`.
///
/// Called ONLY when the caller has confirmed the buffer was edited by the app.
/// Do NOT call on read-only forwarded content (spec 0006 no-silent-rewrite rule).
pub fn normalize_for_write(text: &str) -> String {
    // Two-pass approach is clearer and avoids an allocation per character.
    // First, collapse \r\n → \n, then lone \r → \n.
    let after_crlf = text.replace("\r\n", "\n");
    after_crlf.replace('\r', "\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lf_only_unchanged() {
        let s = "line1\nline2\n";
        assert_eq!(normalize_for_write(s), "line1\nline2\n");
    }

    #[test]
    fn crlf_normalized() {
        let s = "line1\r\nline2\r\n";
        assert_eq!(normalize_for_write(s), "line1\nline2\n");
    }

    #[test]
    fn lone_cr_normalized() {
        let s = "line1\rline2\r";
        assert_eq!(normalize_for_write(s), "line1\nline2\n");
    }

    #[test]
    fn mixed_endings_all_normalized() {
        let s = "a\r\nb\nc\r";
        assert_eq!(normalize_for_write(s), "a\nb\nc\n");
    }

    #[test]
    fn empty_string_unchanged() {
        assert_eq!(normalize_for_write(""), "");
    }

    #[test]
    fn trailing_whitespace_preserved() {
        // spec 0006: trailing whitespace is preserved on write (user may have typed it).
        let s = "line with spaces   \r\nnext\r\n";
        assert_eq!(normalize_for_write(s), "line with spaces   \nnext\n");
    }

    #[test]
    fn bom_preserved() {
        // UTF-8 BOM (\u{FEFF}) must not be touched by line-ending normalization.
        let s = "\u{FEFF}line1\r\nline2\r\n";
        let out = normalize_for_write(s);
        assert!(out.starts_with('\u{FEFF}'), "BOM must be preserved");
        assert_eq!(out, "\u{FEFF}line1\nline2\n");
    }

    #[test]
    fn no_newlines_unchanged() {
        let s = "no newlines here";
        assert_eq!(normalize_for_write(s), "no newlines here");
    }
}
