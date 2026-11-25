/**
 * Gera uma prévia dos e-mails de reserva sem enviar nada.
 *
 *   pnpm email:preview
 *
 * Escreve o HTML e o texto puro em `.preview/`, para abrir no navegador e
 * conferir o layout no celular e no desktop — uma versão por base, porque o
 * local de encontro vem da base da reserva. Não fala com o provedor, não fala
 * com o Supabase e não precisa de nenhuma credencial.
 *
 * Também gera `.preview/revisao-emails.html`: as duas confirmações lado a lado,
 * em largura de desktop e de celular, num arquivo só (imagens embutidas). Só
 * na prévia as imagens apontam para os arquivos locais e o QR fictício é
 * desenhado aqui — o e-mail enviado usa as URLs públicas do site.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

import QRCode from "qrcode";

import type { BaseLocation } from "../../lib/bases/location.ts";
import { checkinQrImageUrl, checkinUrl } from "../../lib/checkin/token.ts";
import {
  buildCheckinReminderEmail,
  buildReservationConfirmationEmail,
  buildReservationRescheduleEmail,
  escapeHtml,
  type ReservationConfirmationData,
} from "../../lib/reservations/confirmation-email.ts";
import { SITE_URL } from "../../lib/site.ts";

/** Espelho de `public.bases` depois de `supabase/maintenance/lago_norte_localizacao_2026_11.sql`. */
const LAGO_NORTE_AFTER_SCRIPT: BaseLocation = {
  baseSlug: "lago-norte",
  baseName: "Lago Norte",
  meetingPoint: null,
  address: "SHIN QL 5, Conjunto 5, Casa 19 — Lago Norte, Brasília-DF",
  mapsUrl: "https://maps.app.goo.gl/KQUaHE4LGmg8h3q17",
};

/** Espelho do que a migration de lançamento grava em `public.bases`. */
const CAPSULA_BAR_LOCATION: BaseLocation = {
  baseSlug: "concha-acustica",
  baseName: "Cápsula Bar — Concha Acústica",
  meetingPoint: "Em frente ao Cápsula Bar — Concha Acústica",
  address: "SHTN Trecho 1, Lote 8 — Brasília/DF",
  mapsUrl: "https://maps.app.goo.gl/ueSCiLvHAggrzuAX7",
};

const quantity = Number(process.argv[2] ?? "1") || 1;

const samples: Array<{ file: string; label: string; data: ReservationConfirmationData }> = [
  {
    file: "lago-norte",
    label: "Lago Norte",
    data: {
      reservationId: "11110000-0000-4000-8000-000000000001",
      publicCode: "AZ7K2M9QX1",
      fullName: "João Gonçalves",
      email: "exemplo@exemplo.com",
      quantity,
      experienceTitle: "Imersão Paranoá",
      startsAt: "2026-12-06T12:00:00.000Z",
      // Token fictício, só para desenhar a seção do QR.
      checkinToken: "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b",
      durationMinutes: 90,
      location: LAGO_NORTE_AFTER_SCRIPT,
    },
  },
  {
    file: "capsula-bar",
    label: "Cápsula Bar — Concha Acústica",
    data: {
      reservationId: "11110000-0000-4000-8000-000000000002",
      publicCode: "CB4T8N2WQ7",
      fullName: "Marina Albuquerque",
      email: "exemplo@exemplo.com",
      quantity,
      experienceTitle: "Remada Sunset",
      startsAt: "2026-12-06T20:30:00.000Z",
      checkinToken: "7c1e2d3f-4a5b-4c6d-9e8f-0a1b2c3d4e5f",
      durationMinutes: 90,
      location: CAPSULA_BAR_LOCATION,
    },
  },
];

const IMAGE_BASE = `${SITE_URL}/images/email/`;

function dataUri(path: string) {
  const type = path.endsWith(".png") ? "image/png" : "image/jpeg";
  return `data:${type};base64,${readFileSync(path).toString("base64")}`;
}

