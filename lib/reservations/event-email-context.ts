/**
 * Conteúdo do evento especial para os e-mails da reserva.
 *
 * Os payloads das RPCs de e-mail (`reservation_confirmation_email`,
 * `admin_reservation_qr_email_payload`, o do lembrete em lote e o do
 * reagendamento) não dizem se a reserva é de um evento. Este módulo completa o
 * payload, pelo `reservationId` que todos trazem, com o tipo da experiência e,
 * quando é evento, o `editorial_content` — de onde sai o e-mail de evento.
 *
 * Falha fechada: sem conseguir ler o tipo, lança, e o envio fica pendente para
 * nova tentativa — nunca sai o e-mail genérico de remada para um ingresso de
 * evento. Banco sem a coluna `kind` não tem evento: o payload segue intacto.
 *
 * Módulo puro, sem imports de aplicação: é lido pelo Next e pelos testes.
 */

type QueryResult = { data: unknown; error: { message: string; code?: string } | null };

/** O pedaço do supabase-js usado aqui: `from(t).select(c).eq(col, valor)`. */
export type EventEmailQueryClient = {
  from(table: string): { select(columns: string): { eq(column: string, value: string): PromiseLike<QueryResult> } };
};

function firstRow(data: unknown): Record<string, unknown> | null {
  const row = Array.isArray(data) ? data[0] : data;
  return row && typeof row === "object" ? row as Record<string, unknown> : null;
}

function isMissingKindColumn(error: { message: string; code?: string }) {
  return error.code === "42703" || /column .*kind.* does not exist/i.test(error.message);
}

/** O payload de sempre, com `experienceKind` e, para evento, `eventEditorial`. */
export async function withEventEmailContext(client: EventEmailQueryClient, payload: unknown): Promise<unknown> {
  const row = firstRow(payload);
  const reservationId = typeof row?.reservationId === "string" ? row.reservationId : "";
  if (!row || !reservationId) return payload;

  const reservation = await client.from("reservations").select("experience_id").eq("id", reservationId);
  if (reservation.error) throw new Error("EVENT_CONTEXT_UNAVAILABLE");
  const experienceId = firstRow(reservation.data)?.experience_id;
  if (typeof experienceId !== "string" || !experienceId) throw new Error("EVENT_CONTEXT_UNAVAILABLE");

  const experience = await client.from("experiences").select("kind, editorial_content").eq("id", experienceId);
  if (experience.error) {
    if (isMissingKindColumn(experience.error)) return { ...row, experienceKind: "REGULAR" };
    throw new Error("EVENT_CONTEXT_UNAVAILABLE");
  }
  const found = firstRow(experience.data);
  if (found?.kind !== "EVENT") return { ...row, experienceKind: "REGULAR" };
  return { ...row, experienceKind: "EVENT", eventEditorial: found.editorial_content };
}
