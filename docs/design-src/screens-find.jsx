// Search overlay, keyboard cheatsheet, and mobile command palette. Mono style.
// Loaded after shell.jsx.

function highlight(text, q, tk) {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return <>{text.slice(0, i)}<mark style={{ background: tk.accentSoft, color: tk.accentText, fontWeight: 700, padding: '0 1px' }}>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}

// ── SEARCH (desktop) ─────────────────────────────────────────────────────────
function SearchDesktop({ mode = 'dark' }) {
  const tk = monoTk(mode);
  const S = TND2.search;
  return (
    <MShell mode={mode} active="search" crumb="Search" zone="SEARCH" right={`${S.results.length} results`}>
      {/* search bar */}
      <div style={{ flexShrink: 0, borderBottom: `1px solid ${tk.lineStrong}`, padding: '16px 22px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, border: `1px solid ${tk.lineStrong}`, padding: '9px 13px', background: tk.panel }}>
          <TIcon name="search" size={17} color={tk.muted} />
          <span style={{ fontFamily: tk.screenFont, fontSize: 16, color: tk.text }}>{S.query}<span style={{ display: 'inline-block', width: 2, height: 17, background: tk.accent, marginLeft: 1, verticalAlign: -3 }} /></span>
          <div style={{ flex: 1 }} />
          <kbd style={{ fontFamily: tk.screenFont, fontSize: 11, color: tk.faint, padding: '2px 6px', border: `1px solid ${tk.line}` }}>⌘P</kbd>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 11 }}>
          <span style={{ fontFamily: tk.screenFont, fontSize: 11, color: tk.faint }}>filters</span>
          {S.chips.map((c, i) => (
            <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: tk.screenFont, fontSize: 11.5, padding: '3px 8px', border: `1px solid ${tk.lineStrong}`, color: tk.text }}>
              <span style={{ color: tk.accentText, fontWeight: 700 }}>{c.k}:</span>{c.v}<span style={{ color: tk.faint }}>×</span>
            </span>
          ))}
          <span style={{ fontFamily: tk.screenFont, fontSize: 11.5, color: tk.faint, padding: '3px 8px', border: `1px dashed ${tk.line}` }}>+ filter</span>
        </div>
      </div>
      {/* type tabs */}
      <div style={{ flexShrink: 0, display: 'flex', gap: 0, borderBottom: `1px solid ${tk.line}`, padding: '0 22px' }}>
        {[['Entries', S.counts.entries, true], ['Groups', S.counts.groups], ['Tags', S.counts.tags], ['People', 0]].map(([l, n, on], i) => (
          <span key={i} style={{ padding: '9px 14px', fontFamily: tk.screenFont, fontSize: 12, fontWeight: on ? 700 : 500, color: on ? tk.accentText : tk.muted, borderBottom: on ? `2px solid ${tk.accent}` : '2px solid transparent' }}>{l} <span style={{ color: tk.faint }}>{n}</span></span>
        ))}
      </div>
      {/* results */}
      <div style={{ flex: 1, overflow: 'hidden', padding: '6px 0' }}>
        {S.results.map((r, i) => (
          <div key={i} style={{ padding: '12px 22px', borderBottom: `1px solid ${tk.line}`, background: i === 0 ? tk.accentSoft : 'transparent' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
              <span style={{ fontFamily: tk.screenFont, fontSize: 14, fontWeight: 700, color: tk.text }}>{highlight(r.t, S.query, tk)}</span>
              {r.due && <span style={{ fontFamily: tk.screenFont, fontSize: 11, color: r.due === 'Today' ? tk.accentText : tk.faint }}>{r.due}</span>}
            </div>
            <div style={{ fontFamily: tk.screenFont, fontSize: 10.5, color: tk.faint, margin: '3px 0 5px' }}>{r.path}</div>
            <div style={{ fontFamily: tk.screenFont, fontSize: 12, color: tk.muted, lineHeight: 1.5 }}>{highlight(r.snip, S.query, tk)}</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 7 }}>{r.tags.map((t) => <TTag key={t} name={t} tk={tk} scoped={t === 'decided'} />)}</div>
          </div>
        ))}
      </div>
    </MShell>
  );
}

