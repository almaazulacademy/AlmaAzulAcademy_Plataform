import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Building2, Moon, Store, SunMedium, Waves } from "lucide-react";

import { ExperienceCard } from "@/components/experience-card";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { Section } from "@/components/section";
import { buttonVariants } from "@/components/ui/button";
import { listPublishedExperiences } from "@/lib/editorial/data";
import { resolveExperienceCardMedia } from "@/lib/editorial/image";

const futureFormats = [
  { label: "Lua Cheia", icon: Moon },
  { label: "Sunset", icon: SunMedium },
  { label: "Aulas", icon: Waves },
  { label: "Team Building", icon: Building2 },
  { label: "Loja", icon: Store },
];

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const published = await listPublishedExperiences();
  const cards = published.map((experience) => {
    const media = resolveExperienceCardMedia(experience);
    return {
      title: experience.title,
      eyebrow: experience.editorial.hero.eyebrow,
      summary: experience.summary,
      location: experience.editorial.hero.details[0] ?? "",
      image: media.src,
      imageAlt: media.alt,
      href: `/experiencias/${experience.slug}`,
    };
  });
  const [featured, ...upcoming] = cards;

  return (
    <main>
      <Navbar overlay />

      <section id="top" className="relative isolate flex h-[100svh] min-h-[720px] overflow-hidden text-white">
        <Image
          src="/images/backgrounds/hero-alma-azul-lago.webp"
          alt="Canoas da Alma Azul no Lago Paranoá vistas de cima"
          fill
          priority
          sizes="100vw"
          className="animate-drift object-cover"
        />
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(7,25,22,0.88)_0%,rgba(7,25,22,0.60)_52%,rgba(7,25,22,0.24)_100%)]" />
        <div className="absolute inset-0 bg-gradient-to-t from-ink/70 via-transparent to-ink/35" />
        <div className="container relative z-10 flex items-end pb-16 pt-36 sm:pb-20 lg:items-center lg:pb-0">
          <div className="max-w-5xl animate-fade-up">
            <p className="mb-5 text-xs font-semibold uppercase tracking-[0.22em] text-white/70">
              Alma Azul Academy · Brasília
            </p>
            <h1 className="max-w-5xl text-balance text-[clamp(3.25rem,7.6vw,7.6rem)] font-medium leading-[0.9] tracking-[-0.065em] drop-shadow-sm">
              Descubra um lado de Brasília que quase ninguém conhece.
            </h1>
            <p className="mt-8 max-w-xl text-lg leading-8 text-white/78 sm:text-xl">
              Experiências para sair do automático e encontrar um novo jeito de estar presente.
            </p>
            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              <Link href={`${featured.href}#reservas`} className={buttonVariants({ variant: "light", size: "lg" })}>
                Reservar minha vaga
                <ArrowRight className="size-4" />
              </Link>
              <Link
                href="#sobre"
                className="inline-flex h-14 items-center justify-center rounded-full border border-white/35 px-7 font-semibold transition-colors hover:bg-white/10"
              >
                Nossa essência
              </Link>
            </div>
          </div>
        </div>
      </section>

      <Section
        id="experiencias"
        eyebrow="Explore nossas experiências"
        title="O Lago Paranoá tem muitas formas de ser vivido."
        description="Do nascer do sol às últimas luzes do dia, criamos experiências para remar, contemplar, mergulhar e se reconectar com a natureza em Brasília."
        tone="paper"
      >
        <ExperienceCard experience={featured} featured />
        {upcoming.length ? (
          <div className="mt-5 grid gap-5 lg:grid-cols-2">
            {upcoming.map((experience) => (
              <ExperienceCard key={experience.href} experience={experience} />
            ))}
          </div>
        ) : null}
      </Section>

      <section id="sobre" className="bg-white py-20 sm:py-28 lg:py-36">
        <div className="container grid items-center gap-12 lg:grid-cols-2 lg:gap-24">
          <div className="relative min-h-[520px] overflow-hidden rounded-4xl sm:min-h-[680px]">
            <Image
              src="/images/experiences/imersao-paranoa/corredor-corrego-do-torto/img-2725.webp"
              alt="Canoa seguindo pelo corredor verde do Córrego do Torto"
              fill
              sizes="(min-width: 1024px) 50vw, 100vw"
              className="object-cover"
            />
          </div>
          <div className="max-w-xl">
            <p className="mb-5 text-xs font-semibold uppercase tracking-[0.2em] text-lake">Nossa essência</p>
            <h2 className="text-balance text-4xl font-medium leading-[1.02] tracking-[-0.05em] sm:text-6xl">
              Não é sobre chegar mais rápido.
            </h2>
            <p className="mt-8 text-lg leading-8 text-ink/65">
              A Alma Azul cria experiências que aproximam pessoas, movimento e natureza. A água é o caminho — presença é o destino.
            </p>
            <Link href={featured.href} className="mt-8 inline-flex items-center gap-2 font-semibold text-forest">
              Descobrir a primeira experiência <ArrowRight className="size-4" />
            </Link>
          </div>
        </div>
      </section>

      <Section
        id="proximas-experiencias"
        eyebrow="O que vem pela frente"
        title="Uma plataforma. Muitos jeitos de viver a água."
        description="A Imersão Paranoá abre o caminho. Novos formatos serão lançados aos poucos."
        tone="mist"
      >
        <div className="mt-14 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {futureFormats.map(({ label, icon: Icon }) => (
            <div key={label} className="flex min-h-36 flex-col justify-between rounded-3xl border border-ink/10 bg-white/65 p-5">
              <Icon className="size-5 text-lake" />
              <p className="font-semibold">{label}</p>
            </div>
          ))}
        </div>
      </Section>

      <section className="relative isolate min-h-[620px] overflow-hidden bg-ink text-white">
        <Image
          src="/images/experiences/imersao-paranoa/grupos/img-2572.webp"
          alt="Grupo navegando de canoa em uma paisagem verde"
          fill
          sizes="100vw"
          className="object-cover"
        />
        <div className="absolute inset-0 bg-ink/65" />
        <div className="container relative z-10 flex min-h-[620px] items-center justify-center py-24 text-center">
          <div className="max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/60">Alma Azul Academy</p>
            <h2 className="mt-6 text-balance text-5xl font-medium leading-[0.98] tracking-[-0.05em] sm:text-7xl">
              Seu próximo mergulho começa aqui.
            </h2>
            <Link href={featured.href} className={buttonVariants({ variant: "light", size: "lg", className: "mt-9" })}>
              Explorar {featured.title}
            </Link>
          </div>
        </div>
      </section>

      <Footer />
    </main>
  );
}
