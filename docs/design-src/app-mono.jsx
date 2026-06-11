// ToNoteDo · full Mono build-out. Every core screen as a static mockup, desktop
// + mobile, in the Mono terminal system. A global Light/Dark toggle (top of the
// canvas) flips every screen at once — the whole system is token-driven.

const MW = 1360, MH = 880, PW = 380, PH = 800;
const MODE_KEY = 'tnd-mono-mode';
const THEME_KEY = 'tnd-active-theme';
const phoneStyle = (mode) => ({ borderRadius: 40, boxShadow: mode === 'dark' ? '0 0 0 1px rgba(0,0,0,.5), 0 30px 70px rgba(0,0,0,.4)' : '0 0 0 1px rgba(40,38,28,.12), 0 30px 70px rgba(40,38,28,.16)' });

function ControlBar({ themeKey, setThemeKey, mode, setMode }) {
  const seg = (active, onPick, opts) => (
    <div style={{ display: 'flex', alignItems: 'center', border: '1px solid rgba(150,170,150,.30)' }}>
      {opts.map(([k, label], i) => (
        <button key={k} onClick={() => onPick(k)} style={{
          padding: '6px 13px', border: 'none', borderLeft: i ? '1px solid rgba(150,170,150,.18)' : 'none', cursor: 'pointer',
          fontFamily: '"JetBrains Mono", monospace', fontSize: 11.5, fontWeight: 700, letterSpacing: '0.03em',
          color: k === active ? '#fff' : '#9a9384', background: k === active ? '#3E7A52' : 'transparent',
        }}>{label}</button>
      ))}
    </div>
  );
  return (
    <div style={{ position: 'fixed', top: 12, left: '50%', transform: 'translateX(-50%)', zIndex: 200, display: 'flex',
      alignItems: 'center', gap: 10, padding: '6px 10px', background: '#161915', border: '1px solid rgba(150,170,150,.32)', boxShadow: '0 6px 24px rgba(0,0,0,.4)' }}
      onPointerDown={(e) => e.stopPropagation()}>
      <span style={{ fontFamily: '"JetBrains Mono", monospace', fontSize: 10.5, color: '#6f6a5c', letterSpacing: '0.08em', paddingLeft: 2 }}>THEME</span>
      {seg(themeKey, setThemeKey, window.TND_THEMES.map((t) => [t.key, t.name]))}
      <span style={{ width: 1, height: 20, background: 'rgba(150,170,150,.22)' }} />
      {seg(mode, setMode, [['light', 'LIGHT'], ['dark', 'DARK']])}
    </div>
  );
}

