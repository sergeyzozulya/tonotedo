// Desktop part 2: editor · properties · status bar · ⌘K palette · assembled
// TNDDesktop. Depends on desktop.jsx (part 1) and bits.jsx.

// ── Editor (live-inline markdown) ────────────────────────────────────────────
function TNDEditor({ tk, D }) {
  const o = TND.open;
  const bodyFont = tk.flags.serifBody ? tk.font.body : tk.font.ui;
  const bodySize = tk.flags.serifBody ? 18 : 15.5;
  const bodyLh = tk.flags.serifBody ? 1.62 : 1.6;

  const block = (b, i) => {
    if (b.t === 'h2') {
      // Demonstrate live-inline source reveal on the "Notes" heading: cursor
      // sits here, so the raw `## ` marker shows with a caret.
      const reveal = b.text === 'Notes';
      return (
        <h2 key={i} style={{ fontFamily: tk.flags.serifBody ? tk.font.body : tk.font.ui, fontSize: tk.flags.serifBody ? 23 : 19, fontWeight: 700, color: tk.text, letterSpacing: '-0.015em', margin: `${D.bodyGap + 8}px 0 4px` }}>
          {reveal && <span style={{ color: tk.faint, fontFamily: tk.font.mono, fontWeight: 400 }}>## </span>}
          {b.text}
          {reveal && <span style={{ display: 'inline-block', width: 2, height: '1.05em', background: tk.accent, marginLeft: 1, verticalAlign: -3, borderRadius: 1 }} />}
        </h2>
      );
    }
    if (b.t === 'task') {
      return (
        <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', margin: `${Math.max(4, D.bodyGap - 8)}px 0`, fontFamily: bodyFont, fontSize: bodySize, lineHeight: bodyLh, color: b.done ? tk.muted : tk.text }}>
          <TCheck done={b.done} tk={tk} size={18} />
          <span style={{ textDecoration: b.done ? 'line-through' : 'none', textDecorationColor: tk.faint, flex: 1 }}><TRuns runs={b.runs} tk={tk} /></span>
        </div>
      );
    }
    if (b.t === 'quote') {
      return (
        <blockquote key={i} style={{ margin: `${D.bodyGap}px 0`, paddingLeft: 16, borderLeft: `3px solid ${tk.accentSoft}`, fontFamily: tk.font.body, fontStyle: 'italic', fontSize: tk.flags.serifBody ? 18 : 16, color: tk.muted, lineHeight: 1.55 }}>{b.text}</blockquote>
      );
    }
    return (
      <p key={i} style={{ margin: `${D.bodyGap}px 0`, fontFamily: bodyFont, fontSize: bodySize, lineHeight: bodyLh, color: tk.text }}><TRuns runs={b.runs} tk={tk} /></p>
    );
  };

  return (
    <div style={{ flex: 1, minWidth: 0, background: tk.flags.ruled ? tk.bg : tk.panel, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ height: 48, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 22px', borderBottom: tndPaneBorder(tk) }}>
        <span style={{ fontFamily: tk.font.mono, fontSize: 11.5, color: tk.faint }}>{o.slug}.md</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: tk.muted, fontFamily: tk.font.ui }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#5E9A6E' }} />saved
        </span>
      </div>
      <div style={{ flex: 1, overflow: 'hidden', padding: `34px ${D.edPad}px` }}>
        <div style={{ maxWidth: 660, margin: '0 auto' }}>
          <h1 style={{ fontFamily: tk.flags.serifBody ? tk.font.body : tk.font.ui, fontSize: tk.flags.serifBody ? 38 : 30, fontWeight: tk.flags.serifBody ? 600 : 700, color: tk.text, letterSpacing: '-0.02em', lineHeight: 1.12, margin: '0 0 6px' }}>{o.title}</h1>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 18, color: tk.faint, fontSize: 12, fontFamily: tk.font.ui }}>
            <span>Created Jun 9</span><span>·</span><span>4 min read</span>
          </div>
          {o.blocks.map(block)}
        </div>
      </div>
    </div>
  );
}

