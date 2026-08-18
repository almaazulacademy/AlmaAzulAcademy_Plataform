import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

/**
 * Configuração ESLint em flat config.
 *
 * `eslint-config-next` 15.x ainda é publicado no formato eslintrc, então o
 * FlatCompat é o caminho oficial para consumi-lo sem escolher plugin por plugin
 * — e sem congelar aqui uma lista que o Next atualiza a cada release.
 *
 * `next/core-web-vitals` traz React, Hooks, jsx-a11y e as regras do Next;
 * `next/typescript` acrescenta as regras de TypeScript. O foco é bug, acesso e
 * contrato — formatação não é responsabilidade do lint neste projeto.
 */
const config = [
  {
    ignores: [
      ".next/**",
      "out/**",
      "build/**",
      "node_modules/**",
      "next-env.d.ts",
      "public/**",
      "supabase/**",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
];

export default config;
