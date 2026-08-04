import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import test from "node:test";

import { validateExperienceEditorial } from "../lib/editorial/experience.ts";
import { DEFAULT_EXPERIENCE_FAQ_ITEMS, resolveExperienceFaq } from "../lib/editorial/faq.ts";
import { resolveExperienceCardLocation, resolveExperienceCardMedia } from "../lib/editorial/image.ts";
import { sessionLocalToIso } from "../lib/sessions/date-time.ts";

const migrationPath = new URL("../supabase/migrations/202608040001_remada_nascer_do_sol.sql", import.meta.url);
const migration = readFileSync(migrationPath, "utf8");

function sunriseEditorial() {
  const match = migration.match(/\$editorial\$\s*(\{[\s\S]*?\})\s*\$editorial\$::jsonb/);
  assert.ok(match, "editorial_content da Remada do Nascer do Sol não encontrado");
  return JSON.parse(match[1]);
}

test("Remada do Nascer do Sol possui editorial publicável e imagem canônica", () => {
  const editorial = sunriseEditorial();
  const validation = validateExperienceEditorial(editorial, true);
  assert.equal(validation.success, true, validation.success ? undefined : validation.errors.join("\n"));
  assert.equal(editorial.hero.image.src, "/images/experiences/remada-nascer-do-sol/remada-nascer-do-sol-hero.webp");
  assert.match(migration, /image_url,\s*display_order,\s*editorial_content/);
  assert.match(migration, /'\/images\/experiences\/remada-nascer-do-sol\/remada-nascer-do-sol-hero\.webp'/);
  assert.equal(editorial.restrictions, undefined);
});

test("conteúdo editorial segue os textos aprovados sem seções ou ofertas adicionais", () => {
  const editorial = sunriseEditorial();
  assert.deepEqual(editorial.hero.details, ["Duração: 1h30", "Horário: 6h", "Nível: iniciantes ao avançado"]);
  assert.equal(editorial.quickFacts.length, 8);
  assert.equal(editorial.about.paragraphs.length, 3);
  assert.equal(editorial.steps.items.length, 3);
  assert.equal(editorial.included.items.length, 9);
  assert.equal(editorial.whatToBring.items.length, 6);
  assert.equal(editorial.faq.items.length, 3);
  const operationalContent = JSON.stringify({ about: editorial.about, steps: editorial.steps, included: editorial.included });
  assert.doesNotMatch(operationalContent, /frutas|lanche|fogueira|percurso específico/i);
});

test("assets selecionados existem em WebP, são únicos e Linux-safe", () => {
  const directory = new URL("../public/images/experiences/remada-nascer-do-sol/", import.meta.url);
  const expected = [
    "remada-nascer-do-sol-hero.webp",
    "remada-nascer-do-sol-sobre.webp",
    ...Array.from({ length: 7 }, (_, index) => `remada-nascer-do-sol-galeria-${String(index + 1).padStart(2, "0")}.webp`),
    "remada-nascer-do-sol-reservas.webp",
  ];
  assert.deepEqual(readdirSync(directory).sort(), expected.sort());
  const hashes = new Set<string>();
  for (const file of expected) {
    const url = new URL(file, directory);
    assert.equal(file, file.toLowerCase());
    assert.equal(existsSync(url), true);
    assert.ok(statSync(url).size > 80_000, `${file} não deve estar excessivamente comprimido`);
    hashes.add(createHash("sha256").update(readFileSync(url)).digest("hex"));
  }
  assert.equal(hashes.size, expected.length);
});

test("FAQ compartilhado inclui tolerância e combina somente as três perguntas específicas", () => {
  const editorial = sunriseEditorial();
  assert.equal(DEFAULT_EXPERIENCE_FAQ_ITEMS.length, 11);
  assert.deepEqual(DEFAULT_EXPERIENCE_FAQ_ITEMS.at(-1), {
    question: "Existe tolerância para atrasos?",
    answer: "Há tolerância de até 20 minutos após o horário de chegada programado. Depois desse período, a saída poderá acontecer sem o participante para não comprometer a experiência do grupo.",
  });
  const combined = resolveExperienceFaq(editorial.faq);
  assert.equal(combined.items.length, 14);
  assert.deepEqual(combined.items.slice(-3).map((item) => item.question), ["Que horas devo chegar?", "Faz frio pela manhã?", "Tem café da manhã?"]);
  assert.equal(new Set(combined.items.map((item) => item.question)).size, combined.items.length);
});

test("migration posiciona após Sunset e faz upsert sem duplicar sessão", () => {
  assert.match(migration, /where slug = 'remada-sunset'/);
  assert.match(migration, /sunset_order \+ 1/);
  assert.match(migration, /on conflict \(slug\) do update/);
  assert.match(migration, /if not exists \(select 1 from public\.experiences where slug = 'remada-nascer-do-sol'\)/);
  assert.match(migration, /not exists \([\s\S]*from public\.sessions session[\s\S]*session\.starts_at = make_timestamptz/);
  assert.equal((migration.match(/insert into public\.sessions/g) ?? []).length, 1);
});

test("migration preenche campos canônicos e todos os campos legados obrigatórios", () => {
  assert.match(migration, /legacy_column_count not in \(0, 7\)/);
  assert.match(migration, /EXPERIENCES_REQUIRED_COLUMNS_UNSUPPORTED/);
  assert.match(migration, /slug, title, eyebrow, short_description, description, duration_minutes,[\s\S]*location, cover_image, gallery, included, active/);
  assert.match(migration, /\$1 #> '\{gallery,images\}'/);
  assert.match(migration, /\$1 #> '\{included,items\}'/);
  assert.match(migration, /cover_image = excluded\.cover_image/);
  assert.match(migration, /active = excluded\.active/);
  assert.doesNotMatch(migration, /drop column|alter column[^;]*drop not null/i);
});

test("primeira sessão representa 07/08/2026 às 6h em Brasília", () => {
  assert.equal(sessionLocalToIso("2026-08-07T06:00"), "2026-08-07T09:00:00.000Z");
  assert.match(migration, /make_timestamptz\(2026, 8, 7, 6, 0, 0, 'America\/Sao_Paulo'\)/);
  assert.match(migration, /\n\s*90,\n\s*7000,\n\s*28,\n\s*'OPEN'::public\.session_status/);
});

test("card da Home usa Hero canônico e localização Lago Norte", () => {
  const editorial = sunriseEditorial();
  const experience = {
    id: "sunrise",
    slug: "remada-nascer-do-sol",
    title: "Remada do Nascer do Sol",
    summary: "Resumo",
    imageUrl: "/images/legacy.webp",
    displayOrder: 2,
    editorial,
  };
  assert.equal(resolveExperienceCardMedia(experience).src, editorial.hero.image.src);
  assert.equal(resolveExperienceCardLocation(experience), "Lago Norte");
});

test("migration preserva conteúdo, preço, capacidade e sessões da Imersão e da Sunset", () => {
  assert.doesNotMatch(migration, /where slug = 'imersao-paranoa'[\s\S]{0,120}(set|update)/i);
  assert.doesNotMatch(migration, /where slug = 'remada-sunset'[\s\S]{0,120}(price_cents|default_capacity)/i);
  assert.equal((migration.match(/insert into public\.experiences/g) ?? []).length, 2);
  assert.equal((migration.match(/'remada-nascer-do-sol'/g) ?? []).length > 2, true);
});
