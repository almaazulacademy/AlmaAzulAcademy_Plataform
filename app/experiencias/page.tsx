import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight, MapPin } from "lucide-react";

import { ActiveBaseBadge, ComingSoonBadge, PartnerBadge } from "@/components/bases/badges";
import { BaseFilter } from "@/components/bases/base-filter";
import { ModalityCard } from "@/components/bases/experience-cards";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { WhatsappFloatButton } from "@/components/layout/whatsapp-float-button";
import { experiencesForBase, groupCatalogByModality, parseBaseFilter } from "@/lib/bases/availability";
import { listCatalogExperiences, listPublicBases } from "@/lib/bases/data";

export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const [bases, params] = await Promise.all([listPublicBases(), searchParams]);
  const selectedSlug = parseBaseFilter(params.base, bases);
  const selected = bases.find((base) => base.slug === selectedSlug);
  return {
    title: selected ? `Experiências da Base ${selected.name}` : "Experiências",
    description: selected
      ? `Experiências da Alma Azul Academy na Base ${selected.name}. ${selected.shortDescription}`
      : "Todas as experiências da Alma Azul Academy no Lago Paranoá, com a base onde cada uma acontece.",
    alternates: { canonical: selected ? `/experiencias?base=${selected.slug}` : "/experiencias" },
  };
}

export default async function ExperiencesPage({ searchParams }: Props) {
  const [bases, catalog] = await Promise.all([listPublicBases(), listCatalogExperiences()]);
  const selectedSlug = parseBaseFilter((await searchParams).base, bases);
  const selected = bases.find((base) => base.slug === selectedSlug) ?? null;
  const groups = groupCatalogByModality(experiencesForBase(catalog, selectedSlug), bases);
  const counts = Object.fromEntries(bases.map((base) => [base.slug, experiencesForBase(catalog, base.slug).length]));

  return (
    <main className="min-h-screen bg-paper pt-24">
      <Navbar />

      <section className="container py-12 sm:py-16 lg:py-24">
        <header className="max-w-3xl">
          <p className="mb-5 text-xs font-semibold uppercase tracking-[0.2em] text-lake">Experiências</p>
          <h1 className="text-balance text-4xl font-medium leading-[1.03] tracking-[-0.045em] text-forest sm:text-5xl lg:text-6xl">
            O Lago Paranoá tem muitas formas de ser vivido.
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-ink/65">
            Cada experiência mostra onde acontece. Algumas existem em mais de uma base; outras são exclusivas de uma só.
          </p>
        </header>

        <div className="mt-10 sm:mt-12">
          <BaseFilter bases={bases} selected={selectedSlug} basePath="/experiencias" counts={counts} />
        </div>

        {selected ? (
          <div className="mt-6 flex flex-col gap-4 rounded-4xl border border-ink/10 bg-white p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
            <div>
              <div className="flex flex-wrap gap-2">
                {selected.status === "ACTIVE" ? <ActiveBaseBadge /> : <ComingSoonBadge />}
                {selected.partnerName ? <PartnerBadge partner={selected.partnerName} /> : null}
              </div>
              <p className="mt-3 inline-flex items-center gap-2 text-lg font-semibold text-forest">
                <MapPin aria-hidden="true" className="size-4 text-lake" /> Base {selected.name}
              </p>
              <p className="mt-1 text-sm text-ink/60">{selected.shortDescription}</p>
            </div>
            <Link href={`/bases/${selected.slug}`} className="inline-flex shrink-0 items-center gap-2 font-semibold text-forest">
              {selected.status === "ACTIVE" ? "Conhecer a base" : "Conhecer a nova base"} <ArrowRight className="size-4" />
            </Link>
          </div>
        ) : null}

        {groups.length ? (
          <div className="mt-8 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {groups.map((group) => (
              <ModalityCard key={group.modality} group={group} />
            ))}
          </div>
        ) : (
          <p className="mt-8 rounded-4xl border border-dashed border-ink/15 bg-white/60 p-10 text-center text-ink/60">
            Nenhuma experiência nesta base ainda.
          </p>
        )}
      </section>

      <Footer />
      <WhatsappFloatButton />
    </main>
  );
}
