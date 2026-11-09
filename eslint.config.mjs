// @ts-check
/**
 * ESLint flat config (ESLint 10 + typescript-eslint v8).
 *
 * Uses ESLint's built-in `defineConfig` helper (`eslint/config`) —
 * the stable, non-deprecated replacement for `tseslint.config()`.
 *
 * Typed linting: `strictTypeChecked` + `projectService` so type-aware
 * rules run with full program information across the monorepo.
 * @see https://typescript-eslint.io/getting-started/typed-linting/
 */
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig([
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "apps/docs/dist/**",
      // Stray tsc outputs must never be linted (they are not project inputs).
      "packages/*/src/**/*.d.ts",
      "packages/*/src/**/*.js",
      "packages/*/src/**/*.map",
    ],
  },
  {
    files: ["packages/*/src/**/*.ts", "apps/*/src/**/*.ts"],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylistic,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // Adapters intentionally satisfy async interfaces with sync bodies
      // (memory adapter, cache, hasher stubs). The rule adds noise here.
      "@typescript-eslint/require-await": "off",
    },
  },
  {
    files: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    files: ["apps/*/src/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    files: ["apps/docs/src/**/*"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    rules: {
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
]);
