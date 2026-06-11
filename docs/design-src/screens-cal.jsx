// Calendar screens (month / week / day) for desktop and mobile, Mono style.
// The calendar is a derived view over entry `due`/`range` properties (0008).
// Loaded after shell.jsx.

// Restrained tag→color map (Mono keeps to green accent + amber + muted).
function tagColor(tag, tk) {
  return { atlas: tk.accent, decided: tk.accent, planning: tk.accent, research: tk.amber, ideas: tk.amber, reading: tk.amber, spec: tk.muted, meetings: tk.accentText }[tag] || tk.muted;
}
const HOUR_PX = 58;

// Shared calendar toolbar (view switch + month nav).
function CalToolbar({ tk, view, label }) {
  const seg = ['Month', 'Week', 'Day'];
  return (
    <div style={{ height: 44, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 18px', borderBottom: `1px solid ${tk.line}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <span style={{ display: 'flex', border: `1px solid ${tk.lineStrong}` }}>
          {seg.map((s) => <span key={s} style={{ padding: '4px 12px', fontFamily: tk.screenFont, fontSize: 12, fontWeight: 700, color: s === view ? '#fff' : tk.muted, background: s === view ? tk.accent : 'transparent', borderRight: s !== 'Day' ? `1px solid ${tk.lineStrong}` : 'none' }}>{s}</span>)}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10, fontFamily: tk.screenFont, color: tk.muted }}>
          <span style={{ cursor: 'pointer' }}>‹</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: tk.text, letterSpacing: '0.02em' }}>{label}</span>
          <span style={{ cursor: 'pointer' }}>›</span>
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontFamily: tk.screenFont, fontSize: 12 }}>
        <span style={{ padding: '3px 10px', border: `1px solid ${tk.lineStrong}`, color: tk.text, fontWeight: 700 }}>Today</span>
        <span style={{ color: tk.faint }}>primary: <span style={{ color: tk.accentText }}>due</span></span>
      </div>
    </div>
  );
}

function CalEntryBar({ tk, e, compact }) {
  const col = tagColor(e.tag, tk);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, height: compact ? 15 : 17, padding: '0 4px', borderLeft: `2px solid ${col}`, background: tk.accentSoft && e.tag === 'atlas' ? tk.accentSoft : tk.panel2, fontFamily: tk.screenFont, fontSize: 10.5, color: tk.text, overflow: 'hidden', whiteSpace: 'nowrap' }}>
      {e.repeat && <span style={{ color: tk.faint }}>↻</span>}
      {e.time && <span style={{ color: tk.faint }}>{e.time}</span>}
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: e.tag === 'atlas' ? 700 : 500 }}>{e.t}</span>
    </div>
  );
}

