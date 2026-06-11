// Mono build-out shells. MShell = desktop chrome (title bar · sidebar · status
// bar) with a slot for each screen's main content. MPhone = mobile frame
// (status bar · screen body · home indicator). Both consume Mono tokens (tk).
// Loaded after bits.jsx.

// Active theme is global so every screen's internal monoTk() call resolves to
// the same one. setTndTheme() is called synchronously from the app on render.
let TND_ACTIVE_KEY = 'mono';
function setTndTheme(k) { TND_ACTIVE_KEY = k; }
const MONO_THEME = () => window.TND_THEMES.find((t) => t.key === TND_ACTIVE_KEY) || window.TND_THEMES.find((t) => t.key === 'mono');
const monoTk = (mode = 'dark') => tndTokens(MONO_THEME(), mode);
// Section-label decorator: bracketed for terminal (boxed) themes, plain otherwise.
function brk(tk, t) { return tk.flags.boxed ? `[ ${t} ]` : t; }

// Bracketed uppercase section label, the Mono signature.
function MLabel({ children, tk, style }) {
  return <div style={{ fontFamily: tk.screenFont, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.08em', color: tk.faint, ...style }}>{brk(tk, children)}</div>;
}

// Hairline-boxed panel.
function MBox({ children, tk, style, pad = 0 }) {
  return <div style={{ border: `1px solid ${tk.line}`, background: tk.panel, padding: pad, ...style }}>{children}</div>;
}

// ── Desktop title bar ────────────────────────────────────────────────────────
function MTitleBar({ tk, crumb }) {
  return (
    <div style={{ height: 44, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 14, padding: '0 12px 0 14px', borderBottom: `1px solid ${tk.lineStrong}`, background: tk.panel, fontFamily: tk.screenFont }}>
      <span style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
        {tk.flags.boxed
          ? <><span style={{ width: 9, height: 9, border: `1px solid ${tk.lineStrong}` }} /><span style={{ color: tk.accentText, fontWeight: 700, fontSize: 13 }}>~/library</span></>
          : <><span style={{ width: 20, height: 20, borderRadius: tk.flags.radius === 0 ? 0 : 6, background: tk.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 800, fontSize: 12 }}>T</span><span style={{ color: tk.text, fontWeight: 700, fontSize: 13.5, letterSpacing: '-0.01em' }}>My Library</span></>}
      </span>
      <span style={{ color: tk.faint }}>{tk.flags.boxed ? '›' : '/'}</span>
      <span style={{ color: tk.muted, fontSize: 12.5, fontWeight: 500, letterSpacing: '0.02em', textTransform: tk.flags.boxed ? 'uppercase' : 'none' }}>{crumb}</span>
      <div style={{ flex: 1 }} />
      <span style={{ display: 'flex', alignItems: 'center', gap: 7, height: 28, padding: '0 9px', border: `1px solid ${tk.line}`, borderRadius: tk.flags.radius === 0 ? 0 : 8, color: tk.faint, fontSize: 12, minWidth: 150 }}>
        <TIcon name="search" size={13} color={tk.faint} /><span style={{ flex: 1 }}>search…</span><kbd style={{ fontSize: 11, color: tk.muted, fontFamily: tk.font.mono }}>⌘P</kbd>
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6, height: 28, padding: '0 11px', borderRadius: tk.flags.radius === 0 ? 0 : 8, background: tk.accent, color: '#fff', fontSize: 12, fontWeight: 700 }}>{tk.flags.boxed ? '+ NEW' : '+ New'}</span>
      <TIcon name="settings" size={17} color={tk.muted} />
    </div>
  );
}