/** Só na prévia: imagens do site viram arquivo local e o QR fictício é desenhado aqui. */
async function localized(html: string, data: ReservationConfirmationData, embed: boolean) {
  let out = html.replace(new RegExp(`${IMAGE_BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([\\w.-]+)`, "g"), (_, name: string) =>
    embed ? dataUri(`public/images/email/${name}`) : `../public/images/email/${name}`,
  );
  if (data.checkinToken) {
    const qr = await QRCode.toDataURL(checkinUrl(data.checkinToken), { width: 440, margin: 1 });
    out = out.replaceAll(checkinQrImageUrl(data.checkinToken), qr);
  }
  return out;
}

mkdirSync(".preview", { recursive: true });

const review: Array<{ label: string; subject: string; html: string }> = [];

for (const { file, label, data } of samples) {
  const email = buildReservationConfirmationEmail(data);
  writeFileSync(`.preview/confirmacao-${file}.html`, await localized(email.html, data, false), "utf8");
  writeFileSync(`.preview/confirmacao-${file}.txt`, email.text, "utf8");
  review.push({ label, subject: email.subject, html: await localized(email.html, data, true) });

  const reminder = buildCheckinReminderEmail(data);
  if (reminder) {
    writeFileSync(`.preview/lembrete-qr-${file}.html`, await localized(reminder.html, data, false), "utf8");
    writeFileSync(`.preview/lembrete-qr-${file}.txt`, reminder.text, "utf8");
  }

  // Reagendamento vindo de Stand-by: a mesma reserva, na turma nova.
  const reschedule = buildReservationRescheduleEmail(data);
  writeFileSync(`.preview/reagendamento-${file}.html`, await localized(reschedule.html, data, false), "utf8");
  writeFileSync(`.preview/reagendamento-${file}.txt`, reschedule.text, "utf8");

  console.info(`${data.location?.baseName}`);
  console.info(`  Assunto: ${email.subject}`);
  console.info(`  HTML   : .preview/confirmacao-${file}.html`);
  console.info(`  Texto  : .preview/confirmacao-${file}.txt`);
  console.info(`  Reagendamento: .preview/reagendamento-${file}.html (${reschedule.subject})`);
}

/** Uma moldura de prévia: o e-mail num iframe da largura pedida. */
function frame(html: string, width: number, title: string) {
  return `<figure style="margin:0;flex:none;width:${width}px;">
      <figcaption style="font:600 13px/1.4 -apple-system,Segoe UI,sans-serif;color:#14312c;margin:0 0 8px;">${escapeHtml(title)} · ${width}px</figcaption>
      <iframe title="${escapeHtml(title)}" srcdoc="${escapeHtml(html)}" style="width:${width}px;height:4200px;border:1px solid #d7c5a0;border-radius:12px;background:#f7f5ef;" scrolling="no"></iframe>
    </figure>`;
}

const sections = review
  .map(({ label, subject, html }) => `
  <section style="margin:0 0 48px;">
    <h2 style="font:600 20px/1.3 -apple-system,Segoe UI,sans-serif;color:#214f43;margin:0 0 4px;">${escapeHtml(label)}</h2>
    <p style="font:14px/1.5 -apple-system,Segoe UI,sans-serif;color:#14312c;opacity:.75;margin:0 0 16px;">Assunto: ${escapeHtml(subject)}</p>
    <div style="display:flex;gap:32px;align-items:flex-start;overflow-x:auto;">
      ${frame(html, 640, "Desktop")}
      ${frame(html, 375, "Celular")}
    </div>
  </section>`)
  .join("");

writeFileSync(
  ".preview/revisao-emails.html",
  `<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Prévia dos e-mails de confirmação</title></head>
<body style="margin:0;padding:24px;background:#ffffff;">
  <h1 style="font:600 24px/1.3 -apple-system,Segoe UI,sans-serif;color:#14312c;margin:0 0 24px;">Prévia — e-mails de confirmação de reserva</h1>${sections}
</body>
</html>`,
  "utf8",
);
console.info("Revisão lado a lado: .preview/revisao-emails.html");
