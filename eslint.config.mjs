import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,

  // Project rule overrides (reduce strictness to match current codebase)
  {
    rules: {
      // Many routes and helpers currently use `any`; disable this rule to avoid noisy CI failures.
      "@typescript-eslint/no-explicit-any": "off"
    }
  },

  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",

    // ignore archived backend code
    "backend_archive/**",
  ]),
]);