import { cache } from "react";

import { listOpenSessions } from "@/lib/reservations/data";
import type { BookingSession } from "@/lib/reservations/types";
import { getSupabaseServerClient } from "@/lib/supabase/server";

export type OpenSessionsResult =
  | { status: "READY"; sessions: BookingSession[] }
  | { status: "UNCONFIGURED" }
  | { status: "ERROR" };

/**
 * Sessões abertas de uma experiência, lidas uma única vez por render.
 *
 * A página da experiência precisa das mesmas sessões em dois lugares: o
 * destaque das turmas, logo abaixo do Hero, e a grade de escolha lá embaixo.
 * O `cache()` do React garante que os dois leiam exatamente a mesma resposta do
 * `list_open_sessions` na mesma requisição — nem duas consultas, nem o risco de
 * o topo anunciar uma turma que a grade já não oferece.
 *
 * O erro não sobe: quem chama recebe um estado e decide o que mostrar. Uma
 * falha de leitura nunca deve derrubar a landing inteira.
 */
export const readOpenSessions = cache(async (experienceSlug: string): Promise<OpenSessionsResult> => {
  const supabase = getSupabaseServerClient();
  if (!supabase) return { status: "UNCONFIGURED" };

  try {
    return { status: "READY", sessions: await listOpenSessions(supabase, experienceSlug) };
  } catch (error) {
    console.error("Erro ao ler sessões abertas:", error instanceof Error ? error.message : "erro desconhecido");
    return { status: "ERROR" };
  }
});
