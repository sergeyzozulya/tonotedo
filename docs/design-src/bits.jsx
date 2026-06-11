// Theme-aware shared primitives. Every component takes `tk` (resolved tokens
// from tndTokens) so the same markup re-skins across all five styles. Tag,
// mention, wikilink and checkbox each honor the style's `flags.tag` etc.

// ── Line icons (1.6 stroke) ───────────────────────────────────────────────
function TIcon({ name, size = 16, stroke = 1.6, color = 'currentColor', style }) {
  const p = {
    calendar: <><rect x="3" y="4.5" width="14" height="13" rx="2"/><path d="M3 8h14M7 2.5v4M13 2.5v4"/></>,
    search: <><circle cx="9" cy="9" r="6"/><path d="M13.5 13.5L17.5 17.5"/></>,
    folder: <path d="M2.5 5.5a1.5 1.5 0 011.5-1.5h3l1.6 1.8H16a1.5 1.5 0 011.5 1.5v7A1.5 1.5 0 0116 15.8H4a1.5 1.5 0 01-1.5-1.5z"/>,
    book: <><path d="M4 3.5h8a2 2 0 012 2v11H6a2 2 0 01-2-2z"/><path d="M14 5.5h2v11h-2"/></>,
    pen: <><path d="M13.5 3.5l3 3L7 16l-3.5.8L4.3 13z"/><path d="M11.5 5.5l3 3"/></>,
    spark: <path d="M10 2.5l1.7 5 5 1.7-5 1.7L10 16l-1.7-5-5-1.7 5-1.7z"/>,
    plus: <path d="M10 4v12M4 10h12"/>,
    doc: <><path d="M5 2.5h6l4 4v11H5z"/><path d="M11 2.5v4h4"/></>,
    chevron: <path d="M7.5 5l4 4-4 4"/>,
    chevronD: <path d="M5 7.5l4 4 4-4"/>,
    check: <path d="M4 10l4 4 8-9"/>,
    hash: <path d="M7 3l-1 14M14 3l-1 14M3.5 7.5h13M3 12.5h13"/>,
    at: <><circle cx="10" cy="10" r="3.2"/><path d="M13.2 10v1.4a2 2 0 003.3 1.5A8 8 0 1013 16.5"/></>,
    link: <><path d="M8 11.5a3 3 0 004.3 0l2.2-2.2a3 3 0 00-4.3-4.3L11 6"/><path d="M12 8.5a3 3 0 00-4.3 0L5.5 10.7a3 3 0 004.3 4.3L11 14"/></>,
    settings: <><circle cx="10" cy="10" r="2.4"/><path d="M10 2.5v2.2M10 15.3v2.2M17.5 10h-2.2M4.7 10H2.5M15.3 4.7l-1.6 1.6M6.3 13.7l-1.6 1.6M15.3 15.3l-1.6-1.6M6.3 6.3L4.7 4.7"/></>,
  }[name];
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" fill="none" stroke={color}
      strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, ...style }}>
      {p}
    </svg>
  );
}

// ── Avatar chip ───────────────────────────────────────────────────────────
function TAvatar({ slug, size = 20, tk, ring }) {
  const p = TND.people[slug] || { initials: '?', tint: tk.muted };
  const r = tk.flags.avatarShape === 'square' ? Math.max(2, size * 0.22) : '50%';
  return (
    <span title={p.name} style={{
      width: size, height: size, borderRadius: r, flexShrink: 0,
      background: p.tint, color: '#fff', display: 'inline-flex', alignItems: 'center',
      justifyContent: 'center', fontSize: size * 0.42, fontWeight: 700, letterSpacing: 0.2,
      fontFamily: tk.font.ui, boxShadow: ring ? `0 0 0 2px ${tk.panel}` : 'none',
    }}>{p.initials}</span>
  );
}

// ── Tag — renders per flags.tag: hash | pill | bracket | caps ──────────────
function TTag({ name, tk, scoped }) {
  const f = tk.flags.tag;
  const col = scoped ? tk.accentText : tk.accentText;
  if (f === 'hash') {
    return <span style={{ color: tk.accentText, fontWeight: 600, fontFamily: tk.font.ui }}>#{name}</span>;
  }
  if (f === 'bracket') {
    return <span style={{ color: scoped ? tk.amber : tk.accentText, fontFamily: tk.font.mono, fontWeight: 600 }}>#{name}</span>;
  }
  if (f === 'caps') {
    return <span style={{ color: tk.text, fontFamily: tk.font.mono, fontSize: '0.74em', letterSpacing: '0.08em', textTransform: 'uppercase', borderBottom: `1px solid ${tk.lineStrong}`, paddingBottom: 1 }}>{name}</span>;
  }
  // pill
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3, padding: '2px 9px',
      borderRadius: tk.flags.tagRadius, background: scoped ? tk.accentSoft : tk.panel2,
      color: scoped ? tk.accentText : tk.muted, fontSize: '0.82em', fontWeight: 600,
      fontFamily: tk.font.ui, border: scoped ? 'none' : `1px solid ${tk.line}`, whiteSpace: 'nowrap',
    }}>{scoped && <span style={{ opacity: 0.7 }}>#</span>}{name}</span>
  );
}