function MonoApp() {
  const [themeKey, setThemeKey] = React.useState(() => { try { return localStorage.getItem(THEME_KEY) || 'mono'; } catch { return 'mono'; } });
  const [mode, setMode] = React.useState(() => { try { return localStorage.getItem(MODE_KEY) || 'dark'; } catch { return 'dark'; } });
  React.useEffect(() => { try { localStorage.setItem(THEME_KEY, themeKey); } catch {} }, [themeKey]);
  React.useEffect(() => { try { localStorage.setItem(MODE_KEY, mode); } catch {} }, [mode]);
  // Make every screen's internal monoTk() resolve to the picked theme.
  window.setTndTheme(themeKey);
  const M = window.TND_THEMES.find((t) => t.key === themeKey) || window.TND_THEMES.find((t) => t.key === 'mono');
  const ph = phoneStyle(mode);
  return (
    <>
      <ControlBar themeKey={themeKey} setThemeKey={setThemeKey} mode={mode} setMode={setMode} />
      <DesignCanvas>
        <DCSection id="intro" title={`ToNoteDo · ${M.name}`} subtitle="The whole app as static mockups — desktop + mobile parity. Use the THEME and LIGHT / DARK switchers (top) to re-skin every screen at once. Drag to reorder · click any frame's ⤢ to focus.">
          <DCArtboard id="legend" label="Read me" width={560} height={MH} style={{ background: M[mode].bg }}><MonoLegend mode={mode} theme={M} /></DCArtboard>
        </DCSection>

        <DCSection id="workspace" title="Workspace & editor" subtitle="The home screen — group tree, entry list, live-inline editor, properties.">
          <DCArtboard id="ws-d" label="Desktop · Workspace" width={MW} height={MH}><TNDDesktop theme={M} mode={mode} /></DCArtboard>
          <DCArtboard id="ws-p" label="Desktop · ⌘K palette" width={MW} height={MH}><TNDDesktop theme={M} mode={mode} palette /></DCArtboard>
          <DCArtboard id="ws-ml" label="Mobile · Entry list" width={PW} height={PH} style={ph}><TNDMobile theme={M} mode={mode} screen="list" /></DCArtboard>
          <DCArtboard id="ws-me" label="Mobile · Editor" width={PW} height={PH} style={ph}><TNDMobile theme={M} mode={mode} screen="editor" /></DCArtboard>
        </DCSection>

        <DCSection id="today" title="Today / agenda" subtitle="Overdue · today · upcoming, derived from due dates.">
          <DCArtboard id="td-d" label="Desktop · Today" width={MW} height={MH}><TodayDesktop mode={mode} /></DCArtboard>
          <DCArtboard id="td-m" label="Mobile · Today" width={PW} height={PH} style={ph}><TodayMobile mode={mode} /></DCArtboard>
        </DCSection>

        <DCSection id="calendar" title="Calendar" subtitle="Month / week / day — a derived view, never a separate object type.">
          <DCArtboard id="cal-mo" label="Desktop · Month" width={MW} height={MH}><CalMonthDesktop mode={mode} /></DCArtboard>
          <DCArtboard id="cal-wk" label="Desktop · Week" width={MW} height={MH}><CalWeekDesktop mode={mode} /></DCArtboard>
          <DCArtboard id="cal-dy" label="Desktop · Day" width={MW} height={MH}><CalDayDesktop mode={mode} /></DCArtboard>
          <DCArtboard id="cal-mom" label="Mobile · Month" width={PW} height={PH} style={ph}><CalMonthMobile mode={mode} /></DCArtboard>
          <DCArtboard id="cal-wkm" label="Mobile · Week" width={PW} height={PH} style={ph}><CalWeekMobile mode={mode} /></DCArtboard>
          <DCArtboard id="cal-dym" label="Mobile · Day" width={PW} height={PH} style={ph}><CalDayMobile mode={mode} /></DCArtboard>
        </DCSection>

        <DCSection id="search" title="Search" subtitle="⌘P · scoped filter chips, typed result tabs, highlighted matches.">
          <DCArtboard id="se-d" label="Desktop · Search" width={MW} height={MH}><SearchDesktop mode={mode} /></DCArtboard>
          <DCArtboard id="se-m" label="Mobile · Search" width={PW} height={PH} style={ph}><SearchMobile mode={mode} /></DCArtboard>
        </DCSection>

        <DCSection id="keys" title="Command & keyboard" subtitle="The palette and the contextual cheatsheet — the discovery surfaces.">
          <DCArtboard id="ch-d" label="Desktop · Cheatsheet (?)" width={MW} height={MH}><CheatsheetDesktop mode={mode} /></DCArtboard>
          <DCArtboard id="pal-m" label="Mobile · ⌘K palette" width={PW} height={PH} style={ph}><PaletteMobile mode={mode} /></DCArtboard>
          <DCArtboard id="ch-m" label="Mobile · Cheatsheet" width={PW} height={PH} style={ph}><CheatsheetMobile mode={mode} /></DCArtboard>
        </DCSection>

        <DCSection id="settings" title="Settings" subtitle="Appearance · editor · keymap · library · plugins. Shown: keymap + presets.">
          <DCArtboard id="set-d" label="Desktop · Keymap" width={MW} height={MH}><SettingsDesktop mode={mode} /></DCArtboard>
          <DCArtboard id="set-m" label="Mobile · Keymap" width={PW} height={PH} style={ph}><SettingsMobile mode={mode} /></DCArtboard>
        </DCSection>

        <DCSection id="groups" title="Groups & schema" subtitle="The _group.md config surface — advisory property schema + scoped tags.">
          <DCArtboard id="gr-d" label="Desktop · Schema editor" width={MW} height={MH}><GroupsDesktop mode={mode} /></DCArtboard>
          <DCArtboard id="gr-m" label="Mobile · Schema editor" width={PW} height={PH} style={ph}><GroupsMobile mode={mode} /></DCArtboard>
        </DCSection>

        <DCSection id="newentry" title="New entry / quick capture" subtitle="One keystroke (⌘N) → a markdown file. Group schema offers properties.">
          <DCArtboard id="ne-d" label="Desktop · Capture" width={MW} height={MH}><NewEntryDesktop mode={mode} /></DCArtboard>
          <DCArtboard id="ne-m" label="Mobile · Capture" width={PW} height={PH} style={ph}><NewEntryMobile mode={mode} /></DCArtboard>
        </DCSection>

        <DCSection id="people" title="People / mentions" subtitle="The @mention directory — _people/, mention counts, last seen.">
          <DCArtboard id="pe-d" label="Desktop · People" width={MW} height={MH}><PeopleDesktop mode={mode} /></DCArtboard>
          <DCArtboard id="pe-m" label="Mobile · People" width={PW} height={PH} style={ph}><PeopleMobile mode={mode} /></DCArtboard>
        </DCSection>

        <DCSection id="tags" title="Tags browser" subtitle="Global tags with counts + scoped tags with parent/child hierarchy.">
          <DCArtboard id="tg-d" label="Desktop · Tags" width={MW} height={MH}><TagsDesktop mode={mode} /></DCArtboard>
          <DCArtboard id="tg-m" label="Mobile · Tags" width={PW} height={PH} style={ph}><TagsMobile mode={mode} /></DCArtboard>
        </DCSection>

        <DCSection id="plugins" title="Plugins manager" subtitle="Providers & processors, permission grants, sandboxed, synced with the library.">
          <DCArtboard id="pl-d" label="Desktop · Plugins" width={MW} height={MH}><PluginsDesktop mode={mode} /></DCArtboard>
          <DCArtboard id="pl-m" label="Mobile · Plugins" width={PW} height={PH} style={ph}><PluginsMobile mode={mode} /></DCArtboard>
        </DCSection>
      </DesignCanvas>
    </>
  );
}

