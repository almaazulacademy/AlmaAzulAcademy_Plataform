import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { adminExperienceLabel, experienceBaseSlug, itemsInBase, parseAdminBaseFilter } from "../lib/admin/base-filter.ts";
import { adminMutationError } from "../lib/admin/mutation-errors.ts";
import {
  catalogExperienceHref,
  exclusiveLabel,
  experiencesForBase,
  groupCatalogByModality,
  isExperienceBookable,
  parseBaseFilter,
} from "../lib/bases/availability.ts";
import { catalogFromComingSoonRow, FALLBACK_BASES, FALLBACK_COMING_SOON_EXPERIENCES, fallbackCatalog, mapPublicBase } from "../lib/bases/catalog.ts";
import { imersaoParanoaFallback } from "../lib/editorial/imersao-paranoa.ts";

function source(path: string) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const migration = source("supabase/migrations/202609150001_multi_base.sql");
const executable = migration.replace(/^\s*--.*$/gm, "");

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

test("migration multi-base é aditiva: nada de dados ou estruturas é removido", () => {
  assert.doesNotMatch(executable, /drop\s+table/i);
  assert.doesNotMatch(executable, /drop\s+column/i);
  assert.doesNotMatch(executable, /\btruncate\b/i);
  assert.doesNotMatch(executable, /delete\s+from/i);
  assert.doesNotMatch(executable, /drop\s+type/i);
  assert.doesNotMatch(executable, /drop\s+function/i);
  assert.doesNotMatch(executable, /cascade/i);
  // A única remoção permitida é trocar o CHECK de status por um mais amplo.
  const drops = executable.match(/drop constraint[^;]*/gi) ?? [];
  assert.equal(drops.length, 1);
  assert.match(executable, /not ilike '%COMING_SOON%'/);
});

test("migration não mexe nas RPCs de reserva e pagamento", () => {
  for (const name of ["create_pre_reservation", "list_open_sessions", "get_booking_session", "confirm_reservation_payment", "attach_payment_checkout", "lookup_reservation", "available_spots"]) {
    assert.doesNotMatch(executable, new RegExp(`function public\\.${name}\\b`), name);
  }
  assert.doesNotMatch(executable, /alter table public\.(sessions|reservations|payment_events)/i);
});

test("histórico existente vira Base Lago Norte e base passa a ser obrigatória", () => {
  assert.match(executable, /create table if not exists public\.bases/);
  assert.match(executable, /status in \('ACTIVE', 'COMING_SOON', 'INACTIVE'\)/);
  assert.match(executable, /add column if not exists base_id uuid references public\.bases\(id\) on delete restrict/);
  assert.match(executable, /set base_id = \(select id from public\.bases where slug = 'lago-norte'\)\s+where base_id is null/);
  assert.match(executable, /alter column base_id set not null/);
  assert.ok(executable.indexOf("where base_id is null") < executable.indexOf("alter column base_id set not null"));
  assert.match(executable, /set is_exclusive = true\s+where slug = 'imersao-paranoa'/);
  assert.match(executable, /on conflict \(slug\) do nothing/);
});

test("Concha Acústica nasce em breve, sem sessões, preço ou capacidade", () => {
  assert.match(executable, /'concha-acustica',\s*'Concha Acústica',\s*'COMING_SOON'/);
  assert.match(executable, /'Cápsula Bar'/);
  for (const slug of ["caminhos-do-paranoa", "remada-nascer-do-sol-concha-acustica", "remada-sunset-concha-acustica", "remada-lua-cheia-concha-acustica"]) {
    assert.match(executable, new RegExp(`'${slug}'`));
  }
  assert.doesNotMatch(executable, /insert into public\.sessions/i);
  assert.doesNotMatch(executable, /'PUBLISHED',\s*\$5/);
  assert.match(executable, /0, 0, 'COMING_SOON'/);
  assert.equal(executable.includes("'imersao-paranoa-concha"), false);
});

test("experiência nova nunca cai no Lago Norte por omissão", () => {
  // Backfill explícito só para o que já existia; nenhuma função atribui base padrão.
  assert.doesNotMatch(executable, /new\.base_id\s*:=/);
  assert.doesNotMatch(executable, /select id into new\.base_id/);
  assert.doesNotMatch(executable, /alter column base_id set default/);
  assert.match(executable, /if p_base_id is null then raise exception 'BASE_REQUIRED'/);
  assert.match(executable, /raise exception 'EXPERIENCE_BASE_LOCKED'/);
  assert.match(source("lib/admin/data.ts"), /p_base_id: input\.baseId/);
  assert.match(adminMutationError(new Error('null value in column "base_id" of relation "experiences"')).message, /Selecione a base/);
});

