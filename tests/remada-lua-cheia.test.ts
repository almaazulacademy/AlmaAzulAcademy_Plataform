import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import test from "node:test";

import { validateExperienceEditorial } from "../lib/editorial/experience.ts";
import { DEFAULT_EXPERIENCE_FAQ_ITEMS, resolveExperienceFaq } from "../lib/editorial/faq.ts";
import { resolveExperienceCardLocation, resolveExperienceCardMedia } from "../lib/editorial/image.ts";

const migrationPath = new URL("../supabase/migrations/202608040002_remada_lua_cheia.sql", import.meta.url);
const migration = readFileSync(migrationPath, "utf8");
const sessionsSection = readFileSync(new URL("../components/sessions-section.tsx", import.meta.url), "utf8");

function moonlightEditorial() {
  const match = migration.match(/\$editorial\$\s*(\{[\s\S]*?\})\s*\$editorial\$::jsonb/);
  assert.ok(match, "editorial_content da Remada da Lua Cheia não encontrado");
  return JSON.parse(match[1]);
}

test("Remada da Lua Cheia possui editorial publicável e imagem canônica", () => {
  const editorial = moonlightEditorial();
  const validation = validateExperienceEditorial(editorial, true);
  assert.equal(validation.success, true, validation.success ? undefined : validation.errors.join("\n"));
  assert.equal(editorial.hero.image.src, "/images/experiences/remada-lua-cheia/remada-lua-cheia-hero.webp");
  assert.deepEqual(editorial.hero.details, ["Duração: 1h30", "Frequência: programação mensal", "Nível: iniciantes ao avançado"]);
  assert.equal(editorial.restrictions, undefined);
});

test("conteúdo editorial usa quatro etapas e preserva os limites aprovados", () => {
  const editorial = moonlightEditorial();
  assert.equal(editorial.quickFacts.length, 7);
  assert.equal(editorial.about.paragraphs.length, 4);
  assert.equal(editorial.steps.items.length, 4);
  assert.equal(editorial.included.items.length, 10);
  assert.equal(editorial.whatToBring.items.length, 6);
  assert.equal(editorial.gallery.images.length, 8);
  assert.equal(editorial.gallery.images.some((image: { src: string }) => image.src.endsWith("remada-lua-cheia-fogueira.webp")), true);
  const content = JSON.stringify({ hero: editorial.hero, quickFacts: editorial.quickFacts, included: editorial.included, whatToBring: editorial.whatToBring });
  assert.doesNotMatch(content, /café|lanche|frutas|bebida alcoólica|lanterna|toalha/i);
  assert.doesNotMatch(content, /\b\d{1,2}:\d{2}\b|2026-\d{2}-\d{2}/);
});

