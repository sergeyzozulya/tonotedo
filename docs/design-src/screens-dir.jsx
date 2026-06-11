// People directory, Tags browser, Plugins manager (desktop + mobile), Mono.
// Loaded after shell.jsx.

function MToggle({ on, tk }) {
  return (
    <span style={{ width: 34, height: 18, background: on ? tk.accent : tk.lineStrong, position: 'relative', flexShrink: 0, display: 'inline-block' }}>
      <span style={{ position: 'absolute', top: 2, left: on ? 18 : 2, width: 14, height: 14, background: '#fff' }} />
    </span>
  );
}

// ── PEOPLE ───────────────────────────────────────────────────────────────────
function PeopleDesktop({ mode = 'dark' }) {
  const tk = monoTk(mode);
  return (
    <MShell mode={mode} active="people" crumb="People" zone="PEOPLE" right={`${TND2.people.length} people`}>
      <MScreenHead tk={tk} title="People" sub="_people/" right={<span style={{ fontFamily: tk.screenFont, fontSize: 12, color: tk.faint }}>@ mention to link</span>} />
      <div style={{ flex: 1, overflow: 'hidden', padding: '8px 0' }}>
        <div style={{ maxWidth: 720, margin: '0 auto', padding: '0 24px' }}>
          {TND2.people.map((p, i) => {
            const person = TND.people[p.slug];
            return (
              <div key={p.slug} style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '13px 4px', borderBottom: `1px solid ${tk.line}` }}>
                <TAvatar slug={p.slug} size={36} tk={tk} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 9 }}>
                    <span style={{ fontFamily: tk.screenFont, fontSize: 14, fontWeight: 700, color: tk.text }}>{person.name}</span>
                    <span style={{ fontFamily: tk.screenFont, fontSize: 11.5, color: tk.accentText }}>@{p.slug}</span>
                  </div>
                  <div style={{ fontFamily: tk.screenFont, fontSize: 11.5, color: tk.faint, marginTop: 2 }}>{p.role} · last in <span style={{ color: tk.muted }}>{p.last}</span></div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontFamily: tk.screenFont, fontSize: 16, fontWeight: 700, color: tk.text }}>{p.mentions}</div>
                  <div style={{ fontFamily: tk.screenFont, fontSize: 10, color: tk.faint, letterSpacing: '0.05em' }}>MENTIONS</div>
                </div>
              </div>
            );
          })}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 4px', fontFamily: tk.screenFont, fontSize: 12.5, color: tk.accentText, fontWeight: 700 }}>
            <span style={{ width: 36, height: 36, border: `1px dashed ${tk.lineStrong}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: tk.faint }}>+</span>add person
          </div>
        </div>
      </div>
    </MShell>
  );
}
function PeopleMobile({ mode = 'dark' }) {
  const tk = monoTk(mode);
  return (
    <MPhone mode={mode} tab="today">
      <MPhoneHead tk={tk} title="People" sub="_people/" />
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {TND2.people.map((p) => {
          const person = TND.people[p.slug];
          return (
            <div key={p.slug} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', borderBottom: `1px solid ${tk.line}` }}>
              <TAvatar slug={p.slug} size={34} tk={tk} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontFamily: tk.screenFont, fontSize: 13.5, fontWeight: 700, color: tk.text }}>{person.name}</div>
                <div style={{ fontFamily: tk.screenFont, fontSize: 11, color: tk.faint, marginTop: 2 }}>{p.role} · @{p.slug}</div>
              </div>
              <span style={{ fontFamily: tk.screenFont, fontSize: 13, fontWeight: 700, color: tk.muted }}>{p.mentions}<span style={{ color: tk.faint, fontWeight: 400 }}> @</span></span>
            </div>
          );
        })}
      </div>
    </MPhone>
  );
}

// ── TAGS ─────────────────────────────────────────────────────────────────────
function TagsDesktop({ mode = 'dark' }) {
  const tk = monoTk(mode);
  const max = Math.max(...TND2.tagsGlobal.map((t) => t.c));
  return (
    <MShell mode={mode} active="tags" crumb="Tags" zone="TAGS" right={`${TND2.tagsGlobal.length} global`}>
      <MScreenHead tk={tk} title="Tags" sub="global + scoped" />
      <div style={{ flex: 1, overflow: 'hidden', padding: '22px 0' }}>
        <div style={{ maxWidth: 700, margin: '0 auto', padding: '0 24px' }}>
          <div style={{ fontFamily: tk.screenFont, fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', color: tk.faint, marginBottom: 12 }}>{brk(tk, 'GLOBAL')}</div>
          {TND2.tagsGlobal.map((t) => (
            <div key={t.n} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '7px 0' }}>
              <span style={{ width: 150, fontFamily: tk.screenFont, fontSize: 13, fontWeight: 700, color: tk.accentText }}>#{t.n}</span>
              <span style={{ flex: 1, height: 8, background: tk.panel2, position: 'relative' }}><span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${(t.c / max) * 100}%`, background: tk.accent }} /></span>
              <span style={{ width: 34, textAlign: 'right', fontFamily: tk.screenFont, fontSize: 12, color: tk.muted }}>{t.c}</span>
            </div>
          ))}
          <div style={{ fontFamily: tk.screenFont, fontSize: 11, fontWeight: 700, letterSpacing: '0.06em', color: tk.faint, margin: '26px 0 12px' }}>{brk(tk, 'SCOPED · PROJECT ATLAS')}</div>
          {TND2.tagsScoped.map((t) => (
            <div key={t.n}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderBottom: `1px solid ${tk.line}` }}>
                <span style={{ fontFamily: tk.screenFont, fontSize: 13, fontWeight: 700, color: tk.amber }}>#{t.n}</span>
                <span style={{ fontFamily: tk.screenFont, fontSize: 11, color: tk.faint }}>{t.scope}</span>
                <div style={{ flex: 1 }} />
                <span style={{ fontFamily: tk.screenFont, fontSize: 12, color: tk.muted }}>{t.c}</span>
              </div>
              {t.children && t.children.map((c) => (
                <div key={c.n} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0 6px 22px', borderBottom: `1px solid ${tk.line}` }}>
                  <span style={{ color: tk.faint }}>└</span>
                  <span style={{ fontFamily: tk.screenFont, fontSize: 12.5, color: tk.amber }}>#{c.n}</span>
                  <div style={{ flex: 1 }} />
                  <span style={{ fontFamily: tk.screenFont, fontSize: 12, color: tk.muted }}>{c.c}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </MShell>
  );
}
function TagsMobile({ mode = 'dark' }) {
  const tk = monoTk(mode);
  const max = Math.max(...TND2.tagsGlobal.map((t) => t.c));
  return (
    <MPhone mode={mode} tab="today">
      <MPhoneHead tk={tk} title="Tags" sub="global + scoped" />
      <div style={{ flex: 1, overflow: 'hidden', padding: '12px 16px' }}>
        <div style={{ fontFamily: tk.screenFont, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', color: tk.faint, marginBottom: 10 }}>{brk(tk, 'GLOBAL')}</div>
        {TND2.tagsGlobal.slice(0, 5).map((t) => (
          <div key={t.n} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
            <span style={{ width: 110, fontFamily: tk.screenFont, fontSize: 12.5, fontWeight: 700, color: tk.accentText }}>#{t.n}</span>
            <span style={{ flex: 1, height: 7, background: tk.panel2, position: 'relative' }}><span style={{ position: 'absolute', inset: 0, width: `${(t.c / max) * 100}%`, background: tk.accent }} /></span>
            <span style={{ fontFamily: tk.screenFont, fontSize: 11.5, color: tk.muted }}>{t.c}</span>
          </div>
        ))}
        <div style={{ fontFamily: tk.screenFont, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.06em', color: tk.faint, margin: '20px 0 10px' }}>{brk(tk, 'SCOPED · ATLAS')}</div>
        {TND2.tagsScoped.map((t) => (
          <div key={t.n} style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '8px 0', borderBottom: `1px solid ${tk.line}` }}>
            <span style={{ fontFamily: tk.screenFont, fontSize: 12.5, fontWeight: 700, color: tk.amber }}>#{t.n}</span>
            <div style={{ flex: 1 }} /><span style={{ fontFamily: tk.screenFont, fontSize: 11.5, color: tk.muted }}>{t.c}</span>
          </div>
        ))}
      </div>
    </MPhone>
  );
}

// ── PLUGINS ──────────────────────────────────────────────────────────────────
function PluginRow({ tk, p, mobile }) {
  return (
    <div style={{ padding: mobile ? '13px 16px' : '15px 4px', borderBottom: `1px solid ${tk.line}` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
        <span style={{ width: 30, height: 30, border: `1px solid ${tk.lineStrong}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><TIcon name={p.kind === 'provider' ? 'link' : 'spark'} size={15} color={p.on ? tk.accent : tk.faint} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontFamily: tk.screenFont, fontSize: 13.5, fontWeight: 700, color: tk.text }}>{p.title}</span>
            <span style={{ fontFamily: tk.screenFont, fontSize: 10, color: p.kind === 'provider' ? tk.accentText : tk.amber, padding: '1px 6px', border: `1px solid ${tk.line}`, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{p.kind}</span>
            <span style={{ fontFamily: tk.screenFont, fontSize: 10.5, color: tk.faint }}>v{p.ver}</span>
          </div>
          <div style={{ fontFamily: tk.screenFont, fontSize: 11.5, color: tk.muted, marginTop: 3 }}>{p.desc}</div>
        </div>
        <MToggle on={p.on} tk={tk} />
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 9, paddingLeft: mobile ? 0 : 41, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: tk.screenFont, fontSize: 10, color: tk.faint }}>grants:</span>
        {p.perms.map((perm) => <span key={perm} style={{ fontFamily: tk.screenFont, fontSize: 10.5, color: perm === 'network' || perm.startsWith('write') ? tk.amber : tk.muted, padding: '1px 6px', border: `1px solid ${tk.line}` }}>{perm}</span>)}
      </div>
    </div>
  );
}
function PluginsDesktop({ mode = 'dark' }) {
  const tk = monoTk(mode);
  return (
    <MShell mode={mode} active="" crumb="Plugins" zone="PLUGINS" right={`${TND2.plugins.filter((p) => p.on).length} active`}>
      <MScreenHead tk={tk} title="Plugins" sub=".tonotedo/plugins/" right={<span style={{ fontFamily: tk.screenFont, fontSize: 12, color: tk.faint }}>sandboxed · interpreter-only on iOS</span>} />
      <div style={{ flex: 1, overflow: 'hidden', padding: '8px 0' }}>
        <div style={{ maxWidth: 720, margin: '0 auto', padding: '0 24px' }}>
          {TND2.plugins.map((p) => <PluginRow key={p.id} tk={tk} p={p} />)}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '16px 4px', fontFamily: tk.screenFont, fontSize: 12, color: tk.faint }}>drop a folder into <span style={{ color: tk.accentText }}>.tonotedo/plugins/</span> — it travels with the library to mobile.</div>
        </div>
      </div>
    </MShell>
  );
}
function PluginsMobile({ mode = 'dark' }) {
  const tk = monoTk(mode);
  return (
    <MPhone mode={mode} tab="set">
      <MPhoneHead tk={tk} title="Plugins" sub=".tonotedo/plugins/" />
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {TND2.plugins.map((p) => <PluginRow key={p.id} tk={tk} p={p} mobile />)}
      </div>
    </MPhone>
  );
}

Object.assign(window, { MToggle, PeopleDesktop, PeopleMobile, TagsDesktop, TagsMobile, PluginRow, PluginsDesktop, PluginsMobile });