test("sessão só pode existir em base ativa", () => {
  assert.match(executable, /raise exception 'SESSION_BASE_NOT_ACTIVE'/);
  assert.match(executable, /before insert or update of experience_id on public\.sessions/);
  assert.match(executable, /new\.experience_id is not distinct from old\.experience_id/);
});

test("modality é só apresentação: nenhuma RPC ou métrica agrupa por ela", () => {
  const sqlWithoutCatalog = executable.replace(/create or replace function public\.list_public_catalog[\s\S]*?\$\$;/, "");
  assert.doesNotMatch(sqlWithoutCatalog.slice(sqlWithoutCatalog.indexOf("admin_base_dashboard_metrics")), /modality/);
  for (const path of ["lib/admin/data.ts", "lib/agenda/data.ts", "lib/reservations/data.ts", "app/api/reservations/route.ts", "app/admin/bases/[slug]/page.tsx"]) {
    assert.doesNotMatch(source(path), /modality/, path);
  }
});

test("reservar exige base ativa por invariante no banco", () => {
  assert.match(executable, /new\.status = 'PUBLISHED'\s+and not exists \(select 1 from public\.bases where id = new\.base_id and status = 'ACTIVE'\)/);
  assert.match(executable, /raise exception 'BASE_NOT_ACTIVE'/);
  assert.match(executable, /before insert or update of status, base_id on public\.experiences/);
  assert.match(executable, /raise exception 'BASE_HAS_PUBLISHED_EXPERIENCES'/);
  // A pré-reserva já recusava experiência não publicada; é nisso que o bloqueio se apoia.
  assert.match(source("supabase/migrations/202608020002_reservation_legacy_field_sync.sql"), /status = 'PUBLISHED';\s+if not found then raise exception 'EXPERIENCE_UNAVAILABLE'/);
});

test("leituras públicas não expõem preço, capacidade nem dados de reserva", () => {
  const catalog = executable.slice(executable.indexOf("function public.list_public_catalog"), executable.indexOf("function public.public_session_context"));
  assert.doesNotMatch(catalog, /price_cents|default_capacity|duration_minutes/);
  const context = executable.slice(executable.indexOf("function public.public_session_context"), executable.indexOf("revoke all on function public.list_public_bases"));
  assert.doesNotMatch(context, /reservations|price_cents|capacity/);
  assert.match(executable, /grant execute on function public\.list_public_catalog\(\) to anon, authenticated, service_role/);
});

test("dashboard por base é exclusivo da service role e exige administrador ativo", () => {
  assert.match(executable, /function public\.admin_base_dashboard_metrics\(p_actor_id uuid, p_base_id uuid\)/);
  assert.match(executable, /if not public\.is_active_admin\(p_actor_id\)/);
  assert.match(executable, /p_base_id is null or e\.base_id = p_base_id/);
  assert.match(executable, /revoke all on function public\.admin_base_dashboard_metrics\(uuid, uuid\) from public, anon, authenticated/);
  assert.match(executable, /grant execute on function public\.admin_base_dashboard_metrics\(uuid, uuid\) to service_role/);
});

// ---------------------------------------------------------------------------
// Catálogo e regras de apresentação
// ---------------------------------------------------------------------------

test("fallback local espelha exatamente o seed da migration", () => {
  for (const base of FALLBACK_BASES) {
    assert.match(executable, new RegExp(`'${base.slug}',\\s*'${base.name}',\\s*'${base.status}'`));
    if (base.imageUrl) assert.match(executable, new RegExp(base.imageUrl.replace(/[.]/g, "\\.")));
  }
  for (const experience of FALLBACK_COMING_SOON_EXPERIENCES) {
    assert.equal(experience.status, "COMING_SOON");
    assert.equal(experience.baseSlug, "concha-acustica");
    assert.match(executable, new RegExp(`'${experience.slug}', '${experience.title}', '${experience.modality}'`));
  }
  assert.deepEqual(FALLBACK_COMING_SOON_EXPERIENCES.map((item) => item.title), ["Caminhos do Paranoá", "Remada Nascer do Sol", "Remada Sunset", "Remada Lua Cheia"]);
});

