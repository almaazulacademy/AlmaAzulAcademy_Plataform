import Image, { getImageProps } from "next/image";
import Link from "next/link";
import { ArrowDown, ArrowRight } from "lucide-react";

import { AmbientVideo } from "@/components/bases/ambient-video";
import { CapsulaStory } from "@/components/bases/capsula-story";
import { ComingSoonBadge } from "@/components/bases/badges";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { WhatsappFloatButton } from "@/components/layout/whatsapp-float-button";
import { buttonVariants } from "@/components/ui/button";
import { CONCHA_LANDING as C } from "@/lib/bases/concha-landing";
import type { PublicBase } from "@/lib/bases/types";

function MediaCredit({ className }: { className?: string }) {
  return <p className={className ?? "text-xs text-white/60"}>{C.mediaCredit}</p>;
}

/** Hero com arte direcionada: recorte horizontal no desktop, vertical no celular. */
function HeroPicture() {
  const common = { alt: C.hero.image.alt, sizes: "100vw", priority: true, quality: 72 } as const;
  const { props: mobile } = getImageProps({ ...common, src: C.hero.image.mobile, width: 1080, height: 1920 });
  const {
    props: { srcSet: desktopSrcSet, ...desktop },
  } = getImageProps({ ...common, src: C.hero.image.desktop, width: 2400, height: 1350 });
  return (
    <picture>
      <source media="(min-width: 768px)" srcSet={desktopSrcSet} sizes="100vw" />
      <source media="(max-width: 767px)" srcSet={mobile.srcSet} sizes="100vw" />
      {/* eslint-disable-next-line jsx-a11y/alt-text -- alt vem de getImageProps */}
      <img {...desktop} className="absolute inset-0 h-full w-full object-cover object-[50%_70%] md:object-center" />
    </picture>
  );
}

/**
 * Landing da Base Concha Acústica enquanto a base está em breve.
 *
 * Só conteúdo: nenhum caminho de compra, datas ou valores. As mídias com
 * canoas são registros da Alma Azul no Lago Paranoá (não da nova base) e são
 * sempre acompanhadas de `C.mediaCredit`.
 */
