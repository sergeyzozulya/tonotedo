// Guard (regression): any module using Svelte runes ($state/$derived/$effect)
// MUST be a `.svelte.ts`/`.svelte.js` file, or the rune leaks unprocessed into
// the production bundle → "$state is not defined" → blank page. Plain `.ts`
// importing these would throw at import here too.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      walk(p, out);
    } else if (
      p.endsWith(".ts") &&
      !p.endsWith(".svelte.ts") &&
      !p.endsWith(".test.ts") &&
      !p.endsWith(".d.ts")
    ) {
      out.push(p);
    }
  }
  return out;
}

describe("rune files are .svelte.ts", () => {
  it("no plain .ts file uses a top-level Svelte rune", () => {
    const offenders: string[] = [];
    // Match a rune used as a call/value, not inside a comment or string.
    const runeUse = /(^|[^.\w"'`/*])\$(state|derived|effect)\b\s*[(<]/;
    for (const f of walk("src")) {
      const src = readFileSync(f, "utf8");
      // strip line comments cheaply to avoid false positives
      const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      if (runeUse.test(code)) offenders.push(f);
    }
    expect(offenders, `rename these to .svelte.ts:\n${offenders.join("\n")}`).toEqual([]);
  });
});
