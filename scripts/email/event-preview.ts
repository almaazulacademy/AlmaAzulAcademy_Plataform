/**
 * Prévia — e, só com confirmação explícita, envio de demonstração — dos
 * e-mails de evento especial, com o ESSÊNCIA de demonstração.
 *
 *   pnpm email:preview:evento            # só gera arquivos em .preview/
 *   pnpm email:preview:evento 3          # com 3 participantes
 *
 *   # Envio de demonstração (só com autorização):
 *   pnpm email:preview:evento --enviar --confirmo
 *
 * Sem `--enviar --confirmo`, não fala com o provedor. Com eles, envia **só para
 * o e-mail oficial da equipe** (`CONTACT_EMAIL`), com o assunto marcado
 * "[DEMONSTRAÇÃO]" e chave de idempotência fixa por modelo — repetir o comando
 * não entrega de novo por 24 horas. Precisa das variáveis do provedor
 * (`RESEND_API_KEY`, `EMAIL_FROM`) no ambiente de quem roda. Não fala com o
 * Supabase e não cria reserva.
 */

import { mkdirSync, writeFileSync } from "node:fs";

import { CONTACT_EMAIL } from "../../lib/contact.ts";
import { getEmailProvider } from "../../lib/email/index.ts";
import { validateEventEditorial } from "../../lib/events/editorial.ts";
import { CONCHA_ACUSTICA_LOCATION, ESSENCIA_EDITORIAL, ESSENCIA_STARTS_AT } from "../../lib/events/fixtures/essencia.ts";
import {
  buildCheckinReminderEmail,
  buildReservationConfirmationEmail,
  buildReservationRescheduleEmail,
  type ConfirmationEmail,
  type ReservationConfirmationData,
} from "../../lib/reservations/confirmation-email.ts";

const args = process.argv.slice(2);
const quantity = Number(args.find((arg) => /^\d+$/.test(arg)) ?? "2") || 2;
const send = args.includes("--enviar") && args.includes("--confirmo");

const editorial = validateEventEditorial(ESSENCIA_EDITORIAL);
if (!editorial.success) throw new Error(`Conteúdo do ESSÊNCIA inválido: ${editorial.errors.join("; ")}`);

/** Reserva fictícia: código e token de demonstração, e-mail da equipe. */
export const demo: ReservationConfirmationData = {
  reservationId: "00000000-0000-4000-8000-0000000e55e0",
  publicCode: "DEMOESS001",
  fullName: "Equipe Alma Azul",
  email: CONTACT_EMAIL,
  quantity,
  experienceTitle: "ESSÊNCIA — Corpo, Mente e Natureza",
  startsAt: ESSENCIA_STARTS_AT,
  checkinToken: "9e5e0000-0000-4000-8000-00000000d3e0",
  durationMinutes: 210,
  location: CONCHA_ACUSTICA_LOCATION,
  event: editorial.data.event,
};

const messages: Array<[string, ConfirmationEmail | null]> = [
  ["confirmacao", buildReservationConfirmationEmail(demo)],
  ["lembrete-qr", buildCheckinReminderEmail(demo)],
  ["reagendamento", buildReservationRescheduleEmail(demo)],
];

mkdirSync(".preview", { recursive: true });
for (const [name, message] of messages) {
  if (!message) continue;
  writeFileSync(`.preview/evento-essencia-${name}.html`, message.html, "utf8");
  writeFileSync(`.preview/evento-essencia-${name}.txt`, message.text, "utf8");
  console.info(`${name}: ${message.subject}`);
  console.info(`  .preview/evento-essencia-${name}.html`);
}

if (send) {
  const provider = getEmailProvider();
  if (!provider) throw new Error("Provedor de e-mail não configurado neste ambiente (RESEND_API_KEY / EMAIL_FROM).");
  for (const [name, message] of messages) {
    if (!message) continue;
    await provider.send({
      ...message,
      to: CONTACT_EMAIL,
      subject: `[DEMONSTRAÇÃO] ${message.subject}`,
      idempotencyKey: `demo-evento-essencia-${name}-v1`,
    });
    console.info(`Enviado (demonstração) para ${CONTACT_EMAIL}: ${name}`);
  }
} else {
  console.info("Nenhum e-mail enviado. Para a demonstração: --enviar --confirmo (só com autorização).");
}
