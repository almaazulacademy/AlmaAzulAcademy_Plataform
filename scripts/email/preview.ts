/**
 * Gera uma prévia dos e-mails de reserva sem enviar nada.
 *
 *   pnpm email:preview
 *
 * Escreve o HTML e o texto puro em `.preview/`, para abrir no navegador e
 * conferir o layout no celular e no desktop — uma versão por base, porque o
 * local de encontro vem da base da reserva. Não fala com o provedor, não fala
 * com o Supabase e não precisa de nenhuma credencial.
 */

import { mkdirSync, writeFileSync } from "node:fs";

import { LAGO_NORTE_LOCATION, type BaseLocation } from "../../lib/bases/location.ts";
import {
  buildCheckinReminderEmail,
  buildReservationConfirmationEmail,
  type ReservationConfirmationData,
} from "../../lib/reservations/confirmation-email.ts";

/** Espelho do que a migration de lançamento grava em `public.bases`. */
const CAPSULA_BAR_LOCATION: BaseLocation = {
  baseSlug: "concha-acustica",
  baseName: "Cápsula Bar — Concha Acústica",
  meetingPoint: "Em frente ao Cápsula Bar — Concha Acústica",
  address: "SHTN Trecho 1, Lote 8 — Brasília/DF",
  mapsUrl: "https://maps.app.goo.gl/ueSCiLvHAggrzuAX7",
};

const quantity = Number(process.argv[2] ?? "1") || 1;

const samples: Array<{ file: string; data: ReservationConfirmationData }> = [
  {
    file: "lago-norte",
    data: {
      reservationId: "11110000-0000-4000-8000-000000000001",
      publicCode: "AZ7K2M9QX1",
      fullName: "João Gonçalves",
      email: "exemplo@exemplo.com",
      quantity,
      experienceTitle: "Imersão Paranoá",
      startsAt: "2026-09-06T12:00:00.000Z",
      // Token fictício, só para desenhar a seção do QR.
      checkinToken: "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b",
      durationMinutes: 90,
      location: LAGO_NORTE_LOCATION,
    },
  },
  {
    file: "capsula-bar",
    data: {
      reservationId: "11110000-0000-4000-8000-000000000002",
      publicCode: "CB4T8N2WQ7",
      fullName: "Marina Albuquerque",
      email: "exemplo@exemplo.com",
      quantity,
      experienceTitle: "Remada Sunset",
      // Inauguração: domingo, 11/10/2026, 17h em Brasília.
      startsAt: "2026-10-11T20:00:00.000Z",
      checkinToken: "7c1e2d3f-4a5b-4c6d-9e8f-0a1b2c3d4e5f",
      durationMinutes: 90,
      location: CAPSULA_BAR_LOCATION,
    },
  },
];

mkdirSync(".preview", { recursive: true });

for (const { file, data } of samples) {
  const email = buildReservationConfirmationEmail(data);
  writeFileSync(`.preview/confirmacao-${file}.html`, email.html, "utf8");
  writeFileSync(`.preview/confirmacao-${file}.txt`, email.text, "utf8");

  const reminder = buildCheckinReminderEmail(data);
  if (reminder) {
    writeFileSync(`.preview/lembrete-qr-${file}.html`, reminder.html, "utf8");
    writeFileSync(`.preview/lembrete-qr-${file}.txt`, reminder.text, "utf8");
  }

  console.info(`${data.location?.baseName}`);
  console.info(`  Assunto: ${email.subject}`);
  console.info(`  HTML   : .preview/confirmacao-${file}.html`);
  console.info(`  Texto  : .preview/confirmacao-${file}.txt`);
}
