// Group + schema management and new-entry quick capture (desktop + mobile),
// Mono style. The schema editor is the `_group.md` config surface (0003);
// schemas are advisory. Loaded after shell.jsx.

const TYPE_COLORS = (tk) => ({ string: tk.muted, text: tk.muted, number: tk.amber, boolean: tk.accent, date: tk.accentText, datetime: tk.accentText, enum: tk.amber, 'tag[]': tk.accentText, 'ref[]': tk.accentText });

function SchemaTable({ tk, dense }) {
  const C = TYPE_COLORS(tk);
  const G = TND2.schema;
  return (
    <div style={{ border: `1px solid ${tk.line}` }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr', borderBottom: `1px solid ${tk.lineStrong}`, background: tk.panel2 }}>
        {['PROPERTY', 'TYPE', 'DEFAULT'].map((h) => <div key={h} style={{ padding: '7px 11px', fontFamily: tk.screenFont, fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', color: tk.faint }}>{h}</div>)}
      </div>
      {G.props.map(([k, type, def], i) => (
        <div key={k} style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr', borderBottom: i < G.props.length - 1 ? `1px solid ${tk.line}` : 'none' }}>
          <div style={{ padding: '8px 11px', fontFamily: tk.screenFont, fontSize: 12.5, fontWeight: 700, color: tk.text }}>{k}</div>
          <div style={{ padding: '8px 11px', fontFamily: tk.screenFont, fontSize: 12 }}><span style={{ color: C[type] || tk.muted }}>{type}</span></div>
          <div style={{ padding: '8px 11px', fontFamily: tk.screenFont, fontSize: 12, color: tk.faint }}>{type === 'enum' ? G.enumOptions.join(' | ') : def}</div>
        </div>
      ))}
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 11px', borderTop: `1px solid ${tk.line}`, fontFamily: tk.screenFont, fontSize: 12, color: tk.accentText, fontWeight: 700 }}>+ add property</div>
    </div>
  );
}

function GroupsDesktop({ mode = 'dark' }) {
  const tk = monoTk(mode);
  const G = TND2.schema;
  return (
    <MShell mode={mode} active="reading" crumb="Reading / Configure" zone="GROUP" right="_group.md">
      <MScreenHead tk={tk} title="Reading" sub="_group.md" right={<span style={{ display: 'flex', gap: 8, fontFamily: tk.screenFont, fontSize: 12 }}><span style={{ padding: '3px 10px', border: `1px solid ${tk.lineStrong}`, color: tk.text, fontWeight: 700 }}>Open as entry</span></span>} />
      <div style={{ flex: 1, overflow: 'hidden', padding: '24px 0' }}>
        <div style={{ maxWidth: 700, margin: '0 auto', padding: '0 24px' }}>
          <div style={{ fontFamily: tk.screenFont, fontSize: 13, color: tk.muted, lineHeight: 1.6, marginBottom: 22, paddingBottom: 18, borderBottom: `1px solid ${tk.line}` }}>{G.desc}</div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 9 }}>
            <span style={{ fontFamily: tk.screenFont, fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', color: tk.faint }}>{brk(tk, 'SCHEMA')}</span>
            <span style={{ fontFamily: tk.screenFont, fontSize: 11, color: tk.faint }}>advisory · inherited by nested groups</span>
          </div>
          <SchemaTable tk={tk} />

          <div style={{ fontFamily: tk.screenFont, fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', color: tk.faint, margin: '26px 0 9px' }}>{brk(tk, 'SCOPED TAGS')}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {G.scopedTags.map((t) => <span key={t} style={{ fontFamily: tk.screenFont, fontSize: 12, color: tk.accentText, padding: '3px 9px', border: `1px solid ${tk.lineStrong}` }}>#{t}</span>)}
            <span style={{ fontFamily: tk.screenFont, fontSize: 12, color: tk.faint, padding: '3px 9px', border: `1px dashed ${tk.line}` }}>+ add</span>
          </div>

          <div style={{ fontFamily: tk.screenFont, fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', color: tk.faint, margin: '26px 0 9px' }}>{brk(tk, 'DEFAULT VIEW')}</div>
          <div style={{ display: 'flex', border: `1px solid ${tk.lineStrong}`, width: 'fit-content' }}>
            {['note', 'task-list'].map((v, i) => <span key={v} style={{ padding: '6px 16px', fontFamily: tk.screenFont, fontSize: 12.5, fontWeight: 700, color: v === G.view ? '#fff' : tk.muted, background: v === G.view ? tk.accent : 'transparent', borderRight: i < 1 ? `1px solid ${tk.lineStrong}` : 'none' }}>{v}</span>)}
          </div>
        </div>
      </div>
    </MShell>
  );
}

function GroupsMobile({ mode = 'dark' }) {
  const tk = monoTk(mode);
  const G = TND2.schema;
  const C = TYPE_COLORS(tk);
  return (
    <MPhone mode={mode} tab="set">
      <MPhoneHead tk={tk} title="Reading" back sub="_group.md · configure" />
      <div style={{ flex: 1, overflow: 'hidden', padding: '14px 16px' }}>
        <div style={{ fontFamily: tk.screenFont, fontSize: 12, color: tk.muted, lineHeight: 1.55, marginBottom: 18 }}>{G.desc}</div>
        <div style={{ fontFamily: tk.screenFont, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', color: tk.faint, marginBottom: 8 }}>{brk(tk, 'SCHEMA')}</div>
        <div style={{ border: `1px solid ${tk.line}` }}>
          {G.props.map(([k, type, def], i) => (
            <div key={k} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 11px', borderBottom: i < G.props.length - 1 ? `1px solid ${tk.line}` : 'none' }}>
              <span style={{ fontFamily: tk.screenFont, fontSize: 12.5, fontWeight: 700, color: tk.text }}>{k}</span>
              <span style={{ fontFamily: tk.screenFont, fontSize: 11.5, color: C[type] || tk.muted }}>{type}</span>
            </div>
          ))}
          <div style={{ padding: '9px 11px', borderTop: `1px solid ${tk.line}`, fontFamily: tk.screenFont, fontSize: 12, color: tk.accentText, fontWeight: 700 }}>+ add property</div>
        </div>
        <div style={{ fontFamily: tk.screenFont, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', color: tk.faint, margin: '20px 0 8px' }}>{brk(tk, 'SCOPED TAGS')}</div>
        <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>
          {G.scopedTags.map((t) => <span key={t} style={{ fontFamily: tk.screenFont, fontSize: 11.5, color: tk.accentText, padding: '3px 8px', border: `1px solid ${tk.lineStrong}` }}>#{t}</span>)}
        </div>
      </div>
    </MPhone>
  );
}

// ── New entry / quick capture ────────────────────────────────────────────────
function captureChips(tk) {
  return TND2.capture.schemaProps.map(([k, type]) => (
    <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: tk.screenFont, fontSize: 11.5, padding: '3px 9px', border: `1px dashed ${tk.lineStrong}`, color: tk.muted }}>
      + {k} <span style={{ color: tk.faint }}>{type}</span>
    </span>
  ));
}

function NewEntryDesktop({ mode = 'dark' }) {
  const tk = monoTk(mode);
  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
      <TodayDesktop mode={mode} />
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 150 }}>
        <div style={{ width: 580, background: tk.panel, border: `1px solid ${tk.lineStrong}`, boxShadow: '0 24px 80px rgba(0,0,0,.5)' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', borderBottom: `1px solid ${tk.line}` }}>
            <span style={{ fontFamily: tk.screenFont, fontSize: 11.5, fontWeight: 700, letterSpacing: '0.05em', color: tk.faint }}>NEW ENTRY</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: tk.screenFont, fontSize: 12, color: tk.text, padding: '3px 9px', border: `1px solid ${tk.lineStrong}` }}>in <span style={{ color: tk.accentText, fontWeight: 700 }}>Project Atlas</span> ▾</span>
          </div>
          <div style={{ padding: '20px 18px 8px' }}>
            <div style={{ fontFamily: tk.screenFont, fontSize: 21, fontWeight: 700, color: tk.text }}># <span style={{ color: tk.faint, fontWeight: 400 }}>Untitled</span><span style={{ display: 'inline-block', width: 2, height: 20, background: tk.accent, marginLeft: 1, verticalAlign: -3 }} /></div>
            <div style={{ fontFamily: tk.screenFont, fontSize: 13, color: tk.faint, marginTop: 12, lineHeight: 1.6 }}>Start writing… use <span style={{ color: tk.accentText }}>#tag</span>, <span style={{ color: tk.accentText }}>@mention</span>, <span style={{ color: tk.accentText }}>[[link]]</span></div>
          </div>
          <div style={{ padding: '4px 18px 16px' }}>
            <div style={{ fontFamily: tk.screenFont, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', color: tk.faint, marginBottom: 8 }}>SCHEMA OFFERS</div>
            <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>{captureChips(tk)}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '10px 16px', borderTop: `1px solid ${tk.line}`, background: tk.panel2, fontFamily: tk.screenFont, fontSize: 11, color: tk.faint }}>
            <span><kbd style={{ fontWeight: 700, color: tk.muted }}>↵</kbd> create</span>
            <span><kbd style={{ fontWeight: 700, color: tk.muted }}>⌘↵</kbd> create & open</span>
            <span><kbd style={{ fontWeight: 700, color: tk.muted }}>esc</kbd> cancel</span>
            <div style={{ flex: 1 }} />
            <span>→ work/atlas/untitled.md</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function NewEntryMobile({ mode = 'dark' }) {
  const tk = monoTk(mode);
  return (
    <MPhone mode={mode} noTabs>
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', inset: 0, opacity: 0.25, pointerEvents: 'none' }}>
          {TND.entries.slice(0, 4).map((e) => <div key={e.id} style={{ padding: '14px 16px', borderBottom: `1px solid ${tk.line}`, fontFamily: tk.screenFont, fontSize: 13, color: tk.muted }}>{e.title}</div>)}
        </div>
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.45)' }} />
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, background: tk.panel, border: `1px solid ${tk.lineStrong}`, boxShadow: '0 -20px 50px rgba(0,0,0,.5)' }}>
          <div style={{ display: 'flex', justifyContent: 'center', padding: '8px 0 2px' }}><span style={{ width: 36, height: 4, background: tk.lineStrong }} /></div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 16px', borderBottom: `1px solid ${tk.line}` }}>
            <span style={{ fontFamily: tk.screenFont, fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', color: tk.faint }}>NEW ENTRY</span>
            <span style={{ fontFamily: tk.screenFont, fontSize: 12, color: tk.text }}>in <span style={{ color: tk.accentText, fontWeight: 700 }}>Project Atlas</span> ▾</span>
          </div>
          <div style={{ padding: '18px 16px' }}>
            <div style={{ fontFamily: tk.screenFont, fontSize: 19, fontWeight: 700, color: tk.text }}># <span style={{ color: tk.faint, fontWeight: 400 }}>Untitled</span><span style={{ display: 'inline-block', width: 2, height: 18, background: tk.accent, marginLeft: 1, verticalAlign: -3 }} /></div>
            <div style={{ fontFamily: tk.screenFont, fontSize: 12.5, color: tk.faint, marginTop: 12 }}>Start writing…</div>
            <div style={{ fontFamily: tk.screenFont, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', color: tk.faint, margin: '20px 0 8px' }}>SCHEMA OFFERS</div>
            <div style={{ display: 'flex', gap: 7, flexWrap: 'wrap' }}>{captureChips(tk)}</div>
          </div>
          {/* accessory row */}
          <div style={{ display: 'flex', padding: '0 6px 6px', height: 42, alignItems: 'center', borderTop: `1px solid ${tk.line}` }}>
            {['H', '•', '☑', '#', '@', '[[', '↵'].map((g, i) => <span key={i} style={{ flex: 1, textAlign: 'center', margin: '0 3px', padding: '7px 0', border: `1px solid ${tk.line}`, fontFamily: tk.screenFont, fontSize: g.length > 1 ? 11 : 14, fontWeight: 700, color: g === '↵' ? '#fff' : (['#', '@', '[['].includes(g) ? tk.accentText : tk.muted), background: g === '↵' ? tk.accent : tk.panel2 }}>{g}</span>)}
          </div>
        </div>
      </div>
    </MPhone>
  );
}

Object.assign(window, { TYPE_COLORS, SchemaTable, GroupsDesktop, GroupsMobile, captureChips, NewEntryDesktop, NewEntryMobile });
