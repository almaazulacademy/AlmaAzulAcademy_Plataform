/**
 * Resolução do alias `@/` para o runner de testes do Node.
 *
 * O `tsconfig.json` mapeia `@/*` para a raiz do projeto e o bundler do Next
 * entende isso sozinho. O `node --test` não: sem este gancho, qualquer teste que
 * importe um módulo da aplicação que use o alias — praticamente todo o fluxo de
 * pagamento — falha na resolução.
 *
 * `registerHooks` é síncrono e roda no mesmo thread, então funciona junto com o
 * `--experimental-strip-types` que já carrega os `.ts` diretamente.
 */

import { existsSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Mesma ordem de extensões que o resolvedor do TypeScript usa. */
function resolveAlias(specifier) {
  const target = path.join(projectRoot, specifier.slice(2));
  const candidates = [
    target,
    `${target}.ts`,
    `${target}.tsx`,
    path.join(target, "index.ts"),
    path.join(target, "index.tsx"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const resolved = resolveAlias(specifier);
      if (resolved) return nextResolve(pathToFileURL(resolved).href, context);
    }
    return nextResolve(specifier, context);
  },
});