test("assets selecionados existem em WebP, são únicos e Linux-safe", () => {
  const directory = new URL("../public/images/experiences/remada-lua-cheia/", import.meta.url);
  const expected = [
    "remada-lua-cheia-hero.webp",
    "remada-lua-cheia-sobre.webp",
    ...Array.from({ length: 7 }, (_, index) => `remada-lua-cheia-galeria-${String(index + 1).padStart(2, "0")}.webp`),
    "remada-lua-cheia-fogueira.webp",
    "remada-lua-cheia-reservas.webp",
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

test("FAQ compartilhado é preservado e a pergunta infantil recebe resposta específica sem duplicação", () => {
  const editorial = moonlightEditorial();
  assert.equal(DEFAULT_EXPERIENCE_FAQ_ITEMS.length, 11);
  assert.equal(editorial.faq.items.length, 6);
  const combined = resolveExperienceFaq(editorial.faq);
  assert.equal(combined.items.length, 16);
  const children = combined.items.filter((item) => item.question === "Crianças podem participar?");
  assert.equal(children.length, 1);
  assert.equal(children[0].answer, "Sim. Crianças são bem-vindas quando acompanhadas pelos pais ou responsáveis e habituadas a participar de experiências na natureza.");
  assert.equal(combined.items.some((item) => item.question === "Existe tolerância para atrasos?"), true);
  assert.equal(combined.items.some((item) => item.question === "O que acontece se chover ou as condições não estiverem seguras?"), true);
});

test("migration publica na quarta posição sem criar sessão ou recorrência", () => {
  assert.match(migration, /where slug = 'remada-nascer-do-sol'/);
  assert.match(migration, /sunrise_order \+ 1/);
  assert.match(migration, /on conflict \(slug\) do update/);
  assert.match(migration, /if not exists \(select 1 from public\.experiences where slug = 'remada-lua-cheia'\)/);
  assert.doesNotMatch(migration, /insert into public\.sessions|make_timestamptz|session_status|cron\.schedule/i);
  assert.doesNotMatch(migration, /\b(2026|2027)-\d{2}-\d{2}\b/);
});

test("migration preenche preço, capacidade, campos canônicos e legados", () => {
  assert.match(migration, /legacy_column_count not in \(0, 7\)/);
  assert.match(migration, /EXPERIENCES_REQUIRED_COLUMNS_UNSUPPORTED/);
  assert.match(migration, /slug, title, eyebrow, short_description, description, duration_minutes,[\s\S]*location, cover_image, gallery, included, active/);
  assert.match(migration, /\$1 #> '\{gallery,images\}'/);
  assert.match(migration, /\$1 #> '\{included,items\}'/);
  assert.match(migration, /\n\s*90,\n\s*7000,\n\s*28,\n\s*'PUBLISHED'/);
  assert.match(migration, /cover_image = excluded\.cover_image/);
  assert.match(migration, /active = excluded\.active/);
  assert.doesNotMatch(migration, /drop column|alter column[^;]*drop not null/i);
});

test("estado sem sessões é genérico, elegante e não cria checkout indevido", () => {
  // Lista vazia, Supabase ausente e falha de leitura caem todos no estado
  // genérico — nenhum deles inventa sessão, preço ou vaga.
  assert.match(sessionsSection, /!result\.sessions\.length\) return <EmptyState \/>;/);
  assert.match(sessionsSection, /result\.status === "UNCONFIGURED"/);
  assert.match(sessionsSection, /result\.status === "ERROR"\) return <EmptyState error \/>;/);
  assert.match(sessionsSection, /Novas datas serão anunciadas em breve\./);
  const emptyState = sessionsSection.match(/function EmptyState[\s\S]*?\n}\n/)?.[0] ?? "";
  assert.ok(emptyState, "função EmptyState não encontrada em sessions-section.tsx");
  assert.doesNotMatch(emptyState, /\/reservar\/|sessionId|checkout|priceCents|remainingSpots/);
  assert.doesNotMatch(emptyState, /R\$\s*0|0 vagas/);
});

test("card da Home usa Hero canônico e localização Lago Norte", () => {
  const editorial = moonlightEditorial();
  const experience = {
    id: "moonlight",
    slug: "remada-lua-cheia",
    title: "Remada da Lua Cheia",
    summary: "Resumo",
    imageUrl: "/images/legacy.webp",
    displayOrder: 3,
    editorial,
  };
  assert.equal(resolveExperienceCardMedia(experience).src, editorial.hero.image.src);
  assert.equal(resolveExperienceCardLocation(experience), "Lago Norte");
});

test("migration não altera dados nem sessões das três experiências existentes", () => {
  for (const slug of ["imersao-paranoa", "remada-sunset", "remada-nascer-do-sol"]) {
    assert.doesNotMatch(migration, new RegExp(`update public\\.experiences[\\s\\S]{0,180}where slug = '${slug}'`, "i"));
  }
  assert.equal((migration.match(/insert into public\.experiences/g) ?? []).length, 2);
  assert.doesNotMatch(migration, /public\.reservations|public\.sessions/);
});
