// Settings screens (desktop modal + mobile), Mono style. Shows the Keymap
// panel — the most distinctive for a keyboard-forward app (0007, 0011).

function SettingsDesktop({ mode = 'dark' }) {
  const tk = monoTk(mode);
  const S = TND2.settings;
  return (
    <div style={{ width: '100%', height: '100%', position: 'relative', overflow: 'hidden' }}>
      <TodayDesktop mode={mode} />
      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 900, height: 600, background: tk.panel, border: `1px solid ${tk.lineStrong}`, boxShadow: '0 24px 80px rgba(0,0,0,.5)', display: 'flex', overflow: 'hidden' }}>
          {/* nav */}
          <div style={{ width: 188, flexShrink: 0, borderRight: `1px solid ${tk.lineStrong}`, background: tk.panel2, padding: '14px 0' }}>
            <div style={{ padding: '0 16px 10px', fontFamily: tk.screenFont, fontSize: 13, fontWeight: 700, color: tk.text, letterSpacing: '0.03em', textTransform: 'uppercase' }}>Settings</div>
            {S.nav.map(([label, icon]) => {
              const on = label === S.active;
              return (
                <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '7px 16px', fontFamily: tk.screenFont, fontSize: 12.5, fontWeight: on ? 700 : 500, color: on ? tk.accentText : tk.muted, background: on ? tk.accentSoft : 'transparent', borderLeft: on ? `2px solid ${tk.accent}` : '2px solid transparent' }}>
                  <TIcon name={icon} size={15} color={on ? tk.accent : tk.faint} />{label}
                </div>
              );
            })}
          </div>
          {/* content: Keymap */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '15px 20px', borderBottom: `1px solid ${tk.lineStrong}` }}>
              <span style={{ fontFamily: tk.screenFont, fontSize: 14, fontWeight: 700, color: tk.text, letterSpacing: '0.02em', textTransform: 'uppercase' }}>Keymap</span>
              <span style={{ fontFamily: tk.screenFont, fontSize: 12, color: tk.faint }}>✕</span>
            </div>
            <div style={{ flex: 1, overflow: 'hidden', padding: 20 }}>
              <div style={{ fontFamily: tk.screenFont, fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', color: tk.faint, marginBottom: 9 }}>{brk(tk, 'PRESET')}</div>
              <div style={{ display: 'flex', border: `1px solid ${tk.lineStrong}`, width: 'fit-content', marginBottom: 8 }}>
                {S.presets.map((p, i) => <span key={p} style={{ padding: '6px 16px', fontFamily: tk.screenFont, fontSize: 12.5, fontWeight: 700, color: p === S.preset ? '#fff' : tk.muted, background: p === S.preset ? tk.accent : 'transparent', borderRight: i < 2 ? `1px solid ${tk.lineStrong}` : 'none' }}>{p}</span>)}
              </div>
              <div style={{ fontFamily: tk.screenFont, fontSize: 11.5, color: tk.muted, marginBottom: 18 }}>✓ modal editing enabled in the <span style={{ color: tk.accentText }}>editor</span> zone · sidebar & palette stay modeless</div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 9 }}>
                <span style={{ fontFamily: tk.screenFont, fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', color: tk.faint }}>{brk(tk, 'BINDINGS')}</span>
                <span style={{ fontFamily: tk.screenFont, fontSize: 11, color: tk.faint }}>click a key to rebind</span>
              </div>
              <div style={{ border: `1px solid ${tk.line}` }}>
                {S.bindings.map(([cmd, name, bind], i) => (
                  <div key={cmd} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', borderBottom: i < S.bindings.length - 1 ? `1px solid ${tk.line}` : 'none', background: i === 4 ? tk.accentSoft : 'transparent' }}>
                    <span style={{ width: 200, fontFamily: tk.screenFont, fontSize: 11.5, color: tk.faint }}>{cmd}</span>
                    <span style={{ flex: 1, fontFamily: tk.screenFont, fontSize: 12.5, color: tk.text }}>{name}</span>
                    {i === 4
                      ? <kbd style={{ fontFamily: tk.screenFont, fontSize: 11.5, fontWeight: 700, color: tk.accentText, padding: '3px 10px', border: `1px solid ${tk.accent}`, background: tk.panel }}>press keys…<span style={{ display: 'inline-block', width: 1.5, height: 12, background: tk.accent, marginLeft: 3, verticalAlign: -2 }} /></kbd>
                      : <kbd style={{ fontFamily: tk.screenFont, fontSize: 11.5, fontWeight: 700, color: tk.text, padding: '3px 10px', border: `1px solid ${tk.line}`, background: tk.panel2 }}>{bind}</kbd>}
                  </div>
                ))}
              </div>
              <div style={{ fontFamily: tk.screenFont, fontSize: 11, color: tk.faint, marginTop: 12 }}>bindings travel with you, not the library · conflicts are flagged before save</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SettingsMobile({ mode = 'dark' }) {
  const tk = monoTk(mode);
  const S = TND2.settings;
  return (
    <MPhone mode={mode} tab="set">
      <MPhoneHead tk={tk} title="Keymap" back sub="Settings › Keymap" />
      <div style={{ flex: 1, overflow: 'hidden', padding: '14px 16px' }}>
        <div style={{ fontFamily: tk.screenFont, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', color: tk.faint, marginBottom: 8 }}>{brk(tk, 'PRESET')}</div>
        <div style={{ display: 'flex', border: `1px solid ${tk.lineStrong}`, marginBottom: 8 }}>
          {S.presets.map((p, i) => <span key={p} style={{ flex: 1, textAlign: 'center', padding: '7px 0', fontFamily: tk.screenFont, fontSize: 11.5, fontWeight: 700, color: p === S.preset ? '#fff' : tk.muted, background: p === S.preset ? tk.accent : 'transparent', borderRight: i < 2 ? `1px solid ${tk.lineStrong}` : 'none' }}>{p}</span>)}
        </div>
        <div style={{ fontFamily: tk.screenFont, fontSize: 11, color: tk.muted, marginBottom: 18 }}>✓ modal editing on · editor zone only</div>
        <div style={{ fontFamily: tk.screenFont, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', color: tk.faint, marginBottom: 8 }}>{brk(tk, 'BINDINGS')}</div>
        <div style={{ border: `1px solid ${tk.line}` }}>
          {S.bindings.slice(0, 6).map(([cmd, name, bind], i) => (
            <div key={cmd} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 11px', borderBottom: i < 5 ? `1px solid ${tk.line}` : 'none' }}>
              <span style={{ fontFamily: tk.screenFont, fontSize: 12, color: tk.text }}>{name}</span>
              <kbd style={{ fontFamily: tk.screenFont, fontSize: 11, fontWeight: 700, color: tk.accentText, padding: '2px 8px', border: `1px solid ${tk.line}`, background: tk.panel2 }}>{bind}</kbd>
            </div>
          ))}
        </div>
      </div>
    </MPhone>
  );
}

Object.assign(window, { SettingsDesktop, SettingsMobile });
