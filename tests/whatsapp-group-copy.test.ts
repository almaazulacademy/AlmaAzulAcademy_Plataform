import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import test from "node:test";

import type { PublicExperience } from "../lib/editorial/experience.ts";
import { GROUP_FAQ_REPLACEMENTS, withoutGroupPromises } from "../lib/editorial/group-copy.ts";
import { refinePublicExperience } from "../lib/editorial/refine.ts";

/**
 * Desde 25/11/2026 as orientações das experiências regulares estão no e-mail de
 * confirmação. Nenhuma tela ou e-mail do fluxo regular promete grupo de
 * WhatsApp nem envio posterior de orientações.
 */

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const PROMISE = /grupo (oficial|da (sua )?experi[êe]ncia|de whatsapp|de comunica)|adicionar você ao grupo|criaremos um grupo|orientações finais/i;

test("a página de retorno do pagamento remete ao e-mail de confirmação, sem grupo", () => {
  const page = source("app/pagamento/retorno/page.tsx");
  assert.doesNotMatch(page, PROMISE);
  assert.doesNotMatch(page, /NEXT_STEPS|previsão do tempo|comunicados da experiência/);
  assert.ok(page.includes(
    "Todas as informações sobre sua experiência, incluindo o ponto de encontro e as orientações de chegada, estão no e-mail de confirmação da sua reserva.",
  ));
  // A confirmação do pagamento e o texto de evento continuam os de sempre.
  assert.match(page, /await confirmPayment\(\{/);
  assert.match(page, /href=\{`\/eventos\/\$\{summary\.eventSlug\}`\}/);
});

function experience(slug: string, answers: string[]) {
  return {
    slug,
    summary: "Resumo",
    editorial: {
      hero: { title: "", subtitle: "", details: [] },
      quickFacts: [],
      faq: { eyebrow: "Dúvidas frequentes", title: "Antes de entrar na água.", items: answers.map((answer, index) => ({ question: `P${index}`, answer })) },
    },
  } as unknown as PublicExperience;
}

test("FAQ do Cápsula Bar: as respostas que citavam o grupo são trocadas na página", () => {
  const old = [...GROUP_FAQ_REPLACEMENTS.keys()];
  for (const slug of ["remada-sunset-concha-acustica", "remada-lua-cheia-concha-acustica", "rota-ermida-ponte-jk", "rota-prainha-do-congresso"]) {
    const page = refinePublicExperience(experience(slug, [...old, "Outra resposta qualquer."]));
    const answers = page.editorial.faq!.items.map((item) => item.answer);
    assert.deepEqual(answers.slice(0, 2), [...GROUP_FAQ_REPLACEMENTS.values()], slug);
    assert.ok(answers.includes("Outra resposta qualquer."), "o resto da FAQ passa intacto");
    for (const answer of answers) assert.doesNotMatch(answer, PROMISE, slug);
  }
  for (const answer of GROUP_FAQ_REPLACEMENTS.values()) {
    assert.match(answer, /\(61\) 99268-2522/);
    assert.doesNotMatch(answer, PROMISE);
  }
});

test("as respostas antigas são exatamente as gravadas pelas migrations do Cápsula Bar", () => {
  const migrations = [
    "supabase/migrations/202610080001_capsula_bar_launch.sql",
    "supabase/migrations/202610120001_rotas_capsula_bar.sql",
    "supabase/migrations/202610240001_remada_lua_cheia_capsula_bar.sql",
  ].map(source).join("\n");
  for (const old of GROUP_FAQ_REPLACEMENTS.keys()) assert.ok(migrations.includes(`"answer": "${old}"`), old);
});

test("resposta já reescrita pela equipe não é tocada", () => {
  const edited = experience("remada-sunset-concha-acustica", ["Há estacionamento na rua em frente ao bar."]);
  assert.equal(withoutGroupPromises(edited), edited);
});

function files(dir: string): string[] {
  return readdirSync(new URL(`../${dir}`, import.meta.url)).flatMap((name) => {
    const path = `${dir}/${name}`;
    return statSync(new URL(`../${path}`, import.meta.url)).isDirectory() ? files(path) : [path];
  });
}

test("nenhuma tela, componente ou texto do fluxo regular promete grupo de WhatsApp", () => {
  const scanned = [...files("app"), ...files("components"), ...files("lib")].filter((path) => /\.(ts|tsx)$/.test(path));
  // As respostas antigas só existem como chave de substituição.
  const offenders = scanned.filter((path) => path !== "lib/editorial/group-copy.ts" && PROMISE.test(source(path)));
  assert.deepEqual(offenders, []);
});
