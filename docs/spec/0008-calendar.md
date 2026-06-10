---
id: docs/spec/0008-calendar
title: Calendar
kind: feature
status: accepted
related: [docs/spec/0001-product-vision, docs/spec/0002-entries, docs/spec/0003-groups, docs/spec/0007-keyboard-model, docs/spec/0011-settings, docs/spec/0012-notifications]
---

# Calendar

## Problem

Entries with dates need a temporal projection. The user types a date as a property of a meeting note or a task, and that property should be enough to make the entry land on a calendar — without forcing the user to "convert" the note into an event. The calendar is a view, not a separate object type. This avoids the database feeling (anti-pillar) while still giving the user a time-based way to see and rearrange their work.

The hard parts: which property drives placement when an entry has several dates, how to render multi-day or timed events without inventing event objects, and how reschedule-by-drag writes back to disk without surprising the user.

## User stories

- I write a meeting note. I add a `due: 2026-05-20` property. The note appears on May 20 in the calendar.
- I drag that meeting from May 20 to May 21. The note's `due` property updates on disk.
- I open the week view. I see every entry with a `due` in this week, regardless of which group it lives in. Entries from the current group are highlighted.
- I set `range: 2026-05-20..2026-05-24` on an entry. It shows as a multi-day band spanning those dates.
- I add a time component in the properties panel; the app saves `due: 2026-05-20T14:00+02:00` with my current offset. The entry appears at 14:00 in day / week views.
- I add `repeat: "RRULE:FREQ=WEEKLY;BYDAY=MO"` to my standup note. The note appears every Monday on the calendar.
- I edit one occurrence of a recurring entry (move next Monday's standup to Tuesday). That single occurrence is overridden without affecting the rule.
- I see today and the next two weeks at a glance, with the option to scroll forward.

## Behavior

**Source of truth.** The calendar is a derived view. The data lives in entry frontmatter; the calendar reads it through the index (see ADR 0001).

**Date properties.** Any entry property of type `date`, `datetime`, or `range` (see 0002) can drive placement. The calendar has a single library-wide **primary date property** setting; default is `due`. Changing it (e.g. to `scheduled`) is a library setting (stored in `_settings.md`, see 0011), not a per-group or per-view choice. Entries that do not carry the primary property simply do not appear on the calendar.

**Time zones.** `datetime` values the app writes carry an explicit offset (`2026-05-20T14:00+02:00`). A value without an offset (hand-typed in vim, imported) is interpreted in the machine's current local zone at read time and is not rewritten. The calendar renders every instant in the current local zone of the machine: after travel, an offset-carrying value appears at the equivalent local time — no rewrite on disk.

**Multi-day entries.** An entry whose primary date property is of type `range` (see 0002) renders as a band from start to end inclusive. The range can be all-day (`2026-06-01..2026-06-05`) or timed (`2026-06-01T09:00..2026-06-01T10:30`). An entry with a single `date` or `datetime` renders as a point on that date or time.

**All-day vs timed.** A `date`-typed value renders as all-day. A `datetime` renders as timed at that hour. A `range` is all-day if its endpoints are dates, timed if they are datetimes. Mixed (one of each) is not supported — it parses but is flagged.

**Recurrence.** A `repeat` property of type string (a well-known property, see 0002) carries an iCalendar RRULE (`RRULE:FREQ=WEEKLY;BYDAY=MO`, `RRULE:FREQ=DAILY;COUNT=10`, etc.). The calendar expands the rule against the entry's primary date property to produce virtual occurrences within the visible range. Occurrences are not separate entries on disk — only the single source entry exists.

**RRULE v1 subset.** The parser supports a deliberate subset of RFC 5545 that covers common personal scheduling. Anything outside the subset is rejected with a non-blocking "unsupported RRULE feature: X" warning on the entry; the source date still renders as a single occurrence.

| Supported | Notes |
|---|---|
| `FREQ` | `DAILY`, `WEEKLY`, `MONTHLY`, `YEARLY` only |
| `INTERVAL` | every N units |
| `COUNT` | terminate after N occurrences |
| `UNTIL` | terminate at date |
| `BYDAY` | weekday list (`MO,WE,FR`) and positional prefix (`1MO`, `-1FR`) |
| `BYMONTHDAY` | day of month, including negatives (`-1` = last day) |
| `BYMONTH` | month of year |

Unsupported in v1 (warned, not parsed): `BYSETPOS`, `BYWEEKNO`, `BYYEARDAY`, `BYHOUR`, `BYMINUTE`, `BYSECOND`, `WKST`, and sub-day frequencies (`SECONDLY`, `MINUTELY`, `HOURLY`). The companion properties `RDATE` and `EXDATE` are also unsupported in v1; per-occurrence skip and move are expressed via the `overrides:` map below.

Adding any of these later does not break stored data — an entry already carrying `RRULE:FREQ=WEEKLY;BYDAY=MO` keeps working unchanged when the parser learns more.

Per-occurrence overrides live on the source entry in an `overrides` property (a well-known map-shaped property, see 0002; written and edited via the calendar UI): a map from the original occurrence date to either a replacement value (move that occurrence) or `skip` (omit it). Example:

```yaml
repeat: "RRULE:FREQ=WEEKLY;BYDAY=MO"
overrides:
  "2026-05-25": "2026-05-26"   # moved one day
  "2026-06-01": skip
```

Editing one occurrence in the UI writes an entry in `overrides`. Editing the source (rule or primary date) edits all non-overridden occurrences. There is no "edit this and future occurrences" gesture in v1; the user expresses that by ending the old rule (`UNTIL=...`) and creating a new entry with a new rule.

**Views.** Day, Week, Month, Agenda (a flat list of upcoming items). The user switches views with a single keystroke (commands `view.day`, `view.week`, etc. — see 0007). Each view honors the same filter state.

**Filters.** The calendar inherits the active group filter from the sidebar. "All groups" is also valid. Tag filters and property filters compose on top.

**Drag to reschedule.** Dragging an entry to a new date or time writes the chosen primary property on disk. For a `date` value, the time component is preserved if it was a `datetime`; for an all-day drag to a `datetime`-typed property, the time stays at its previous value. No silent type changes.

**Keyboard navigation.** Arrow keys move between days; `pgup` / `pgdn` between weeks or months by view; `t` jumps to today.

**Selection and editing.** Selecting a calendar item opens a docked side panel showing the entry's title, properties, and body for inline editing. The calendar remains visible; reschedules and edits compose. Opening the entry in the full editor is a separate command (`cmd+enter` on a selected item), not the default click.

**Color and grouping.** Entries inherit group color (from `_group.md`) and tag color on the calendar. When both apply, group color is the band fill; tag colors are chips on the entry card. No new color system.

## Non-goals

- No external calendar sync (Google, iCloud, CalDAV) in v1. That belongs to a calendar **provider** plugin (see 0010).
- No invitations, attendees, RSVP, video links. Not a meeting tool.
- No reminders / notifications in v1. Specified separately in 0012-notifications (post-v1).
- No "edit this and future occurrences" gesture for recurring entries in v1. Users end one rule (with `UNTIL`) and start a new entry.
- No calendar-only entries that exist nowhere else. Every visible item is a real entry on disk.

## Edge cases

- **Entry with multiple date properties.** The calendar uses only the primary property. Other dates are visible in the entry's side panel but do not render as separate items on the calendar.
- **Malformed `range`** (`end` before `start`, or mixed `date` / `datetime` endpoints). Render as a single point on `start`; flag a non-blocking warning on the entry.
- **Invalid RRULE.** Recurrence is suppressed for that entry; the source date still renders as a single occurrence; warning surfaced.
- **Recurring entry's source date moved.** All non-overridden occurrences shift accordingly. Overrides keyed by the original (pre-move) date stay valid; once that key is no longer in the rule's expansion, the override is orphaned and surfaced in the entry's side panel for cleanup.
- **Time zone changes.** Per the Time zones rule above: offset-carrying values are fixed instants and shift their displayed hour when the machine's zone changes; offset-less values are zone-naive and stay at their literal hour. Neither is rewritten on disk.
- **Past entries.** Render normally; visually muted but not hidden. The user opts in to "hide past" as a filter.
- **Drag onto a day outside the current view's range.** View shifts to include the target day; the move completes.
- **Very dense days (50+ entries).** Day cell shows the first N with a `+M more` affordance; agenda view is offered as the recommended way to read dense days.
- **Renaming the primary date property.** If the user globally switches "primary date" from `due` to `scheduled`, existing entries without `scheduled` simply do not appear on the calendar. No data is rewritten.

## Acceptance criteria

- Adding a `due` property with a date value makes the entry appear on the calendar at that date.
- Editing the date in the entry's properties panel moves the calendar item in the same session, without restart.
- Dragging an entry from day X to day Y writes the new date to disk (verifiable by reading the `.md` file).
- A `range` value renders as a band spanning the inclusive interval.
- An entry with a valid `repeat` RRULE renders at every expanded occurrence within the visible window.
- Editing a single occurrence persists an `overrides` entry on the source; other occurrences are unaffected.
- Day, Week, Month, Agenda views all reflect the same underlying entries.
- Group filter applied in the sidebar restricts the calendar to entries from that group.
- A `datetime` value renders at the correct hour in Day and Week views.
- Removing the primary date property from an entry removes it from the calendar.
