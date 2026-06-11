import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import sveltePlugin from "eslint-plugin-svelte";

/** @type {import("eslint").Linter.Config[]} */
export default [
  {
    ignores: ["dist/**", "src-tauri/**", "node_modules/**"],
  },
  // TypeScript files
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
    },
  },
  // Svelte files — use flat/recommended which bundles the svelte parser
  ...sveltePlugin.configs["flat/recommended"],
  // Override Svelte TS parser
  {
    files: ["**/*.svelte"],
    languageOptions: {
      parserOptions: {
        parser: tsParser,
      },
    },
  },
  // Rune modules (`*.svelte.ts` / `*.svelte.js`) are plain TS/JS modules that
  // use runes — the Svelte recommended config grabs them with the svelte
  // parser, which can't parse a full TS module. Force the TS parser; runes are
  // just call expressions to it. This block comes last so it wins.
  {
    files: ["**/*.svelte.ts", "**/*.svelte.js"],
    languageOptions: {
      parser: tsParser,
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
    },
  },
];
