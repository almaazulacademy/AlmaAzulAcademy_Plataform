import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";

import { validateExperienceEditorial } from "../lib/editorial/experience.ts";
import { DEFAULT_EXPERIENCE_FAQ_ITEMS, resolveExperienceFaq } from "../lib/editorial/faq.ts";
import { imersaoParanoaEditorial } from "../lib/editorial/imersao-paranoa.ts";
import { sessionLocalToIso } from "../lib/sessions/date-time.ts";

const migrationPath = new URL("../supabase/migrations/202608030003_remada_sunset.sql", import.meta.url);
const migration = readFileSync(migrationPath, "utf8");
const diagnostic = readFileSync(
  new URL("../supabase/diagnostics/202608030003_experiences_schema_preflight.sql", import.meta.url),
  "utf8",
);

function sunsetEditorial() {
  const match = migration.match(/\$editorial\$\s*(\{[\s\S]*?\})\s*\$editorial\$::jsonb/);
  assert.ok(match, "editorial_content da Remada Sunset não encontrado");
  return JSON.parse(match[1]);
}

test("Remada Sunset possui editorial publicável e imagem canônica", () => {
  const editorial = sunsetEditorial();
  const validation = validateExperienceEditorial(editorial, true);
  assert.equal(validation.success, true, validation.success ? undefined : validation.errors.join("\n"));
  assert.equal(editorial.hero.image.src, "/images/experiences/remada-sunset/remada-sunset-hero.webp");
  assert.match(migration, /image_url,\s*display_order,\s*editorial_content/);
  assert.match(migration, /'\/images\/experiences\/remada-sunset\/remada-sunset-hero\.webp'/);
  assert.doesNotMatch(migration, /fogueira|lanche|café colaborativo/i);
});

test("assets selecionados existem em WebP e com capitalização Linux-safe", () => {
  const directory = new URL("../public/images/experiences/remada-sunset/", import.meta.url);
  const files = readdirSync(directory);
  const expected = [
    "remada-sunset-hero.webp",
    "remada-sunset-sobre.webp",
    "remada-sunset-galeria-01.webp",
    "remada-sunset-galeria-02.webp",
    "remada-sunset-galeria-03.webp",
    "remada-sunset-galeria-04.webp",
    "remada-sunset-galeria-05.webp",
    "remada-sunset-reservas.webp",
  ];
  assert.deepEqual(files.sort(), expected.sort());
  for (const file of expected) {
    assert.equal(file, file.toLowerCase());
    assert.equal(existsSync(new URL(file, directory)), true);
  }
});

test("FAQ padrão é canônico e combina perguntas específicas sem duplicação", () => {
  assert.equal(DEFAULT_EXPERIENCE_FAQ_ITEMS.length, 10);
  assert.equal(DEFAULT_EXPERIENCE_FAQ_ITEMS[0].question, "Preciso ter experiência com canoa ou remo?");
  const combined = resolveExperienceFaq(imersaoParanoaEditorial.faq);
  assert.equal(combined.items.length, 11);
  assert.equal(combined.items.at(-1)?.question, "Quanto tempo dura a experiência?");
  assert.equal(new Set(combined.items.map((item) => item.question)).size, combined.items.length);
});

test("migration posiciona após Paranoá e faz upsert sem duplicar sessão", () => {
  assert.match(migration, /paranoa_order \+ 1/);
  assert.match(migration, /on conflict \(slug\) do update/);
  assert.match(migration, /if not exists \(select 1 from public\.experiences where slug = 'remada-sunset'\)/);
  assert.match(migration, /not exists \([\s\S]*from public\.sessions session[\s\S]*session\.starts_at = make_timestamptz/);
  assert.equal((migration.match(/insert into public\.sessions/g) ?? []).length, 1);
});

test("migration preenche de uma vez todos os campos obrigatórios do schema legado", () => {
  assert.match(migration, /legacy_column_count not in \(0, 7\)/);
  assert.match(migration, /EXPERIENCES_REQUIRED_COLUMNS_UNSUPPORTED/);
  assert.match(migration, /is_nullable = 'NO'[\s\S]*column_default is null/);
  assert.match(migration, /slug, title, eyebrow, short_description, description, duration_minutes,[\s\S]*location, cover_image, gallery, included, active/);
  assert.match(migration, /'PÔR DO SOL NO LAGO PARANOÁ'/);
  assert.match(migration, /'Base da Alma Azul Academy, Lago Norte, Brasília'/);
  assert.match(migration, /\$1 #> '\{gallery,images\}'/);
  assert.match(migration, /\$1 #> '\{included,items\}'/);
  assert.match(migration, /cover_image = excluded\.cover_image/);
  assert.match(migration, /active = excluded\.active/);
  assert.doesNotMatch(migration, /set editorial_content = jsonb_set/);
  assert.doesNotMatch(migration, /drop column|alter column[^;]*drop not null/i);
});

test("diagnóstico de experiences é somente leitura e expõe o inventário solicitado", () => {
  const executable = diagnostic.replace(/^\s*--.*$/gm, "");
  assert.doesNotMatch(executable, /\b(insert|update|delete|alter|create|drop|truncate|grant|revoke|do)\b/i);
  assert.match(diagnostic, /column_name/);
  assert.match(diagnostic, /data_type/);
  assert.match(diagnostic, /is_nullable/);
  assert.match(diagnostic, /column_default/);
  assert.match(diagnostic, /table_name = 'experiences'/);
});

test("primeira sessão representa 09/08/2026 às 17h em Brasília", () => {
  assert.equal(sessionLocalToIso("2026-08-09T17:00"), "2026-08-09T20:00:00.000Z");
  assert.match(migration, /make_timestamptz\(2026, 8, 9, 17, 0, 0, 'America\/Sao_Paulo'\)/);
  assert.match(migration, /\n\s*90,\n\s*7000,\n\s*28,\n\s*'OPEN'::public\.session_status/);
});

test("metadata dinâmica publica canonical por slug", () => {
  const route = readFileSync(new URL("../app/experiencias/[slug]/page.tsx", import.meta.url), "utf8");
  assert.match(route, /alternates: \{ canonical: `\/experiencias\/\$\{experience\.slug\}` \}/);
  assert.match(route, /seoTitle\.includes\("Alma Azul Academy"\) \? \{ absolute: seoTitle \} : seoTitle/);
});

test("Home renderiza experiências publicadas logo após o destaque", () => {
  const home = readFileSync(new URL("../app/page.tsx", import.meta.url), "utf8");
  const featured = home.indexOf("<ExperienceCard experience={featured} featured />");
  const upcoming = home.indexOf("upcoming.map");
  const about = home.indexOf('<section id="sobre"');
  assert.ok(featured >= 0 && upcoming > featured && about > upcoming);
  assert.equal(home.match(/upcoming\.map/g)?.length, 1);
});

test("Imersão Paranoá preserva Hero e conteúdo específico fora do FAQ", () => {
  assert.equal(imersaoParanoaEditorial.hero.image.src, "/images/backgrounds/hero-alma-azul-lago.webp");
  assert.match(imersaoParanoaEditorial.about.paragraphs.join(" "), /Córrego do Torto/);
  assert.equal(imersaoParanoaEditorial.faq?.items.length, 1);
  assert.equal(imersaoParanoaEditorial.faq?.items[0].question, "Quanto tempo dura a experiência?");
});
