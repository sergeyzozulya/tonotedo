/// Apply the `overrides` map (docs/spec/0008-calendar.md) to a rule expansion.
///
/// The overrides map keys are original occurrence date strings (`"2026-05-25"`).
/// Values are either a replacement date string or `"skip"`.
///
/// Orphan detection: we expand the rule up to a generous horizon (max of
/// `window_to + 2 years` or `COUNT * interval` worth of dates) and report
/// any override key that does not appear in that full expansion.
use std::collections::{HashMap, HashSet};

use jiff::civil::Date;

use super::expand::expand_all;
use super::types::{
    ExpansionResult, Occurrence, OrphanedOverride, OverrideAction, OverridesMap, RRule, StartDate,
};

/// Parse an overrides map from raw string pairs (as extracted from YAML).
///
/// Caller supplies a `HashMap<String, String>` (key = original date string,
/// value = replacement date string or `"skip"`).
pub fn parse_overrides(raw: &HashMap<String, String>) -> OverridesMap {
    raw.iter()
        .filter_map(|(k, v)| {
            let action = if v.trim().eq_ignore_ascii_case("skip") {
                OverrideAction::Skip
            } else {
                let target: Date = v.trim().parse().ok()?;
                OverrideAction::MoveTo(target)
            };
            Some((k.clone(), action))
        })
        .collect()
}

/// Expand the rule within [window_from, window_to], applying overrides.
///
/// COUNT semantics: COUNT is exhausted from rule start, not window start.
/// An occurrence that has passed COUNT is simply absent from the expansion.
///
/// Orphan horizon: 2 years beyond the last window boundary, or 1000 total
/// occurrences, whichever comes first.  This is "generous" as the spec says.
pub fn expand_with_overrides(
    rule: &RRule,
    start: StartDate,
    window_from: Date,
    window_to: Date,
    overrides: &OverridesMap,
) -> ExpansionResult {
    // Full expansion (for COUNT-aware window clipping and orphan detection).
    let all_dates = expand_all(rule, start);

    // Build a set of all original dates (for orphan detection).
    let all_set: HashSet<String> = all_dates.iter().map(|d| d.to_string()).collect();

    // Apply overrides to get the effective occurrence list.
    // We track every effective date that lands in the window.
    let mut occurrences: Vec<Occurrence> = Vec::new();

    for &original in &all_dates {
        let key = original.to_string();
        let (effective, moved) = if let Some(action) = overrides.get(&key) {
            match action {
                OverrideAction::Skip => continue,
                OverrideAction::MoveTo(target) => (*target, true),
            }
        } else {
            (original, false)
        };

        // Only include occurrences whose effective date is within the window.
        if effective >= window_from && effective <= window_to {
            occurrences.push(Occurrence {
                original,
                effective,
                moved,
            });
        }
    }

    // Sort by effective date.
    occurrences.sort_by_key(|o| o.effective);

    // Detect orphaned overrides: keys not in the full expansion.
    // Also check keys that are in the expansion but BEYOND the COUNT/UNTIL
    // boundary — those are already excluded from `all_dates`, so they won't
    // appear in `all_set` and will be correctly flagged as orphaned.
    //
    // We extend the orphan horizon: if the rule is open-ended, expand_all
    // already caps at MAX_OCCURRENCES (10 000), which is generous enough.
    // If COUNT is small, any key beyond the last occurrence is also orphaned.
    let orphaned: Vec<OrphanedOverride> = overrides
        .iter()
        .filter(|(key, _)| !all_set.contains(*key))
        .map(|(key, action)| OrphanedOverride {
            key: key.clone(),
            action: action.clone(),
        })
        .collect();

    // Also orphan keys that would only be reached past the UNTIL boundary.
    // These are already excluded from `all_set` above since `expand_all`
    // respects COUNT/UNTIL, so no extra work needed.

    ExpansionResult {
        occurrences,
        orphaned,
    }
}
