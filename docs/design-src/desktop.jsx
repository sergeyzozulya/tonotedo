// Desktop three-pane workspace: title bar · sidebar (group tree) · entry list
// · live-inline editor · properties panel · status bar. Theme-driven; the same
// markup re-skins across all five styles. `palette` overlays the ⌘K command
// palette. Designed to fill a 1360×880 artboard.

const TND_DENSITY = {
  roomy:    { rowY: 9, listPad: 18, gap: 3, side: 16, edPad: 56, bodyGap: 18 },
  balanced: { rowY: 7, listPad: 14, gap: 2, side: 13, edPad: 44, bodyGap: 15 },
  compact:  { rowY: 4, listPad: 9,  gap: 0, side: 9,  edPad: 30, bodyGap: 11 },
};

function tndPaneBorder(tk) {
  // mono/editorial separate panes with hairlines; soft/fog/paper float panels.
  return `1px solid ${tk.line}`;
}

// ── Title bar ──────────────────────────────────────────────────────────────
function TNDTitleBar({ tk }) {
  const up = tk.flags.uppercaseLabels;
  return (
    <div style={{
      height: 48, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 14,
      padding: '0 14px 0 16px', borderBottom: tndPaneBorder(tk), background: tk.panel,
      color: tk.text, fontFamily: tk.font.ui,
    }}>
      <div style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
        {tk.flags.boxed
          ? <span style={{ fontFamily: tk.font.mono, color: tk.accentText, fontWeight: 700 }}>~/library</span>
          : <>
              <span style={{ width: 22, height: 22, borderRadius: tk.flags.radius === 0 ? 0 : 6, background: tk.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 800, fontSize: 13 }}>T</span>
              <span style={{ fontWeight: 700, fontSize: 14, letterSpacing: '-0.01em' }}>My Library</span>
              <TIcon name="chevronD" size={14} color={tk.faint} />
            </>}
      </div>
      <div style={{ width: 1, height: 18, background: tk.line }} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: tk.muted, fontSize: 13, fontWeight: 500, letterSpacing: up ? '0.03em' : '0' }}>
        <span>Work</span>
        <TIcon name="chevron" size={12} color={tk.faint} />
        <span style={{ color: tk.text, fontWeight: 600 }}>{up ? 'PROJECT ATLAS' : 'Project Atlas'}</span>
      </div>
      <div style={{ flex: 1 }} />
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, height: 30, padding: '0 10px 0 11px',
        borderRadius: tk.flags.radius === 0 ? 0 : 8, border: `1px solid ${tk.line}`, background: tk.panel2,
        color: tk.faint, fontSize: 12.5, minWidth: 168,
      }}>
        <TIcon name="search" size={14} color={tk.faint} />
        <span style={{ flex: 1 }}>Search…</span>
        <kbd style={{ fontFamily: tk.font.mono, fontSize: 11, color: tk.muted }}>⌘P</kbd>
      </div>
      <button style={{
        display: 'flex', alignItems: 'center', gap: 6, height: 30, padding: '0 12px 0 9px',
        borderRadius: tk.flags.radius === 0 ? 0 : 8, border: 'none', background: tk.accent, color: '#fff',
        fontFamily: tk.font.ui, fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
      }}>
        <TIcon name="plus" size={15} color="#fff" stroke={2.2} />{up ? 'NEW' : 'New entry'}
      </button>
      <TIcon name="settings" size={18} color={tk.muted} />
    </div>
  );
}

