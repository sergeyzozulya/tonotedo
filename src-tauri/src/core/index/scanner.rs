// Body inline scanner: extracts #tags, @mentions, and [[wikilinks]] from
// markdown body text.
//
// Spec refs:
//   - docs/spec/0004-tags.md  §Form — letters/digits/-/_/  ; case-preserving
//   - docs/spec/0005-mentions.md §Form — letters/digits/-/_ ; word-boundary rule
//   - docs/spec/0006-markdown-editor.md §Behavior — fenced code suppression
//
// Rules implemented:
//   1. Fenced code blocks (``` or ~~~) suppress all inline tokens on enclosed lines.
//   2. Inline code spans (`...`) suppress tokens within the span.
//   3. #tag: `#` followed by one or more [a-zA-Z0-9\-_/], not preceded by a word char.
//   4. @mention: `@` followed by one or more [a-zA-Z0-9\-_],
//      NOT preceded by a word char (letter/digit/underscore) — so email@host is not a mention.
//   5. [[wikilink]]: `[[` ... `]]`, target is the text before `|` if present.
//
// The scanner is line-based for fence tracking.  Inline code stripping is
// a best-effort character scan; it handles the common case of non-nested backtick spans.

/// One inline token found in the body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Token {
    Tag(String),
    Mention(String),
    WikiLink(String),
}

/// Scan `body` and return all inline tokens (tags, mentions, wikilinks).
/// Tokens inside fenced or inline code blocks are suppressed.
pub fn scan_body(body: &str) -> Vec<Token> {
    let mut tokens = Vec::new();
    let mut in_fence = false;
    let mut fence_marker: Option<char> = None;

    for line in body.lines() {
        let trimmed = line.trim_start();

        // Detect fence open/close (``` or ~~~).
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            let marker = trimmed.chars().next().unwrap();
            if !in_fence {
                in_fence = true;
                fence_marker = Some(marker);
            } else if fence_marker == Some(marker) {
                in_fence = false;
                fence_marker = None;
            }
            // The fence line itself is not scanned.
            continue;
        }

        if in_fence {
            continue;
        }

        scan_line(line, &mut tokens);
    }

    tokens
}

/// Scan a single (non-fenced) line for inline tokens, stripping inline code first.
fn scan_line(line: &str, tokens: &mut Vec<Token>) {
    // Strip inline code spans to avoid parsing tokens inside them.
    let stripped = strip_inline_code(line);
    scan_stripped(&stripped, tokens);
}

/// Remove all inline code spans (`...`) from `text`, replacing their content
/// with spaces of the same length to preserve character offsets.
fn strip_inline_code(text: &str) -> String {
    let bytes = text.as_bytes();
    let len = bytes.len();
    let mut result = text.to_string();
    let res_bytes = unsafe { result.as_bytes_mut() };
    let mut i = 0;
    while i < len {
        if bytes[i] == b'`' {
            // Find the closing backtick.
            let start = i;
            let mut j = i + 1;
            while j < len && bytes[j] != b'`' {
                j += 1;
            }
            if j < len {
                // Replace the interior with spaces (keep delimiters as spaces too).
                res_bytes[start..=j].fill(b' ');
                i = j + 1;
            } else {
                // Unclosed backtick — leave rest as-is.
                break;
            }
        } else {
            i += 1;
        }
    }
    result
}