test("imagens das bases e das experiências em breve existem no acervo", () => {
  const paths = [...FALLBACK_BASES.map((base) => base.imageUrl), ...FALLBACK_COMING_SOON_EXPERIENCES.map((item) => item.image.src)];
  for (const path of paths) {
    assert.ok(path, "imagem obrigatória");
    assert.equal(existsSync(new URL(`../public${path}`, import.meta.url)), true, path);
  }
  assert.ok(readdirSync(new URL("../public/images/experiences/imersao-paranoa/lago/", import.meta.url)).includes("vista-aerea-lago.webp"));
});

const bases = FALLBACK_BASES;
const catalog = fallbackCatalog([
  imersaoParanoaFallback,
  { ...imersaoParanoaFallback, id: "sunset", slug: "remada-sunset", title: "Remada Sunset", displayOrder: 1 },
]);

test("sem migration, tudo que está publicado é Lago Norte e só a Imersão é exclusiva", () => {
  const published = catalog.filter((item) => item.status === "PUBLISHED");
  assert.deepEqual(published.map((item) => item.baseSlug), ["lago-norte", "lago-norte"]);
  assert.equal(published.find((item) => item.slug === "imersao-paranoa")?.isExclusive, true);
  assert.equal(published.find((item) => item.slug === "remada-sunset")?.isExclusive, false);
});

test("experiência em breve nunca é reservável nem aponta para uma agenda", () => {
  const [lagoNorte, concha] = bases;
  const sunsetConcha = catalog.find((item) => item.slug === "remada-sunset-concha-acustica");
  assert.ok(sunsetConcha);
  assert.equal(isExperienceBookable(sunsetConcha, concha), false);
  assert.equal(catalogExperienceHref(sunsetConcha, concha), "/bases/concha-acustica#experiencias");
  // Mesmo que alguém publique por engano, base em breve continua bloqueando.
  assert.equal(isExperienceBookable({ status: "PUBLISHED" }, concha), false);
  const imersao = catalog.find((item) => item.slug === "imersao-paranoa");
  assert.ok(imersao);
  assert.equal(isExperienceBookable(imersao, lagoNorte), true);
  assert.equal(catalogExperienceHref(imersao, lagoNorte), "/experiencias/imersao-paranoa");
});

test("vitrine agrupa a mesma modalidade das duas bases em um card", () => {
  const groups = groupCatalogByModality(catalog, bases);
  assert.deepEqual(groups.map((group) => group.modality), ["imersao-paranoa", "remada-sunset", "caminhos-do-paranoa", "remada-nascer-do-sol", "remada-lua-cheia"]);

  const sunset = groups.find((group) => group.modality === "remada-sunset");
  assert.ok(sunset);
  assert.deepEqual(sunset.entries.map((entry) => entry.base.slug), ["lago-norte", "concha-acustica"]);
  assert.equal(sunset.lead.slug, "remada-sunset");
  assert.equal(sunset.comingSoon, false);
  assert.equal(sunset.exclusiveBase, null);

  const imersao = groups.find((group) => group.modality === "imersao-paranoa");
  assert.equal(imersao?.exclusiveBase?.slug, "lago-norte");
  assert.equal(exclusiveLabel(imersao!.exclusiveBase!), "Exclusiva da Base Lago Norte");

  const caminhos = groups.find((group) => group.modality === "caminhos-do-paranoa");
  assert.equal(caminhos?.comingSoon, true);
  assert.equal(caminhos?.exclusiveBase, null);
});

test("filtro por base mostra só a base escolhida e nunca a Imersão na Concha", () => {
  const concha = groupCatalogByModality(experiencesForBase(catalog, "concha-acustica"), bases);
  assert.deepEqual(concha.map((group) => group.lead.title), ["Caminhos do Paranoá", "Remada Nascer do Sol", "Remada Sunset", "Remada Lua Cheia"]);
  assert.ok(concha.every((group) => group.comingSoon));
  assert.equal(concha.some((group) => group.modality === "imersao-paranoa"), false);

  assert.equal(parseBaseFilter("concha-acustica", bases), "concha-acustica");
  assert.equal(parseBaseFilter(["LAGO-NORTE"], bases), "lago-norte");
  assert.equal(parseBaseFilter("base-inexistente", bases), null);
  assert.equal(parseBaseFilter(undefined, bases), null);
});