function MonoLegend({ mode, theme }) {
  const tk = tndTokens(theme, mode);
  const screens = ['Workspace & editor', 'Today / agenda', 'Calendar M/W/D', 'Search', 'Command & keyboard', 'Settings', 'Groups & schema', 'New entry', 'People', 'Tags', 'Plugins'];
  return (
    <div style={{ height: '100%', padding: '38px 36px', fontFamily: tk.screenFont, color: tk.text, display: 'flex', flexDirection: 'column', boxSizing: 'border-box', background: tk.bg }}>
      <div style={{ fontFamily: tk.font.mono, fontSize: 11, fontWeight: 700, letterSpacing: '0.14em', color: tk.accentText }}>{brk(tk, `${theme.name.toUpperCase()} · BUILD-OUT`)}</div>
      <div style={{ fontFamily: tk.flags.serifBody ? tk.font.body : tk.screenFont, fontSize: 33, fontWeight: 800, letterSpacing: '-0.01em', lineHeight: 1.1, margin: '14px 0 16px', color: tk.text }}>The whole app,<br />one system.</div>
      <p style={{ fontSize: 13.5, lineHeight: 1.7, color: tk.muted, margin: '0 0 10px' }}>Every core screen of ToNoteDo, rendered in the <b style={{ color: tk.text }}>{theme.name}</b> system — {theme.tagline.toLowerCase()}.</p>
      <p style={{ fontSize: 13.5, lineHeight: 1.7, color: tk.muted, margin: '0 0 14px' }}>Desktop + mobile parity for each (0013): focus zones become screens, the palette becomes a pull-down, context menus become long-press.</p>
      <p style={{ fontSize: 12.5, lineHeight: 1.6, color: tk.accentText, margin: '0 0 22px' }}>↑ Re-skin every screen with the THEME and LIGHT / DARK switchers at the top of the canvas.</p>

      <div style={{ fontFamily: tk.font.mono, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.1em', color: tk.faint, marginBottom: 12 }}>{brk(tk, 'SCREENS')}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 16px' }}>
        {screens.map((s, i) => (
          <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 12.5, color: tk.text }}>
            <span style={{ fontFamily: tk.font.mono, color: tk.accentText, fontWeight: 700 }}>{String(i + 1).padStart(2, '0')}</span>{s}
          </div>
        ))}
      </div>

      <div style={{ flex: 1 }} />
      <div style={{ borderTop: `1px solid ${tk.line}`, paddingTop: 16, display: 'flex', gap: 18, flexWrap: 'wrap' }}>
        {[['accent', tk.accent], ['amber', tk.amber], ['panel', tk.panel2], ['text', tk.text]].map(([n, c]) => (
          <span key={n} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: tk.faint, fontFamily: tk.font.mono }}><span style={{ width: 14, height: 14, background: c, border: `1px solid ${tk.line}`, borderRadius: tk.flags.radius === 0 ? 0 : 4 }} />{n}</span>
        ))}
      </div>
      <div style={{ marginTop: 14, fontSize: 11.5, lineHeight: 1.6, color: tk.faint }}>Light + dark both first-class · all five directions share one component layer · ready to turn interactive on your word.</div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<MonoApp />);
