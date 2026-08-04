import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import test from "node:test";

import { imersaoParanoaEditorial, imersaoParanoaFallback } from "../lib/editorial/imersao-paranoa.ts";
import { emptyExperienceEditorial, validateExperienceEditorial } from "../lib/editorial/experience.ts";
import { resolveExperienceCardMedia } from "../lib/editorial/image.ts";
import { isReservedExperienceSlug, slugify, validateAdminExperienceInput } from "../lib/admin/validation.ts";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

test("contrato editorial valida publicação completa e permite rascunho incompleto", () => {
  assert.equal(validateExperienceEditorial(imersaoParanoaEditorial, true).success, true);
  assert.equal(validateExperienceEditorial(emptyExperienceEditorial(), true).success, false);
  assert.equal(validateExperienceEditorial(emptyExperienceEditorial(), false).success, true);
});

test("publicação administrativa é bloqueada quando o editorial está incompleto", () => {
  const base = {
    title: "Experiência de teste",
    summary: "Resumo editorial válido para o cadastro.",
    description: "Descrição editorial válida para manter o registro em rascunho.",
    durationMinutes: 90,
    priceCents: 10000,
    defaultCapacity: 10,
    imageUrl: "/images/experiences/teste/capa.webp",
    displayOrder: 1,
    editorialContent: emptyExperienceEditorial(),
  };
  assert.equal(validateAdminExperienceInput({ ...base, status: "DRAFT" }).success, true);
  assert.equal(validateAdminExperienceInput({ ...base, status: "PUBLISHED" }).success, false);
});

test("slugs reservados são normalizados e bloqueados", () => {
  assert.equal(slugify("  Área Admin  "), "area-admin");
  assert.equal(isReservedExperienceSlug("admin"), true);
  assert.equal(isReservedExperienceSlug("remada-da-lua-cheia"), false);
});

test("migration é aditiva, filtra publicação e restringe RPCs", () => {
  const sql = source("supabase/migrations/202608030002_dynamic_experiences.sql");
  assert.match(sql, /add column if not exists editorial_content jsonb/);
  assert.match(sql, /where e\.slug = lower\(trim\(p_slug\)\) and e\.status = 'PUBLISHED'/);
  assert.match(sql, /where e\.status = 'PUBLISHED'/);
  assert.match(sql, /order by e\.display_order, e\.title/);
  assert.match(sql, /revoke all on function public\.get_public_experience/);
  assert.match(sql, /experience_editorial_is_publishable/);
  assert.match(sql, /INCOMPLETE_EDITORIAL_CONTENT/g);
  assert.match(sql, /grant execute on function public\.get_public_experience\(text\) to anon, authenticated, service_role/);
  assert.match(sql, /create or replace function public\.admin_create_experience/);
  assert.match(sql, /create or replace function public\.admin_update_experience/);
  assert.match(sql, /create or replace function public\.admin_list_experiences/);
  assert.doesNotMatch(sql, /drop function if exists public\.admin_(create|update)_experience/);
  assert.doesNotMatch(sql, /drop table|drop column/);
});

test("rota dinâmica gera metadata, retorna 404 e usa sessões por slug", () => {
  const route = source("app/experiencias/[slug]/page.tsx");
  const landing = source("components/experience-landing.tsx");
  assert.match(route, /generateMetadata/);
  assert.match(route, /if \(!experience\) notFound\(\)/);
  assert.match(landing, /SessionsSection experienceSlug=\{experience\.slug\}/);
});

test("Home usa catálogo publicado e não importa a fonte editorial local", () => {
  const home = source("app/page.tsx");
  assert.match(home, /listPublishedExperiences/);
  assert.match(home, /resolveExperienceCardMedia/);
  assert.doesNotMatch(home, /from "@\/lib\/experiences"/);
});

test("Home prioriza hero.image e usa image_url apenas como fallback legado", () => {
  const experience = structuredClone(imersaoParanoaFallback);
  experience.imageUrl = "/images/legacy-card.webp";
  assert.deepEqual(resolveExperienceCardMedia(experience), {
    src: "/images/backgrounds/hero-alma-azul-lago.webp",
    alt: "Canoas da Alma Azul no Lago Paranoá vistas de cima",
  });

  experience.slug = "outra-experiencia";
  experience.editorial.hero.image.src = "https://cdn.example.com/experiencia.webp";
  assert.equal(resolveExperienceCardMedia(experience).src, "https://cdn.example.com/experiencia.webp");

  experience.editorial.hero.image.src = "arquivo-invalido.webp";
  experience.imageUrl = "/images/backgrounds/corredor-corrego-do-torto.webp";
  assert.equal(resolveExperienceCardMedia(experience).src, "/images/backgrounds/corredor-corrego-do-torto.webp");

  experience.imageUrl = null;
  assert.equal(resolveExperienceCardMedia(experience).src, null);
});

test("imagem aprovada existe com capitalização exata no repositório", () => {
  const backgrounds = readdirSync(new URL("../public/images/backgrounds/", import.meta.url));
  const groups = readdirSync(new URL("../public/images/experiences/imersao-paranoa/grupos/", import.meta.url));
  assert.equal(backgrounds.includes("hero-alma-azul-lago.webp"), true);
  assert.equal(backgrounds.includes("corredor-corrego-do-torto.webp"), true);
  assert.equal(groups.includes("img-3964.webp"), true);
  assert.equal(groups.includes("IMG_3964.webp"), false);
});

test("componente esconde alt quebrado e mantém fallback e overlay", () => {
  const image = source("components/editorial-image.tsx");
  const card = source("components/experience-card.tsx");
  const data = source("lib/editorial/data.ts");
  assert.match(image, /onError=\{\(\) => setFailedSource\(src\)\}/);
  assert.match(image, /text-transparent/);
  assert.match(image, /radial-gradient/);
  assert.match(image, /src\.startsWith\("\/images\/"\)/);
  assert.match(card, /bg-gradient-to-t from-ink\/90/);
  assert.match(data, /row\.image_url/);
});

test("Imersão preserva conteúdo e as duas rotas usam o mesmo renderer", () => {
  const legacy = source("app/imersao-paranoa/page.tsx");
  const dynamic = source("app/experiencias/[slug]/page.tsx");
  assert.match(legacy, /ExperienceLanding/);
  assert.match(dynamic, /ExperienceLanding/);
  assert.equal(imersaoParanoaEditorial.about.paragraphs[0], "Uma experiência de 1h30 navegando pelo Lago Paranoá por um dos lugares mais preservados e belos de Brasília: o Córrego do Torto.");
  assert.equal(imersaoParanoaEditorial.gallery?.images.length, 6);
  assert.equal(imersaoParanoaEditorial.faq?.items.length, 1);
});

test("renderer mantém breakpoints para mobile, tablet e desktop e aceita seções opcionais", () => {
  const landing = source("components/experience-landing.tsx");
  assert.match(landing, /sm:grid-cols-2/);
  assert.match(landing, /lg:grid-cols-3/);
  assert.match(landing, /content\.gallery \?/);
  assert.match(landing, /content\.steps \?/);
  assert.match(landing, /resolveExperienceFaq\(content\.faq\)/);
});
