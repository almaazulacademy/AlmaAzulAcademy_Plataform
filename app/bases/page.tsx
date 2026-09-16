import type { Metadata } from "next";

import { BaseCard } from "@/components/bases/base-card";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { WhatsappFloatButton } from "@/components/layout/whatsapp-float-button";
import { experiencesForBase } from "@/lib/bases/availability";
import { listCatalogExperiences, listPublicBases } from "@/lib/bases/data";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Bases",
  description: "Conheça as bases da Alma Azul Academy em Brasília: Lago Norte, em operação, e Concha Acústica, a nova base que chega em breve.",
  alternates: { canonical: "/bases" },
};

export default async function BasesPage() {
  const [bases, catalog] = await Promise.all([listPublicBases(), listCatalogExperiences()]);

  return (
    <main className="min-h-screen bg-paper pt-24">
      <Navbar />

      <section className="container py-12 sm:py-16 lg:py-24">
        <header className="max-w-3xl">
          <p className="mb-5 text-xs font-semibold uppercase tracking-[0.2em] text-lake">Mesma essência · {bases.length} bases</p>
          <h1 className="text-balance text-4xl font-medium leading-[1.03] tracking-[-0.045em] text-forest sm:text-5xl lg:text-6xl">
            Escolha onde viver a Alma Azul
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-ink/65">
            Cada base tem o seu cenário peculiar. A essência da Alma Azul de viver o Lago Paranoá é a mesma.
          </p>
        </header>

        <div className="mt-12 grid gap-5 sm:mt-16 lg:grid-cols-2 lg:gap-6">
          {bases.map((base) => (
            <BaseCard
              key={base.slug}
              base={base}
              experienceTitles={experiencesForBase(catalog, base.slug).map((experience) => experience.title)}
            />
          ))}
        </div>
      </section>

      <Footer />
      <WhatsappFloatButton />
    </main>
  );
}
