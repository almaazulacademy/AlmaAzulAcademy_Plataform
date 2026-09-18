import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import jsQR from "jsqr";
import QRCode from "qrcode";

import {
  attendanceTotals,
  checkinQrImageUrl,
  checkinUrl,
  extractCheckinToken,
  isCheckinToken,
  isDateKey,
  localDateKey,
  presenceState,
} from "../lib/checkin/token.ts";
import { resolveCheckinOrigin } from "../lib/checkin/origin.ts";
import {
  checkinErrorResponse,
  parseAttendanceSession,
  parseAttendanceSessions,
  parseCheckinReservation,
} from "../lib/checkin/parse.ts";
import {
  buildCheckinReminderEmail,
  buildReservationConfirmationEmail,
  CHECKIN_NOTE,
  parseReservationConfirmationData,
  type ReservationConfirmationData,
} from "../lib/reservations/confirmation-email.ts";

const TOKEN = "3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function statements(text: string) {
  return text.split("\n").filter((line) => !line.trimStart().startsWith("--")).join("\n");
}

const sql = statements(source("supabase/migrations/202609180001_reservation_checkin.sql"));

function fn(name: string) {
  const start = sql.indexOf(`function public.${name}(`);
  assert.ok(start >= 0, `função ${name} não encontrada`);
  const end = sql.indexOf("$$;", sql.indexOf("$$", start) + 2);
  return sql.slice(start, end);
}

function data(overrides: Partial<ReservationConfirmationData> = {}): ReservationConfirmationData {
  return {
    reservationId: "11110000-0000-4000-8000-000000000001",
    publicCode: "AZ7K2M9QX1",
    fullName: "João Silva",
    email: "joao@exemplo.com.br",
    quantity: 3,
    experienceTitle: "Imersão Paranoá",
    startsAt: "2026-09-19T12:00:00.000Z",
    checkinToken: TOKEN,
    ...overrides,
  };
}

// --- Token e QR -------------------------------------------------------------

test("o QR carrega só a URL com o token, sem dado pessoal", () => {
  const url = checkinUrl(TOKEN);
  assert.equal(url, `https://www.almaazulacademy.com.br/checkin/${TOKEN}`);
  for (const personal of ["João", "joao@", "AZ7K2M9QX1", "11110000"]) assert.ok(!url.includes(personal));
  assert.equal(checkinQrImageUrl(TOKEN), `https://www.almaazulacademy.com.br/api/checkin/qr/${TOKEN}`);
});

// --- Origem do QR (Preview x Produção) ----------------------------------------

const PROD = "https://www.almaazulacademy.com.br";

test("origem do QR: variável explícita tem prioridade", () => {
  assert.equal(resolveCheckinOrigin({ CHECKIN_PUBLIC_ORIGIN: "https://staging.exemplo.com/qualquer" }), "https://staging.exemplo.com");
  assert.equal(
    resolveCheckinOrigin({ CHECKIN_PUBLIC_ORIGIN: "https://staging.exemplo.com", VERCEL_ENV: "preview", VERCEL_URL: "x.vercel.app" }),
    "https://staging.exemplo.com",
  );
  assert.equal(resolveCheckinOrigin({ CHECKIN_PUBLIC_ORIGIN: "http://localhost:3000" }), "http://localhost:3000");
});

test("origem do QR: valor explícito inseguro ou inválido é ignorado", () => {
  assert.equal(resolveCheckinOrigin({ CHECKIN_PUBLIC_ORIGIN: "http://evil.example" }), PROD);
  assert.equal(resolveCheckinOrigin({ CHECKIN_PUBLIC_ORIGIN: "javascript:alert(1)" }), PROD);
  assert.equal(resolveCheckinOrigin({ CHECKIN_PUBLIC_ORIGIN: "   " }), PROD);
});

test("origem do QR: Preview da Vercel usa a URL da branch e, na falta, a do deploy", () => {
  assert.equal(
    resolveCheckinOrigin({ VERCEL_ENV: "preview", VERCEL_BRANCH_URL: "app-git-feat.vercel.app", VERCEL_URL: "app-abc123.vercel.app" }),
    "https://app-git-feat.vercel.app",
  );
  assert.equal(resolveCheckinOrigin({ VERCEL_ENV: "preview", VERCEL_URL: "app-abc123.vercel.app" }), "https://app-abc123.vercel.app");
  assert.equal(resolveCheckinOrigin({ VERCEL_ENV: "preview" }), PROD);
});

