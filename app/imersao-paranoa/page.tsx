import type { Metadata } from "next";
import Image from "next/image";
import { Suspense } from "react";
import {
  Compass,
  Droplets,
  LifeBuoy,
  MapPin,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

import { FAQ } from "@/components/faq";
import { FeatureCard } from "@/components/feature-card";
import { Footer } from "@/components/layout/footer";
import { Gallery } from "@/components/gallery";
import { Hero } from "@/components/hero";
import { Navbar } from "@/components/layout/navbar";
import { Section } from "@/components/section";
import { SessionsLoading, SessionsSection } from "@/components/sessions-section";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Imersão Paranoá",
  description:
    "Uma travessia de canoa pelo corredor do Córrego do Torto até o Lago Paranoá, em Brasília.",
};

const galleryImages = [
  {
    src: "/images/experiences/imersao-paranoa/corredor-corrego-do-torto/img-2074.webp",
    alt: "Canoas navegando sob a mata do Córrego do Torto",
  },
  {
    src: "/images/experiences/imersao-paranoa/lago/alma-azul-original.webp",
    alt: "Participantes tomando banho no Lago Paranoá",
  },
  {
    src: "/images/experiences/imersao-paranoa/corredor-corrego-do-torto/img-1956.webp",
    alt: "Grupo remando no corredor natural",
  },
  {
    src: "/images/experiences/imersao-paranoa/grupos/img-3964.webp",
    alt: "Grupo reunido entre canoas",
  },
  {
    src: "/images/experiences/imersao-paranoa/corredor-corrego-do-torto/img-2672.webp",
    alt: "Paisagem aberta entre o córrego e a vegetação",
  },
  {
    src: "/images/experiences/imersao-paranoa/lago/img-4363.webp",
    alt: "Grupo celebrando a chegada ao lago com os remos erguidos",
  },
];

const included = [
  {
    icon: LifeBuoy,
    title: "Equipamentos",
    description: "Coletes salva-vidas e remos preparados para a experiência.",
  },
  {
    icon: Compass,
    title: "Instrutores em cada canoa",
    description: "Acompanhamento próximo da equipe Alma Azul durante todo o percurso.",
  },
  {
    icon: ShieldCheck,
    title: "Instrução para iniciantes",
    description: "Orientação completa antes da saída, mesmo para quem nunca remou.",
  },
  {
    icon: Sparkles,
    title: "Lanche colaborativo",
    description: "Encontro na base ao final, com café preto por conta da casa.",
  },
  {
    icon: Droplets,
    title: "Banho no lago",
    description: "Uma pausa para entrar na água e aproveitar o Lago Paranoá.",
  },
];

const faqs = [
  {
    question: "Preciso ter experiência com canoa?",
    answer:
      "Não. A experiência é conduzida pela equipe Alma Azul e começa com orientações sobre remada e segurança. O percurso foi pensado para receber também quem está começando.",
  },
  {
    question: "Preciso saber nadar?",
    answer:
      "O uso do colete salva-vidas é parte da experiência. As orientações específicas de participação e segurança serão confirmadas no momento da reserva, em uma próxima etapa da plataforma.",
  },
  {
    question: "O que devo levar?",
    answer:
      "Roupas leves que possam molhar, proteção solar, garrafa de água e uma troca de roupa. A lista completa será enviada antes de cada edição.",
  },
  {
    question: "Quanto tempo dura a experiência?",
    answer:
      "A experiência dura aproximadamente 1h30. O horário exato e as informações do encontro aparecem em cada sessão disponível.",
  },
  {
    question: "Quando as reservas serão abertas?",
    answer:
      "As próximas sessões abertas aparecem automaticamente na seção Próximas datas. A reserva online será habilitada em uma etapa futura.",
  },
];

