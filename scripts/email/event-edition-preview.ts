/**
 * Prévia dos e-mails do ingresso de uma edição registrada em
 * `lib/events/editions.ts`. Só gera arquivos: não tem envio, não fala com o
 * provedor de e-mail nem com o Supabase e não cria reserva.
 *
 *   pnpm email:preview:edicao essencia-lua-cheia      # 2 participantes
 *   pnpm email:preview:edicao essencia-lua-cheia 3    # 3 participantes
 *
 * Gera `.preview/evento-<slug>-{confirmacao,lembrete-qr,reagendamento}.{html,txt}`.
 * O envio de demonstração continua só no roteiro da 1ª edição
 * (`scripts/email/event-preview.ts`), com autorização.
 */

import { mkdirSync, writeFileSync } from "node:fs";

import { CONTACT_EMAIL } from "../../lib/contact.ts";
import { validateEventEditorial } from "../../lib/events/editorial.ts";
import { getEventEdition } from "../../lib/events/editions.ts";
import {
  buildCheckinReminderEmail,
  buildReservationConfirmationEmail,
  buildReservationRescheduleEmail,
  type ConfirmationEmail,
  type ReservationConfirmationData,
} from "../../lib/reservations/confirmation-email.ts";

/** Os três e-mails do ingresso de uma edição, com uma reserva fictícia. */
export function editionPreviewEmails(slug: string, quantity = 2): Array<[string, ConfirmationEmail | null]> {
  const edition = getEventEdition(slug);
  if (!edition) throw new Error(`Edição "${slug}" não está registrada em lib/events/editions.ts.`);
  const editorial = validateEventEditorial(edition.editorial);
  if (!editorial.success) throw new Error(`Conteúdo de ${slug} inválido: ${editorial.errors.join("; ")}`);
  const demo: ReservationConfirmationData = {
    reservationId: "00000000-0000-4000-8000-0000000ed1a0",
    publicCode: "DEMOEDICAO",
    fullName: "Equipe Alma Azul",
    email: CONTACT_EMAIL,
    quantity,
    experienceTitle: edition.title,
    startsAt: edition.startsAt,
    checkinToken: "9e5e0000-0000-4000-8000-00000000d3e1",
    durationMinutes: edition.durationMinutes,
    location: edition.location,
    event: editorial.data.event,
  };
  return [
    ["confirmacao", buildReservationConfirmationEmail(demo)],
    ["lembrete-qr", buildCheckinReminderEmail(demo)],
    ["reagendamento", buildReservationRescheduleEmail(demo)],
  ];
}

if (process.argv[1]?.endsWith("event-edition-preview.ts")) {
  const args = process.argv.slice(2);
  const slug = args.find((arg) => !/^\d+$/.test(arg)) ?? "";
  const quantity = Number(args.find((arg) => /^\d+$/.test(arg)) ?? "2") || 2;
  mkdirSync(".preview", { recursive: true });
  for (const [name, message] of editionPreviewEmails(slug, quantity)) {
    if (!message) continue;
    writeFileSync(`.preview/evento-${slug}-${name}.html`, message.html, "utf8");
    writeFileSync(`.preview/evento-${slug}-${name}.txt`, message.text, "utf8");
    console.info(`${name}: ${message.subject}`);
    console.info(`  .preview/evento-${slug}-${name}.html`);
  }
  console.info("Só arquivos: nenhum e-mail enviado.");
}