test("origem do QR: produção e local usam o domínio oficial, mesmo com VERCEL_URL", () => {
  assert.equal(resolveCheckinOrigin({ VERCEL_ENV: "production", VERCEL_URL: "app-abc123.vercel.app" }), PROD);
  assert.equal(resolveCheckinOrigin({}), PROD);
  assert.equal(resolveCheckinOrigin({ VERCEL_ENV: "development", VERCEL_URL: "localhost:3000" }), PROD);
});

test("links do QR seguem a origem resolvida (Preview) e não mudam SITE_URL", () => {
  const origin = resolveCheckinOrigin({ VERCEL_ENV: "preview", VERCEL_BRANCH_URL: "app-git-feat.vercel.app" });
  assert.equal(checkinUrl(TOKEN, origin), `https://app-git-feat.vercel.app/checkin/${TOKEN}`);
  assert.equal(checkinQrImageUrl(TOKEN, origin), `https://app-git-feat.vercel.app/api/checkin/qr/${TOKEN}`);
  assert.equal(extractCheckinToken(checkinUrl(TOKEN, origin)), TOKEN);
  assert.match(source("lib/site.ts"), /export const SITE_URL = "https:\/\/www\.almaazulacademy\.com\.br";/);
  // Só o check-in usa a nova origem.
  for (const path of ["app/layout.tsx", "app/api/reservations/route.ts", "lib/site.ts"]) {
    assert.doesNotMatch(source(path), /resolveCheckinOrigin|CHECKIN_PUBLIC_ORIGIN/, path);
  }
});

test("só aceita UUID v4 aleatório como token", () => {
  assert.ok(isCheckinToken(TOKEN));
  assert.ok(!isCheckinToken("11110000-0000-1000-8000-000000000001")); // v1, previsível
  assert.ok(!isCheckinToken("123"));
  assert.ok(!isCheckinToken(null));
});

test("extrai o token do QR lido, de qualquer origem, e recusa o resto", () => {
  assert.equal(extractCheckinToken(checkinUrl(TOKEN)), TOKEN);
  assert.equal(extractCheckinToken(`http://localhost:3000/checkin/${TOKEN.toUpperCase()}`), TOKEN);
  assert.equal(extractCheckinToken(`  ${TOKEN} `), TOKEN);
  assert.equal(extractCheckinToken(`https://preview.vercel.app/checkin/${TOKEN}?x=1`), TOKEN);
  assert.equal(extractCheckinToken("https://www.almaazulacademy.com.br/agenda"), null);
  assert.equal(extractCheckinToken(`https://evil.example/checkin/${TOKEN}extra`), null);
  assert.equal(extractCheckinToken("BEGIN:VCARD"), null);
});

test("o QR gerado é lido de volta pela câmera (jsQR) e identifica o mesmo token", () => {
  const qr = QRCode.create(checkinUrl(TOKEN), { errorCorrectionLevel: "M" });
  const scale = 6;
  const quiet = 4;
  const size = (qr.modules.size + quiet * 2) * scale;
  const pixels = new Uint8ClampedArray(size * size * 4).fill(255);
  for (let row = 0; row < qr.modules.size; row++) {
    for (let col = 0; col < qr.modules.size; col++) {
      if (!qr.modules.get(row, col)) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const y = (row + quiet) * scale + dy;
          const x = (col + quiet) * scale + dx;
          const index = (y * size + x) * 4;
          pixels[index] = pixels[index + 1] = pixels[index + 2] = 0;
        }
      }
    }
  }
  const decoded = jsQR(pixels, size, size);
  assert.ok(decoded, "QR não decodificou");
  assert.equal(extractCheckinToken(decoded.data), TOKEN);
});

// --- Presença ---------------------------------------------------------------

test("estado de presença separa aguardando, completo, parcial e ausente", () => {
  assert.equal(presenceState(3, null), "WAITING");
  assert.equal(presenceState(3, 3), "COMPLETE");
  assert.equal(presenceState(3, 2), "PARTIAL");
  assert.equal(presenceState(3, 0), "ABSENT");
});

