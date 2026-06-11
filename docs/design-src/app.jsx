// Assembles the five style explorations onto the design canvas. Each section is
// one visual system, shown four ways: desktop light, desktop dark (with the ⌘K
// palette open), mobile light (entry list), mobile dark (editor).

const DESK_W = 1360, DESK_H = 880;
const PHONE_W = 380, PHONE_H = 800;
const phoneStyle = (tk) => ({ borderRadius: 40, boxShadow: `0 0 0 1px rgba(0,0,0,.06), ${'0 30px 70px rgba(20,18,14,.18)'}` });

function App() {
  return (
    <DesignCanvas>
      <DCSection id="intro" title="ToNoteDo — 5 style directions" subtitle="One canonical screen (group tree → entry list → live-inline editor → properties), re-skinned five ways. Each in light + dark, desktop + mobile. Drag to reorder · click any frame's ⤢ to focus.">
        <DCArtboard id="legend" label="Read me" width={560} height={DESK_H} style={{ background: '#FBF9F4' }}>
          <Legend />
        </DCArtboard>
      </DCSection>

      {window.TND_THEMES.map((theme) => (
        <DCSection key={theme.key} id={theme.key} title={theme.name} subtitle={theme.tagline}>
          <DCArtboard id={theme.key + '-d-l'} label="Desktop · Light" width={DESK_W} height={DESK_H}>
            <TNDDesktop theme={theme} mode="light" />
          </DCArtboard>
          <DCArtboard id={theme.key + '-d-d'} label="Desktop · Dark · ⌘K palette" width={DESK_W} height={DESK_H}>
            <TNDDesktop theme={theme} mode="dark" palette />
          </DCArtboard>
          <DCArtboard id={theme.key + '-m-l'} label="Mobile · Light · List" width={PHONE_W} height={PHONE_H} style={phoneStyle()}>
            <TNDMobile theme={theme} mode="light" screen="list" />
          </DCArtboard>
          <DCArtboard id={theme.key + '-m-d'} label="Mobile · Dark · Editor" width={PHONE_W} height={PHONE_H} style={phoneStyle()}>
            <TNDMobile theme={theme} mode="dark" screen="editor" />
          </DCArtboard>
        </DCSection>
      ))}
    </DesignCanvas>
  );
}

function Legend() {
  const swatches = window.TND_THEMES.map((t) => ({ name: t.name, c: t.light.accent, tag: t.tagline }));
  return (
    <div style={{ height: '100%', padding: '38px 40px', fontFamily: '"Hanken Grotesk", sans-serif', color: '#2C2620', display: 'flex', flexDirection: 'column', boxSizing: 'border-box' }}>
      <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#B5613E' }}>Style exploration</div>
      <div style={{ fontFamily: '"Newsreader", serif', fontSize: 40, fontWeight: 600, letterSpacing: '-0.02em', lineHeight: 1.08, margin: '10px 0 14px' }}>A sample screen,<br/>five ways.</div>
      <p style={{ fontSize: 15, lineHeight: 1.6, color: '#6B6457', margin: '0 0 8px' }}>Every artboard below is the <b>same workspace</b> — group tree, entry list, the live-inline markdown editor, and the typed properties panel — so a chosen direction seeds every other screen and feature.</p>
      <p style={{ fontSize: 15, lineHeight: 1.6, color: '#6B6457', margin: '0 0 22px' }}>Pick a direction whole, or mix parts (a list shape from one, a palette from another). I'll build the rest of the app from your pick.</p>

      <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#B6AD9C', marginBottom: 12 }}>The five directions</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
        {swatches.map((s) => (
          <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 13 }}>
            <span style={{ width: 30, height: 30, borderRadius: 8, background: s.c, flexShrink: 0 }} />
            <div>
              <div style={{ fontSize: 15, fontWeight: 700 }}>{s.name}</div>
              <div style={{ fontSize: 12.5, color: '#8C8475' }}>{s.tag}</div>
            </div>
          </div>
        ))}
      </div>

      <div style={{ flex: 1 }} />
      <div style={{ borderTop: '1px solid rgba(60,48,28,0.1)', paddingTop: 16, fontSize: 12.5, lineHeight: 1.6, color: '#8C8475' }}>
        <div style={{ fontWeight: 700, color: '#6B6457', marginBottom: 6 }}>Shown in every frame</div>
        #tags (global + scoped) · @mention chips · [[wikilinks]] · task checkboxes + done · typed properties · ⌘K palette · calendar peek · keyboard hints.
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