// ── Sidebar (views + group tree) ────────────────────────────────────────────
function TNDSidebar({ tk, D }) {
  const up = tk.flags.uppercaseLabels;
  const sectionLabel = (t) => (
    <div style={{ padding: `0 ${D.side}px`, marginTop: 16, marginBottom: 7, fontSize: 10.5, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: tk.faint, fontFamily: tk.flags.boxed ? tk.font.mono : tk.font.ui }}>
      {tk.flags.boxed ? `[ ${t} ]` : t}
    </div>
  );
  const Row = ({ icon, label, hint, count, selected, indent = 0, color, open, hasChildren }) => (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, height: 30 + D.rowY,
      padding: `0 ${D.side}px 0 ${D.side + indent * 16}px`, margin: tk.flags.pillNav ? `1px ${D.side - 6}px` : 0,
      borderRadius: tk.flags.pillNav ? 9 : 0, cursor: 'pointer', position: 'relative',
      background: selected ? (tk.flags.pillNav ? tk.accentSoft : tk.sel) : 'transparent',
      color: selected ? (tk.flags.boxed ? tk.accentText : tk.text) : tk.muted,
      fontFamily: tk.font.ui, fontSize: 13.5, fontWeight: selected ? 700 : 500,
    }}>
      {selected && !tk.flags.pillNav && <span style={{ position: 'absolute', left: 0, top: 6, bottom: 6, width: 3, borderRadius: 2, background: tk.accent }} />}
      {hasChildren && <TIcon name={open ? 'chevronD' : 'chevron'} size={12} color={tk.faint} style={{ marginLeft: -4 }} />}
      {tk.flags.sidebarIcons && icon && <TIcon name={icon} size={16} color={selected ? tk.accent : (color || tk.muted)} />}
      {!tk.flags.sidebarIcons && color && <span style={{ width: 7, height: 7, borderRadius: tk.flags.radius === 0 ? 0 : '50%', background: color, flexShrink: 0 }} />}
      <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{up && selected ? label.toUpperCase() : label}</span>
      {hint && <kbd style={{ fontFamily: tk.font.mono, fontSize: 10.5, color: tk.faint }}>{hint}</kbd>}
      {count != null && <span style={{ fontSize: 11, color: tk.faint, fontVariantNumeric: 'tabular-nums', fontFamily: tk.flags.boxed ? tk.font.mono : tk.font.ui }}>{count}</span>}
    </div>
  );
  return (
    <div style={{
      width: 246, flexShrink: 0, borderRight: tndPaneBorder(tk), background: tk.flags.ruled ? tk.bg : tk.panel,
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      <div style={{ flex: 1, paddingTop: 8 }}>
        {TND.views.map((v) => <Row key={v.id} icon={v.icon} label={v.label} hint={v.hint} />)}
        {sectionLabel('Groups')}
        {TND.tree.map((g) => (
          <React.Fragment key={g.id}>
            <Row icon={g.icon} label={g.label} count={g.count} color={g.color} hasChildren={!!g.children} open={g.open} />
            {g.open && g.children && g.children.map((c) => (
              <Row key={c.id} icon={c.icon} label={c.label} count={c.count} color={c.color} selected={c.selected} indent={1} />
            ))}
          </React.Fragment>
        ))}
      </div>
      <div style={{ padding: `10px ${D.side}px`, borderTop: tndPaneBorder(tk), display: 'flex', alignItems: 'center', gap: 8, color: tk.faint, fontSize: 11.5, fontFamily: tk.font.ui }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: tk.flags.tag === 'bracket' ? tk.accent : '#5E9A6E' }} />
        <span>Local · synced 2m ago</span>
      </div>
    </div>
  );
}