/// Scan a line (already inline-code-stripped) for tokens.
fn scan_stripped(text: &str, tokens: &mut Vec<Token>) {
    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    let mut i = 0;

    while i < n {
        // ── Wikilink: [[ ... ]] ───────────────────────────────────────────────
        if i + 1 < n && chars[i] == '[' && chars[i + 1] == '[' {
            let start = i + 2;
            let mut j = start;
            while j + 1 < n && !(chars[j] == ']' && chars[j + 1] == ']') {
                j += 1;
            }
            if j + 1 < n {
                let inner: String = chars[start..j].iter().collect();
                // Strip optional display text after `|`.
                let target = inner.split('|').next().unwrap_or(&inner).trim().to_string();
                if !target.is_empty() {
                    tokens.push(Token::WikiLink(target));
                }
                i = j + 2;
                continue;
            }
        }

        // ── #tag ─────────────────────────────────────────────────────────────
        if chars[i] == '#' {
            // Must not be preceded by a word character.
            let preceded_by_word = i > 0 && is_word_char(chars[i - 1]);
            if !preceded_by_word {
                let start = i + 1;
                let mut j = start;
                while j < n && is_tag_char(chars[j]) {
                    j += 1;
                }
                if j > start {
                    let tag: String = chars[start..j].iter().collect();
                    tokens.push(Token::Tag(tag));
                    i = j;
                    continue;
                }
            }
        }

        // ── @mention ─────────────────────────────────────────────────────────
        if chars[i] == '@' {
            // Word-boundary rule: must NOT be preceded by a word char (letter/digit/_).
            // email@example.com: the `@` is preceded by 'm', which is a word char → skip.
            let preceded_by_word = i > 0 && is_word_char(chars[i - 1]);
            if !preceded_by_word {
                let start = i + 1;
                let mut j = start;
                while j < n && is_mention_char(chars[j]) {
                    j += 1;
                }
                if j > start {
                    let slug: String = chars[start..j].iter().collect();
                    tokens.push(Token::Mention(slug));
                    i = j;
                    continue;
                }
            }
        }

        i += 1;
    }
}

/// Word character for the word-boundary rule (letter, digit, or underscore).
fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Allowed characters in a tag slug: letters, digits, `-`, `_`, `/`.
fn is_tag_char(c: char) -> bool {
    c.is_alphanumeric() || c == '-' || c == '_' || c == '/'
}