test("linhas do banco são validadas antes de chegar à interface", () => {
  assert.equal(mapPublicBase({ slug: "x", name: "X", status: "OUTRO" }), null);
  assert.equal(mapPublicBase({ slug: "lago-norte", name: "Lago Norte", status: "ACTIVE" })?.status, "ACTIVE");
  assert.equal(catalogFromComingSoonRow({ slug: "a", title: "A", base_slug: "concha-acustica", status: "PUBLISHED" }), null);
  const row = catalogFromComingSoonRow({ slug: "a", title: "A", base_slug: "concha-acustica", status: "COMING_SOON", image_url: "javascript:alert(1)" });
  assert.equal(row?.image.src, null);
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

test("admin recorta sessões e reservas pela base da experiência", () => {
  const experiences = [
    { id: "e1", title: "Remada Sunset", baseSlug: "lago-norte", baseName: "Lago Norte" },
    { id: "e2", title: "Remada Sunset", baseSlug: "concha-acustica", baseName: "Concha Acústica" },
    { id: "e3", title: "Legado", baseSlug: null },
  ];
  const items = [{ experienceId: "e1" }, { experienceId: "e2" }, { experienceId: "e3" }, { experienceId: "desconhecida" }];
  assert.equal(itemsInBase(items, experiences, "").length, 4);
  assert.deepEqual(itemsInBase(items, experiences, "concha-acustica"), [{ experienceId: "e2" }]);
  assert.deepEqual(itemsInBase(items, experiences, "lago-norte"), [{ experienceId: "e1" }, { experienceId: "e3" }, { experienceId: "desconhecida" }]);
  assert.equal(experienceBaseSlug({ baseSlug: null }), "lago-norte");
  assert.equal(parseAdminBaseFilter("qualquer", [{ slug: "lago-norte" }]), "");
  assert.equal(adminExperienceLabel(experiences[1]), "Remada Sunset · Concha Acústica");
});

test("publicar em base inativa vira mensagem clara no painel", () => {
  assert.equal(adminMutationError(new Error("BASE_NOT_ACTIVE")).status, 409);
  assert.match(adminMutationError(new Error("BASE_NOT_ACTIVE")).message, /Em breve/);
  assert.equal(adminMutationError(new Error("BASE_HAS_PUBLISHED_EXPERIENCES")).status, 409);
});

test("dashboard separa visão geral e uma página por base, com estado vazio", () => {
  const shell = source("components/admin/admin-shell.tsx");
  assert.match(shell, /label: "Visão geral"/);
  assert.match(shell, /href: `\/admin\/bases\/\$\{base\.slug\}`/);
  const page = source("app/admin/bases/[slug]/page.tsx");
  assert.match(page, /Nenhuma sessão cadastrada ainda\./);
  assert.match(page, /getAdminBaseDashboard\(context\.profile\.userId, base\.id\)/);
  // A visão geral continua usando a RPC original, intacta.
  assert.match(source("app/admin/page.tsx"), /getAdminDashboard\(context\.profile\.userId\)/);
});

// ---------------------------------------------------------------------------
// Navegação e compatibilidade pública
// ---------------------------------------------------------------------------

test("menu não trata a Imersão como item estrutural e Reservar leva para a agenda", () => {
  const navbar = source("components/layout/navbar.tsx");
  assert.doesNotMatch(navbar, /imersao-paranoa/);
  assert.match(navbar, /\{ label: "Experiências", href: "\/experiencias" \}/);
  assert.match(navbar, /\{ label: "Bases", href: "\/bases" \}/);
  assert.match(navbar, /\{ label: "Acompanhar reserva", href: "\/acompanhar-reserva" \}/);
  assert.match(navbar, /const RESERVE_HREF = "\/agenda"/);
});

test("URLs existentes continuam válidas e as novas rotas existem", () => {
  assert.match(source("next.config.ts"), /source: "\/imersao-paranoa"/);
  for (const path of ["app/experiencias/[slug]/page.tsx", "app/reservar/[sessionId]/page.tsx", "app/acompanhar-reserva/page.tsx", "app/agenda/page.tsx", "app/bases/page.tsx", "app/bases/[slug]/page.tsx", "app/experiencias/page.tsx"]) {
    assert.equal(existsSync(new URL(`../${path}`, import.meta.url)), true, path);
  }
  const sitemap = source("app/sitemap.ts");
  assert.match(sitemap, /absoluteUrl\("\/bases"\)/);
  assert.match(sitemap, /absoluteUrl\("\/experiencias"\)/);
});

test("URL manual de experiência ou sessão em breve explica em vez de reservar", () => {
  const route = source("app/experiencias/[slug]/page.tsx");
  assert.match(route, /upcoming\?\.experience\.status === "COMING_SOON"/);
  assert.ok(route.indexOf("ComingSoonExperience experience") < route.indexOf("if (!experience) notFound()"));
  const comingSoon = source("components/bases/coming-soon-experience.tsx");
  assert.doesNotMatch(comingSoon, /SessionsSection|ReservationForm|price|\/reservar\//);
  const reserve = source("app/reservar/[sessionId]/page.tsx");
  assert.match(reserve, /getSessionAvailabilityContext/);
  assert.match(reserve, /Reservas ainda não abertas/);
  assert.match(source("app/api/reservations/route.ts"), /EXPERIENCE_UNAVAILABLE/);
});

// ---------------------------------------------------------------------------
// Mídia e bloqueadores
// ---------------------------------------------------------------------------

test("mídia da base é só local e fotos temporárias da Concha estão registradas", async () => {
  const { isLocalBaseMedia, isTemporaryMedia, TEMPORARY_BASE_MEDIA } = await import("../lib/bases/media.ts");
  assert.equal(isLocalBaseMedia("/images/bases/concha-acustica/palco.webp"), true);
  assert.equal(isLocalBaseMedia("/videos/bases/concha-acustica/chegada.mp4"), true);
  assert.equal(isLocalBaseMedia("https://images.unsplash.com/foto.jpg"), false);
  assert.equal(isLocalBaseMedia("/images/../../etc/passwd"), false);

  const temporary = TEMPORARY_BASE_MEDIA["concha-acustica"];
  const concha = FALLBACK_BASES.find((base) => base.slug === "concha-acustica");
  // Toda foto usada hoje pela Concha (card da base e cards das experiências) está marcada como temporária.
  assert.equal(isTemporaryMedia("concha-acustica", concha?.imageUrl), true);
  for (const experience of FALLBACK_COMING_SOON_EXPERIENCES) assert.equal(isTemporaryMedia("concha-acustica", experience.image.src), true, experience.slug);
  // A mesma foto no Lago Norte não é "ilustrativa": é a base dela.
  assert.equal(isTemporaryMedia("lago-norte", "/images/experiences/remada-sunset/remada-sunset-hero.webp"), false);
  for (const path of temporary) assert.equal(existsSync(new URL(`../public${path}`, import.meta.url)), true, path);
  assert.match(source("app/bases/[slug]/page.tsx"), /BaseSpaceMedia/);
});

test("bloqueadores de ativação da Concha estão registrados no código e na documentação", () => {
  assert.match(source("lib/reservations/confirmation-email.ts"), /BLOQUEADOR MULTI-BASE[\s\S]*bases\.address[\s\S]*export const MEETING_LOCATION/);
  assert.match(source("lib/integrations/google-sheets/schema.ts"), /BLOQUEADOR MULTI-BASE/);
  const doc = source("docs/multi-base.md");
  assert.match(doc, /## Bloqueadores antes de ativar a Concha Acústica/);
  assert.match(doc, /MEETING_LOCATION/);
  assert.match(doc, /Base no Google Sheets/);
});

test("landing da Concha é só conteúdo: sem reserva, com mídia local e leve", async () => {
  const { CONCHA_LANDING } = await import("../lib/bases/concha-landing.ts");
  const landing = source("components/bases/concha-landing.tsx");
  const copy = JSON.stringify(CONCHA_LANDING);
  // Nenhum caminho de compra: sem agenda, reserva, checkout, preço ou lista de espera.
  for (const forbidden of [/\/agenda/, /reserv/i, /comprar/i, /checkout/i, /R\$/, /pre[çc]o/i, /lista de espera/i, /\/experiencias\/[a-z]/]) {
    assert.equal(forbidden.test(landing) || forbidden.test(copy), false, String(forbidden));
  }
  // A landing só substitui a página padrão enquanto a base está fechada.
  assert.match(source("app/bases/[slug]/page.tsx"), /base\.slug === "concha-acustica" && !bookable/);
  // Registros do Lago Paranoá sempre identificados; nada de Drive ou URL externa.
  assert.equal(CONCHA_LANDING.mediaCredit, "Registros de experiências Alma Azul no Lago Paranoá");
  assert.equal(/https?:\/\//.test(copy), false);
  const paths = copy.match(/\/(images|videos)\/[^"]+/g) ?? [];
  assert.ok(paths.length >= 14);
  const { statSync } = await import("node:fs");
  for (const path of paths) {
    const url = new URL(`../public${path}`, import.meta.url);
    assert.equal(existsSync(url), true, path);
    const limit = path.endsWith(".mp4") ? (path.includes("capsula") ? 400_000 : 4_000_000) : 400_000;
    assert.ok(statSync(url).size <= limit, `${path} acima do orçamento`);
  }
  // Nenhuma foto associada a um roteiro específico.
  assert.equal(CONCHA_LANDING.paths.routes.some((route) => "image" in route), false);
});
