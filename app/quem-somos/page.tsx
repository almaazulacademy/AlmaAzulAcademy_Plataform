import type { Metadata } from "next";
import Image from "next/image";

import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { WhatsappFloatButton } from "@/components/layout/whatsapp-float-button";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Quem Somos",
  description:
    "Pai e filho de Alma Azul aventureira: conheça Marcelo e Rudah Bosi e o propósito que move a Alma Azul Academy.",
  alternates: { canonical: "/quem-somos" },
};

type Person = {
  id: string;
  name: string;
  role: string;
  paragraphs: string[];
  image: { src: string; alt: string; position: string };
  photoSide: "left" | "right";
  tone: "white" | "paper";
};

const people: Person[] = [
  {
    id: "marcelo-bosi",
    name: "Marcelo Bosi",
    role: "Fundador e instrutor",
    paragraphs: [
      "Amante e atleta dos esportes aquáticos desde a adolescência, Marcelo foi um dos pioneiros do movimento da Canoa Havaiana no Brasil e o primeiro a levar uma canoa para as águas do Lago Paranoá.",
      "Ao longo de sua trajetória, conquistou diversos títulos nacionais e internacionais na Canoa Havaiana e na Canoagem Oceânica, ajudando a desenvolver e difundir a cultura dos esportes a remo no Brasil.",
    ],
    image: {
      src: "/images/quem-somos/marcelo-bosi.webp",
      alt: "Marcelo Bosi a bordo de um veleiro entre blocos de gelo, com canoas presas ao costado",
      position: "8% 45%",
    },
    photoSide: "left",
    tone: "white",
  },
  {
    id: "rudah-bosi",
    name: "Rudah Bosi",
    role: "Gestor e instrutor",
    paragraphs: [
      "Atleta profissional de SUP Race e multimedalhista em diferentes modalidades a remo, como Canoa Havaiana e Canoagem, Rudah construiu sua trajetória dentro dos esportes aquáticos desde muito jovem.",
      "Hoje, além de competir em alto nível, busca inspirar novas gerações e todos que acompanham sua jornada a encontrarem na água uma forma de esporte, aventura, conexão e estilo de vida.",
    ],
    image: {
      src: "/images/quem-somos/rudah-bosi.webp",
      alt: "Rudah Bosi de braços abertos em uma canoa no Lago Paranoá ao entardecer, segurando um remo",
      position: "50% 62%",
    },
    photoSide: "right",
    tone: "paper",
  },
];

export default function QuemSomosPage() {
  return (
    <main className="min-h-screen bg-paper pt-24">
      <Navbar />

      <section id="proposito" className="container scroll-mt-20 py-12 sm:py-16 lg:py-24">
        <div className="grid gap-10 lg:grid-cols-12 lg:grid-rows-[auto_1fr] lg:gap-x-10 lg:gap-y-12">
          <header className="animate-fade-up lg:col-span-5 lg:row-start-1 lg:self-end">
            <p className="mb-5 text-xs font-semibold uppercase tracking-[0.2em] text-lake">Quem Somos</p>
            <h1 className="text-balance text-[clamp(3rem,7vw,6rem)] font-medium leading-[0.92] tracking-[-0.06em] text-forest">
              Nosso propósito
            </h1>
          </header>

          <div className="relative animate-fade-up lg:col-span-7 lg:col-start-6 lg:row-span-2 lg:row-start-1">
            <div className="relative aspect-[4/5] overflow-hidden rounded-3xl sm:aspect-[5/6] sm:rounded-4xl lg:aspect-auto lg:h-[min(80svh,46rem)] lg:min-h-[34rem]">
              <Image
                src="/images/quem-somos/marcelo-e-rudah-bosi.webp"
                alt="Marcelo e Rudah Bosi, pai e filho, abraçados na borda de uma cratera vulcânica coberta de névoa"
                fill
                priority
                sizes="(min-width: 1024px) 56vw, 100vw"
                className="object-cover object-[50%_72%] lg:object-[50%_88%]"
              />
              <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-ink/55 to-transparent" />
              <p className="absolute bottom-5 left-5 text-xs font-semibold uppercase tracking-[0.2em] text-white/85 sm:bottom-7 sm:left-7">
                Marcelo &amp; Rudah Bosi
              </p>
            </div>
          </div>

          <div className="animate-fade-up lg:col-span-5 lg:row-start-2 lg:self-start">
            <p className="text-balance text-2xl font-medium leading-snug tracking-[-0.03em] text-ink sm:text-3xl">
              Somos pai e filho de Alma Azul aventureira.
            </p>
            <div className="mt-6 h-px w-16 bg-sand" aria-hidden="true" />
            <p className="mt-6 max-w-xl text-lg leading-8 text-ink/65">
              Dedicados a explorar o mundo de forma integrada e sustentável, criamos a Alma Azul com o propósito de
              proporcionar experiências e oportunidades para que mais pessoas embarquem em suas próprias jornadas
              através dos esportes aquáticos e da conexão com a natureza.
            </p>
          </div>
        </div>
      </section>

      {people.map((person) => (
        <PersonSection key={person.id} person={person} />
      ))}

      <Footer />
      <WhatsappFloatButton />
    </main>
  );
}

function PersonSection({ person }: { person: Person }) {
  const photoLeft = person.photoSide === "left";

  return (
    <section
      id={person.id}
      aria-labelledby={`${person.id}-nome`}
      className={cn("scroll-mt-20 py-20 sm:py-28 lg:py-36", person.tone === "white" ? "bg-white" : "bg-paper")}
    >
      <div className="container grid gap-8 sm:gap-10 lg:grid-cols-12 lg:grid-rows-[auto_1fr] lg:gap-x-10 lg:gap-y-8">
        <header
          className={cn(
            "reveal-on-scroll lg:col-span-5 lg:row-start-1 lg:self-end",
            photoLeft ? "lg:col-start-8" : "lg:col-start-1",
          )}
        >
          <p className="mb-5 text-xs font-semibold uppercase tracking-[0.2em] text-lake">{person.role}</p>
          <h2
            id={`${person.id}-nome`}
            className="text-balance text-5xl font-medium leading-[0.95] tracking-[-0.055em] sm:text-6xl lg:text-7xl"
          >
            {person.name}
          </h2>
        </header>

        <div
          className={cn(
            "reveal-on-scroll relative lg:col-span-6 lg:row-span-2 lg:row-start-1",
            photoLeft ? "lg:col-start-1" : "lg:col-start-7",
          )}
        >
          <div className="relative -mx-5 aspect-[4/5] overflow-hidden sm:mx-0 sm:aspect-[5/6] sm:rounded-4xl lg:aspect-[4/5]">
            <Image
              src={person.image.src}
              alt={person.image.alt}
              fill
              sizes="(min-width: 1024px) 50vw, 100vw"
              className="object-cover"
              style={{ objectPosition: person.image.position }}
            />
          </div>
        </div>

        <div
          className={cn(
            "reveal-on-scroll lg:col-span-5 lg:row-start-2",
            photoLeft ? "lg:col-start-8" : "lg:col-start-1",
          )}
        >
          <div className="mb-8 h-px w-16 bg-sand" aria-hidden="true" />
          <div className="max-w-xl space-y-6 text-lg leading-8 text-ink/65">
            {person.paragraphs.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
