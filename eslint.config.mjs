import globals from "globals";

/** @type {import("eslint").Linter.Config[]} */
export default [
  {
    files: ["**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {
        ...globals.node,
        fetch: "readonly",
      },
    },
    rules: {
      // Errors
      "no-undef": "error",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-constant-condition": "error",
      "no-dupe-args": "error",
      "no-dupe-keys": "error",
      "no-duplicate-case": "error",
      "no-unreachable": "error",
      "no-unsafe-negation": "error",
      "use-isnan": "error",
      "valid-typeof": "error",

      // Warnings → errors (strict)
      "no-var": "error",
      "prefer-const": "error",
      "eqeqeq": ["error", "always"],
      "no-throw-literal": "error",
      "no-implicit-coercion": "error",
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",

      // Style (warnings only)
      "no-trailing-spaces": "warn",
      "no-multiple-empty-lines": ["warn", { max: 2 }],
    },
  },
  {
    ignores: ["node_modules/"],
  },
];
