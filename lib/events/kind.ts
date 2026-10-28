/**
 * Tipo da sessão — agenda regular ou evento especial — para filtrar as turmas
 * de destino de uma troca de turma ou de um Stand-by.
 *
 * O banco já recusa a troca entre tipos (`EVENT_KIND_MISMATCH`, trigger
 * `reservations_event_kind_guard`). Este filtro é o que a tela mostra: uma
 * reserva regular só vê turmas regulares e uma reserva de evento só vê sessões
 * de evento, sem mudar nenhuma outra regra das RPCs de opções (preço, vagas,
 * status, base, autorização).
 *
 * A leitura é a do servidor, com a service role: `sessions.experience_id` e
 * `experiences.kind`. Sem a coluna `kind` (banco anterior à migration
 * `202610280001`), toda sessão é regular, como era. Qualquer outra falha
 * lança: sem saber o tipo, não há o que mostrar com segurança.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type ExperienceKind = "REGULAR" | "EVENT";

type QueryResult = { data: unknown; error: { message: string; code?: string } | null };

/** O pedaço do supabase-js usado aqui: `from(t).select(c).in(col, valores)`. */
export type KindQueryClient = {
  from(table: string): { select(columns: string): { in(column: string, values: string[]): PromiseLike<QueryResult> } };
};

export type SessionKinds = (sessionIds: string[]) => Promise<Map<string, ExperienceKind>>;

/** Ids por consulta: ~3,7 KB de URL, longe dos ~8 KB em que proxies começam a recusar. */
export const SESSION_BATCH = 100;

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object") : [];
}

/** A coluna ainda não existe: o banco não conhece eventos. */
function isMissingKindColumn(error: { message: string; code?: string }) {
  return error.code === "42703" || /column .*kind.* does not exist/i.test(error.message);
}

export function sessionKindsFrom(client: KindQueryClient): SessionKinds {
  return async (sessionIds) => {
    const kinds = new Map<string, ExperienceKind>();
    const ids = [...new Set(sessionIds.filter(Boolean))];
    if (!ids.length) return kinds;

    // A troca de turma do painel lista a agenda inteira (centenas de turmas). O
    // filtro `in` vai na URL do PostgREST: em lotes, ela fica bem abaixo do
    // limite dos proxies.
    const experienceOf = new Map<string, string>();
    for (let start = 0; start < ids.length; start += SESSION_BATCH) {
      const sessions = await client.from("sessions").select("id, experience_id").in("id", ids.slice(start, start + SESSION_BATCH));
      if (sessions.error) throw new Error(`SESSION_KIND_LOOKUP_FAILED: ${sessions.error.message}`);
      for (const row of rows(sessions.data)) experienceOf.set(String(row.id), String(row.experience_id));
    }

    const experienceIds = [...new Set(experienceOf.values())];
    const experiences = experienceIds.length
      ? await client.from("experiences").select("id, kind").in("id", experienceIds)
      : { data: [], error: null };
    if (experiences.error && !isMissingKindColumn(experiences.error)) {
      throw new Error(`SESSION_KIND_LOOKUP_FAILED: ${experiences.error.message}`);
    }
    const kindOf = new Map(rows(experiences.error ? [] : experiences.data).map((row) => [String(row.id), row.kind === "EVENT" ? "EVENT" as const : "REGULAR" as const]));

    for (const [sessionId, experienceId] of experienceOf) {
      kinds.set(sessionId, experiences.error ? "REGULAR" : kindOf.get(experienceId) ?? "REGULAR");
    }
    return kinds;
  };
}

/** O cliente do servidor. A conversão evita que o TypeScript expanda os genéricos do supabase-js. */
export function sessionKindsFromSupabase(client: SupabaseClient): SessionKinds {
  return sessionKindsFrom(client as unknown as KindQueryClient);
}

/**
 * Só as opções do mesmo tipo da turma de origem. Origem desconhecida (sessão
 * que não existe mais) não tem tipo para comparar: nenhuma opção passa.
 */
export function keepSameKind<T>(originSessionId: string | null | undefined, options: T[], sessionIdOf: (option: T) => string, kinds: Map<string, ExperienceKind>): T[] {
  const origin = originSessionId ? kinds.get(originSessionId) : undefined;
  if (!origin) return [];
  return options.filter((option) => kinds.get(sessionIdOf(option)) === origin);
}

/** Lê os tipos da origem e das opções e devolve só as do mesmo tipo. */
export async function filterSameKind<T>(lookup: SessionKinds, originSessionId: string | null | undefined, options: T[], sessionIdOf: (option: T) => string): Promise<T[]> {
  if (!originSessionId) return [];
  if (!options.length) return options;
  const kinds = await lookup([originSessionId, ...options.map(sessionIdOf)]);
  return keepSameKind(originSessionId, options, sessionIdOf, kinds);
}
