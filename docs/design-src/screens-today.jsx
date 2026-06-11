// Today / agenda screens (desktop + mobile), Mono style. A temporal digest:
// overdue, today, upcoming — all derived from `due`. Loaded after shell.jsx.

function AgRow({ tk, e, kind }) {
  const left = e.time || e.due || (e.repeat ? '↻' : '');
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 11, padding: '11px 0', borderBottom: `1px solid ${tk.line}` }}>
      <span style={{ width: 56, flexShrink: 0, fontFamily: tk.screenFont, fontSize: 11.5, color: kind === 'overdue' ? tk.amber : tk.faint, fontWeight: kind === 'overdue' ? 700 : 500, textAlign: 'right', paddingTop: 1 }}>{left}</span>
      <TCheck done={false} tk={tk} size={16} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: tk.screenFont, fontSize: 13.5, fontWeight: 700, color: tk.text }}>{e.t}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginTop: 5, flexWrap: 'wrap' }}>
          {e.tasks && <span style={{ fontFamily: tk.screenFont, fontSize: 11, color: tk.faint }}>[{e.tasks.done}/{e.tasks.total}]</span>}
          {e.tags && e.tags.map((t) => <TTag key={t} name={t} tk={tk} scoped={t === 'decided'} />)}
          {e.repeat && <span style={{ fontFamily: tk.screenFont, fontSize: 11, color: tk.faint }}>↻ weekly</span>}
        </div>
      </div>
      {e.people && <div style={{ display: 'flex', flexDirection: 'row-reverse', flexShrink: 0 }}>{e.people.map((p, k) => <span key={p} style={{ marginRight: k ? -6 : 0 }}><TAvatar slug={p} size={20} tk={tk} ring /></span>)}</div>}
    </div>
  );
}

function AgSection({ tk, label, count, color, children }) {
  return (
    <div style={{ marginBottom: 26 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6 }}>
        <span style={{ width: 7, height: 7, background: color }} />
        <span style={{ fontFamily: tk.screenFont, fontSize: 11, fontWeight: 700, letterSpacing: '0.08em', color: tk.muted }}>{label}</span>
        {count != null && <span style={{ fontFamily: tk.screenFont, fontSize: 11, color: tk.faint }}>{count}</span>}
        <span style={{ flex: 1, height: 1, background: tk.line }} />
      </div>
      {children}
    </div>
  );
}

function TodayDesktop({ mode = 'dark' }) {
  const tk = monoTk(mode);
  const T = TND2.today;
  return (
    <MShell mode={mode} active="today" crumb="Today" zone="AGENDA" right="Jun 10">
      <MScreenHead tk={tk} title="Today" sub={T.date} right={<span style={{ display: 'flex', gap: 8, fontFamily: tk.screenFont, fontSize: 12 }}><span style={{ padding: '3px 10px', border: `1px solid ${tk.lineStrong}`, color: tk.text, fontWeight: 700 }}>+ Capture</span><span style={{ padding: '3px 10px', color: tk.faint }}>⌘N</span></span>} />
      <div style={{ flex: 1, overflow: 'hidden', padding: '26px 0' }}>
        <div style={{ maxWidth: 680, margin: '0 auto', padding: '0 24px' }}>
          <AgSection tk={tk} label="OVERDUE" count={T.overdue.length} color={tk.amber}>
            {T.overdue.map((e, i) => <AgRow key={i} tk={tk} e={e} kind="overdue" />)}
          </AgSection>
          <AgSection tk={tk} label="TODAY" count={T.now.length} color={tk.accent}>
            {T.now.map((e, i) => <AgRow key={i} tk={tk} e={e} />)}
          </AgSection>
          <AgSection tk={tk} label="UPCOMING" color={tk.muted}>
            {T.upcoming.map((g, i) => (
              <div key={i} style={{ marginBottom: 8 }}>
                <div style={{ fontFamily: tk.screenFont, fontSize: 11, color: tk.faint, padding: '6px 0 2px 67px' }}>{g.d}</div>
                {g.items.map((e, j) => <AgRow key={j} tk={tk} e={e} />)}
              </div>
            ))}
          </AgSection>
        </div>
      </div>
    </MShell>
  );
}

function TodayMobile({ mode = 'dark' }) {
  const tk = monoTk(mode);
  const T = TND2.today;
  const Row = ({ e, kind }) => (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '11px 16px', borderBottom: `1px solid ${tk.line}` }}>
      <TCheck done={false} tk={tk} size={17} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
          <span style={{ fontFamily: tk.screenFont, fontSize: 13.5, fontWeight: 700, color: tk.text }}>{e.t}</span>
          <span style={{ fontFamily: tk.screenFont, fontSize: 11, color: kind === 'overdue' ? tk.amber : tk.faint, whiteSpace: 'nowrap' }}>{e.time || e.due || (e.repeat ? '↻' : '')}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 5, flexWrap: 'wrap' }}>
          {e.tasks && <span style={{ fontFamily: tk.screenFont, fontSize: 11, color: tk.faint }}>[{e.tasks.done}/{e.tasks.total}]</span>}
          {e.tags && e.tags.map((t) => <TTag key={t} name={t} tk={tk} scoped={t === 'decided'} />)}
          {e.people && <span style={{ display: 'flex', flexDirection: 'row-reverse', marginLeft: 'auto' }}>{e.people.map((p, k) => <span key={p} style={{ marginRight: k ? -5 : 0 }}><TAvatar slug={p} size={18} tk={tk} ring /></span>)}</span>}
        </div>
      </div>
    </div>
  );
  const Head = ({ label, color, count }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px 6px', background: tk.panel }}>
      <span style={{ width: 6, height: 6, background: color }} />
      <span style={{ fontFamily: tk.screenFont, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.07em', color: tk.muted }}>{label}</span>
      {count != null && <span style={{ fontFamily: tk.screenFont, fontSize: 10.5, color: tk.faint }}>{count}</span>}
    </div>
  );
  return (
    <MPhone mode={mode} tab="today">
      <MPhoneHead tk={tk} title="Today" sub={T.date} right={<span style={{ fontFamily: tk.screenFont, fontSize: 12, color: tk.accentText, fontWeight: 700 }}>+ ⌘N</span>} />
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <Head label="OVERDUE" color={tk.amber} count={1} />
        {T.overdue.map((e, i) => <Row key={i} e={e} kind="overdue" />)}
        <Head label="TODAY" color={tk.accent} count={3} />
        {T.now.map((e, i) => <Row key={i} e={e} />)}
        <Head label="UPCOMING" color={tk.muted} />
        {T.upcoming.slice(0, 2).map((g, i) => (
          <React.Fragment key={i}>
            <div style={{ fontFamily: tk.screenFont, fontSize: 10.5, color: tk.faint, padding: '6px 16px 0' }}>{g.d}</div>
            {g.items.map((e, j) => <Row key={j} e={e} />)}
          </React.Fragment>
        ))}
      </div>
    </MPhone>
  );
}

Object.assign(window, { AgRow, AgSection, TodayDesktop, TodayMobile });
