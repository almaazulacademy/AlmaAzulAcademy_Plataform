import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL("../supabase/migrations/202608020002_reservation_legacy_field_sync.sql", import.meta.url);

test("migration funciona com schema legado ou puramente canônico", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /legacy_column_count not in \(0, 4\)/i);
  assert.match(sql, /if has_legacy_aliases then[\s\S]+else[\s\S]+insert into public\.reservations/i);
});

test("criação de pré-reserva preenche campos canônicos e legados", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /full_name, customer_name[\s\S]+phone, customer_phone, email, customer_email[\s\S]+quantity, participants/i);
  assert.match(sql, /\$4, \$4[\s\S]+\$6, \$6[\s\S]+lower\(trim\(\$7\)\), lower\(trim\(\$7\)\)[\s\S]+\$8, \$8/i);
});

test("trigger mantém as duas representações sincronizadas em inserts e updates", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /before insert or update[\s\S]+execute function public\.sync_reservation_legacy_fields/i);
  assert.match(sql, /new\.customer_name := new\.full_name/i);
  assert.match(sql, /new\.customer_email := new\.email/i);
  assert.match(sql, /new\.customer_phone := new\.phone/i);
  assert.match(sql, /new\.participants := new\.quantity/i);
});

test("confirmação e demais updates usam a sincronização sem reescrever transições", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /confirm_reservation_payment\(uuid,text,text,integer,text,jsonb\)/i);
  assert.match(sql, /attach_payment_checkout\(uuid,text,text,text\)/i);
  assert.match(sql, /cancel_pre_reservation\(uuid\)/i);
  assert.doesNotMatch(sql, /create or replace function public\.confirm_reservation_payment/i);
});
