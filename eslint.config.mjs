// ESLint flat config — strict, no-unsafe-any, no non-null assertion in prod code.

import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/node_modules/**", "apps/docs/dist/**"],
  },
  {
    files: ["packages/*/src/**/*.ts", "apps/example/src/**/*.ts"],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylistic],
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
    files: ["apps/example/src/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    files: ["apps/docs/src/**/*"],
    extends: [tseslint.configs.recommended],
    rules: {
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
);