// ── CHEATSHEET (desktop, overlay over the workspace) ─────────────────────────
function CheatsheetDesktop({ mode = 'dark' }) {
  const tk = monoTk(mode);
  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
      <TodayDesktop mode={mode} />
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 860, maxHeight: 640, background: tk.panel, border: `1px solid ${tk.lineStrong}`, boxShadow: '0 24px 80px rgba(0,0,0,.5)', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 18px', borderBottom: `1px solid ${tk.lineStrong}` }}>
            <span style={{ fontFamily: tk.screenFont, fontSize: 14, fontWeight: 700, color: tk.text, letterSpacing: '0.03em', textTransform: 'uppercase' }}>Cheatsheet</span>
            <span style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              <span style={{ fontFamily: tk.screenFont, fontSize: 11, color: tk.faint }}>zone:</span>
              <span style={{ fontFamily: tk.screenFont, fontSize: 11, fontWeight: 700, color: tk.accentText, padding: '2px 8px', border: `1px solid ${tk.lineStrong}` }}>EDITOR</span>
              <kbd style={{ fontFamily: tk.screenFont, fontSize: 11, color: tk.faint, padding: '2px 6px', border: `1px solid ${tk.line}` }}>?</kbd>
            </span>
          </div>
          <div style={{ flex: 1, overflow: 'hidden', padding: 20, display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: '0 36px' }}>
            {TND2.cheatsheet.map((sec, i) => (
              <div key={i} style={{ marginBottom: 16 }}>
                <div style={{ fontFamily: tk.screenFont, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.08em', color: tk.faint, marginBottom: 6, paddingBottom: 5, borderBottom: `1px solid ${tk.line}` }}>[ {sec.cat.toUpperCase()} ]</div>
                {sec.items.map(([label, bind], j) => (
                  <div key={j} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '5px 0' }}>
                    <span style={{ fontFamily: tk.screenFont, fontSize: 12.5, color: tk.text }}>{label}</span>
                    <kbd style={{ fontFamily: tk.screenFont, fontSize: 11.5, fontWeight: 700, color: tk.accentText, padding: '2px 8px', background: tk.panel2, border: `1px solid ${tk.line}` }}>{bind}</kbd>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div style={{ padding: '10px 18px', borderTop: `1px solid ${tk.lineStrong}`, fontFamily: tk.screenFont, fontSize: 11, color: tk.faint }}>commands reflect the active zone · rebind any in <span style={{ color: tk.accentText }}>Settings → Keymap</span></div>
        </div>
      </div>
    </div>
  );
}

// ── PALETTE (mobile, pulled-down sheet) ──────────────────────────────────────
function PaletteMobile({ mode = 'dark' }) {
  const tk = monoTk(mode);
  const p = TND.palette;
  return (
    <MPhone mode={mode} noTabs>
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        {/* dimmed list behind */}
        <div style={{ position: 'absolute', inset: 0, opacity: 0.3, pointerEvents: 'none' }}>
          {TND.entries.slice(0, 5).map((e) => (
            <div key={e.id} style={{ padding: '13px 16px', borderBottom: `1px solid ${tk.line}`, fontFamily: tk.screenFont, fontSize: 13, color: tk.muted }}>{e.title}</div>
          ))}
        </div>
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.45)' }} />
        {/* sheet */}
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, background: tk.panel, border: `1px solid ${tk.lineStrong}`, boxShadow: '0 20px 50px rgba(0,0,0,.5)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px', borderBottom: `1px solid ${tk.lineStrong}` }}>
            <TIcon name="search" size={17} color={tk.muted} />
            <span style={{ fontFamily: tk.screenFont, fontSize: 16, color: tk.text }}>{p.query}<span style={{ display: 'inline-block', width: 2, height: 16, background: tk.accent, marginLeft: 1, verticalAlign: -3 }} /></span>
            <div style={{ flex: 1 }} />
            <span style={{ fontFamily: tk.screenFont, fontSize: 12, color: tk.faint }}>esc</span>
          </div>
          <div style={{ padding: '6px 0 10px' }}>
            <div style={{ padding: '8px 16px 4px', fontFamily: tk.screenFont, fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', color: tk.faint }}>{brk(tk, 'COMMANDS')}</div>
            {p.results.map((r, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '11px 16px', background: i === 0 ? tk.accentSoft : 'transparent' }}>
                <TIcon name={r.icon} size={16} color={i === 0 ? tk.accentText : tk.muted} />
                <span style={{ flex: 1, fontFamily: tk.screenFont, fontSize: 13.5, fontWeight: i === 0 ? 700 : 500, color: tk.text }}>{r.label}</span>
                <span style={{ fontFamily: tk.screenFont, fontSize: 10.5, color: tk.faint }}>{r.cat}</span>
                {r.bind && <kbd style={{ fontFamily: tk.screenFont, fontSize: 11, fontWeight: 700, color: tk.accentText }}>{r.bind}</kbd>}
              </div>
            ))}
            <div style={{ padding: '10px 16px 4px', fontFamily: tk.screenFont, fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', color: tk.faint }}>{brk(tk, 'RECENT')}</div>
            {p.recent.map((r, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '10px 16px' }}>
                <TIcon name="doc" size={15} color={tk.muted} />
                <span style={{ flex: 1, fontFamily: tk.screenFont, fontSize: 13, color: tk.text }}>{r.label}</span>
                <span style={{ fontFamily: tk.screenFont, fontSize: 10.5, color: tk.faint }}>{r.sub}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </MPhone>
  );
}

// ── SEARCH (mobile) ──────────────────────────────────────────────────────────
function SearchMobile({ mode = 'dark' }) {
  const tk = monoTk(mode);
  const S = TND2.search;
  return (
    <MPhone mode={mode} tab="search">
      <div style={{ flexShrink: 0, padding: '12px 16px 10px', borderBottom: `1px solid ${tk.lineStrong}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, border: `1px solid ${tk.lineStrong}`, padding: '8px 11px' }}>
          <TIcon name="search" size={16} color={tk.muted} />
          <span style={{ fontFamily: tk.screenFont, fontSize: 15, color: tk.text }}>{S.query}<span style={{ display: 'inline-block', width: 2, height: 15, background: tk.accent, marginLeft: 1, verticalAlign: -2 }} /></span>
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 9, flexWrap: 'wrap' }}>
          {S.chips.map((c, i) => <span key={i} style={{ fontFamily: tk.screenFont, fontSize: 11, padding: '3px 7px', border: `1px solid ${tk.lineStrong}`, color: tk.text }}><span style={{ color: tk.accentText, fontWeight: 700 }}>{c.k}:</span>{c.v} ×</span>)}
        </div>
      </div>
      <div style={{ flexShrink: 0, display: 'flex', borderBottom: `1px solid ${tk.line}`, padding: '0 10px' }}>
        {[['Entries', 4, true], ['Groups', 1], ['Tags', 2]].map(([l, n, on], i) => (
          <span key={i} style={{ padding: '9px 11px', fontFamily: tk.screenFont, fontSize: 11.5, fontWeight: on ? 700 : 500, color: on ? tk.accentText : tk.muted, borderBottom: on ? `2px solid ${tk.accent}` : '2px solid transparent' }}>{l} {n}</span>
        ))}
      </div>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {S.results.slice(0, 4).map((r, i) => (
          <div key={i} style={{ padding: '11px 16px', borderBottom: `1px solid ${tk.line}`, background: i === 0 ? tk.accentSoft : 'transparent' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10 }}>
              <span style={{ fontFamily: tk.screenFont, fontSize: 13.5, fontWeight: 700, color: tk.text }}>{highlight(r.t, S.query, tk)}</span>
              {r.due && <span style={{ fontFamily: tk.screenFont, fontSize: 10.5, color: tk.faint }}>{r.due}</span>}
            </div>
            <div style={{ fontFamily: tk.screenFont, fontSize: 10, color: tk.faint, margin: '3px 0 4px' }}>{r.path}</div>
            <div style={{ fontFamily: tk.screenFont, fontSize: 11.5, color: tk.muted, lineHeight: 1.45 }}>{highlight(r.snip, S.query, tk)}</div>
          </div>
        ))}
      </div>
    </MPhone>
  );
}

// ── CHEATSHEET (mobile, gestures & commands sheet) ──────────────────────────
function CheatsheetMobile({ mode = 'dark' }) {
  const tk = monoTk(mode);
  return (
    <MPhone mode={mode} noTabs>
      <MPhoneHead tk={tk} title="Cheatsheet" sub="gestures & commands · editor" right={<span style={{ fontFamily: tk.screenFont, fontSize: 13, color: tk.faint }}>✕</span>} />
      <div style={{ flex: 1, overflow: 'hidden', padding: '4px 0' }}>
        {TND2.cheatsheet.map((sec, i) => (
          <div key={i}>
            <div style={{ padding: '11px 16px 5px', fontFamily: tk.screenFont, fontSize: 10, fontWeight: 700, letterSpacing: '0.07em', color: tk.faint }}>[ {sec.cat.toUpperCase()} ]</div>
            {sec.items.slice(0, 3).map(([label, bind], j) => (
              <div key={j} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 16px', borderBottom: `1px solid ${tk.line}` }}>
                <span style={{ fontFamily: tk.screenFont, fontSize: 12.5, color: tk.text }}>{label}</span>
                <kbd style={{ fontFamily: tk.screenFont, fontSize: 11, fontWeight: 700, color: tk.accentText, padding: '2px 7px', background: tk.panel2, border: `1px solid ${tk.line}` }}>{bind}</kbd>
              </div>
            ))}
          </div>
        ))}
      </div>
    </MPhone>
  );
}

Object.assign(window, { highlight, SearchDesktop, CheatsheetDesktop, PaletteMobile, SearchMobile, CheatsheetMobile });
