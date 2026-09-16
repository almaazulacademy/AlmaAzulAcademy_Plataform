import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { imersaoParanoaFallback } from "../lib/editorial/imersao-paranoa.ts";
import { refinePublicExperience } from "../lib/editorial/refine.ts";
import { validateExperienceEditorial } from "../lib/editorial/experience.ts";
import { CONCHA_LANDING } from "../lib/bases/concha-landing.ts";

const oldSummary = "Uma remada nas primeiras luzes do dia, com banho no lago, café preto dentro da canoa e os sons da natureza ao redor.";

test("conteúdo antigo do banco é corrigido em cards, FAQ, seções e SEO sem mudar outros campos", () => {
  const experience = structuredClone(imersaoParanoaFallback);
  experience.editorial.about.paragraphs.push("No caminho passamos por paisagens que poucas pessoas conhecem, fazemos uma pausa para banho em uma prainha no meio do lago e encerramos tudo com um lanche colaborativo na nossa base.");
  experience.editorial.included!.items.push({ icon: "Sparkles", title: "Lanche colaborativo", description: "Encontro na base ao final, com café preto por conta da casa." });
  const before = structuredClone(experience);
  const revised = refinePublicExperience(experience);
  assert.doesNotMatch(JSON.stringify(revised), /lanche|colaborativo|café/i);
  assert.deepEqual(experience, before, "não deve alterar o registro original");
  assert.deepEqual(revised.editorial.hero, before.editorial.hero);
  assert.deepEqual(revised.editorial.quickFacts, before.editorial.quickFacts);
  assert.deepEqual(revised.editorial.faq, before.editorial.faq);
  assert.deepEqual(refinePublicExperience(revised), revised);
  assert.equal(validateExperienceEditorial(revised.editorial, true).success, true);
});

test("Remada antiga perde oferta de café em todas as superfícies públicas", () => {
  const migration = readFileSync(new URL("../supabase/migrations/202608040001_remada_nascer_do_sol.sql", import.meta.url), "utf8");
  const match = migration.match(/\$editorial\$\s*(\{[\s\S]*?\})\s*\$editorial\$::jsonb/)!;
  const editorial = JSON.parse(match[1]);
  const clean = structuredClone(editorial);
  editorial.gallery.description = oldSummary;
  editorial.about.paragraphs[1] = "Durante a experiência, o grupo acompanha as primeiras luzes da manhã, faz pausas para banho no meio do lago e em uma prainha e compartilha um café preto ainda dentro da canoa.";
  editorial.steps.items[2] = { title: "Banho e café na canoa", description: "Durante o percurso, fazemos pausas para banho no meio do lago e em uma prainha. Também compartilhamos um café preto dentro da canoa enquanto contemplamos as primeiras luzes do dia." };
  editorial.included.items.splice(6, 0, { icon: "Sparkles", title: "Café preto compartilhado dentro da canoa", description: "" });
  editorial.faq.items.push({ question: "Tem café da manhã?", answer: "Não servimos café da manhã ou lanche. Durante a remada, compartilhamos um café preto dentro da canoa." });
  editorial.seo.description = "Veja Brasília despertar de dentro de uma canoa havaiana. Remada de 1h30 com banho no lago, café preto na canoa, fotos e acompanhamento completo.";
  const revised = refinePublicExperience({ ...imersaoParanoaFallback, slug: "remada-nascer-do-sol", summary: oldSummary, editorial });
  assert.doesNotMatch(JSON.stringify(revised), /lanche|colaborativo|café/i);
  assert.deepEqual(revised.editorial, clean);
  assert.equal(validateExperienceEditorial(revised.editorial, true).success, true);
});

test("Cápsula Bar é padronizado sem duplicar Bar ou modificar identificadores técnicos", () => {
  assert.doesNotMatch(JSON.stringify(CONCHA_LANDING), /C[áa]psula\b(?! Bar)/);
  const experience = { ...structuredClone(imersaoParanoaFallback), slug: "outra-experiencia", title: "Na Cápsula", summary: "Capsula e Cápsula Bar", imageUrl: "/Capsula.webp" };
  experience.editorial.about.paragraphs = ["Café e lanche de outra experiência."];
  const revised = refinePublicExperience(experience);
  assert.equal(revised.title, "Na Cápsula Bar");
  assert.equal(revised.summary, "Cápsula Bar e Cápsula Bar");
  assert.equal(revised.imageUrl, experience.imageUrl);
  assert.equal(revised.slug, experience.slug);
  assert.deepEqual(revised.editorial.about.paragraphs, experience.editorial.about.paragraphs);
});
