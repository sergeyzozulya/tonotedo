// Theme token re-resolution tests (issue #28, spec 0011 AC4).
//
// AC4: "switching data-tnd-mode swaps a sampled chip token value per THEME-MAP.json
//       while a hex-escape value stays."
//
// Approach: headless tests — no DOM, no CSS injection.  We test against the two
// authoritative data sources directly:
//   1. THEME-MAP.json  — the machine-readable token registry.
//   2. tokens.css      — the CSS custom property definitions.
//
// Tests verify:
//   a) A sampled chip token (e.g. paper/slate/fg) has DIFFERENT values in
//      light vs dark mode (mode switching changes chip tokens).
//   b) The tokens.css file contains the expected CSS variable declarations for
//      each theme × mode combination.
//   c) A hex-escape value (e.g. a pure hex color string) remains a valid hex
//      color across mode switches — i.e. hex values don't transform into rgba.
//   d) The THEME-MAP.json and tokens.css agree on the chip token values for
//      the default theme (Paper).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import themeMap from "../styles/THEME-MAP.json";

// ── Paths ─────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dir = dirname(__filename);
const CSS_PATH = join(__dir, "../styles/tokens.css");

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Normalize a color string for comparison: lowercase, remove spaces. */
function normColor(v: string): string {
  return v.trim().toLowerCase().replace(/\s+/g, "");
}

/** True if the value is a pure hex color (#rgb or #rrggbb or #rrggbbaa). */
function isHexColor(v: string): boolean {
  return /^#[0-9a-fA-F]{3,8}$/.test(v.trim());
}

