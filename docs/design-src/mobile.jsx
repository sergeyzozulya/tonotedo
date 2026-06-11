// Mobile screens for ToNoteDo. `screen` = 'list' (entry list / zone-as-screen)
// or 'editor' (open entry with accessory row + properties sheet peek). The
// focus zones (0007) become screens on phones (0013). Fills a 380×800 artboard.

// ── Faux status bar + home indicator ────────────────────────────────────────
function TMStatus({ tk }) {
  return (
    <div style={{ height: 44, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 24px 0 26px', fontFamily: tk.font.ui }}>
      <span style={{ fontSize: 14, fontWeight: 700, color: tk.text, letterSpacing: '0.02em' }}>9:41</span>
      <span style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 5 }}>
        <svg width="17" height="11" viewBox="0 0 17 11" fill={tk.text}><rect x="0" y="7" width="3" height="4" rx="1"/><rect x="4.5" y="5" width="3" height="6" rx="1"/><rect x="9" y="2.5" width="3" height="8.5" rx="1"/><rect x="13.5" y="0" width="3" height="11" rx="1"/></svg>
        <svg width="16" height="11" viewBox="0 0 16 11" fill="none" stroke={tk.text} strokeWidth="1.3"><path d="M1 4.2A10 10 0 0115 4.2M3.2 6.5a7 7 0 019.6 0M5.6 8.8a3.4 3.4 0 014.8 0" strokeLinecap="round"/></svg>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 1.5 }}>
          <span style={{ width: 22, height: 11, borderRadius: 3, border: `1px solid ${tk.muted}`, display: 'inline-flex', alignItems: 'center', padding: 1.5 }}><span style={{ width: 13, height: '100%', borderRadius: 1, background: tk.text }} /></span>
          <span style={{ width: 1.5, height: 4, background: tk.muted, borderRadius: 1 }} />
        </span>
      </span>
    </div>
  );
}
function TMHome({ tk }) {
  return <div style={{ height: 22, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><span style={{ width: 130, height: 5, borderRadius: 3, background: tk.text, opacity: 0.32 }} /></div>;
}

// ── List screen ──────────────────────────────────────────────────────────────
function TMList({ tk }) {
  const up = tk.flags.uppercaseLabels;
  const dueColor = (due) => due === 'Today' ? tk.accentText : tk.muted;
  const card = tk.flags.list === 'card';
  return (
    <>
      {/* pull-down palette handle */}
      <div style={{ flexShrink: 0, display: 'flex', justifyContent: 'center', paddingTop: 2 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 12px', borderRadius: 999, background: tk.panel2, color: tk.faint, fontFamily: tk.font.mono, fontSize: 10.5 }}><TIcon name="search" size={11} color={tk.faint} />⌘K · pull to search</span>
      </div>
      {/* header */}
      <div style={{ flexShrink: 0, padding: '12px 20px 14px', display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: tk.faint, fontSize: 12.5, fontFamily: tk.font.ui, marginBottom: 3 }}>
            <TIcon name="chevron" size={13} color={tk.faint} style={{ transform: 'rotate(180deg)' }} />Work
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
            <span style={{ fontFamily: tk.flags.serifBody ? tk.font.body : tk.font.ui, fontSize: 27, fontWeight: tk.flags.serifBody ? 600 : 800, color: tk.text, letterSpacing: '-0.02em' }}>{up ? 'PROJECT ATLAS' : 'Project Atlas'}</span>
            <span style={{ fontSize: 13, color: tk.faint, fontFamily: tk.font.mono }}>{TND.group.count}</span>
          </div>
        </div>
        <span style={{ width: 36, height: 36, borderRadius: tk.flags.radius === 0 ? 0 : 10, background: tk.panel2, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><TIcon name="settings" size={18} color={tk.muted} /></span>
      </div>
      {/* list */}
      <div style={{ flex: 1, overflow: 'hidden', padding: card ? '0 12px' : '0' }}>
        {TND.entries.slice(0, 5).map((e, i) => (
          <div key={e.id} style={{
            padding: card ? '13px 14px' : '13px 20px', margin: card ? '7px 0' : 0,
            borderRadius: card ? tk.flags.radius : 0, borderBottom: card ? 'none' : `1px solid ${tk.line}`,
            background: e.selected ? (card ? tk.accentSoft : tk.sel) : (card ? tk.panel : 'transparent'),
            boxShadow: card && !e.selected ? tk.shadow : (card && e.selected ? `inset 0 0 0 1.5px ${tk.accent}` : 'none'),
            position: 'relative',
          }}>
            {e.selected && !card && <span style={{ position: 'absolute', left: 0, top: 10, bottom: 10, width: 3, background: tk.accent }} />}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
              <span style={{ fontFamily: tk.flags.list === 'index' ? tk.font.body : tk.font.ui, fontSize: tk.flags.list === 'index' ? 18 : 16, fontWeight: tk.flags.titleWeight, color: tk.text, letterSpacing: '-0.01em', lineHeight: 1.25 }}>{e.title}</span>
              {e.due && <span style={{ fontSize: 11.5, fontWeight: 600, color: dueColor(e.due), whiteSpace: 'nowrap', fontFamily: tk.flags.boxed ? tk.font.mono : tk.font.ui }}>{e.due}</span>}
            </div>
            <div style={{ marginTop: 4, fontSize: 13.5, color: tk.muted, lineHeight: 1.4, display: '-webkit-box', WebkitLineClamp: 1, WebkitBoxOrient: 'vertical', overflow: 'hidden', fontFamily: tk.font.ui }}>{e.preview}</div>
            <div style={{ marginTop: 9, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
                {e.tasks && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, color: tk.muted, fontFamily: tk.font.mono }}><TCheck done={false} tk={tk} size={12} />{e.tasks.done}/{e.tasks.total}</span>}
                {e.tags && e.tags.slice(0, 2).map((t) => <span key={t} style={{ fontSize: 12 }}><TTag name={t} tk={tk} scoped={t === 'decided'} /></span>)}
              </div>
              {e.people && <div style={{ display: 'flex', flexDirection: 'row-reverse' }}>{e.people.slice(0, 3).map((p, j) => <span key={p} style={{ marginRight: j ? -6 : 0 }}><TAvatar slug={p} size={22} tk={tk} ring /></span>)}</div>}
            </div>
          </div>
        ))}
      </div>
      {/* bottom tab bar + FAB */}
      <div style={{ flexShrink: 0, position: 'relative', borderTop: `1px solid ${tk.line}`, background: tk.panel, padding: '9px 18px 6px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        {[['folder', 'Library', true], ['search', 'Search', false], ['calendar', 'Calendar', false], ['settings', 'Settings', false]].map(([ic, lb, on], i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, flex: 1 }}>
            <TIcon name={ic} size={21} color={on ? tk.accent : tk.faint} />
            <span style={{ fontSize: 10, fontWeight: on ? 700 : 500, color: on ? tk.accentText : tk.faint, fontFamily: tk.font.ui }}>{lb}</span>
          </div>
        ))}
        <span style={{ position: 'absolute', top: -26, right: 18, width: 52, height: 52, borderRadius: tk.flags.radius === 0 ? 0 : 16, background: tk.accent, boxShadow: `0 8px 20px ${tk.accentSoft}, 0 4px 10px rgba(0,0,0,.18)`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><TIcon name="plus" size={24} color="#fff" stroke={2.4} /></span>
      </div>
    </>
  );
}

// ── Editor screen ────────────────────────────────────────────────────────────
function TMEditor({ tk }) {
  const o = TND.open;
  const bodyFont = tk.flags.serifBody ? tk.font.body : tk.font.ui;
  const bodySize = tk.flags.serifBody ? 17.5 : 15;
  const block = (b, i) => {
    if (b.t === 'h2') return <h2 key={i} style={{ fontFamily: tk.flags.serifBody ? tk.font.body : tk.font.ui, fontSize: tk.flags.serifBody ? 20 : 17, fontWeight: 700, color: tk.text, letterSpacing: '-0.01em', margin: '18px 0 4px' }}>{b.text}</h2>;
    if (b.t === 'task') return (
      <div key={i} style={{ display: 'flex', gap: 9, alignItems: 'flex-start', margin: '9px 0', fontFamily: bodyFont, fontSize: bodySize, lineHeight: 1.5, color: b.done ? tk.muted : tk.text }}>
        <TCheck done={b.done} tk={tk} size={18} /><span style={{ textDecoration: b.done ? 'line-through' : 'none', textDecorationColor: tk.faint, flex: 1 }}><TRuns runs={b.runs} tk={tk} /></span>
      </div>
    );
    if (b.t === 'quote') return <blockquote key={i} style={{ margin: '14px 0', paddingLeft: 13, borderLeft: `3px solid ${tk.accentSoft}`, fontFamily: tk.font.body, fontStyle: 'italic', fontSize: tk.flags.serifBody ? 16.5 : 15, color: tk.muted, lineHeight: 1.5 }}>{b.text}</blockquote>;
    return <p key={i} style={{ margin: '12px 0', fontFamily: bodyFont, fontSize: bodySize, lineHeight: 1.58, color: tk.text }}><TRuns runs={b.runs} tk={tk} /></p>;
  };
  return (
    <>
      {/* top bar */}
      <div style={{ flexShrink: 0, height: 46, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 14px', borderBottom: `1px solid ${tk.line}` }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: tk.accentText, fontFamily: tk.font.ui, fontSize: 14, fontWeight: 600 }}><TIcon name="chevron" size={16} color={tk.accentText} style={{ transform: 'rotate(180deg)' }} />Atlas</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11.5, color: tk.muted, fontFamily: tk.font.ui }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: '#5E9A6E' }} />saved</span>
        <span style={{ display: 'inline-flex', gap: 14 }}><TIcon name="settings" size={19} color={tk.muted} /><TIcon name="doc" size={19} color={tk.muted} /></span>
      </div>
      {/* body */}
      <div style={{ flex: 1, overflow: 'hidden', padding: '20px 20px 0' }}>
        <h1 style={{ fontFamily: tk.flags.serifBody ? tk.font.body : tk.font.ui, fontSize: tk.flags.serifBody ? 30 : 25, fontWeight: tk.flags.serifBody ? 600 : 800, color: tk.text, letterSpacing: '-0.02em', lineHeight: 1.12, margin: '0 0 14px' }}>{o.title}</h1>
        {o.blocks.slice(0, 7).map(block)}
      </div>
      {/* properties sheet peek */}
      <div style={{ flexShrink: 0, borderTop: `1px solid ${tk.line}`, background: tk.panel2, padding: '10px 18px 11px' }}>
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 9 }}><span style={{ width: 36, height: 4, borderRadius: 2, background: tk.lineStrong }} /></div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
          <span style={{ fontFamily: tk.font.ui, fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: tk.faint }}>Properties</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: tk.flags.radius === 0 ? 0 : 6, background: tk.accentSoft, color: tk.accentText, fontSize: 11.5, fontWeight: 600, fontFamily: tk.font.ui }}><TIcon name="calendar" size={11} color={tk.accentText} />Jun 10</span>
          <TTag name="atlas" tk={tk} /><TTag name="decided" tk={tk} scoped />
          <span style={{ display: 'flex', flexDirection: 'row-reverse', marginLeft: 'auto' }}>{['sergey', 'maya'].map((p, j) => <span key={p} style={{ marginRight: j ? -6 : 0 }}><TAvatar slug={p} size={20} tk={tk} ring /></span>)}</span>
        </div>
      </div>
      {/* accessory keyboard row (software-keyboard editor commands, 0013) */}
      <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 0, padding: '0 6px', height: 44, background: tk.bg, borderTop: `1px solid ${tk.line}` }}>
        {[['H', 'serif'], ['B', 'b'], ['•', ''], ['☑', ''], ['#', 'a'], ['@', 'a'], ['[[', 'a'], ['⌘K', 'k']].map(([g, kind], i) => (
          <span key={i} style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', height: 32, margin: '0 3px', borderRadius: tk.flags.radius === 0 ? 0 : 7, background: tk.panel, border: `1px solid ${tk.line}`, fontFamily: g === '⌘K' ? tk.font.mono : tk.font.ui, fontSize: g.length > 1 ? 12 : 15, fontWeight: 700, color: ['#', '@', '[['].includes(g) ? tk.accentText : tk.muted }}>{g}</span>
        ))}
      </div>
    </>
  );
}

function TNDMobile({ theme, mode, screen }) {
  const tk = tndTokens(theme, mode);
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: tk.bg, color: tk.text, overflow: 'hidden' }}>
      <TMStatus tk={tk} />
      {screen === 'editor' ? <TMEditor tk={tk} /> : <TMList tk={tk} />}
      <TMHome tk={tk} />
    </div>
  );
}

Object.assign(window, { TNDMobile });
