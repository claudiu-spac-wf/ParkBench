const tseslint = require("typescript-eslint");
module.exports = [
  {
    ignores: [
      "**/node_modules/**",
      "node_modules.*",
      "**/dist/**",
      "**/build/**",
      "coverage/**",
      "test-results/**",
      "playwright-report/**",
      ".parkbench/**",
      "*.min.js"
    ]
  },
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: ["**/*.{ts,tsx}"] })),
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/no-require-imports": "off",
      "no-var": "off"
    }
  },
  { files: ["**/*.js"], rules: {} }
];