/** True if the value is an rgba() color string. */
function isRgbaColor(v: string): boolean {
  return /^rgba?\(/.test(v.trim());
}

// Load the CSS once.
const tokensCSS = readFileSync(CSS_PATH, "utf-8");

/**
 * Extract the value of a CSS custom property from the tokens.css content.
 * Looks for `--tnd-<name>: <value>;` inside a `[data-tnd-theme="<theme>"][data-tnd-mode="<mode>"]`
 * block (or `:root` for the default Paper/light block).
 *
 * The :root block in tokens.css is written as:
 *   :root,
 *   [data-tnd-theme="paper"][data-tnd-mode="light"] { ... }
 *
 * We use a line-start match (multiline flag) for :root to avoid matching the
 * comment lines that also contain the word "root".
 */
function extractCSSVar(theme: string, mode: string, varName: string): string | null {
  const isDefault = theme === "paper" && mode === "light";

  let openBraceStart: number;

  if (isDefault) {
    // Match `:root` at the start of a line (not inside a comment).
    const rootPattern = /^:root[,\s]/m;
    const m = rootPattern.exec(tokensCSS);
    if (!m) return null;
    openBraceStart = tokensCSS.indexOf("{", m.index);
  } else {
    const selectorPattern = new RegExp(
      `\\[data-tnd-theme="${theme}"\\]\\[data-tnd-mode="${mode}"\\]\\s*\\{`,
    );
    const m = selectorPattern.exec(tokensCSS);
    if (!m) return null;
    openBraceStart = m.index + m[0].length - 1; // the { is at the end of the match
  }

  const blockStart = openBraceStart + 1;
  // Find the closing brace of this block.
  let depth = 1;
  let i = blockStart;
  while (i < tokensCSS.length && depth > 0) {
    if (tokensCSS[i] === "{") depth++;
    else if (tokensCSS[i] === "}") depth--;
    i++;
  }
  const blockContent = tokensCSS.slice(blockStart, i - 1);

  // Match `--tnd-<varName>: <value>;`
  const varPattern = new RegExp(`--tnd-${varName}:\\s*([^;]+);`);
  const varMatch = varPattern.exec(blockContent);
  if (!varMatch) return null;
  return varMatch[1].trim();
}

// ── Tests: chip token values change between light and dark modes ───────────────

describe("theme token re-resolution — chip tokens swap on mode switch", () => {
  // Use the Paper theme as the canonical test case (it's the default).
  const paperTheme = themeMap.themes.find((t) => t.key === "paper")!;

  it("Paper/slate/fg has DIFFERENT values in light vs dark mode", () => {
    const lightFg = (paperTheme.tokens.light.chips as Record<string, { fg: string; bg: string }>)
      .slate.fg;
    const darkFg = (paperTheme.tokens.dark.chips as Record<string, { fg: string; bg: string }>)
      .slate.fg;
    expect(normColor(lightFg)).not.toBe(normColor(darkFg));
  });

  it("Paper/slate/bg has DIFFERENT values in light vs dark mode", () => {
    const lightBg = (paperTheme.tokens.light.chips as Record<string, { fg: string; bg: string }>)
      .slate.bg;
    const darkBg = (paperTheme.tokens.dark.chips as Record<string, { fg: string; bg: string }>)
      .slate.bg;
    expect(normColor(lightBg)).not.toBe(normColor(darkBg));
  });

  it("Fog/blue/fg changes between light and dark (accent theme check)", () => {
    const fogTheme = themeMap.themes.find((t) => t.key === "fog")!;
    const lightBlue = (fogTheme.tokens.light.chips as Record<string, { fg: string; bg: string }>)
      .blue.fg;
    const darkBlue = (fogTheme.tokens.dark.chips as Record<string, { fg: string; bg: string }>).blue
      .fg;
    expect(normColor(lightBlue)).not.toBe(normColor(darkBlue));
  });

  it("all 5 themes: slate/fg differs between light and dark", () => {
    for (const theme of themeMap.themes) {
      const chips = theme.tokens as {
        light: { chips: Record<string, { fg: string; bg: string }> };
        dark: { chips: Record<string, { fg: string; bg: string }> };
      };
      const lightFg = chips.light.chips.slate.fg;
      const darkFg = chips.dark.chips.slate.fg;
      expect(normColor(lightFg)).not.toBe(normColor(darkFg));
    }
  });
});

// ── Tests: hex-escape values are stable (don't become rgba on mode switch) ────

describe("theme token re-resolution — hex values stay hex across modes", () => {
  it("Paper light accent token is a hex color", () => {
    const accent = (
      themeMap.themes.find((t) => t.key === "paper")!.tokens.light as unknown as Record<
        string,
        string
      >
    ).accent;
    expect(isHexColor(accent)).toBe(true);
  });

  it("Paper dark accent token is also a hex color", () => {
    const accent = (
      themeMap.themes.find((t) => t.key === "paper")!.tokens.dark as unknown as Record<
        string,
        string
      >
    ).accent;
    expect(isHexColor(accent)).toBe(true);
  });

  it("all themes: light and dark accent values are hex colors (not rgba)", () => {
    for (const theme of themeMap.themes) {
      const light = theme.tokens.light as unknown as Record<string, string>;
      const dark = theme.tokens.dark as unknown as Record<string, string>;
      expect(isHexColor(light.accent)).toBe(true);
      expect(isHexColor(dark.accent)).toBe(true);
    }
  });

  it("chip fg values that are hex stay hex in both modes", () => {
    // Verify that wherever a hex value appears, it stays hex (doesn't magically
    // convert to rgba between modes).  This confirms the token contract: hex
    // escapes are stable format across the mode switch.
    for (const theme of themeMap.themes) {
      const chips = theme.tokens as {
        light: { chips: Record<string, { fg: string; bg: string }> };
        dark: { chips: Record<string, { fg: string; bg: string }> };
      };
      for (const chipName of [
        "slate",
        "red",
        "amber",
        "green",
        "teal",
        "blue",
        "violet",
        "pink",
      ] as const) {
        const lFg = chips.light.chips[chipName].fg;
        const dFg = chips.dark.chips[chipName].fg;
        // Each chip fg in THEME-MAP is a hex color.
        expect(isHexColor(lFg)).toBe(true);
        expect(isHexColor(dFg)).toBe(true);
        // chip bg values are rgba() — not hex (they are transparency tints).
        const lBg = chips.light.chips[chipName].bg;
        const dBg = chips.dark.chips[chipName].bg;
        expect(isRgbaColor(lBg)).toBe(true);
        expect(isRgbaColor(dBg)).toBe(true);
      }
    }
  });
});

// ── Tests: THEME-MAP.json and tokens.css agree on Paper chip token values ──────

describe("theme token re-resolution — THEME-MAP.json and tokens.css agree", () => {
  // For each chip token in the default (Paper/light) theme, verify that the
  // value in THEME-MAP.json matches the CSS variable in tokens.css.
  //
  // The CSS uses kebab-case custom properties; the JSON uses camelCase/nested.
  // We normalise both for comparison (case-insensitive, remove spaces).

  const paperLight = themeMap.themes.find((t) => t.key === "paper")!.tokens.light;
  const chipMap = paperLight.chips as Record<string, { fg: string; bg: string }>;

  const cssChipTokens = [
    "slate",
    "red",
    "amber",
    "green",
    "teal",
    "blue",
    "violet",
    "pink",
  ] as const;

  for (const chipName of cssChipTokens) {
    it(`Paper/light ${chipName}/fg: THEME-MAP and tokens.css agree`, () => {
      const jsonFg = chipMap[chipName].fg;
      const cssFg = extractCSSVar("paper", "light", `chip-${chipName}-fg`);
      expect(cssFg).not.toBeNull();
      // Both must be non-empty.
      expect(jsonFg.trim().length).toBeGreaterThan(0);
      expect(cssFg!.trim().length).toBeGreaterThan(0);
      // Normalised values must match.
      expect(normColor(cssFg!)).toBe(normColor(jsonFg));
    });

    it(`Paper/light ${chipName}/bg: THEME-MAP and tokens.css agree`, () => {
      const jsonBg = chipMap[chipName].bg;
      const cssBg = extractCSSVar("paper", "light", `chip-${chipName}-bg`);
      expect(cssBg).not.toBeNull();
      expect(normColor(cssBg!)).toBe(normColor(jsonBg));
    });
  }

  it("Paper/dark slate/fg: THEME-MAP and tokens.css agree", () => {
    const paperDark = themeMap.themes.find((t) => t.key === "paper")!.tokens.dark;
    const jsonFg = (paperDark.chips as Record<string, { fg: string; bg: string }>).slate.fg;
    const cssFg = extractCSSVar("paper", "dark", "chip-slate-fg");
    expect(cssFg).not.toBeNull();
    expect(normColor(cssFg!)).toBe(normColor(jsonFg));
  });

  it("Paper/light and Paper/dark slate/fg are different in both sources", () => {
    const lightFg = extractCSSVar("paper", "light", "chip-slate-fg");
    const darkFg = extractCSSVar("paper", "dark", "chip-slate-fg");
    expect(lightFg).not.toBeNull();
    expect(darkFg).not.toBeNull();
    expect(normColor(lightFg!)).not.toBe(normColor(darkFg!));
  });
});

// ── Tests: CSS variables are present for all 5 themes × 2 modes ───────────────

describe("theme token re-resolution — CSS variable presence", () => {
  const themeKeys = ["paper", "fog", "mono", "editorial", "soft"] as const;
  const modes = ["light", "dark"] as const;

  for (const theme of themeKeys) {
    for (const mode of modes) {
      it(`tokens.css defines --tnd-chip-slate-fg for ${theme}/${mode}`, () => {
        const val = extractCSSVar(theme, mode, "chip-slate-fg");
        expect(val).not.toBeNull();
        expect(val!.trim().length).toBeGreaterThan(0);
      });

      it(`tokens.css defines --tnd-accent for ${theme}/${mode}`, () => {
        const val = extractCSSVar(theme, mode, "accent");
        expect(val).not.toBeNull();
        expect(isHexColor(val!)).toBe(true);
      });
    }
  }
});
