---
id: docs/spec/0012-notifications
title: Notifications and reminders
kind: feature
status: accepted
related: [docs/spec/0001-product-vision, docs/spec/0002-entries, docs/spec/0008-calendar, docs/spec/0011-settings]
---

# Notifications and reminders

## Problem

The calendar (0008) gives entries a temporal projection but explicitly defers reminders: an entry due at 14:00 is visible if the user is looking, silent if they are not. A personal productivity app whose tasks never speak up is a notebook; the gap is a way for a dated entry to raise a signal at the right moment. The constraints come from the pillars: local-only (no push service, no account), calm (no nag streams, no badges screaming), and derived from entry data (a reminder is a property, not a separate object — same move the calendar makes).

This spec is post-v1 (0008 lists notifications as a v1 non-goal); it exists so the property shapes are fixed before anything ships that would have to migrate.

## User stories

- I set `due: 2026-06-12T14:00+02:00` and `remind: 10m` on a meeting note. At 13:50 my OS shows a notification with the entry title. Clicking it opens the entry.
- I set `remind: [10m, 1d]` on a flight entry. I get a nudge the day before and ten minutes before.
- My weekly standup entry (`repeat:` RRULE) reminds me before every occurrence, except the one I overrode to `skip`.
- I close the laptop before a reminder fires. On wake, the missed reminder is delivered once, marked late — not silently dropped, not repeated.
- I turn on quiet hours (22:00–08:00). Reminders due in that window deliver at the window's end.

## Behavior

**Source of truth.** A reminder is derived from entry frontmatter, exactly as calendar placement is. No separate reminder store; deleting the property deletes the reminder.

**The `remind` property.** A well-known property (0002): a duration, or a list of durations, counted back from the entry's **primary date property** (0008). Duration syntax: `<n><unit>` with units `m`, `h`, `d`, `w` (`10m`, `2h`, `1d`, `1w`); `0m` means "at the time itself." An absolute datetime value is also accepted for one-off reminders untethered to a lead time. Entries without the primary date property cannot remind (nothing to count back from); the property is flagged inert in the side panel.

**All-day items.** For `date`-typed values the lead time counts back from a per-library "day start" time (library setting, see 0011; default 09:00). `remind: 1d` on an all-day Saturday entry fires Friday 09:00.

**Recurrence.** For entries with `repeat:` (0008), reminders apply to each expanded occurrence. Overridden occurrences remind at their moved time; `skip` occurrences do not remind.

**Delivery.** OS-native notifications (Notification Center / toast / libnotify): entry title, the primary date, group breadcrumb. Click opens the entry in the app. Where the platform supports scheduled local notifications, the app schedules ahead; otherwise delivery requires the app running (foreground or its tray/background process — see Open questions). No sound by default; per-library toggle (0011).

**Missed reminders.** A reminder whose fire time passed while the app was not running (or the machine slept) is delivered once on next launch/wake, visually marked as late. Reminders more than a configurable age (default 24h) are dropped silently into the entry's side panel rather than notified — a wall of stale toasts on Monday morning is the opposite of calm.

**Quiet hours.** An optional per-user window (0011) during which nothing fires; pending reminders deliver at the window's end, collapsed into a single summary notification if there are more than three.

## Non-goals

- No push, email, SMS, or cross-device delivery. Local machine only — the no-forced-cloud anti-pillar applies in full.
- No snooze hierarchies, nag repeats, or escalation chains. A reminder fires once (plus the late-delivery pass).
- No reminders on mentions, tags, or searches ("remind me about everything tagged #followup"). Reminders hang off one entry's date.
- No in-app notification center / unread tray in v1 of this feature; the OS surface is the only surface.
- No location-based or context-based triggers.

## Edge cases

- **Time zone changes.** Reminder time derives from the primary date's resolved instant (0008's rules); an offset-carrying datetime reminds at the same instant worldwide; a zone-naive value reminds at its literal local hour.
- **Primary date property changed library-wide** (0008 edge case). Reminders re-derive from the new property; entries lacking it stop reminding. No rewrite.
- **`remind` on an entry whose date is already past.** Inert; no late-delivery (it was never scheduled); flagged in the side panel.
- **Duplicate durations** (`[10m, 10m]`). Deduplicated; fires once.
- **Malformed duration.** That list element is inert and flagged (same non-blocking posture as malformed frontmatter, 0002); valid elements still fire.
- **Entry in trash.** Trashed entries never remind; restoring re-schedules future reminders only.

## Acceptance criteria

- `remind: 10m` on an entry with a timed primary date fires an OS notification 10 minutes before; clicking it opens the entry.
- `remind: [10m, 1d]` fires exactly twice.
- A recurring entry reminds before each occurrence within the scheduling horizon; a `skip` override silences that occurrence.
- Removing the `remind` property (or the primary date) cancels pending reminders in the same session.
- A reminder missed by under 24h delivers once on wake, marked late; one missed by over 24h appears only in the entry's side panel.
- During quiet hours nothing fires; at window end, pending reminders deliver (collapsed if >3).
- All behavior works with networking disabled.

## Open questions

- Background delivery model per platform: tray/login-item process vs OS-scheduled local notifications (macOS `UNUserNotificationCenter` allows scheduling; Linux generally needs a running process). Belongs in a tech design doc once 0011's settings land.
- Scheduling horizon for recurring entries (how far ahead occurrences are scheduled): proposal 30 days, re-evaluated on each app wake.
- Should `remind` accept per-occurrence overrides like dates do (`overrides:` interplay), or is rule-level enough? Defaulting to rule-level until a real need appears.
