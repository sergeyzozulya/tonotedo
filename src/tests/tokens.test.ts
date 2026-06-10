import { describe, it, expect } from "vitest";
import themeMap from "../styles/THEME-MAP.json";

// The 8 chip token names mandated by spec 0004 + 0011.
const CHIP_TOKENS = ["slate", "red", "amber", "green", "teal", "blue", "violet", "pink"] as const;

// Surface tokens every theme must expose (in THEME-MAP token bags).
const SURFACE_TOKENS = [
  "bg",
  "panel",
  "panel2",
  "text",
  "textMuted",
  "textFaint",
  "line",
  "lineStrong",
  "accent",
  "accentSoft",
  "accentText",
  "sel",
  "shadow",
] as const;

const MODES = ["light", "dark"] as const;

/**
 * Very loose CSS color validator: accepts #rrggbb, #rrggbbaa, #rgb,
 * rgb(...), rgba(...), and the keyword "none".
 */
function isValidCSSColor(value: string): boolean {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v === "none") return true;
  if (/^#[0-9a-fA-F]{3,8}$/.test(v)) return true;
  if (/^rgba?\(/.test(v)) return true;
  // Allow shadow strings that start with a number (pixel offset) — these are
  // not colors themselves but the surface-token spec includes --tnd-shadow.
  if (/^[\d-]/.test(v)) return true;
  return false;
}

describe("THEME-MAP", () => {
  it("has exactly 5 themes", () => {
    expect(themeMap.themes).toHaveLength(5);
  });

  it("has exactly one default theme", () => {
    const defaults = themeMap.themes.filter((t) => t.default);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].key).toBe("paper");
  });

  it("all 5 themes × 2 modes are present", () => {
    for (const theme of themeMap.themes) {
      expect(theme.modes).toEqual(expect.arrayContaining(["light", "dark"]));
      expect(theme.modes).toHaveLength(2);
      for (const mode of MODES) {
        expect(theme.tokens[mode], `${theme.key}/${mode} tokens missing`).toBeDefined();
      }
    }
  });

  it("every theme defines all surface tokens in both modes", () => {
    for (const theme of themeMap.themes) {
      for (const mode of MODES) {
        const bag = theme.tokens[mode] as Record<string, unknown>;
        for (const token of SURFACE_TOKENS) {
          expect(bag[token], `${theme.key}/${mode} missing surface token "${token}"`).toBeDefined();
        }
      }
    }
  });

  it("every theme defines all 8 chip tokens (fg + bg) in both modes", () => {
    for (const theme of themeMap.themes) {
      for (const mode of MODES) {
        const chips = (theme.tokens[mode] as { chips: Record<string, unknown> }).chips;
        expect(chips, `${theme.key}/${mode} missing chips object`).toBeDefined();
        for (const name of CHIP_TOKENS) {
          const chip = chips[name] as { fg: string; bg: string } | undefined;
          expect(chip, `${theme.key}/${mode} missing chip "${name}"`).toBeDefined();
          expect(chip?.fg, `${theme.key}/${mode} chip "${name}" missing fg`).toBeDefined();
          expect(chip?.bg, `${theme.key}/${mode} chip "${name}" missing bg`).toBeDefined();
        }
      }
    }
  });

  it("all chip token values are valid CSS colors", () => {
    for (const theme of themeMap.themes) {
      for (const mode of MODES) {
        const chips = (theme.tokens[mode] as { chips: Record<string, { fg: string; bg: string }> })
          .chips;
        for (const name of CHIP_TOKENS) {
          const { fg, bg } = chips[name];
          expect(
            isValidCSSColor(fg),
            `${theme.key}/${mode} chip "${name}" fg="${fg}" is not a valid CSS color`,
          ).toBe(true);
          expect(
            isValidCSSColor(bg),
            `${theme.key}/${mode} chip "${name}" bg="${bg}" is not a valid CSS color`,
          ).toBe(true);
        }
      }
    }
  });

  it("all surface token color values are valid CSS colors or shadows", () => {
    // shadow uses box-shadow syntax, not a color — skip it
    const colorTokens = SURFACE_TOKENS.filter((t) => t !== "shadow");
    for (const theme of themeMap.themes) {
      for (const mode of MODES) {
        const bag = theme.tokens[mode] as unknown as Record<string, string>;
        for (const token of colorTokens) {
          expect(
            isValidCSSColor(bag[token]),
            `${theme.key}/${mode} surface "${token}"="${bag[token]}" is not a valid CSS color`,
          ).toBe(true);
        }
      }
    }
  });

  it("theme keys match expected design names", () => {
    const keys = themeMap.themes.map((t) => t.key);
    expect(keys).toEqual(expect.arrayContaining(["paper", "fog", "mono", "editorial", "soft"]));
  });
});
