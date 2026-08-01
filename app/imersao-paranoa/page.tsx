import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  Compass,
  Droplets,
  LifeBuoy,
  MapPin,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";

import { FAQ } from "@/components/faq";
import { FeatureCard } from "@/components/feature-card";
import { Footer } from "@/components/layout/footer";
import { Gallery } from "@/components/gallery";
import { Hero } from "@/components/hero";
import { Navbar } from "@/components/layout/navbar";
import { Section } from "@/components/section";
import { buttonVariants } from "@/components/ui/button";

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
    icon: Compass,
    title: "Condução completa",
    description: "Acompanhamento da equipe Alma Azul durante todo o percurso.",
  },
  {
    icon: LifeBuoy,
    title: "Equipamentos",
    description: "Canoa, remo e colete salva-vidas preparados para a experiência.",
  },
  {
    icon: ShieldCheck,
    title: "Orientação de segurança",
    description: "Instruções claras antes da saída e suporte em toda a travessia.",
  },
  {
    icon: Droplets,
    title: "Banho no lago",
    description: "Uma pausa para entrar na água e aproveitar o Lago Paranoá.",
  },
  {
    icon: Users,
    title: "Experiência em grupo",
    description: "Ritmo coletivo, boas conversas e espaço para novas conexões.",
  },
  {
    icon: Sparkles,
    title: "Memórias reais",
    description: "Uma manhã fora do automático, cercada pela natureza de Brasília.",
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
      "A Imersão ocupa uma manhã. Horários exatos, ponto de encontro e duração serão apresentados junto às próximas datas disponíveis.",
  },
  {
    question: "Quando as reservas serão abertas?",
    answer:
      "O sistema de reservas ainda está em preparação. Esta primeira versão apresenta a experiência; as próximas datas e vagas serão anunciadas em breve.",
  },
];

export default function ImersaoParanoaPage() {
  return (
    <main>
      <Navbar overlay />
      <Hero
        eyebrow="Experiência inaugural · Alma Azul Academy"
        title="Imersão Paranoá"
        description="Uma manhã de canoa entre a mata do Córrego do Torto e a imensidão do Lago Paranoá."
        image="/images/backgrounds/hero-alma-azul-lago.webp"
        primaryLabel="Reservas em breve"
        primaryHref="#reserva"
        secondaryLabel="Conheça o percurso"
        secondaryHref="#sobre"
        details={["Brasília, DF", "Experiência guiada", "Nível iniciante"]}
        immersive
      />

      <section id="conteudo" className="bg-paper py-8">
        <div className="container grid grid-cols-2 gap-4 sm:grid-cols-4">
          {[
            ["Onde", "Lago Paranoá"],
            ["Formato", "Em grupo"],
            ["Duração", "Uma manhã"],
            ["Reservas", "Em breve"],
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
              Brasília como você nunca viu.
            </h2>
            <p className="mt-8 text-lg leading-8 text-ink/65">
              A travessia começa em águas estreitas, sob o verde do corredor do Córrego do Torto. Aos poucos, a paisagem se abre até encontrar o Lago Paranoá.
            </p>
            <p className="mt-5 text-lg leading-8 text-ink/65">
              Não é uma competição. É um convite para remar junto, observar e sentir a cidade por outro ponto de vista.
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

      <section id="reserva" className="scroll-mt-20 bg-white p-3 sm:p-5">
        <div className="relative isolate min-h-[680px] overflow-hidden rounded-4xl text-white">
          <Image
            src="/images/experiences/imersao-paranoa/lago/img-1225.webp"
            alt="Grupo observando o Lago Paranoá ao final da travessia"
            fill
            sizes="100vw"
            className="object-cover"
          />
          <div className="absolute inset-0 bg-ink/65" />
          <div className="container relative z-10 flex min-h-[680px] items-center justify-center py-24 text-center">
            <div className="max-w-3xl">
              <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/60">Próximas edições</p>
              <h2 className="mt-6 text-balance text-5xl font-medium leading-[0.98] tracking-[-0.055em] sm:text-7xl">
                Pronto para mudar o ritmo?
              </h2>
              <p className="mx-auto mt-7 max-w-xl text-lg leading-8 text-white/70">
                As reservas serão abertas em breve. Por enquanto, explore a experiência e acompanhe as novidades da Alma Azul.
              </p>
              <span className={buttonVariants({ variant: "light", size: "lg", className: "mt-9 cursor-default" })}>
                Reservas em breve <ArrowRight className="size-4" />
              </span>
              <p className="mt-4 text-xs text-white/45">Nenhuma cobrança ou reserva é realizada nesta versão.</p>
            </div>
          </div>
        </div>
      </section>

      <Footer />
    </main>
  );
}
