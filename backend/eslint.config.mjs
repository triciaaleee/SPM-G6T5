import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

// One lint config for every service under services/. It is dev tooling only:
// services still never import code from each other (AGENTS.md §1).
// Bug-catching rules only; formatting is not linted. See CI.md for why.
export default tseslint.config(
  { ignores: ["**/dist/", "**/node_modules/", "**/coverage/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // A leading underscore marks a deliberately unused name (e.g. a mock's `_init`).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // Visible but not blocking: a few lib files still use `any` for Supabase rows.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    // Test doubles (mock Supabase clients, fetch stubs) are typed loosely on purpose.
    files: ["**/__tests__/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