export function ConchaLanding({ base, fallbackBase }: { base: PublicBase; fallbackBase: PublicBase | null }) {
  const fallbackHref = fallbackBase ? `/bases/${fallbackBase.slug}` : "/experiencias";

  return (
    <main>
      <Navbar overlay />

      {/* 1. Hero */}
      <section id="top" className="relative isolate flex h-[100svh] min-h-[680px] overflow-hidden bg-ink text-white">
        <HeroPicture />
        <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(8,28,25,0.62)_0%,rgba(8,28,25,0.22)_55%,transparent_100%)]" />
        <div className="absolute inset-0 bg-[linear-gradient(0deg,rgba(8,28,25,0.82)_0%,rgba(8,28,25,0.35)_55%,transparent_80%)] md:bg-[linear-gradient(0deg,rgba(8,28,25,0.6)_0%,rgba(8,28,25,0.05)_45%,transparent_70%)]" />

        <div className="container relative z-10 flex flex-1 items-end pb-20 pt-32 sm:pb-24 lg:items-center lg:pb-0">
          <div className="max-w-3xl animate-fade-up">
            <p className="mb-5 text-xs font-semibold uppercase tracking-[0.22em] text-sand">{C.hero.eyebrow}</p>
            <h1 className="text-balance text-[clamp(3rem,7.4vw,7rem)] font-medium leading-[0.9] tracking-[-0.06em]">{C.hero.title}</h1>
            <p className="mt-7 max-w-xl text-balance text-lg leading-8 text-white/80 sm:text-xl">{C.hero.description}</p>

            {/* Parceria: elemento menor, subordinado ao título da Alma Azul. */}
            <div className="mt-8 flex items-center gap-4">
              <span className="text-xs font-semibold uppercase tracking-[0.18em] text-white/60">Em parceria com</span>
              <span className="relative block aspect-video w-32 shrink-0 overflow-hidden rounded-xl bg-white shadow-soft sm:w-36">
                <AmbientVideo
                  desktopSrc={C.partner.video.desktop}
                  mobileSrc={C.partner.video.mobile}
                  poster={C.partner.video.poster}
                  fallbackMode="on-failure"
                  fallback={<Image src={C.partner.video.poster} alt="" fill sizes="144px" className="scale-[1.7] object-cover" />}
                  className="scale-[1.7] object-cover"
                />
                <span className="sr-only">{base.partnerName ?? "Cápsula Bar"}</span>
              </span>
            </div>

            <a href="#brasilia-vista-da-agua" className={buttonVariants({ variant: "light", size: "lg", className: "mt-9" })}>
              Conhecer a nova base <ArrowDown className="size-4" />
            </a>
          </div>
        </div>
        <MediaCredit className="absolute bottom-4 left-4 z-10 max-w-[60%] text-[11px] leading-tight text-white/55 sm:left-auto sm:right-6 sm:max-w-none sm:text-right" />
      </section>

      {/* 2. Impacto — drone */}
      <section id="brasilia-vista-da-agua" className="scroll-mt-20 bg-white p-3 sm:p-5">
        <div className="relative isolate h-[82svh] min-h-[520px] overflow-hidden rounded-4xl bg-ink text-white sm:h-[88svh]">
          <AmbientVideo
            desktopSrc={C.impact.video.desktop}
            mobileSrc={C.impact.video.mobile}
            loop
            lazy
            fallback={<Image src={C.impact.video.poster} alt="" fill sizes="100vw" className="object-cover" />}
            className="object-cover"
          />
          <div className="absolute inset-0 bg-[linear-gradient(0deg,rgba(8,28,25,0.8)_0%,rgba(8,28,25,0.15)_55%,rgba(8,28,25,0.05)_100%)]" />
          <div className="container relative z-10 flex h-full flex-col justify-end pb-12 sm:pb-16">
            <h2 className="max-w-3xl text-balance text-5xl font-medium leading-[0.95] tracking-[-0.055em] sm:text-7xl">{C.impact.title}</h2>
            <p className="mt-5 max-w-lg text-lg leading-8 text-white/75 sm:text-xl">{C.impact.description}</p>
            <MediaCredit className="mt-8 text-xs text-white/50" />
          </div>
        </div>
      </section>

      {/* 3. Cápsula — a nova base */}
      <CapsulaStory />

      {/* 4. Experiências */}
      <section id="experiencias" className="scroll-mt-20 bg-paper py-20 sm:py-28 lg:py-36" aria-labelledby="experiencias-titulo">
        <div className="container">
          <div className="mb-12 max-w-3xl sm:mb-16">
            <p className="mb-5 text-xs font-semibold uppercase tracking-[0.2em] text-lake">Base {base.name}</p>
            <h2 id="experiencias-titulo" className="text-balance text-4xl font-medium leading-[1.03] tracking-[-0.045em] sm:text-5xl lg:text-6xl">
              {C.experiences.title}
            </h2>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-ink/65">{C.experiences.description}</p>
          </div>

          <div className="grid gap-4 sm:gap-5 lg:grid-cols-3">
            {C.experiences.items.map((item, index) => {
              const featured = index === 0;
              const routes = "routes" in item ? item.routes : null;
              return (
                <article
                  key={item.title}
                  className={
                    featured
                      ? "relative isolate min-h-[520px] overflow-hidden rounded-4xl bg-ink text-white lg:col-span-3 lg:min-h-[560px]"
                      : "relative isolate aspect-[4/5] max-w-full overflow-hidden rounded-4xl bg-ink text-white"
                  }
                >
                  <Image
                    src={item.image.src}
                    alt={item.image.alt}
                    fill
                    sizes={featured ? "(min-width: 1024px) 90vw, 100vw" : "(min-width: 1024px) 30vw, 100vw"}
                    className="object-cover"
                    style={{ objectPosition: item.image.position }}
                  />
                  <div className="absolute inset-0 bg-[linear-gradient(0deg,rgba(8,28,25,0.85)_0%,rgba(8,28,25,0.2)_55%,transparent_80%)]" />
                  <div className="absolute left-5 top-5 sm:left-7 sm:top-7">
                    <ComingSoonBadge tone="dark" />
                  </div>
                  <div className={featured ? "absolute inset-x-0 bottom-0 p-6 sm:p-10" : "absolute inset-x-0 bottom-0 p-6 sm:p-7"}>
                    <h3 className={featured ? "text-4xl font-medium tracking-[-0.05em] sm:text-6xl" : "text-3xl font-medium tracking-[-0.045em]"}>{item.title}</h3>
                    <p className="mt-3 max-w-md leading-7 text-white/75">{item.summary}</p>
                    {routes ? (
                      <p className="mt-5 text-sm text-white/60">
                        Primeiros roteiros planejados: <span className="text-white/85">{routes.join(" · ")}</span>
                      </p>
                    ) : null}
                  </div>
                </article>
              );
            })}
          </div>
          <MediaCredit className="mt-5 text-xs text-ink/45" />
        </div>
      </section>

      {/* 5. Caminhos do Paranoá */}
      <section id="caminhos-do-paranoa" className="scroll-mt-20 bg-white py-20 sm:py-28 lg:py-36">
        <div className="container grid items-center gap-12 lg:grid-cols-[0.95fr_1.05fr] lg:gap-20">
          <div className="order-2 grid grid-cols-2 gap-3 sm:gap-4 lg:order-1">
            {C.paths.images.map((image, index) => (
              <div key={image.src} className={`relative aspect-[3/4] max-w-full overflow-hidden rounded-4xl bg-mist ${index === 1 ? "mt-10 sm:mt-16" : ""}`}>
                <Image src={image.src} alt={image.alt} fill sizes="(min-width: 1024px) 22vw, 50vw" className="object-cover" />
              </div>
            ))}
            <MediaCredit className="col-span-2 text-xs text-ink/45" />
          </div>

          <div className="order-1 lg:order-2">
            <p className="mb-5 text-xs font-semibold uppercase tracking-[0.2em] text-lake">{C.paths.eyebrow}</p>
            <h2 className="text-balance text-4xl font-medium leading-[1.03] tracking-[-0.045em] text-forest sm:text-5xl lg:text-6xl">{C.paths.title}</h2>
            <p className="mt-6 max-w-xl text-lg leading-8 text-ink/65">{C.paths.description}</p>

            <ol className="mt-10 divide-y divide-ink/10 border-y border-ink/10">
              {C.paths.routes.map((route, index) => (
                <li key={route.title} className="grid grid-cols-[auto_1fr] gap-x-5 py-6">
                  <span className="pt-1 text-sm font-semibold tabular-nums text-lake">{String(index + 1).padStart(2, "0")}</span>
                  <div>
                    <h3 className="flex flex-wrap items-center gap-3 text-2xl font-medium tracking-[-0.03em] text-ink">
                      {route.title} <ComingSoonBadge />
                    </h3>
                    <p className="mt-2 leading-7 text-ink/65">{route.description}</p>
                  </div>
                </li>
              ))}
            </ol>
            <p className="mt-5 text-sm text-ink/50">{C.paths.note}</p>
          </div>
        </div>
      </section>

      {/* 7. Encerramento — base ainda fechada */}
      <section className="bg-white p-3 sm:p-5">
        <div className="relative isolate overflow-hidden rounded-4xl bg-ink text-white">
          <Image src={C.capsula.image.desktop} alt="" fill sizes="100vw" className="object-cover" />
          <div className="absolute inset-0 bg-ink/75" />
          <div className="container relative z-10 py-20 sm:py-28">
            <div className="max-w-3xl">
              <ComingSoonBadge tone="dark" />
              <h2 className="mt-6 text-balance text-5xl font-medium leading-[0.98] tracking-[-0.055em] sm:text-6xl">{C.closing.title}</h2>
              <p className="mt-6 max-w-xl text-lg leading-8 text-white/70">{C.closing.description}</p>
              <Link href={fallbackHref} className={buttonVariants({ variant: "light", size: "lg", className: "mt-9" })}>
                {C.closing.secondaryLabel} <ArrowRight className="size-4" />
              </Link>
            </div>
          </div>
        </div>
      </section>

      <Footer />
      <WhatsappFloatButton />
    </main>
  );
}
