import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";
import { dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * ESLint config — Phase 0
 *
 * Стратегия: включаем полезные правила поэтапно.
 * - `error` для критичных баг-детекторов (no-unreachable, no-undef, no-fallthrough)
 * - `warn` для качества кода (no-unused-vars, no-explicit-any, exhaustive-deps)
 * - `off` для шумных/устаревших правил, которые конфликтуют со стилем проекта
 *
 * После Phase 1-2 (когда явные `any` и unused-vars будут вычищены),
 * можно поднять `warn` → `error`.
 */
const eslintConfig = [...nextCoreWebVitals, ...nextTypescript, {
  rules: {
    // === TypeScript rules ===
    // warn — проявить, не блокировать
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/no-unused-vars": ["warn", {
      argsIgnorePattern: "^_",
      varsIgnorePattern: "^_",
      caughtErrorsIgnorePattern: "^_",
    }],
    "@typescript-eslint/no-non-null-assertion": "warn",
    "@typescript-eslint/ban-ts-comment": "warn",
    "@typescript-eslint/prefer-as-const": "off",
    "@typescript-eslint/no-unused-disable-directive": "off",

    // === React / hooks ===
    "react-hooks/exhaustive-deps": "warn",
    "react-hooks/purity": "off",
    "react/no-unescaped-entities": "off",
    "react/display-name": "off",
    "react/prop-types": "off",
    "react-compiler/react-compiler": "off",

    // === Next.js ===
    "@next/next/no-img-element": "warn",
    "@next/next/no-html-link-for-pages": "off",

    // === JavaScript — error-уровень для реальных багов ===
    // NOTE: `no-undef` отключён для TS-файлов в per-files override ниже —
    // TypeScript сам валидирует типы, а `no-undef` не понимает TS-глобалы
    // (React, NodeJS, RequestInit) и даёт ложные срабатывания.
    "no-unreachable": "error",
    "no-undef": "error",
    "no-fallthrough": "error",
    "no-case-declarations": "error",
    "no-redeclare": "error",
    "no-useless-escape": "warn",
    "no-mixed-spaces-and-tabs": "error",

    // === JavaScript — warn для качества ===
    "prefer-const": "warn",
    "no-unused-vars": "off", // делегируем в @typescript-eslint/no-unused-vars
    "no-console": ["warn", { allow: ["warn", "error"] }],
    "no-debugger": "error",
    "no-empty": "warn",
    "no-irregular-whitespace": "warn",

    // === React 19 compiler rules — пока warn, починим в Phase 1+ ===
    "react-hooks/set-state-in-effect": "warn",
  },
}, {
  // === Per-files overrides ===
  // Отключаем `no-undef` для TS-файлов: TypeScript уже валидирует типы,
  // а это правило не понимает TS-глобалы (React, NodeJS, RequestInit и т.д.).
  files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.mts"],
  rules: {
    "no-undef": "off",
  },
}, {
  ignores: [
    "node_modules/**",
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "examples/**",
    "skills/**",
    "mini-services/**",
    ".zscripts/**",
    "scripts/**",
    "prisma/migrations/**",
    // Agent sandboxes / local artifacts (gitignored, but present on developer machines)
    "download/**",
  ],
}];

export default eslintConfig;
