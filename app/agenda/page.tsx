import type { Metadata } from "next";
import { Suspense } from "react";

import { AgendaLoading, AgendaSessions } from "@/components/agenda-sessions";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { WhatsappFloatButton } from "@/components/layout/whatsapp-float-button";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Agenda geral",
  description:
    "Todas as próximas datas das experiências da Alma Azul Academy em um só lugar. Escolha o dia, veja qual experiência acontece em cada horário e reserve sua vaga.",
  alternates: { canonical: "/agenda" },
};

export default function AgendaPage() {
  return (
    <main className="min-h-screen bg-paper pt-24">
      <Navbar />

      <section className="container py-12 sm:py-16 lg:py-24">
        <header className="max-w-3xl">
          <p className="mb-5 text-xs font-semibold uppercase tracking-[0.2em] text-lake">Agenda geral</p>
          <h1 className="text-balance text-4xl font-medium leading-[1.03] tracking-[-0.045em] text-forest sm:text-5xl lg:text-6xl">
            Reserve a experiência certa para você
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-ink/65">
            Escolha a data e encontre facilmente qual experiência acontece em cada horário.
          </p>
        </header>

        <div className="mt-12 sm:mt-16">
          <Suspense fallback={<AgendaLoading />}>
            <AgendaSessions />
          </Suspense>
        </div>
      </section>

      <Footer />
      <WhatsappFloatButton />
    </main>
  );
}
