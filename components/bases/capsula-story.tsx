import Image, { getImageProps } from "next/image";
import { ArrowDown } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { CONCHA_LANDING } from "@/lib/bases/concha-landing";

const C = CONCHA_LANDING.capsula;

/** Foto do lago com recorte próprio para celular (4:5) e desktop (2:1). Carrega sob demanda. */
function LakePicture() {
  const common = { alt: C.image.alt, sizes: "100vw", quality: 75 } as const;
  const { props: mobile } = getImageProps({ ...common, src: C.image.mobile, width: 1080, height: 1350 });
  const {
    props: { srcSet: desktopSrcSet, ...desktop },
  } = getImageProps({ ...common, src: C.image.desktop, width: 2400, height: 1200 });
  return (
    <picture>
      <source media="(min-width: 768px)" srcSet={desktopSrcSet} sizes="100vw" />
      <source media="(max-width: 767px)" srcSet={mobile.srcSet} sizes="100vw" />
      {/* eslint-disable-next-line jsx-a11y/alt-text -- alt vem de getImageProps */}
      <img {...desktop} loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
    </picture>
  );
}

/**
 * A nova base contada pelo lugar: de onde o Cápsula vem, o lago, o encontro
 * com a Alma Azul e quem idealizou o espaço. Editorial, não institucional —
 * texto curto e fotografia fazendo a maior parte do trabalho.
 */
export function CapsulaStory() {
  const [art, night] = C.details;

  return (
    <section id="nova-base" className="scroll-mt-20 bg-white py-20 sm:py-28 lg:py-36" aria-labelledby="nova-base-titulo">
      <div className="container grid gap-8 lg:grid-cols-2 lg:gap-20">
        <div>
          <p className="mb-5 text-xs font-semibold uppercase tracking-[0.2em] text-lake">{C.eyebrow}</p>
          <h2 id="nova-base-titulo" className="text-balance text-4xl font-medium leading-[1.02] tracking-[-0.05em] text-forest sm:text-5xl lg:text-7xl">
            {C.title}
          </h2>
        </div>
        <div className="space-y-5 lg:pt-12">
          {C.paragraphs.map((paragraph) => (
            <p key={paragraph} className="text-lg leading-8 text-ink/70 sm:text-xl sm:leading-9">
              {paragraph}
            </p>
          ))}
        </div>
      </div>

      {/* O lugar: o lago como protagonista da nova base. */}
      <figure className="mt-12 px-3 sm:mt-16 sm:px-5">
        <div className="relative isolate aspect-[4/5] max-h-[88svh] w-full max-w-full overflow-hidden rounded-4xl bg-mist md:aspect-[2/1] md:max-h-none">
          <LakePicture />
          <div className="absolute inset-x-0 bottom-0 h-1/3 bg-gradient-to-t from-ink/55 to-transparent" />
          <figcaption className="absolute bottom-5 left-5 text-sm text-white/85 sm:bottom-7 sm:left-8">{C.image.caption}</figcaption>
        </div>
      </figure>

      {/* O encontro: texto no centro, arte e pessoas nas bordas. */}
      <div className="container mt-12 grid grid-cols-2 gap-x-3 gap-y-10 sm:mt-16 sm:gap-x-4 lg:mt-24 lg:grid-cols-12 lg:items-center lg:gap-x-8">
        <figure className="order-2 lg:order-1 lg:col-span-5">
          <div className="relative aspect-[4/5] max-w-full overflow-hidden rounded-4xl bg-mist">
            <Image src={art.src} alt={art.alt} fill sizes="(min-width: 1024px) 40vw, 50vw" className="object-cover" />
          </div>
          <figcaption className="mt-3 text-xs text-ink/50">{art.caption}</figcaption>
        </figure>

        <div className="order-1 col-span-2 lg:order-2 lg:col-span-3 lg:px-2">
          <h3 className="text-balance text-3xl font-medium tracking-[-0.04em] text-forest sm:text-4xl">{C.encounter.title}</h3>
          <p className="mt-5 text-lg leading-8 text-ink/70">{C.encounter.text}</p>

          <div className="mt-10 flex items-center gap-5 border-t border-ink/10 pt-8">
            <Image
              src={C.founder.photo.src}
              alt={C.founder.photo.alt}
              width={C.founder.photo.width}
              height={C.founder.photo.height}
              sizes="120px"
              className="aspect-[3/4] w-20 shrink-0 rounded-3xl object-cover object-top sm:w-24"
            />
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-ink/45">{C.founder.eyebrow}</p>
              <p className="mt-1 text-2xl font-medium tracking-[-0.03em] text-ink">{C.founder.name}</p>
              <p className="text-ink/60">{C.founder.role}</p>
              <Image src={CONCHA_LANDING.partner.logo} alt="Cápsula Bar" width={640} height={453} sizes="64px" className="mt-3 h-auto w-14" />
            </div>
          </div>

          <a href="#experiencias" className={buttonVariants({ variant: "outline", size: "lg", className: "mt-10" })}>
            {C.cta} <ArrowDown className="size-4" />
          </a>
        </div>

        <figure className="order-3 mt-14 lg:col-span-4 lg:mt-32">
          <div className="relative aspect-[4/5] max-w-full overflow-hidden rounded-4xl bg-mist">
            <Image src={night.src} alt={night.alt} fill sizes="(min-width: 1024px) 34vw, 50vw" className="object-cover" />
          </div>
          <figcaption className="mt-3 text-xs text-ink/50">{night.caption}</figcaption>
        </figure>
      </div>
    </section>
  );
}