// ── Entry list (four list variants via flags.list) ───────────────────────────
function TNDEntryList({ tk, D }) {
  const up = tk.flags.uppercaseLabels;
  const variant = tk.flags.list;
  const dueColor = (due) => due === 'Today' ? tk.accentText : tk.muted;

  const renderEntry = (e, i) => {
    const meta = (
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
        {e.due && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11.5, fontWeight: 600, color: dueColor(e.due), fontFamily: tk.flags.boxed ? tk.font.mono : tk.font.ui }}>
            <TIcon name="calendar" size={12} color={dueColor(e.due)} />{e.due}
          </span>
        )}
        {e.tasks && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11.5, fontWeight: 600, color: tk.muted, fontFamily: tk.font.mono }}>
            <TCheck done={false} tk={tk} size={11} />{e.tasks.done}/{e.tasks.total}
          </span>
        )}
        {e.tags && e.tags.slice(0, 2).map((t) => <span key={t} style={{ fontSize: 11.5 }}><TTag name={t} tk={tk} scoped={t === 'decided'} /></span>)}
      </div>
    );
    const avatars = e.people && (
      <div style={{ display: 'flex', flexDirection: 'row-reverse', marginRight: 2 }}>
        {e.people.slice(0, 3).map((p, j) => <span key={p} style={{ marginRight: j ? -6 : 0 }}><TAvatar slug={p} size={20} tk={tk} ring /></span>)}
      </div>
    );

    if (variant === 'index') {
      // Editorial: typographic index, hairline rule, serif title, mono meta.
      return (
        <div key={e.id} style={{ padding: `${D.listPad - 2}px ${D.listPad + 2}px`, borderBottom: `1px solid ${tk.line}`, background: e.selected ? tk.sel : 'transparent', cursor: 'pointer', position: 'relative' }}>
          {e.selected && <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: tk.accent }} />}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
            <span style={{ fontFamily: tk.font.body, fontSize: 19, fontWeight: tk.flags.titleWeight, color: tk.text, letterSpacing: '-0.01em', lineHeight: 1.2 }}>{e.title}</span>
            {e.due && <span style={{ fontFamily: tk.font.mono, fontSize: 11, color: dueColor(e.due), whiteSpace: 'nowrap' }}>{e.due}</span>}
          </div>
          <div style={{ marginTop: 5, fontSize: 13, color: tk.muted, lineHeight: 1.45, fontFamily: tk.font.ui }}>{e.preview}</div>
          <div style={{ marginTop: 9, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>{e.tags && e.tags.map((t) => <TTag key={t} name={t} tk={tk} scoped={t === 'decided'} />)}</div>
            {avatars}
          </div>
        </div>
      );
    }

    if (variant === 'dense') {
      // Mono: tight single-block rows, bracketed marker on selection.
      return (
        <div key={e.id} style={{
          padding: `${D.listPad}px ${D.listPad + 2}px`, borderBottom: `1px solid ${tk.line}`,
          background: e.selected ? tk.accentSoft : 'transparent', cursor: 'pointer', fontFamily: tk.font.mono,
        }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 7 }}>
            <span style={{ color: e.selected ? tk.accentText : tk.faint, fontWeight: 700 }}>{e.selected ? '>' : '·'}</span>
            <span style={{ flex: 1, fontSize: 13, fontWeight: 700, color: tk.text, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.title}</span>
            {e.due && <span style={{ fontSize: 11, color: dueColor(e.due) }}>{e.due}</span>}
          </div>
          <div style={{ paddingLeft: 14, marginTop: 3, fontSize: 11.5, color: tk.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.preview}</div>
          <div style={{ paddingLeft: 14, marginTop: 4, display: 'flex', gap: 8, alignItems: 'center' }}>
            {e.tags && e.tags.map((t) => <TTag key={t} name={t} tk={tk} scoped={t === 'decided'} />)}
            {e.tasks && <span style={{ fontSize: 11, color: tk.faint }}>[{e.tasks.done}/{e.tasks.total}]</span>}
          </div>
        </div>
      );
    }

    // 'preview' (paper) and 'card' (fog/soft) share a structure; card floats.
    const card = variant === 'card';
    return (
      <div key={e.id} style={{
        padding: `${D.listPad}px ${D.listPad + 1}px`,
        margin: card ? `${D.gap + 2}px 9px` : 0,
        borderRadius: card ? tk.flags.radius : 0,
        borderBottom: card ? 'none' : `1px solid ${tk.line}`,
        background: e.selected ? (card ? tk.accentSoft : tk.sel) : 'transparent',
        boxShadow: card && e.selected ? `inset 0 0 0 1.5px ${tk.accent}` : 'none',
        cursor: 'pointer', position: 'relative',
      }}>
        {e.selected && !card && <span style={{ position: 'absolute', left: 0, top: 8, bottom: 8, width: 3, borderRadius: 2, background: tk.accent }} />}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
          <span style={{ fontFamily: tk.font.ui, fontSize: 14.5, fontWeight: tk.flags.titleWeight, color: tk.text, letterSpacing: '-0.01em', lineHeight: 1.25 }}>{e.title}</span>
          {e.due && <span style={{ fontSize: 11, fontWeight: 600, color: dueColor(e.due), whiteSpace: 'nowrap', fontFamily: tk.font.ui }}>{e.due}</span>}
        </div>
        <div style={{ marginTop: 4, fontSize: 12.8, color: tk.muted, lineHeight: 1.45, fontFamily: tk.font.ui, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{e.preview}</div>
        <div style={{ marginTop: 9, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          {meta}{avatars}
        </div>
      </div>
    );
  };

  return (
    <div style={{ width: 336, flexShrink: 0, borderRight: tndPaneBorder(tk), background: tk.flags.ruled ? tk.bg : tk.panel, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ height: 48, flexShrink: 0, borderBottom: tndPaneBorder(tk), display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 16px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{ fontFamily: tk.font.ui, fontSize: 15, fontWeight: 700, color: tk.text, letterSpacing: up ? '0.03em' : '-0.01em' }}>{up ? 'PROJECT ATLAS' : 'Project Atlas'}</span>
          <span style={{ fontSize: 12, color: tk.faint, fontFamily: tk.font.mono }}>{TND.group.count}</span>
        </div>
        <div style={{ display: 'flex', gap: 10, color: tk.muted, alignItems: 'center' }}>
          <span style={{ fontSize: 11.5, color: tk.faint, fontFamily: tk.font.ui }}>Updated</span>
          <TIcon name="chevronD" size={13} color={tk.muted} />
        </div>
      </div>
      <div style={{ flex: 1, overflow: 'hidden', paddingTop: card_pad(variant) }}>
        {TND.entries.map(renderEntry)}
      </div>
    </div>
  );
}
function card_pad(v) { return v === 'card' ? 4 : 0; }

window.__TND_DESKTOP_PART1 = true;
Object.assign(window, { TND_DENSITY, tndPaneBorder, TNDTitleBar, TNDSidebar, TNDEntryList, card_pad });