test("totais contam reservas, vagas, presentes e aguardando de verdade", () => {
  const totals = attendanceTotals([
    { quantity: 2, checkedInCount: 2 },
    { quantity: 3, checkedInCount: null },
    { quantity: 4, checkedInCount: 3 },
  ]);
  assert.deepEqual(totals, { reservations: 3, reservedSpots: 9, present: 5, pendingReservations: 1, pendingSpots: 3 });
});

test("datas: hoje/amanhã no fuso de Brasília e validação de yyyy-mm-dd", () => {
  // 02:00 UTC do dia 20 ainda é dia 19 em Brasília.
  assert.equal(localDateKey(new Date("2026-09-20T02:00:00Z")), "2026-09-19");
  assert.equal(localDateKey(new Date("2026-09-20T02:00:00Z"), 1), "2026-09-20");
  assert.ok(isDateKey("2026-09-19"));
  assert.ok(!isDateKey("2026-02-30"));
  assert.ok(!isDateKey("19/09/2026"));
});

// --- Parsers e erros --------------------------------------------------------

test("parsers leem as RPCs de presença", () => {
  const reservation = parseCheckinReservation({
    reservationId: "r1", status: "CONFIRMED", fullName: "João", quantity: 3, sessionId: "s1",
    experienceTitle: "Sunset", startsAt: "2026-09-19T20:30:00Z", hasToken: true, checkedInCount: 2, checkinMethod: "QR",
  });
  assert.equal(reservation?.checkedInCount, 2);
  assert.equal(reservation?.checkinMethod, "QR");
  assert.equal(parseCheckinReservation({ reservationId: "r1", checkedInCount: null })?.checkedInCount, null);
  assert.equal(parseCheckinReservation(null), null);

  const session = parseAttendanceSession({ sessionId: "s1", reservations: [{ reservationId: "r1", quantity: 2, checkedInCount: null }] });
  assert.equal(session?.reservations.length, 1);
  const list = parseAttendanceSessions([{ session_id: "s1", reserved_spots: 24, present_count: 15, pending_spots: 9 }]);
  assert.equal(list[0].pendingSpots, 9);
});

test("recusas do banco viram mensagens claras para o instrutor", () => {
  assert.equal(checkinErrorResponse(new Error("CHECKIN_WRONG_SESSION")).message, "Este QR pertence a outra experiência.");
  assert.equal(checkinErrorResponse(new Error("CHECKIN_ALREADY_DONE")).status, 409);
  assert.equal(checkinErrorResponse(new Error("ADMIN_FORBIDDEN")).status, 403);
});

// --- E-mails ----------------------------------------------------------------

test("o e-mail de confirmação inclui a seção do QR com os dados da reserva", () => {
  const email = buildReservationConfirmationEmail(data());
  assert.match(email.html, /Seu QR Code de check-in/);
  assert.ok(email.html.includes(CHECKIN_NOTE));
  assert.ok(email.html.includes(`src="${checkinQrImageUrl(TOKEN)}"`));
  assert.ok(email.html.includes(`href="${checkinUrl(TOKEN)}"`));
  assert.match(email.html, /João Silva/);
  assert.match(email.html, /Vagas reservadas/);
  assert.match(email.html, /3 vagas/);
  assert.match(email.html, /09:00/);
  // Conteúdo anterior continua lá.
  assert.match(email.html, /Reserva confirmada/);
  assert.match(email.html, /Localização/);
  assert.match(email.text, /SEU QR CODE DE CHECK-IN/);
  assert.ok(email.text.includes(checkinUrl(TOKEN)));
});

test("sem token (migration pendente) o e-mail de confirmação sai como antes", () => {
  const email = buildReservationConfirmationEmail(data({ checkinToken: null }));
  assert.ok(!email.html.includes("QR Code"));
  assert.match(email.html, /Reserva confirmada/);
});

test("o payload do banco com checkinToken é lido; lixo é ignorado", () => {
  const row = { ...data(), status: "CONFIRMED", checkinToken: TOKEN.toUpperCase() };
  assert.equal(parseReservationConfirmationData(row)?.checkinToken, TOKEN);
  assert.equal(parseReservationConfirmationData({ ...row, checkinToken: "abc" })?.checkinToken, null);
});

