/**
 * Gera uma prévia do e-mail de confirmação sem enviar nada.
 *
 *   pnpm email:preview
 *
 * Escreve o HTML e o texto puro em `.preview/`, para abrir no navegador e
 * conferir o layout no celular e no desktop. Não fala com o provedor, não fala
 * com o Supabase e não precisa de nenhuma credencial.
 */

import { mkdirSync, writeFileSync } from "node:fs";

import { buildReservationConfirmationEmail } from "../../lib/reservations/confirmation-email.ts";

const email = buildReservationConfirmationEmail({
  reservationId: "11110000-0000-4000-8000-000000000001",
  publicCode: "AZ7K2M9QX1",
  fullName: "João Gonçalves",
  email: "exemplo@exemplo.com",
  quantity: Number(process.argv[2] ?? "1") || 1,
  experienceTitle: "Imersão Paranoá",
  startsAt: "2026-09-06T12:00:00.000Z",
});

mkdirSync(".preview", { recursive: true });
writeFileSync(".preview/confirmacao.html", email.html, "utf8");
writeFileSync(".preview/confirmacao.txt", email.text, "utf8");

console.info(`Assunto: ${email.subject}`);
console.info("HTML  : .preview/confirmacao.html");
console.info("Texto : .preview/confirmacao.txt");