// ── Inline run renderer for editor body (text / mention / tag / wikilink) ──
function TRuns({ runs, tk }) {
  return runs.map((r, i) => {
    if (r.s !== undefined) return <span key={i}>{r.s}</span>;
    if (r.tag) {
      const scoped = r.tag === 'decided';
      return <span key={i} style={{ verticalAlign: 'baseline' }}><TTag name={r.tag} tk={tk} scoped={scoped} /></span>;
    }
    if (r.mention) {
      const p = TND.people[r.mention];
      return (
        <span key={i} style={{
          display: 'inline-flex', alignItems: 'center', gap: 4, verticalAlign: -3,
          padding: tk.flags.tag === 'bracket' ? '0' : '1px 7px 1px 3px', margin: '0 1px',
          borderRadius: tk.flags.tagRadius === 0 ? 0 : 999,
          background: tk.flags.tag === 'bracket' ? 'transparent' : tk.accentSoft,
          color: tk.accentText, fontWeight: 600, fontFamily: tk.font.ui, fontSize: '0.92em',
        }}>
          {tk.flags.tag === 'bracket'
            ? <span style={{ fontFamily: tk.font.mono }}>@{r.mention}</span>
            : <><TAvatar slug={r.mention} size={16} tk={tk} />{p ? p.name.split(' ')[0] : r.mention}</>}
        </span>
      );
    }
    if (r.link) {
      return (
        <span key={i} style={{
          color: tk.accentText, fontWeight: 600, fontFamily: tk.font.ui,
          borderBottom: `1.5px solid ${tk.accentSoft}`, cursor: 'pointer',
          textDecoration: tk.flags.tag === 'caps' ? 'none' : 'none', whiteSpace: 'nowrap',
        }}>{tk.flags.tag === 'bracket' ? `[[${r.link}]]` : r.text}</span>
      );
    }
    return null;
  });
}

// ── Task checkbox (body-level, drives `- [ ]`) ─────────────────────────────
function TCheck({ done, tk, size = 17 }) {
  const sq = tk.flags.radius === 0;
  return (
    <span style={{
      width: size, height: size, flexShrink: 0, borderRadius: sq ? 0 : 5,
      border: `1.6px solid ${done ? tk.accent : tk.lineStrong}`,
      background: done ? tk.accent : 'transparent', display: 'inline-flex',
      alignItems: 'center', justifyContent: 'center', marginTop: 2,
    }}>
      {done && <TIcon name="check" size={size * 0.7} color="#fff" stroke={2.4} />}
    </span>
  );
}

// ── Mini month calendar peek (properties panel / desktop) ──────────────────
function TMiniCal({ tk, compact }) {
  const { today, days, due } = TND.cal;
  // June 2026 starts on a Monday; render Mon-first 7-col grid.
  const lead = 0; // Jun 1 = Monday in our mock
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  const cell = compact ? 22 : 26;
  return (
    <div style={{ fontFamily: tk.font.ui }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 12.5, fontWeight: 700, color: tk.text, letterSpacing: tk.flags.uppercaseLabels ? '0.04em' : '-0.01em' }}>{TND.cal.month}</span>
        <span style={{ display: 'flex', gap: 2, color: tk.faint }}>
          <TIcon name="chevron" size={13} style={{ transform: 'rotate(180deg)' }} />
          <TIcon name="chevron" size={13} />
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 1 }}>
        {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((d, i) => (
          <div key={i} style={{ textAlign: 'center', fontSize: 9.5, fontWeight: 700, color: tk.faint, height: 16, lineHeight: '16px' }}>{d}</div>
        ))}
        {cells.map((d, i) => {
          const isToday = d === today;
          const hasDue = d && due.includes(d);
          return (
            <div key={i} style={{ height: cell, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2 }}>
              <span style={{
                width: cell - 6, height: cell - 6, display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 11.5, fontWeight: isToday ? 700 : 500, borderRadius: tk.flags.radius === 0 ? 0 : '50%',
                background: isToday ? tk.accent : 'transparent', color: isToday ? '#fff' : (d ? tk.muted : 'transparent'),
              }}>{d || ''}</span>
              <span style={{ width: 4, height: 4, borderRadius: '50%', background: hasDue && !isToday ? tk.accent : 'transparent' }} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

Object.assign(window, { TIcon, TAvatar, TTag, TRuns, TCheck, TMiniCal });
