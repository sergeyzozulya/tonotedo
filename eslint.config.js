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
];
