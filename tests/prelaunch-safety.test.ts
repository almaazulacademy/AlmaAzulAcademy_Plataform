import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import test from "node:test";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const removedPublicFiles = [
  "public/images/backgrounds/banho-no-lago.webp",
  "public/images/experiences/imersao-paranoa/corredor-corrego-do-torto/img-2393.webp",
  "public/images/experiences/imersao-paranoa/grupos/img-1255.webp",
  "public/images/experiences/imersao-paranoa/grupos/img-2514.webp",
  "public/images/experiences/imersao-paranoa/grupos/img-3615.webp",
  "public/images/experiences/imersao-paranoa/lago/img-1148.webp",
  "public/images/experiences/imersao-paranoa/originals/alma-azul-original.jpg",
  "public/images/experiences/imersao-paranoa/originals/img-1148.heic",
  "public/images/experiences/imersao-paranoa/originals/img-1255.heic",
  "public/images/experiences/imersao-paranoa/originals/img-2393.heic",
  "public/images/experiences/imersao-paranoa/originals/img-2514.heic",
  "public/images/experiences/imersao-paranoa/originals/img-3615.heic",
  "public/images/experiences/imersao-paranoa/originals/img-3964.heic",
  "public/images/experiences/imersao-paranoa/originals/img-4363.jpg",
];

const replacedPublicFiles = [
  "public/images/experiences/imersao-paranoa/lago/alma-azul-original.webp",
  "public/images/experiences/imersao-paranoa/grupos/img-3964.webp",
  "public/images/experiences/imersao-paranoa/lago/img-4363.webp",
  "public/images/experiences/remada-lua-cheia/remada-lua-cheia-sobre.webp",
  "public/images/experiences/remada-lua-cheia/remada-lua-cheia-galeria-06.webp",
  "public/images/experiences/remada-lua-cheia/remada-lua-cheia-galeria-07.webp",
];

test("arquivos com rosto reconhecível e sem uso não permanecem em public", () => {
  for (const path of removedPublicFiles) {
    assert.equal(existsSync(new URL(`../${path}`, import.meta.url)), false, path);
  }
});

test("substituições seguras são WebP válidos, únicos e Linux-safe", () => {
  const hashes = new Set<string>();
  for (const path of replacedPublicFiles) {
    const url = new URL(`../${path}`, import.meta.url);
    const filename = path.split("/").at(-1) ?? "";
    assert.equal(filename, filename.toLowerCase());
    assert.equal(existsSync(url), true, path);
    assert.ok(statSync(url).size > 80_000, `${path} não deve estar excessivamente comprimido`);
    const bytes = readFileSync(url);
    assert.equal(bytes.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(bytes.subarray(8, 12).toString("ascii"), "WEBP");
    hashes.add(createHash("sha256").update(bytes).digest("hex"));
  }
  assert.equal(hashes.size, replacedPublicFiles.length);
});

test("migration de privacidade sincroniza editorial e legados sem tocar reservas ou sessões", () => {
  const sql = source("supabase/migrations/202608040003_prelaunch_image_privacy.sql");
  assert.match(sql, /jsonb_set\(editorial_content, '\{gallery,images\}'/);
  assert.match(sql, /image_url = '\/images\/backgrounds\/hero-alma-azul-lago\.webp'/);
  assert.match(sql, /set cover_image = editorial_content #>> '\{hero,image,src\}'/);
  assert.match(sql, /set gallery = editorial_content #> '\{gallery,images\}'/);
  assert.doesNotMatch(sql, /public\.(reservations|sessions|payment_events|admin_users)/i);
  assert.doesNotMatch(sql, /drop\s+(table|column)|truncate|cascade/i);
});

test("preflight e postcheck são somente leitura e não projetam PII", () => {
  for (const path of [
    "supabase/diagnostics/prelaunch_test_reservations_preflight.sql",
    "supabase/diagnostics/prelaunch_test_reservations_postcheck.sql",
  ]) {
    const sql = source(path);
    assert.doesNotMatch(sql, /^\s*(insert|update|delete|create|alter|drop|truncate|call)\b/im, path);
  }

  const preflight = source("supabase/diagnostics/prelaunch_test_reservations_preflight.sql");
  assert.doesNotMatch(preflight, /select\s+(full_name|phone|email|cpf_hash|checkout_url|provider_reference|payload)\b/i);
  assert.match(preflight, /MANUAL_FINANCIAL_REVIEW_REQUIRED/);
  assert.match(preflight, /CONFIGURE_OFFICIAL_OPERATION_START_AND_RERUN/);
});

test("manutenção começa travada, é transacional e exclui em ordem explícita", () => {
  const sql = source("supabase/maintenance/clear_test_reservations_before_launch.sql");
  assert.match(sql, /^begin;/im);
  assert.match(sql, /^commit;/im);
  assert.match(sql, /false::boolean as confirm_delete_test_reservations/);
  assert.match(sql, /false::boolean as confirm_all_payment_evidence_is_test/);
  assert.match(sql, /null::timestamptz as approved_test_data_cutoff/);
  assert.match(sql, /UNEXPECTED_RESERVATION_DEPENDENCIES/);
  assert.match(sql, /PAYMENT_EVIDENCE_REQUIRES_MANUAL_CONFIRMATION/);

  const auditDelete = sql.indexOf("delete from public.admin_audit_log");
  const paymentDelete = sql.indexOf("delete from public.payment_events");
  const reservationDelete = sql.indexOf("delete from public.reservations");
  assert.ok(auditDelete > 0 && paymentDelete > auditDelete && reservationDelete > paymentDelete);

  assert.doesNotMatch(sql, /delete from public\.(experiences|sessions|admin_users|platform_settings)/i);
  assert.doesNotMatch(sql, /drop\s+table|truncate|setval|https?:\/\/|net\.http|http_post|fetch\s*\(/i);
});

test("postcheck confirma zero dependências, preservação e vagas integrais", () => {
  const sql = source("supabase/diagnostics/prelaunch_test_reservations_postcheck.sql");
  assert.match(sql, /reservations_expected_zero/);
  assert.match(sql, /participants_expected_zero/);
  assert.match(sql, /holds_expected_zero/);
  assert.match(sql, /payment_events_expected_zero/);
  assert.match(sql, /public\.available_spots\(s\.id\) = s\.capacity/);
  assert.match(sql, /payment_events_without_reservation/);
  assert.match(sql, /sessions_without_experience/);
  assert.match(sql, /POSTCHECK_OK/);
});

test("galeria aceita quantidade variável e imagem inválida conserva fallback visual", () => {
  const gallery = source("components/gallery.tsx");
  const editorialImage = source("components/editorial-image.tsx");
  assert.match(gallery, /images\.map\(\(image, index\)/);
  assert.doesNotMatch(gallery, /images\[[0-9]+\]/);
  assert.match(editorialImage, /const failed = !supported \|\| failedSource === src/);
  assert.match(editorialImage, /role=\{failed \? "img" : undefined\}/);
});
