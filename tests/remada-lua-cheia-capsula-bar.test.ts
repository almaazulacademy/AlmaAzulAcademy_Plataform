import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { PGlite } from "@electric-sql/pglite";

import { validateExperienceEditorial } from "../lib/editorial/experience.ts";
import { applyMigration, fullDatabase } from "./support/full-database.ts";

const MIGRATION = "202610240001_remada_lua_cheia_capsula_bar.sql";
const SLUG = "remada-lua-cheia-concha-acustica";
const BEFORE = "202610160001_reservation_standby_self_service.sql";
const ADMIN = "00000000-0000-4000-8000-00000000000a";

const executable = readFileSync(new URL(`../supabase/migrations/${MIGRATION}`, import.meta.url), "utf8")
  .replace(/^\s*--.*$/gm, "");

type Row = Record<string, unknown>;

async function rows(db: PGlite, sql: string, params: unknown[] = []) {
  return (await db.query<Row>(sql, params)).rows;
}

/** Impressão digital de tudo o que não é a Lua Cheia do Cápsula Bar. */
async function others(db: PGlite) {
  return rows(db, `
    select e.id, e.slug, e.title, e.status, e.summary, e.description, e.price_cents, e.duration_minutes,
           e.default_capacity, e.image_url, e.editorial_content::text as editorial, e.base_id,
           (select count(*) from public.sessions s where s.experience_id = e.id) as sessions
    from public.experiences e where e.slug <> $1 order by e.slug`, [SLUG]);
}

test("migration é aditiva: sem sessão, publicação, preço ou RPC", () => {
  for (const forbidden of [
    /\bdrop\s/i, /\bdelete\s+from\b/i, /\btruncate\b/i, /insert\s+into/i, /create\s+(or\s+replace\s+)?function/i,
    /public\.sessions/i, /public\.reservations/i, /'PUBLISHED'/, /price_cents/i, /default_capacity/i, /duration_minutes/i,
  ]) {
    assert.equal(forbidden.test(executable), false, String(forbidden));
  }
});

test("Lua Cheia do Cápsula Bar ganha landing completa, sem fogueira, e o resto fica igual", async () => {
  const db = await fullDatabase({ until: BEFORE });
  const before = await others(db);
  const [seeded] = await rows(db, "select title, summary, description, image_url, status, price_cents, duration_minutes, default_capacity from public.experiences where slug = $1", [SLUG]);
  assert.deepEqual([seeded.status, seeded.price_cents, seeded.duration_minutes, seeded.default_capacity], ["COMING_SOON", 7000, 90, 24]);
  await applyMigration(db, MIGRATION);

  const [row] = await rows(db, `
    select e.title, e.summary, e.description, e.image_url, e.status, e.price_cents, e.duration_minutes, e.default_capacity,
           e.editorial_content, b.slug as base_slug,
           public.experience_editorial_is_publishable(e.editorial_content) as publishable
    from public.experiences e join public.bases b on b.id = e.base_id where e.slug = $1`, [SLUG]);
  assert.equal(row.base_slug, "concha-acustica");
  assert.equal(row.publishable, true);
  assert.deepEqual(
    [row.title, row.summary, row.description, row.image_url, row.status, row.price_cents, row.duration_minutes, row.default_capacity],
    [seeded.title, seeded.summary, seeded.description, seeded.image_url, seeded.status, seeded.price_cents, seeded.duration_minutes, seeded.default_capacity],
  );

  const validation = validateExperienceEditorial(row.editorial_content, true);
  assert.equal(validation.success, true, validation.success ? "" : validation.errors.join(" "));
  const copy = JSON.stringify(row.editorial_content);
  const text = copy.replace(/\/images\/[^"]+/g, "");
  assert.match(text, /Cápsula Bar/);
  assert.match(text, /SHTN Trecho 1, Lote 8/);
  // Banho só como opção, sujeito à avaliação dos instrutores; fotos não são prometidas.
  assert.match(text, /banho opcional, conforme avaliação de segurança dos instrutores/);
  for (const forbidden of [/fogueira/i, /\bfogo\b/i, /confraterniza/i, /Lago Norte|QL 5/, /R\$/, /ducha/i, /fotos/i, /mergulh/i, /prainha/i]) {
    assert.equal(forbidden.test(text), false, String(forbidden));
  }
  for (const path of copy.match(/\/images\/[^"]+/g) ?? []) {
    assert.doesNotMatch(path, /fogueira|galeria/);
    assert.doesNotThrow(() => readFileSync(new URL(`../public${path}`, import.meta.url)), path);
  }

  assert.deepEqual(await others(db), before);

  // Reaplicar não sobrescreve edição do painel.
  await db.query("update public.experiences set editorial_content = jsonb_set(editorial_content, '{hero,title}', '\"Editado\"') where slug = $1", [SLUG]);
  await applyMigration(db, MIGRATION);
  const [again] = await rows(db, "select editorial_content #>> '{hero,title}' as title from public.experiences where slug = $1", [SLUG]);
  assert.equal(again.title, "Editado");
});

test("depois da migration, o painel publica e o fluxo de reserva funciona com R$ 70, 90 min e 24 vagas", async () => {
  const db = await fullDatabase({ until: MIGRATION });
  await db.exec(`
    insert into auth.users (id) values ('${ADMIN}');
    insert into public.admin_users (user_id, display_name, role, is_active) values ('${ADMIN}', 'Admin', 'ADMIN', true);`);
  const [e] = await rows(db, "select * from public.experiences where slug = $1", [SLUG]);

  // Mesma RPC do botão "Ativar" do painel, reenviando o cadastro como está.
  const [published] = await rows(db, "select public.admin_update_experience($1,$2,$3,$4,'PUBLISHED',$5,$6,$7,$8,$9,$10,$11,$12) as ok", [
    ADMIN, e.id, e.title, e.summary, e.image_url ?? "", e.display_order, e.description, e.duration_minutes, e.price_cents,
    e.default_capacity, JSON.stringify(e.editorial_content), e.base_id,
  ]);
  assert.equal(published.ok, true);
  const catalog = await rows(db, "select * from public.list_public_catalog()");
  assert.ok(JSON.stringify(catalog).includes(SLUG));

  const [session] = await rows(db, "select public.admin_create_session($1,$2, date_trunc('day', now()) + interval '6 days 21 hours', 90, 7000, 24, 'OPEN', '') as id", [ADMIN, e.id]);
  const open = await rows(db, "select price_cents, duration_minutes, remaining_spots from public.list_open_sessions($1)", [SLUG]);
  assert.deepEqual(open.map((item) => [item.price_cents, item.duration_minutes, item.remaining_spots]), [[7000, 90, 24]]);

  const [pre] = await rows(db, "select public.create_pre_reservation($1,'Cliente de Teste','12345678901','61999990000','a@exemplo.com',2,'',$2) as data", [session.id, randomUUID()]);
  const reservation = pre.data as { reservationId: string; totalCents: number };
  assert.equal(reservation.totalCents, 14000);
  const [paid] = await rows(db, "select public.confirm_reservation_payment($1,'INFINITEPAY',$2,14000,'', '{}'::jsonb) as ok", [reservation.reservationId, randomUUID()]);
  assert.equal(paid.ok, true);
  const [spots] = await rows(db, "select public.available_spots($1) as spots", [session.id]);
  assert.equal(spots.spots, 22);
});
