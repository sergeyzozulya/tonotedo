// Mobile calendar screens (month / week / day), Mono style. Phone reduces
// density by layout, never by dropping a view (0013). Loaded after screens-cal.

function CalSeg({ tk, view }) {
  return (
    <div style={{ display: 'flex', border: `1px solid ${tk.lineStrong}`, margin: '0 16px 12px' }}>
      {['Month', 'Week', 'Day'].map((s, i) => (
        <span key={s} style={{ flex: 1, textAlign: 'center', padding: '6px 0', fontFamily: tk.screenFont, fontSize: 12, fontWeight: 700, color: s === view ? '#fff' : tk.muted, background: s === view ? tk.accent : 'transparent', borderRight: i < 2 ? `1px solid ${tk.lineStrong}` : 'none' }}>{s}</span>
      ))}
    </div>
  );
}

// ── MONTH (mobile): compact grid + selected-day agenda ───────────────────────
function CalMonthMobile({ mode = 'dark' }) {
  const tk = monoTk(mode);
  const weekdays = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const sel = TND2.calMonth[10] || [];
  return (
    <MPhone mode={mode} tab="cal">
      <MPhoneHead tk={tk} title="June 2026" right={<span style={{ display: 'flex', gap: 14, fontFamily: tk.screenFont, color: tk.muted, fontSize: 15 }}><span>‹</span><span>›</span></span>} />
      <CalSeg tk={tk} view="Month" />
      <div style={{ padding: '0 12px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)' }}>
          {weekdays.map((w, i) => <div key={i} style={{ textAlign: 'center', fontFamily: tk.screenFont, fontSize: 9.5, fontWeight: 700, color: tk.faint, padding: '2px 0' }}>{w}</div>)}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 1 }}>
          {Array.from({ length: 30 }, (_, k) => k + 1).map((d) => {
            const items = (TND2.calMonth[d] || []).filter((it) => !it.rangeMid);
            const today = d === 10;
            return (
              <div key={d} style={{ height: 40, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 3, background: today ? tk.accentSoft : 'transparent', border: today ? `1px solid ${tk.accent}` : 'none' }}>
                <span style={{ fontFamily: tk.screenFont, fontSize: 12, fontWeight: today ? 700 : 500, color: today ? tk.accentText : tk.muted }}>{d}</span>
                <span style={{ display: 'flex', gap: 2 }}>{items.slice(0, 3).map((it, j) => <span key={j} style={{ width: 4, height: 4, background: tagColor(it.tag, tk) }} />)}</span>
              </div>
            );
          })}
        </div>
      </div>
      <div style={{ flex: 1, marginTop: 14, borderTop: `1px solid ${tk.lineStrong}`, overflow: 'hidden' }}>
        <div style={{ padding: '10px 16px 4px', fontFamily: tk.screenFont, fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', color: tk.faint }}>WED · JUN 10</div>
        {sel.map((it, j) => (
          <div key={j} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '10px 16px', borderBottom: `1px solid ${tk.line}` }}>
            <span style={{ fontFamily: tk.screenFont, fontSize: 11, color: tk.faint, width: 38 }}>{it.time || 'all'}</span>
            <span style={{ width: 3, alignSelf: 'stretch', background: tagColor(it.tag, tk) }} />
            <span style={{ flex: 1, fontFamily: tk.screenFont, fontSize: 13, fontWeight: 700, color: tk.text }}>{it.t}</span>
            {it.people && <span style={{ display: 'flex', flexDirection: 'row-reverse' }}>{it.people.map((p, k) => <span key={p} style={{ marginRight: k ? -5 : 0 }}><TAvatar slug={p} size={18} tk={tk} ring /></span>)}</span>}
          </div>
        ))}
      </div>
    </MPhone>
  );
}