// ── Desktop sidebar (active highlight by id) ─────────────────────────────────
function MSidebar({ tk, active }) {
  const Row = ({ id, icon, label, hint, count, indent = 0, color, hasChildren, open }) => {
    const on = id === active;
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, height: 28, padding: `0 12px 0 ${12 + indent * 15}px`, background: on ? tk.accentSoft : 'transparent', color: on ? tk.accentText : tk.muted, fontFamily: tk.screenFont, fontSize: 12.5, fontWeight: on ? 700 : 500, position: 'relative' }}>
        {on && <span style={{ position: 'absolute', left: 0, top: 5, bottom: 5, width: 2, background: tk.accent }} />}
        <span style={{ width: 9, color: tk.faint, fontWeight: 700 }}>{hasChildren ? (open ? '▾' : '▸') : ''}</span>
        {color && <span style={{ width: 7, height: 7, background: color, flexShrink: 0 }} />}
        <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
        {hint && <kbd style={{ fontSize: 10.5, color: tk.faint }}>{hint}</kbd>}
        {count != null && <span style={{ fontSize: 11, color: tk.faint }}>{count}</span>}
      </div>
    );
  };
  return (
    <div style={{ width: 222, flexShrink: 0, borderRight: `1px solid ${tk.lineStrong}`, background: tk.panel, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ flex: 1, paddingTop: 8 }}>
        <Row id="today" label="Today" hint="" />
        <Row id="calendar" label="Calendar" hint="⌘⌥M" />
        <Row id="search" label="Search" hint="⌘P" />
        <Row id="tags" label="Tags" />
        <Row id="people" label="People" />
        <MLabel tk={tk} style={{ padding: '14px 12px 6px' }}>GROUPS</MLabel>
        <Row id="work" label="Work" count={23} hasChildren open />
        <Row id="atlas" label="Project Atlas" count={9} indent={1} color={tk.accent} />
        <Row id="meetings" label="Meetings" count={11} indent={1} />
        <Row id="reading" label="Reading" count={41} />
        <Row id="journal" label="Journal" count={128} />
        <Row id="ideas" label="Ideas" count={17} />
      </div>
      <div style={{ padding: '9px 12px', borderTop: `1px solid ${tk.line}`, display: 'flex', alignItems: 'center', gap: 7, color: tk.faint, fontSize: 11, fontFamily: tk.screenFont }}>
        <span style={{ width: 7, height: 7, background: tk.accent }} />local · synced 2m
      </div>
    </div>
  );
}

// ── Desktop status bar (prominent keybindings on accent) ─────────────────────
function MStatusBar({ tk, zone = 'EDITOR', right = '1,240 words' }) {
  return (
    <div style={{ height: 28, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 15, padding: '0 13px', background: tk.accent, color: 'rgba(255,255,255,.94)', fontFamily: tk.screenFont, fontSize: 11 }}>
      {TND.hints.map((h, i) => (
        <span key={i} style={{ display: 'inline-flex', gap: 5 }}><kbd style={{ fontWeight: 700, color: '#fff', fontFamily: tk.font.mono }}>{h.k}</kbd><span style={{ opacity: 0.85 }}>{h.label}</span></span>
      ))}
      <div style={{ flex: 1 }} />
      <span style={{ opacity: 0.85 }}>{zone}</span>
      <span style={{ opacity: 0.85 }}>{right}</span>
    </div>
  );
}

// ── Desktop shell ────────────────────────────────────────────────────────────
function MShell({ mode = 'dark', active, crumb, zone, right, children }) {
  const tk = monoTk(mode);
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: tk.bg, color: tk.text, overflow: 'hidden' }}>
      <MTitleBar tk={tk} crumb={crumb} />
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <MSidebar tk={tk} active={active} />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: tk.flags ? tk.bg : tk.bg }}>{children}</div>
      </div>
      <MStatusBar tk={tk} zone={zone} right={right} />
    </div>
  );
}