export default function ImersaoParanoaPage() {
  return (
    <main>
      <Navbar overlay />
      <Hero
        eyebrow="Experiência inaugural · Alma Azul Academy"
        title="Imersão Paranoá"
        description="Explore o lado mais preservado do Lago Paranoá."
        image="/images/backgrounds/hero-alma-azul-lago.webp"
        primaryLabel="Ver próximas datas"
        primaryHref="#reservas"
        secondaryLabel="Conheça o percurso"
        secondaryHref="#sobre"
        details={["Brasília, DF", "1h30 de experiência", "Nível iniciante"]}
        immersive
      />

      <section id="conteudo" className="bg-paper py-8">
        <div className="container grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[
            ["Onde", "Lago Paranoá"],
            ["Formato", "Em grupo"],
            ["Duração", "1h30"],
            ["Reservas", "Datas abertas"],
          ].map(([label, value]) => (
            <div key={label} className="rounded-2xl border border-ink/10 bg-white/55 p-5 sm:p-6">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-ink/45">{label}</p>
              <p className="mt-2 font-semibold">{value}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="sobre" className="scroll-mt-20 bg-white py-20 sm:py-28 lg:py-36">
        <div className="container grid items-center gap-12 lg:grid-cols-[0.9fr_1.1fr] lg:gap-24">
          <div className="max-w-xl">
            <p className="mb-5 text-xs font-semibold uppercase tracking-[0.2em] text-lake">Sobre a experiência</p>
            <h2 className="text-balance text-4xl font-medium leading-[1.02] tracking-[-0.05em] sm:text-6xl">
              Explore o lado mais preservado do Lago Paranoá.
            </h2>
            <p className="mt-8 text-lg leading-8 text-ink/65">
              Uma experiência de 1h30 navegando pelo Lago Paranoá por um dos lugares mais preservados e belos de Brasília: o Córrego do Torto.
            </p>
            <p className="mt-5 text-lg leading-8 text-ink/65">
              No caminho passamos por paisagens que poucas pessoas conhecem, fazemos uma pausa para banho em uma prainha no meio do lago e encerramos tudo com um lanche colaborativo na nossa base.
            </p>
          </div>
          <div className="relative min-h-[580px] overflow-hidden rounded-4xl sm:min-h-[720px]">
            <Image
              src="/images/experiences/imersao-paranoa/corredor-corrego-do-torto/img-2672.webp"
              alt="Canoas saindo do corredor verde em direção ao lago"
              fill
              sizes="(min-width: 1024px) 55vw, 100vw"
              className="object-cover"
            />
          </div>
        </div>
      </section>

      <Section
        id="galeria"
        eyebrow="Galeria"
        title="Água, mata e boas companhias."
        description="Registros reais da Alma Azul. Sem banco de imagens, sem cenário montado."
        tone="paper"
      >
        <Gallery images={galleryImages} />
      </Section>

      <Section
        id="como-funciona"
        eyebrow="Como funciona"
        title="Do encontro ao mergulho."
        description="Uma jornada simples, bem conduzida e no ritmo do grupo."
        tone="ink"
      >
        <div className="grid gap-px overflow-hidden rounded-4xl bg-white/15 lg:grid-cols-3">
          {[
            ["01", "Encontro", "Recepção do grupo, preparação dos equipamentos e orientações de segurança."],
            ["02", "Travessia", "Remada guiada pelo corredor do Córrego do Torto, cercado pela mata."],
            ["03", "Lago", "Chegada ao Paranoá, pausa para banho e tempo para aproveitar a paisagem."],
          ].map(([number, title, description]) => (
            <div key={number} className="bg-ink p-8 sm:p-10 lg:min-h-[370px] lg:p-12">
              <span className="text-sm font-semibold text-white/35">{number}</span>
              <h3 className="mt-24 text-3xl font-medium tracking-[-0.04em]">{title}</h3>
              <p className="mt-5 max-w-sm leading-7 text-white/60">{description}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section
        id="incluso"
        eyebrow="Tudo preparado"
        title="O que está incluso."
        description="Você chega com disposição. A Alma Azul cuida da estrutura da experiência."
        tone="white"
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {included.map((item) => (
            <FeatureCard key={item.title} {...item} />
          ))}
        </div>
      </Section>

      <section className="bg-paper py-20 sm:py-28 lg:py-36">
        <div className="container grid gap-12 lg:grid-cols-[0.85fr_1.15fr] lg:gap-24">
          <div>
            <p className="mb-5 text-xs font-semibold uppercase tracking-[0.2em] text-lake">Dúvidas frequentes</p>
            <h2 className="text-balance text-4xl font-medium leading-[1.02] tracking-[-0.05em] sm:text-6xl">
              Antes de entrar na água.
            </h2>
            <div className="mt-8 inline-flex items-center gap-2 text-sm text-ink/55">
              <MapPin className="size-4 text-lake" /> Brasília · Distrito Federal
            </div>
          </div>
          <FAQ items={faqs} />
        </div>
      </section>

      <section id="reservas" className="scroll-mt-20 bg-white p-3 sm:p-5">
        <div className="relative isolate overflow-hidden rounded-4xl bg-ink text-white">
          <Image
            src="/images/experiences/imersao-paranoa/lago/img-1225.webp"
            alt="Grupo observando o Lago Paranoá ao final da travessia"
            fill
            sizes="100vw"
            className="object-cover"
          />
          <div className="absolute inset-0 bg-ink/85" />
          <div className="container relative z-10 py-24 sm:py-28 lg:py-36">
            <div className="mb-12 max-w-3xl sm:mb-16">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sand">Escolha seu dia</p>
              <h2 className="mt-6 text-balance text-5xl font-medium leading-[0.98] tracking-[-0.055em] sm:text-7xl">Próximas datas</h2>
              <p className="mt-7 max-w-xl text-lg leading-8 text-white/65">Confira as sessões futuras e abertas. Nesta etapa, exibimos disponibilidade em tempo real sem realizar reservas.</p>
            </div>
            <Suspense fallback={<SessionsLoading />}>
              <SessionsSection />
            </Suspense>
          </div>
        </div>
      </section>

      <Footer />
    </main>
  );
}