/// Allowed characters in a mention slug: letters, digits, `-`, `_`.
fn is_mention_char(c: char) -> bool {
    c.is_alphanumeric() || c == '-' || c == '_'
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Tags ─────────────────────────────────────────────────────────────────

    #[test]
    fn tag_simple() {
        let tokens = scan_body("this is #followup text");
        assert!(tokens.contains(&Token::Tag("followup".to_string())));
    }

    #[test]
    fn tag_hierarchical() {
        let tokens = scan_body("filed under #project/atlas");
        assert!(tokens.contains(&Token::Tag("project/atlas".to_string())));
    }

    #[test]
    fn tag_at_line_start() {
        let tokens = scan_body("#standup notes");
        assert!(tokens.contains(&Token::Tag("standup".to_string())));
    }

    #[test]
    fn tag_not_preceded_by_word_char() {
        // `foo#bar` — `#` preceded by word char → not a tag.
        let tokens = scan_body("foo#bar");
        assert!(!tokens.iter().any(|t| matches!(t, Token::Tag(_))));
    }

    #[test]
    fn tag_hash_no_following_chars_not_a_tag() {
        let tokens = scan_body("text # alone");
        assert!(!tokens.iter().any(|t| matches!(t, Token::Tag(_))));
    }

    // ── Mentions ──────────────────────────────────────────────────────────────

    #[test]
    fn mention_simple() {
        let tokens = scan_body("had lunch with @sergey today");
        assert!(tokens.contains(&Token::Mention("sergey".to_string())));
    }

    #[test]
    fn mention_at_line_start() {
        let tokens = scan_body("@anna should review this");
        assert!(tokens.contains(&Token::Mention("anna".to_string())));
    }

    #[test]
    fn mention_email_not_a_mention() {
        // email@example.com: `@` preceded by `l` (word char) → NOT a mention.
        let tokens = scan_body("contact email@example.com for details");
        assert!(
            !tokens
                .iter()
                .any(|t| matches!(t, Token::Mention(s) if s == "example")),
            "email@example.com must not be parsed as mention @example"
        );
        assert!(
            !tokens.iter().any(|t| matches!(t, Token::Mention(_))),
            "no mention should be extracted from email@example.com"
        );
    }

    #[test]
    fn mention_after_punctuation() {
        // Punctuation before `@` is fine — it's not a word char.
        let tokens = scan_body("cc: @bob");
        assert!(tokens.contains(&Token::Mention("bob".to_string())));
    }

    #[test]
    fn mention_disallowed_chars_stop_at_dot() {
        // `@john.doe`: parses `@john`, the `.doe` is plain text.
        let tokens = scan_body("asked @john.doe to review");
        assert!(tokens.contains(&Token::Mention("john".to_string())));
        // `.doe` must not be a separate mention.
        assert!(!tokens.contains(&Token::Mention("doe".to_string())));
    }

    // ── Wikilinks ─────────────────────────────────────────────────────────────

    #[test]
    fn wikilink_bare() {
        let tokens = scan_body("see [[meeting-notes]] for context");
        assert!(tokens.contains(&Token::WikiLink("meeting-notes".to_string())));
    }

    #[test]
    fn wikilink_with_display_text() {
        let tokens = scan_body("see [[work/atlas/meeting-notes|meeting notes]] today");
        assert!(tokens.contains(&Token::WikiLink("work/atlas/meeting-notes".to_string())));
    }

    // ── Code suppression ─────────────────────────────────────────────────────

    #[test]
    fn fenced_code_block_suppressed() {
        let body = "before\n```\n#not-a-tag\n@not-a-mention\n```\nafter";
        let tokens = scan_body(body);
        assert!(
            !tokens.iter().any(|t| matches!(t, Token::Tag(_))),
            "tags inside fenced code must be suppressed"
        );
        assert!(
            !tokens.iter().any(|t| matches!(t, Token::Mention(_))),
            "mentions inside fenced code must be suppressed"
        );
    }

    #[test]
    fn tilde_fence_code_block_suppressed() {
        let body = "~~~\n#not-a-tag\n~~~\n";
        let tokens = scan_body(body);
        assert!(!tokens.iter().any(|t| matches!(t, Token::Tag(_))));
    }

    #[test]
    fn inline_code_suppressed() {
        let tokens = scan_body("use `#config` option");
        assert!(
            !tokens.iter().any(|t| matches!(t, Token::Tag(_))),
            "#config inside inline code must not be a tag"
        );
    }

    #[test]
    fn inline_code_does_not_suppress_outside() {
        let tokens = scan_body("use `code` and then #real-tag");
        assert!(tokens.contains(&Token::Tag("real-tag".to_string())));
    }

    // ── Both surfaces semantics ───────────────────────────────────────────────

    #[test]
    fn body_and_frontmatter_union_test() {
        // Spec 0004 edge case: body has #a #b, frontmatter has [a, c].
        // Body scanner gives {a, b}; combined with frontmatter {a, c} = {a, b, c}.
        let body = "text with #a and #b inline";
        let tokens = scan_body(body);
        let body_tags: Vec<_> = tokens
            .iter()
            .filter_map(|t| {
                if let Token::Tag(s) = t {
                    Some(s.clone())
                } else {
                    None
                }
            })
            .collect();
        assert!(body_tags.contains(&"a".to_string()));
        assert!(body_tags.contains(&"b".to_string()));
        // "c" is NOT in the body — it comes from frontmatter only.
        assert!(!body_tags.contains(&"c".to_string()));
    }

    // ── Multiple tokens on one line ───────────────────────────────────────────

    #[test]
    fn multiple_tags_one_line() {
        let tokens = scan_body("tagged as #foo #bar and #baz");
        let tags: Vec<_> = tokens
            .iter()
            .filter_map(|t| {
                if let Token::Tag(s) = t {
                    Some(s.as_str())
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(tags, vec!["foo", "bar", "baz"]);
    }

    #[test]
    fn mixed_tokens_one_line() {
        let tokens = scan_body("meeting with @anna about [[project-x]] #followup");
        assert!(tokens.contains(&Token::Mention("anna".to_string())));
        assert!(tokens.contains(&Token::WikiLink("project-x".to_string())));
        assert!(tokens.contains(&Token::Tag("followup".to_string())));
    }
}