// ── Properties panel (typed frontmatter) + calendar peek ─────────────────────
function TNDProperties({ tk, D }) {
  const up = tk.flags.uppercaseLabels;
  const Field = ({ label, children }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, minHeight: 30, padding: tk.flags.ruled ? '9px 0' : '0', borderBottom: tk.flags.ruled ? `1px solid ${tk.line}` : 'none' }}>
      <span style={{ width: 74, flexShrink: 0, fontFamily: tk.font.mono, fontSize: 11.5, color: tk.faint, letterSpacing: '0.01em' }}>{label}</span>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>{children}</div>
    </div>
  );
  const fieldVal = (p) => {
    if (p.type === 'date') return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 9px', borderRadius: tk.flags.radius === 0 ? 0 : 7, background: tk.accentSoft, color: tk.accentText, fontSize: 12.5, fontWeight: 600, fontFamily: tk.font.ui }}><TIcon name="calendar" size={12} color={tk.accentText} />Jun 10, 2026</span>;
    if (p.type === 'boolean') return (
      <span style={{ width: 34, height: 19, borderRadius: tk.flags.radius === 0 ? 0 : 999, background: p.v ? tk.accent : tk.lineStrong, position: 'relative', flexShrink: 0, transition: 'background .15s' }}>
        <span style={{ position: 'absolute', top: 2, left: p.v ? 17 : 2, width: 15, height: 15, borderRadius: tk.flags.radius === 0 ? 0 : '50%', background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,.25)' }} />
      </span>
    );
    if (p.type === 'enum') return (
      <span style={{ display: 'inline-flex', gap: 0, borderRadius: tk.flags.radius === 0 ? 0 : 7, overflow: 'hidden', border: `1px solid ${tk.line}` }}>
        {p.options.map((o) => <span key={o} style={{ padding: '3px 9px', fontSize: 11.5, fontWeight: 600, fontFamily: tk.font.ui, background: o === p.v ? tk.accent : 'transparent', color: o === p.v ? '#fff' : tk.muted }}>{o}</span>)}
      </span>
    );
    if (p.type === 'tag[]') return p.v.map((t) => <TTag key={t} name={t} tk={tk} scoped={t === 'decided'} />);
    if (p.type === 'ref[]') return p.v.map((m) => (
      <span key={m} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 9px 2px 3px', borderRadius: 999, background: tk.panel2, fontSize: 12, fontWeight: 600, color: tk.text, fontFamily: tk.font.ui }}>
        <TAvatar slug={m} size={16} tk={tk} />{TND.people[m] ? TND.people[m].name.split(' ')[0] : m}
      </span>
    ));
    if (p.type === 'number') return <span style={{ fontFamily: tk.font.mono, fontSize: 13, fontWeight: 600, color: tk.text }}>{p.v}</span>;
    return <span>{String(p.v)}</span>;
  };
  return (
    <div style={{ width: 300, flexShrink: 0, borderLeft: tndPaneBorder(tk), background: tk.flags.ruled ? tk.bg : tk.panel, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ height: 48, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 18px', borderBottom: tndPaneBorder(tk) }}>
        <span style={{ fontFamily: tk.font.ui, fontSize: 13, fontWeight: 700, color: tk.text, letterSpacing: up ? '0.05em' : '0.01em', textTransform: up ? 'uppercase' : 'none' }}>Properties</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontFamily: tk.font.mono, fontSize: 11, color: tk.faint, padding: '2px 6px', borderRadius: tk.flags.radius === 0 ? 0 : 5, border: `1px solid ${tk.line}` }}>{'{ }'} raw</span>
      </div>
      <div style={{ flex: 1, overflow: 'hidden', padding: '14px 18px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: tk.flags.ruled ? 0 : 11 }}>
          {TND.props.map((p) => <Field key={p.k} label={p.k}>{fieldVal(p)}</Field>)}
        </div>
        <button style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 6, padding: '5px 0', border: 'none', background: 'transparent', color: tk.accentText, fontFamily: tk.font.ui, fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}>
          <TIcon name="plus" size={14} color={tk.accentText} />Add property
        </button>
        <div style={{ height: 1, background: tk.line, margin: '14px 0 16px' }} />
        <div style={{ fontFamily: tk.font.ui, fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: tk.faint, marginBottom: 12 }}>{tk.flags.boxed ? '[ Calendar ]' : 'Calendar'}</div>
        <TMiniCal tk={tk} />
      </div>
    </div>
  );
}

// ── Status bar (keyboard hints) ──────────────────────────────────────────────
function TNDStatusBar({ tk }) {
  const prominent = tk.flags.chrome === 'statusbar';
  return (
    <div style={{
      height: prominent ? 30 : 28, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 16,
      padding: '0 14px', borderTop: tndPaneBorder(tk),
      background: prominent ? tk.accent : tk.panel,
      color: prominent ? 'rgba(255,255,255,.92)' : tk.faint, fontFamily: tk.font.mono, fontSize: 11,
    }}>
      {TND.hints.map((h, i) => (
        <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <kbd style={{ fontWeight: 700, color: prominent ? '#fff' : tk.muted }}>{h.k}</kbd>
          <span style={{ opacity: prominent ? 0.85 : 1 }}>{h.label}</span>
        </span>
      ))}
      <div style={{ flex: 1 }} />
      <span style={{ opacity: prominent ? 0.85 : 1 }}>EDITOR</span>
      <span style={{ opacity: prominent ? 0.85 : 1 }}>1,240 words</span>
    </div>
  );
}

// ── ⌘K command palette overlay ───────────────────────────────────────────────
function TNDPalette({ tk }) {
  const p = TND.palette;
  const groupLabel = (t) => <div style={{ padding: '10px 16px 5px', fontFamily: tk.font.ui, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: tk.faint }}>{t}</div>;
  return (
    <div style={{ position: 'absolute', inset: 0, zIndex: 50, background: tk.mode === 'dark' ? 'rgba(0,0,0,.5)' : 'rgba(20,18,14,.32)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 116 }}>
      <div style={{ width: 560, borderRadius: tk.flags.radius === 0 ? 0 : 14, background: tk.panel, boxShadow: '0 24px 80px rgba(0,0,0,.4), 0 0 0 1px ' + tk.line, overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '15px 18px', borderBottom: `1px solid ${tk.line}` }}>
          <TIcon name="search" size={18} color={tk.muted} />
          <span style={{ fontFamily: tk.font.ui, fontSize: 17, color: tk.text }}>{p.query}<span style={{ display: 'inline-block', width: 2, height: 19, background: tk.accent, marginLeft: 1, verticalAlign: -3, borderRadius: 1 }} /></span>
          <div style={{ flex: 1 }} />
          <kbd style={{ fontFamily: tk.font.mono, fontSize: 11, color: tk.faint, padding: '2px 6px', border: `1px solid ${tk.line}`, borderRadius: 5 }}>esc</kbd>
        </div>
        <div style={{ padding: '4px 0 8px', maxHeight: 320 }}>
          {groupLabel('Commands')}
          {p.results.map((r, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '0 8px', padding: '9px 10px', borderRadius: tk.flags.radius === 0 ? 0 : 9, background: i === 0 ? tk.accentSoft : 'transparent' }}>
              <span style={{ width: 26, height: 26, borderRadius: tk.flags.radius === 0 ? 0 : 7, background: i === 0 ? tk.accent : tk.panel2, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <TIcon name={r.icon} size={15} color={i === 0 ? '#fff' : tk.muted} />
              </span>
              <span style={{ flex: 1, fontFamily: tk.font.ui, fontSize: 14, fontWeight: i === 0 ? 700 : 500, color: i === 0 ? tk.text : tk.text }}>{r.label}</span>
              <span style={{ fontFamily: tk.font.mono, fontSize: 11, color: tk.faint }}>{r.cat}</span>
              {r.bind && <kbd style={{ fontFamily: tk.font.mono, fontSize: 11.5, fontWeight: 700, color: i === 0 ? tk.accentText : tk.muted, padding: '2px 7px', borderRadius: 5, background: tk.panel2 }}>{r.bind}</kbd>}
            </div>
          ))}
          {groupLabel('Recent')}
          {p.recent.map((r, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '0 8px', padding: '8px 10px', borderRadius: tk.flags.radius === 0 ? 0 : 9 }}>
              <span style={{ width: 26, height: 26, borderRadius: tk.flags.radius === 0 ? 0 : 7, background: tk.panel2, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><TIcon name="doc" size={14} color={tk.muted} /></span>
              <span style={{ fontFamily: tk.font.ui, fontSize: 14, fontWeight: 500, color: tk.text }}>{r.label}</span>
              <span style={{ fontFamily: tk.font.ui, fontSize: 12, color: tk.faint }}>{r.sub}</span>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '9px 16px', borderTop: `1px solid ${tk.line}`, background: tk.panel2, fontFamily: tk.font.mono, fontSize: 11, color: tk.faint }}>
          <span><kbd style={{ fontWeight: 700, color: tk.muted }}>↑↓</kbd> navigate</span>
          <span><kbd style={{ fontWeight: 700, color: tk.muted }}>↵</kbd> run</span>
          <span><kbd style={{ fontWeight: 700, color: tk.muted }}>⌘K</kbd> palette</span>
        </div>
      </div>
    </div>
  );
}

// ── Assembled desktop workspace ──────────────────────────────────────────────
function TNDDesktop({ theme, mode, palette }) {
  const tk = tndTokens(theme, mode);
  const D = TND_DENSITY[tk.flags.density];
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: tk.bg, color: tk.text, position: 'relative', overflow: 'hidden' }}>
      <TNDTitleBar tk={tk} />
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <TNDSidebar tk={tk} D={D} />
        <TNDEntryList tk={tk} D={D} />
        <TNDEditor tk={tk} D={D} />
        <TNDProperties tk={tk} D={D} />
      </div>
      <TNDStatusBar tk={tk} />
      {palette && <TNDPalette tk={tk} />}
    </div>
  );
}

Object.assign(window, { TNDEditor, TNDProperties, TNDStatusBar, TNDPalette, TNDDesktop });