// ── MONTH (desktop) ──────────────────────────────────────────────────────────
function CalMonthGrid({ tk, cellH }) {
  const cells = [];
  for (let d = 1; d <= 30; d++) cells.push(d);
  const weekdays = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', borderBottom: `1px solid ${tk.lineStrong}` }}>
        {weekdays.map((w, i) => <div key={w} style={{ padding: '6px 8px', fontFamily: tk.screenFont, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', color: tk.faint, borderRight: i < 6 ? `1px solid ${tk.line}` : 'none', textAlign: 'right' }}>{w}</div>)}
      </div>
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gridAutoRows: '1fr' }}>
        {cells.map((d, i) => {
          const items = TND2.calMonth[d] || [];
          const today = d === 10;
          const inBand = d >= 18 && d <= 19;
          return (
            <div key={d} style={{ borderRight: (i % 7) !== 6 ? `1px solid ${tk.line}` : 'none', borderBottom: `1px solid ${tk.line}`, padding: 5, display: 'flex', flexDirection: 'column', gap: 2, background: today ? tk.accentSoft : 'transparent', overflow: 'hidden' }}>
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <span style={{ fontFamily: tk.screenFont, fontSize: 11.5, fontWeight: today ? 700 : 500, color: today ? '#fff' : tk.muted, background: today ? tk.accent : 'transparent', minWidth: 18, height: 18, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', padding: '0 4px' }}>{d}</span>
              </div>
              {inBand && <div style={{ height: 15, background: tagColor('ideas', tk), color: '#1b1b16', fontFamily: tk.screenFont, fontSize: 10, fontWeight: 700, padding: '0 5px', display: 'flex', alignItems: 'center', whiteSpace: 'nowrap', overflow: 'hidden' }}>{d === 18 ? '▦ Design jam' : '…'}</div>}
              {items.filter((it) => !it.rangeStart && !it.rangeMid).slice(0, 3).map((it, j) => <CalEntryBar key={j} tk={tk} e={it} compact />)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
function CalMonthDesktop({ mode = 'dark' }) {
  const tk = monoTk(mode);
  return <MShell mode={mode} active="calendar" crumb="Calendar / Month" zone="CALENDAR" right="32 entries"><CalToolbar tk={tk} view="Month" label="June 2026" /><CalMonthGrid tk={tk} /></MShell>;
}

// ── WEEK (desktop) ───────────────────────────────────────────────────────────
function CalWeekDesktop({ mode = 'dark' }) {
  const tk = monoTk(mode);
  const hours = TND2.weekHours;
  return (
    <MShell mode={mode} active="calendar" crumb="Calendar / Week" zone="CALENDAR" right="Jun 8 – 14">
      <CalToolbar tk={tk} view="Week" label="Jun 8 – 14, 2026" />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {/* day header */}
        <div style={{ display: 'grid', gridTemplateColumns: '46px repeat(7,1fr)', borderBottom: `1px solid ${tk.lineStrong}` }}>
          <div style={{ borderRight: `1px solid ${tk.line}` }} />
          {TND2.weekCols.map(([d, n], i) => (
            <div key={d} style={{ padding: '6px 8px', borderRight: i < 6 ? `1px solid ${tk.line}` : 'none', fontFamily: tk.screenFont, background: n === 10 ? tk.accentSoft : 'transparent' }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', color: tk.faint }}>{d.toUpperCase()}</div>
              <div style={{ fontSize: 17, fontWeight: 700, color: n === 10 ? tk.accentText : tk.text }}>{n}</div>
            </div>
          ))}
        </div>
        {/* all-day band */}
        <div style={{ display: 'grid', gridTemplateColumns: '46px repeat(7,1fr)', borderBottom: `1px solid ${tk.line}`, minHeight: 22 }}>
          <div style={{ borderRight: `1px solid ${tk.line}`, fontFamily: tk.screenFont, fontSize: 9, color: tk.faint, padding: '3px 4px', textAlign: 'right' }}>all-day</div>
          <div style={{ gridColumn: '6 / 8', margin: 2, background: tagColor('ideas', tk), color: '#1b1b16', fontFamily: tk.screenFont, fontSize: 10.5, fontWeight: 700, padding: '2px 6px' }}>▦ Design jam · range</div>
        </div>
        {/* timed grid */}
        <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '46px repeat(7,1fr)', position: 'absolute', inset: 0 }}>
            <div style={{ borderRight: `1px solid ${tk.line}` }}>
              {hours.map((h) => <div key={h} style={{ height: HOUR_PX * 0.62, fontFamily: tk.screenFont, fontSize: 9.5, color: tk.faint, padding: '2px 4px', textAlign: 'right' }}>{h}:00</div>)}
            </div>
            {TND2.weekCols.map(([d, n], col) => (
              <div key={d} style={{ borderRight: col < 6 ? `1px solid ${tk.line}` : 'none', position: 'relative', background: n === 10 ? 'rgba(115,176,131,0.04)' : 'transparent' }}>
                {hours.map((h, hi) => <div key={h} style={{ position: 'absolute', top: hi * HOUR_PX * 0.62, left: 0, right: 0, borderTop: `1px solid ${tk.line}`, height: 0 }} />)}
                {TND2.weekEvents.filter((e) => e.day === col).map((e, j) => {
                  const top = (e.s - hours[0]) * HOUR_PX * 0.62;
                  const h = (e.e - e.s) * HOUR_PX * 0.62;
                  const col2 = tagColor(e.tag, tk);
                  return (
                    <div key={j} style={{ position: 'absolute', top: top + 1, left: 2, right: 2, height: Math.max(h - 2, 14), background: tk.panel2, borderLeft: `2px solid ${col2}`, padding: '1px 4px', overflow: 'hidden', fontFamily: tk.screenFont }}>
                      <div style={{ fontSize: 9.5, fontWeight: 700, color: tk.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.t}</div>
                      {h > 26 && <div style={{ fontSize: 9, color: tk.faint }}>{e.s}:00</div>}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </MShell>
  );
}

// ── DAY (desktop) ────────────────────────────────────────────────────────────
function CalDayDesktop({ mode = 'dark' }) {
  const tk = monoTk(mode);
  const hours = TND2.weekHours;
  return (
    <MShell mode={mode} active="calendar" crumb="Calendar / Day" zone="CALENDAR" right="Wed Jun 10">
      <CalToolbar tk={tk} view="Day" label="Wednesday, Jun 10" />
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* timeline */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ display: 'flex', borderBottom: `1px solid ${tk.line}`, minHeight: 26, alignItems: 'center' }}>
            <span style={{ width: 56, fontFamily: tk.screenFont, fontSize: 9.5, color: tk.faint, padding: '0 6px', textAlign: 'right' }}>all-day</span>
            <span style={{ margin: 3, background: tk.panel2, borderLeft: `2px solid ${tagColor('spec', tk)}`, padding: '2px 8px', fontFamily: tk.screenFont, fontSize: 11, fontWeight: 700, color: tk.text }}>Review spec</span>
          </div>
          <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
            {hours.map((h, hi) => (
              <div key={h} style={{ position: 'absolute', top: hi * HOUR_PX, left: 0, right: 0, borderTop: `1px solid ${tk.line}`, display: 'flex' }}>
                <span style={{ width: 56, fontFamily: tk.screenFont, fontSize: 10, color: tk.faint, padding: '2px 6px', textAlign: 'right' }}>{h}:00</span>
              </div>
            ))}
            {/* now line */}
            <div style={{ position: 'absolute', top: (9.6 - hours[0]) * HOUR_PX, left: 56, right: 0, borderTop: `2px solid ${tk.amber}`, zIndex: 3 }}><span style={{ position: 'absolute', left: -5, top: -4, width: 7, height: 7, borderRadius: '50%', background: tk.amber }} /></div>
            {TND2.dayEvents.map((e, j) => {
              const top = (e.s - hours[0]) * HOUR_PX;
              const h = (e.e - e.s) * HOUR_PX;
              const col = tagColor(e.tag, tk);
              return (
                <div key={j} style={{ position: 'absolute', top: top + 1, left: 62, right: 18, height: Math.max(h - 3, 18), background: tk.panel2, borderLeft: `3px solid ${col}`, padding: '3px 10px', overflow: 'hidden', fontFamily: tk.screenFont }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: tk.text }}>{e.t}</span>
                    <span style={{ fontSize: 10, color: tk.faint }}>{e.s}:00–{e.e}:00</span>
                  </div>
                  {e.people && h > 30 && <div style={{ display: 'flex', flexDirection: 'row-reverse', width: 'fit-content', marginTop: 4 }}>{e.people.map((p, k) => <span key={p} style={{ marginRight: k ? -5 : 0 }}><TAvatar slug={p} size={17} tk={tk} ring /></span>)}</div>}
                </div>
              );
            })}
          </div>
        </div>
        {/* right rail: mini month + unscheduled */}
        <div style={{ width: 230, flexShrink: 0, borderLeft: `1px solid ${tk.lineStrong}`, background: tk.panel, padding: 16, display: 'flex', flexDirection: 'column', gap: 18 }}>
          <TMiniCal tk={tk} compact />
          <div>
            <MLabel tk={tk} style={{ marginBottom: 8 }}>UNSCHEDULED</MLabel>
            {['Naming + positioning', 'Vendor comparison'].map((t) => (
              <div key={t} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 0', fontFamily: tk.screenFont, fontSize: 11.5, color: tk.muted, borderBottom: `1px solid ${tk.line}` }}>
                <span style={{ color: tk.faint }}>≡</span>{t}
              </div>
            ))}
            <div style={{ marginTop: 8, fontFamily: tk.screenFont, fontSize: 10.5, color: tk.faint }}>drag onto the day to schedule →</div>
          </div>
        </div>
      </div>
    </MShell>
  );
}

Object.assign(window, { tagColor, HOUR_PX, CalToolbar, CalEntryBar, CalMonthGrid, CalMonthDesktop, CalWeekDesktop, CalDayDesktop });
