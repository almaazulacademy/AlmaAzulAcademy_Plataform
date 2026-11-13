/**
 * Registro das edições de eventos especiais preparadas no repositório.
 *
 * Uma edição nova entra aqui com o próprio arquivo de conteúdo em
 * `lib/events/fixtures/` (um `EventEdition`). A partir disso, sem cadastrar nada:
 *
 *   - a prévia da página: `/eventos/demonstracao/<slug>` (só dev e Preview);
 *   - a prévia dos e-mails: `pnpm email:preview:evento --edicao=<slug>`;
 *   - os scripts de cadastro: `pnpm events:edition-sql <slug>`.
 *
 * As edições já cadastradas continuam aqui com `registered: true`, como
 * histórico: a prévia funciona, o gerador recusa um novo cadastro.
 *
 * Módulo puro, sem imports de aplicação: é lido pelo Next e pelos testes.
 */

import { editionsErrors, type EventEdition } from "./edition.ts";
import { ESSENCIA_EDITION } from "./fixtures/essencia.ts";
import { ESSENCIA_LUA_CHEIA_EDITION } from "./fixtures/essencia-lua-cheia.ts";

export const EVENT_EDITIONS: readonly EventEdition[] = [ESSENCIA_EDITION, ESSENCIA_LUA_CHEIA_EDITION];

{
  const errors = editionsErrors(EVENT_EDITIONS);
  if (errors.length) throw new Error(`Edições de eventos inválidas: ${errors.join("; ")}`);
}

/** A edição pelo slug, ou null. */
export function getEventEdition(slug: string, editions: readonly EventEdition[] = EVENT_EDITIONS): EventEdition | null {
  return editions.find((edition) => edition.slug === slug) ?? null;
}
