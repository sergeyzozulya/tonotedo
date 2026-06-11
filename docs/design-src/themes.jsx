// Five calm-but-distinct visual systems for ToNoteDo. Each theme carries two
// token sets (light/dark) plus structural FLAGS the shared workspace reads to
// diverge layout (icons, tag rendering, list shape, chrome). Colors are kept
// low-chroma per the "calm" pillar; accents use a single confident hue each.

const TND_THEMES = [
  // ── 1 · PAPER — warm minimal, serif reading body (Bear / Things energy) ──
  {
    key: 'paper', name: 'Paper', tagline: 'Warm minimal · serif reading body',
    font: { ui: '"Mulish", sans-serif', body: '"Newsreader", Georgia, serif', mono: '"IBM Plex Mono", monospace' },
    flags: { sidebarIcons: false, tag: 'hash', list: 'preview', chrome: 'plain', serifBody: true, radius: 7, tagRadius: 5, density: 'roomy', avatarShape: 'circle', titleWeight: 600 },
    light: { bg: '#F7F4EE', panel: '#FBF9F4', panel2: '#F1ECE3', text: '#2C2620', muted: '#8C8475', faint: '#B6AD9C', line: 'rgba(60,48,28,0.08)', lineStrong: 'rgba(60,48,28,0.14)', accent: '#B5613E', accentSoft: 'rgba(181,97,62,0.12)', accentText: '#9A4F30', sel: 'rgba(181,97,62,0.10)', shadow: '0 1px 2px rgba(60,48,28,.05), 0 6px 24px rgba(60,48,28,.05)' },
    dark: { bg: '#1B1814', panel: '#221E18', panel2: '#2A251E', text: '#EAE3D6', muted: '#9A9182', faint: '#6B6356', line: 'rgba(255,245,225,0.07)', lineStrong: 'rgba(255,245,225,0.13)', accent: '#D98A66', accentSoft: 'rgba(217,138,102,0.16)', accentText: '#E7A484', sel: 'rgba(217,138,102,0.13)', shadow: '0 1px 2px rgba(0,0,0,.3), 0 8px 30px rgba(0,0,0,.3)' },
  },

  // ── 2 · FOG — cool soft-neutral, gentle elevation, muted blue accent ──
  {
    key: 'fog', name: 'Fog', tagline: 'Soft neutral · rounded · muted blue',
    font: { ui: '"Hanken Grotesk", sans-serif', body: '"Hanken Grotesk", sans-serif', mono: '"IBM Plex Mono", monospace' },
    flags: { sidebarIcons: true, tag: 'pill', list: 'card', chrome: 'plain', serifBody: false, radius: 11, tagRadius: 999, density: 'balanced', avatarShape: 'circle', titleWeight: 600 },
    light: { bg: '#EEF1F4', panel: '#FFFFFF', panel2: '#F4F7FA', text: '#222A31', muted: '#69737E', faint: '#9AA4AE', line: '#E4E9EE', lineStrong: '#D3DAE1', accent: '#5277A6', accentSoft: 'rgba(82,119,166,0.12)', accentText: '#3E6595', sel: 'rgba(82,119,166,0.10)', shadow: '0 1px 2px rgba(30,45,65,.06), 0 8px 24px rgba(30,45,65,.07)' },
    dark: { bg: '#14181D', panel: '#1C222A', panel2: '#232B34', text: '#E4E9EF', muted: '#8995A2', faint: '#5C6772', line: 'rgba(150,180,210,0.10)', lineStrong: 'rgba(150,180,210,0.18)', accent: '#7DA2CE', accentSoft: 'rgba(125,162,206,0.16)', accentText: '#9FBEE3', sel: 'rgba(125,162,206,0.14)', shadow: '0 1px 2px rgba(0,0,0,.35), 0 10px 30px rgba(0,0,0,.4)' },
  },

  // ── 3 · MONO — terminal, keyboard-forward, dense, hairline boxes ──
  {
    key: 'mono', name: 'Mono', tagline: 'Terminal · keyboard-forward · dense',
    font: { ui: '"JetBrains Mono", monospace', body: '"JetBrains Mono", monospace', mono: '"JetBrains Mono", monospace' },
    flags: { sidebarIcons: false, tag: 'bracket', list: 'dense', chrome: 'statusbar', serifBody: false, radius: 0, tagRadius: 0, density: 'compact', avatarShape: 'square', titleWeight: 700, boxed: true, uppercaseLabels: true },
    light: { bg: '#F4F2EC', panel: '#FBFAF6', panel2: '#EEEBE2', text: '#1F1E1A', muted: '#7C7868', faint: '#A8A393', line: 'rgba(40,38,28,0.16)', lineStrong: 'rgba(40,38,28,0.30)', accent: '#3E7A52', accentSoft: 'rgba(62,122,82,0.12)', accentText: '#2F6342', sel: 'rgba(62,122,82,0.10)', amber: '#A9742A', shadow: 'none' },
    dark: { bg: '#101210', panel: '#161915', panel2: '#1C201B', text: '#C7D0C2', muted: '#7E887A', faint: '#565E53', line: 'rgba(150,170,150,0.16)', lineStrong: 'rgba(150,170,150,0.32)', accent: '#73B083', accentSoft: 'rgba(115,176,131,0.15)', accentText: '#8FC79E', sel: 'rgba(115,176,131,0.12)', amber: '#D6A256', shadow: 'none' },
  },

  // ── 4 · EDITORIAL — high-contrast typographic, hairline rules, near-mono ──
  {
    key: 'editorial', name: 'Editorial', tagline: 'High-contrast typographic · hairline rules',
    font: { ui: '"Hanken Grotesk", sans-serif', body: '"Newsreader", Georgia, serif', mono: '"IBM Plex Mono", monospace' },
    flags: { sidebarIcons: false, tag: 'caps', list: 'index', chrome: 'rules', serifBody: true, radius: 0, tagRadius: 0, density: 'roomy', avatarShape: 'circle', titleWeight: 500, ruled: true },
    light: { bg: '#FBFAF7', panel: '#FBFAF7', panel2: '#F2F0EA', text: '#15140F', muted: '#6E6A60', faint: '#A39E92', line: 'rgba(20,18,10,0.12)', lineStrong: 'rgba(20,18,10,0.85)', accent: '#933623', accentSoft: 'rgba(147,54,35,0.09)', accentText: '#933623', sel: 'rgba(20,18,10,0.05)', shadow: '0 1px 2px rgba(20,18,10,.05), 0 10px 30px rgba(20,18,10,.05)' },
    dark: { bg: '#131210', panel: '#131210', panel2: '#1C1A17', text: '#ECE9E1', muted: '#9A958A', faint: '#625D53', line: 'rgba(236,233,225,0.14)', lineStrong: 'rgba(236,233,225,0.80)', accent: '#CE6E58', accentSoft: 'rgba(206,110,88,0.12)', accentText: '#DE8470', sel: 'rgba(236,233,225,0.06)', shadow: '0 1px 2px rgba(0,0,0,.4), 0 12px 36px rgba(0,0,0,.45)' },
  },

  // ── 5 · SOFT — rounded friendly, green accent, avatar-forward ──
  {
    key: 'soft', name: 'Soft', tagline: 'Rounded friendly · sage green · avatar-forward',
    font: { ui: '"Figtree", sans-serif', body: '"Figtree", sans-serif', mono: '"IBM Plex Mono", monospace' },
    flags: { sidebarIcons: true, tag: 'pill', list: 'card', chrome: 'plain', serifBody: false, radius: 16, tagRadius: 999, density: 'balanced', avatarShape: 'circle', titleWeight: 600, pillNav: true },
    light: { bg: '#EDF1EB', panel: '#FFFFFF', panel2: '#F3F7F1', text: '#222A23', muted: '#6C766C', faint: '#9BA59A', line: '#E4EAE1', lineStrong: '#D3DBCF', accent: '#4F9168', accentSoft: 'rgba(79,145,104,0.12)', accentText: '#3C7B53', sel: 'rgba(79,145,104,0.10)', shadow: '0 1px 2px rgba(30,50,35,.05), 0 8px 26px rgba(30,50,35,.07)' },
    dark: { bg: '#141814', panel: '#1B201B', panel2: '#222922', text: '#E5EBE2', muted: '#8A958A', faint: '#5C665B', line: 'rgba(160,200,170,0.10)', lineStrong: 'rgba(160,200,170,0.18)', accent: '#79BB90', accentSoft: 'rgba(121,187,144,0.15)', accentText: '#95CEA8', sel: 'rgba(121,187,144,0.13)', shadow: '0 1px 2px rgba(0,0,0,.35), 0 10px 30px rgba(0,0,0,.4)' },
  },
];

// Resolve a theme + mode into a flat token bag the components consume.
function tndTokens(theme, mode) {
  const c = theme[mode];
  return { ...c, mode, font: theme.font, flags: theme.flags, key: theme.key, name: theme.name,
    // Primary working typeface for the build-out screens: monospace for the
    // terminal (boxed) themes, the theme's UI face otherwise.
    screenFont: theme.flags.boxed ? theme.font.mono : theme.font.ui,
    // Warning/attention accent — themes may define their own; otherwise a warm amber.
    amber: c.amber || (mode === 'dark' ? '#D6A256' : '#A9742A') };
}

window.TND_THEMES = TND_THEMES;
window.tndTokens = tndTokens;
