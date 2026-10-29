/**
 * Prévia dos e-mails da lista de espera do evento (etapa 5C-2), com o ESSÊNCIA
 * de demonstração: confirmação da inscrição e aviso de vaga.
 *
 *   pnpm email:preview:evento-lista      # só gera arquivos em .preview/
 *
 * Não envia nada, não fala com o Supabase e não tem opção de envio: o link de
 * saída usa um token fictício que não abre inscrição nenhuma.
 */

import { mkdirSync, writeFileSync } from "node:fs";

import { CONTACT_EMAIL } from "../../lib/contact.ts";
import { validateEventEditorial } from "../../lib/events/editorial.ts";
import { CONCHA_ACUSTICA_LOCATION, ESSENCIA_EDITORIAL, ESSENCIA_STARTS_AT } from "../../lib/events/fixtures/essencia.ts";
import { buildEventWaitlistJoinedEmail, buildEventWaitlistSpotEmail, type WaitlistEvent } from "../../lib/events/waitlist-email.ts";

const editorial = validateEventEditorial(ESSENCIA_EDITORIAL);
if (!editorial.success) throw new Error(`Conteúdo do ESSÊNCIA inválido: ${editorial.errors.join("; ")}`);

const event: WaitlistEvent = { slug: "essencia", content: editorial.data.event, location: CONCHA_ACUSTICA_LOCATION, durationMinutes: 210 };
const common = {
  fullName: "Equipe Alma Azul",
  email: CONTACT_EMAIL,
  quantity: 2,
  experienceTitle: "ESSÊNCIA — Corpo, Mente e Natureza",
  startsAt: ESSENCIA_STARTS_AT,
  baseName: "Cápsula Bar — Concha Acústica",
  cancelToken: "0".repeat(64),
};

const messages = [
  ["lista-confirmacao", buildEventWaitlistJoinedEmail(common, event)],
  ["lista-aviso-de-vaga", buildEventWaitlistSpotEmail({ ...common, sessionId: "00000000-0000-4000-8000-0000000e55e0", priceCents: 15_000, remainingSpots: 2 }, event)],
] as const;

mkdirSync(".preview", { recursive: true });
for (const [name, message] of messages) {
  writeFileSync(`.preview/evento-essencia-${name}.html`, message.html, "utf8");
  writeFileSync(`.preview/evento-essencia-${name}.txt`, message.text, "utf8");
  console.info(`${name}: ${message.subject}`);
  console.info(`  .preview/evento-essencia-${name}.html`);
}
console.info("Nenhum e-mail enviado.");
