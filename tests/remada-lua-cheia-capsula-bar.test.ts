import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { PGlite } from "@electric-sql/pglite";

import { validateExperienceEditorial } from "../lib/editorial/experience.ts";
import { applyMigration, fullDatabase } from "./support/full-database.ts";

const MIGRATION = "202610240001_remada_lua_cheia_capsula_bar.sql";
const SLUG = "remada-lua-cheia-concha-acustica";

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
  const db = await fullDatabase({ until: "202610160001_reservation_standby_self_service.sql" });
  const before = await others(db);
  const [seeded] = await rows(db, "select status, price_cents, duration_minutes, default_capacity from public.experiences where slug = $1", [SLUG]);
  await applyMigration(db, MIGRATION);

  const [row] = await rows(db, `
    select e.status, e.price_cents, e.duration_minutes, e.default_capacity, e.editorial_content, b.slug as base_slug,
           public.experience_editorial_is_publishable(e.editorial_content) as publishable
    from public.experiences e join public.bases b on b.id = e.base_id where e.slug = $1`, [SLUG]);
  assert.equal(row.base_slug, "concha-acustica");
  assert.equal(row.publishable, true);
  assert.deepEqual(
    [row.status, row.price_cents, row.duration_minutes, row.default_capacity],
    [seeded.status, seeded.price_cents, seeded.duration_minutes, seeded.default_capacity],
  );

  const validation = validateExperienceEditorial(row.editorial_content, true);
  assert.equal(validation.success, true, validation.success ? "" : validation.errors.join(" "));
  const copy = JSON.stringify(row.editorial_content);
  const text = copy.replace(/\/images\/[^"]+/g, "");
  assert.match(text, /Cápsula Bar/);
  for (const forbidden of [/fogueira/i, /\bfogo\b/i, /confraterniza/i, /Lago Norte|QL 5/, /R\$/, /ducha/i]) {
    assert.equal(forbidden.test(text), false, String(forbidden));
  }
  for (const path of copy.match(/\/images\/[^"]+/g) ?? []) {
    assert.doesNotMatch(path, /fogueira/);
    assert.doesNotThrow(() => readFileSync(new URL(`../public${path}`, import.meta.url)), path);
  }

  assert.deepEqual(await others(db), before);

  // Reaplicar não sobrescreve edição do painel.
  await db.query("update public.experiences set editorial_content = jsonb_set(editorial_content, '{hero,title}', '\"Editado\"') where slug = $1", [SLUG]);
  await applyMigration(db, MIGRATION);
  const [again] = await rows(db, "select editorial_content #>> '{hero,title}' as title from public.experiences where slug = $1", [SLUG]);
  assert.equal(again.title, "Editado");
});
