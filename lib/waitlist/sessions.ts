/**
 * De onde vêm as turmas que o site lista: `list_open_sessions`, como sempre, ou
 * `list_public_sessions`, que inclui as esgotadas.
 *
 * Recebe as duas leituras prontas, sem Supabase: é o que permite testar a
 * escolha e a contingência contra o Postgres em memória.
 */

import { isMissingFunctionError } from "../reservations/data.ts";
import type { BookingSession } from "../reservations/types.ts";
import { asOpenSession, type PublicSession } from "./public.ts";

export type PublicSessionSources = {
  /** `WAITLIST_PUBLIC_ENABLED`. */
  enabled: boolean;
  listOpen: (experienceSlug: string) => Promise<BookingSession[]>;
  listPublic: (experienceSlug: string) => Promise<PublicSession[]>;
  /** Só um símbolo: nada da resposta do banco vai para o log. */
  warn?: (code: string) => void;
};

/**
 * Turmas de uma experiência para exibir.
 *
 * Desligada a variável, é exatamente `list_open_sessions` — o site como era.
 * Ligada, `list_public_sessions`; se a função não existir no banco (migration
 * da fase 1 ausente ou revertida), volta para `list_open_sessions` em vez de
 * derrubar a agenda: as turmas esgotadas somem, e nada mais muda. Qualquer
 * outra falha sobe, como a leitura de sempre.
 */
export async function loadPublicSessions(experienceSlug: string, sources: PublicSessionSources): Promise<PublicSession[]> {
  if (!sources.enabled) return (await sources.listOpen(experienceSlug)).map(asOpenSession);
  try {
    return await sources.listPublic(experienceSlug);
  } catch (error) {
    if (!isMissingFunctionError(error)) throw error;
    sources.warn?.("LIST_PUBLIC_SESSIONS_MISSING");
    return (await sources.listOpen(experienceSlug)).map(asOpenSession);
  }
}