test("o lembrete do QR tem nome, experiência, data, horário, vagas e o mesmo QR", () => {
  const reminder = buildCheckinReminderEmail(data());
  assert.ok(reminder);
  assert.equal(reminder.to, "joao@exemplo.com.br");
  assert.match(reminder.subject, /QR Code de check-in/);
  assert.match(reminder.text, /Olá, João!/);
  assert.match(reminder.text, /Passando para confirmar sua experiência na Alma Azul Academy\./);
  assert.match(reminder.text, /Experiência: Imersão Paranoá/);
  assert.match(reminder.text, /Horário: 09:00/);
  assert.match(reminder.text, /Vagas reservadas: 3 vagas/);
  assert.match(reminder.text, /Nos vemos na água!/);
  assert.ok(reminder.html.includes(checkinQrImageUrl(TOKEN)));
  assert.equal(buildCheckinReminderEmail(data({ checkinToken: null })), null);
});

// --- Migration --------------------------------------------------------------

test("migration é aditiva: não altera status, pagamento nem quantidade", () => {
  assert.doesNotMatch(sql, /drop table|drop column|alter column|delete from/i);
  assert.doesNotMatch(sql, /set\s+status\s*=/i);
  assert.doesNotMatch(sql, /set\s+quantity\s*=/i);
  assert.match(sql, /add column if not exists checkin_token uuid/);
  assert.match(sql, /add column if not exists checked_in_count integer/);
});

test("backfill só dá token a confirmadas sem token", () => {
  assert.match(sql, /update public\.reservations\s+set checkin_token = gen_random_uuid\(\)\s+where status = 'CONFIRMED'\s+and checkin_token is null;/);
});

test("trigger gera o token na confirmação e nunca troca um existente", () => {
  const trigger = fn("ensure_reservation_checkin_token");
  assert.match(trigger, /new\.status = 'CONFIRMED' and new\.checkin_token is null/);
  assert.match(sql, /unique index if not exists reservations_checkin_token_key/);
});

test("toda RPC administrativa exige admin ativo e não é executável por anon", () => {
  for (const name of ["admin_attendance_sessions", "admin_attendance_session", "admin_checkin_lookup", "admin_register_checkin", "admin_reservation_qr_email"]) {
    assert.match(fn(name), /if not public\.is_active_admin\(p_actor_id\) then/, name);
    assert.match(sql, new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon, authenticated;`), name);
  }
});

test("registro de presença trava a linha, exige confirmada, turma certa e bloqueia duplicado", () => {
  const register = fn("admin_register_checkin");
  assert.match(register, /for update/);
  assert.match(register, /current_row\.status <> 'CONFIRMED'/);
  assert.match(register, /CHECKIN_WRONG_SESSION/);
  assert.match(register, /CHECKIN_ALREADY_DONE/);
  assert.match(register, /insert into public\.admin_audit_log/);
});

test("a página pública do QR não devolve dado pessoal", () => {
  const ticket = fn("public_checkin_ticket");
  for (const field of ["full_name", "email", "phone", "cpf", "public_code"]) assert.ok(!ticket.includes(field), field);
});

// --- Rotas ------------------------------------------------------------------

test("check-in exige sessão da equipe; reenvio de QR exige sessão administrativa", () => {
  for (const path of ["app/api/admin/checkin/route.ts", "app/api/admin/checkin/lookup/route.ts"]) {
    assert.match(source(path), /authorizeCheckinApi\(\)/, path);
  }
  assert.match(source("app/api/admin/reservations/[reservationId]/resend-qr/route.ts"), /authorizeAdminApi\(\)/);
  assert.match(source("app/api/admin/checkin/route.ts"), /isSameOriginRequest/);
  assert.match(source("middleware.ts"), /"\/api\/admin\/:path\*"/);
});

test("a imagem pública do QR não consulta o banco", () => {
  const route = source("app/api/checkin/qr/[token]/route.ts");
  assert.doesNotMatch(route, /supabase|rpc\(/i);
  assert.match(route, /isCheckinToken/);
});