// A boxed content header used at the top of most screen bodies.
function MScreenHead({ tk, title, sub, right }) {
  return (
    <div style={{ height: 46, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 18px', borderBottom: `1px solid ${tk.lineStrong}` }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ fontFamily: tk.screenFont, fontSize: 14, fontWeight: 700, color: tk.text, letterSpacing: tk.flags.boxed ? '0.02em' : '-0.01em', textTransform: tk.flags.boxed ? 'uppercase' : 'none' }}>{title}</span>
        {sub && <span style={{ fontFamily: tk.screenFont, fontSize: 12, color: tk.faint }}>{sub}</span>}
      </div>
      {right}
    </div>
  );
}

// ── Mobile frame ─────────────────────────────────────────────────────────────
function MPhoneStatus({ tk }) {
  return (
    <div style={{ height: 40, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 22px 0 24px', fontFamily: tk.screenFont }}>
      <span style={{ fontSize: 13, fontWeight: 700, color: tk.text }}>9:41</span>
      <span style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 5 }}>
        <svg width="16" height="10" viewBox="0 0 16 10" fill={tk.text}><rect x="0" y="6.5" width="2.6" height="3.5"/><rect x="4" y="4.5" width="2.6" height="5.5"/><rect x="8" y="2.5" width="2.6" height="7.5"/><rect x="12" y="0" width="2.6" height="10"/></svg>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 1.5 }}><span style={{ width: 21, height: 10, border: `1px solid ${tk.muted}`, display: 'inline-flex', alignItems: 'center', padding: 1.5 }}><span style={{ width: 12, height: '100%', background: tk.text }} /></span><span style={{ width: 1.5, height: 4, background: tk.muted }} /></span>
      </span>
    </div>
  );
}
function MPhoneHome({ tk }) {
  return <div style={{ height: 20, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><span style={{ width: 120, height: 4, background: tk.text, opacity: 0.34 }} /></div>;
}
// Bottom tab bar (Mono): bracketed, monospace.
function MPhoneTabs({ tk, active }) {
  const tabs = [['today', 'TODAY', 'Today'], ['cal', 'CAL', 'Calendar'], ['search', 'FIND', 'Search'], ['set', 'SET', 'Settings']];
  return (
    <div style={{ flexShrink: 0, position: 'relative', borderTop: `1px solid ${tk.lineStrong}`, background: tk.panel, padding: '8px 14px 5px', display: 'flex', justifyContent: 'space-between' }}>
      {tabs.map(([id, lb, full]) => {
        const on = id === active;
        const text = tk.flags.boxed ? lb : full;
        return <span key={id} style={{ flex: 1, textAlign: 'center', fontFamily: tk.screenFont, fontSize: 11, fontWeight: on ? 700 : 500, color: on ? tk.accentText : tk.faint, letterSpacing: tk.flags.boxed ? '0.04em' : '0' }}>{on && tk.flags.boxed ? `[${text}]` : text}</span>;
      })}
    </div>
  );
}

function MPhone({ mode = 'dark', children, tab, noTabs }) {
  const tk = monoTk(mode);
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', background: tk.bg, color: tk.text, overflow: 'hidden' }}>
      <MPhoneStatus tk={tk} />
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>{children}</div>
      {!noTabs && <MPhoneTabs tk={tk} active={tab} />}
      <MPhoneHome tk={tk} />
    </div>
  );
}

// Mobile header bar with optional back chevron.
function MPhoneHead({ tk, title, back, right, sub }) {
  return (
    <div style={{ flexShrink: 0, padding: '10px 16px 12px', borderBottom: `1px solid ${tk.line}` }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {back && <span style={{ color: tk.accentText, fontFamily: tk.screenFont, fontSize: 14 }}>‹</span>}
          <span style={{ fontFamily: tk.screenFont, fontSize: 18, fontWeight: 800, color: tk.text, letterSpacing: tk.flags.boxed ? '0.01em' : '-0.02em', textTransform: tk.flags.boxed ? 'uppercase' : 'none' }}>{title}</span>
        </span>
        {right}
      </div>
      {sub && <div style={{ fontFamily: tk.screenFont, fontSize: 12, color: tk.faint, marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

Object.assign(window, { MONO_THEME, monoTk, setTndTheme, brk, MLabel, MBox, MTitleBar, MSidebar, MStatusBar, MShell, MScreenHead, MPhone, MPhoneHead, MPhoneTabs, MPhoneStatus, MPhoneHome });