// ── WEEK (mobile): agenda grouped by weekday ─────────────────────────────────
function CalWeekMobile({ mode = 'dark' }) {
  const tk = monoTk(mode);
  const byDay = {};
  TND2.weekEvents.forEach((e) => { (byDay[e.day] = byDay[e.day] || []).push(e); });
  return (
    <MPhone mode={mode} tab="cal">
      <MPhoneHead tk={tk} title="Jun 8 – 14" right={<span style={{ display: 'flex', gap: 14, fontFamily: tk.screenFont, color: tk.muted, fontSize: 15 }}><span>‹</span><span>›</span></span>} />
      <CalSeg tk={tk} view="Week" />
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {TND2.weekCols.map(([d, n], col) => {
          const evs = byDay[col] || [];
          const today = n === 10;
          return (
            <div key={d} style={{ display: 'flex', borderBottom: `1px solid ${tk.line}`, background: today ? tk.accentSoft : 'transparent' }}>
              <div style={{ width: 54, flexShrink: 0, padding: '10px 8px', textAlign: 'center', borderRight: `1px solid ${tk.line}` }}>
                <div style={{ fontFamily: tk.screenFont, fontSize: 9.5, fontWeight: 700, color: tk.faint }}>{d.toUpperCase()}</div>
                <div style={{ fontFamily: tk.screenFont, fontSize: 17, fontWeight: 700, color: today ? tk.accentText : tk.text }}>{n}</div>
              </div>
              <div style={{ flex: 1, padding: '7px 12px', display: 'flex', flexDirection: 'column', gap: 5, minHeight: 30, justifyContent: 'center' }}>
                {evs.length === 0 && <span style={{ fontFamily: tk.screenFont, fontSize: 11, color: tk.faint }}>—</span>}
                {evs.map((e, j) => (
                  <div key={j} style={{ display: 'flex', alignItems: 'center', gap: 7, fontFamily: tk.screenFont, fontSize: 12 }}>
                    <span style={{ color: tk.faint, width: 34 }}>{e.s}:00</span>
                    <span style={{ width: 3, height: 13, background: tagColor(e.tag, tk) }} />
                    <span style={{ color: tk.text, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.t}</span>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </MPhone>
  );
}

// ── DAY (mobile): timeline ───────────────────────────────────────────────────
function CalDayMobile({ mode = 'dark' }) {
  const tk = monoTk(mode);
  const hours = [8, 9, 10, 11, 12, 13, 14, 15];
  const HP = 50;
  return (
    <MPhone mode={mode} tab="cal">
      <MPhoneHead tk={tk} title="Wed Jun 10" sub="Wednesday · today" right={<span style={{ display: 'flex', gap: 14, fontFamily: tk.screenFont, color: tk.muted, fontSize: 15 }}><span>‹</span><span>›</span></span>} />
      <CalSeg tk={tk} view="Day" />
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 16px 8px' }}>
        <span style={{ fontFamily: tk.screenFont, fontSize: 10, color: tk.faint, width: 40, textAlign: 'right' }}>all-day</span>
        <span style={{ background: tk.panel2, borderLeft: `2px solid ${tagColor('spec', tk)}`, padding: '2px 8px', fontFamily: tk.screenFont, fontSize: 11.5, fontWeight: 700, color: tk.text }}>Review spec</span>
      </div>
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden', borderTop: `1px solid ${tk.line}` }}>
        {hours.map((h, hi) => (
          <div key={h} style={{ position: 'absolute', top: hi * HP, left: 0, right: 0, borderTop: `1px solid ${tk.line}`, display: 'flex' }}>
            <span style={{ width: 48, fontFamily: tk.screenFont, fontSize: 10, color: tk.faint, padding: '2px 6px', textAlign: 'right' }}>{h}:00</span>
          </div>
        ))}
        <div style={{ position: 'absolute', top: (9.6 - hours[0]) * HP, left: 48, right: 0, borderTop: `2px solid ${tk.amber}`, zIndex: 3 }}><span style={{ position: 'absolute', left: -4, top: -4, width: 7, height: 7, borderRadius: '50%', background: tk.amber }} /></div>
        {TND2.dayEvents.map((e, j) => {
          const top = (e.s - hours[0]) * HP, h = (e.e - e.s) * HP;
          return (
            <div key={j} style={{ position: 'absolute', top: top + 1, left: 54, right: 14, height: Math.max(h - 3, 20), background: tk.panel2, borderLeft: `3px solid ${tagColor(e.tag, tk)}`, padding: '3px 9px', overflow: 'hidden', fontFamily: tk.screenFont }}>
              <div style={{ fontSize: 11.5, fontWeight: 700, color: tk.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.t}</div>
              <div style={{ fontSize: 9.5, color: tk.faint }}>{e.s}:00–{e.e}:00</div>
            </div>
          );
        })}
      </div>
    </MPhone>
  );
}

Object.assign(window, { CalSeg, CalMonthMobile, CalWeekMobile, CalDayMobile });
