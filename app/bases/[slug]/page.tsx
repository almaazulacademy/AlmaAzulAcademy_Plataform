import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, Compass, Droplets, LifeBuoy, MapPin, Navigation, ShieldCheck, Sparkles, Waves, type LucideIcon } from "lucide-react";

import { ActiveBaseBadge, ComingSoonBadge, PartnerBadge } from "@/components/bases/badges";
import { BaseSpaceMedia } from "@/components/bases/base-media";
import { BaseExperienceCard } from "@/components/bases/experience-cards";
import { EditorialImage } from "@/components/editorial-image";
import { FeatureCard } from "@/components/feature-card";
import { Gallery } from "@/components/gallery";
import { Hero } from "@/components/hero";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { WhatsappFloatButton } from "@/components/layout/whatsapp-float-button";
import { Section } from "@/components/section";
import { buttonVariants } from "@/components/ui/button";
import { baseStatusLabel, experiencesForBase, isBaseBookable } from "@/lib/bases/availability";
import { basePageContent } from "@/lib/bases/content";
import { getPublicBase, listCatalogExperiences, listPublicBases } from "@/lib/bases/data";
import { isTemporaryMedia, TEMPORARY_MEDIA_LABEL } from "@/lib/bases/media";

export const dynamic = "force-dynamic";

const icons: Record<string, LucideIcon> = { Compass, Droplets, LifeBuoy, ShieldCheck, Sparkles, Waves };

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const base = await getPublicBase(slug);
  if (!base) return { title: "Base não encontrada", robots: { index: false, follow: false } };
  const content = basePageContent(base);
  return {
    title: `Base ${base.name}`,
    description: base.shortDescription,
    alternates: { canonical: `/bases/${base.slug}` },
    openGraph: { title: `Base ${base.name} | Alma Azul Academy`, description: base.shortDescription, images: [content.heroImage.src], type: "website" },
  };
}

export default async function BasePage({ params }: Props) {
  const { slug } = await params;
  const [bases, catalog] = await Promise.all([listPublicBases(), listCatalogExperiences()]);
  const base = bases.find((item) => item.slug === slug);
  if (!base) notFound();

  const content = basePageContent(base);
  const bookable = isBaseBookable(base);
  const experiences = experiencesForBase(catalog, base.slug);
  const fallbackBase = bases.find((item) => item.slug !== base.slug && isBaseBookable(item)) ?? null;
  const mapLink = base.address
    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${base.address}, Brasília - DF`)}`
    : null;

  return (
    <main>
      <Navbar overlay />
      <Hero
        eyebrow={content.heroEyebrow}
        title={content.heroTitle}
        description={content.heroSubtitle}
        image={content.heroImage.src}
        imageAlt={content.heroImage.alt}
        imageCredit={isTemporaryMedia(base.slug, content.heroImage.src) ? `${TEMPORARY_MEDIA_LABEL} · Lago Paranoá` : undefined}
        primaryLabel={bookable ? "Ver experiências" : "Ver experiências planejadas"}
        primaryHref="#experiencias"
        secondaryLabel={bookable ? "Ver agenda" : fallbackBase ? `Conhecer a Base ${fallbackBase.name}` : undefined}
        secondaryHref={bookable ? "/agenda" : fallbackBase ? `/bases/${fallbackBase.slug}` : undefined}
        details={[base.locationLabel, baseStatusLabel(base.status), ...(base.partnerName ? [`Em parceria com ${base.partnerName}`] : [])]}
        immersive
      />

      <section id="conteudo" className="scroll-mt-20 bg-paper py-16 sm:py-24">
        <div className="container grid gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:gap-16">
          <div className="max-w-2xl">
            <div className="flex flex-wrap gap-2">
              {bookable ? <ActiveBaseBadge /> : <ComingSoonBadge />}
              {base.partnerName ? <PartnerBadge partner={base.partnerName} /> : null}
            </div>
            <h2 className="mt-6 text-balance text-4xl font-medium leading-[1.02] tracking-[-0.05em] sm:text-5xl">{content.aboutTitle}</h2>
            <p className="mt-6 text-lg leading-8 text-ink/65">{base.description}</p>
          </div>

          <aside className="rounded-4xl border border-ink/10 bg-white p-6 sm:p-8" aria-label="Informações da base">
            <dl className="space-y-6">
              <div>
                <dt className="text-xs font-semibold uppercase tracking-[0.16em] text-ink/45">Localização</dt>
                <dd className="mt-2 flex items-start gap-2 text-lg font-semibold text-forest">
                  <MapPin aria-hidden="true" className="mt-1 size-4 shrink-0 text-lake" />
                  <span>
                    {base.locationLabel}
                    {base.address ? <span className="mt-1 block text-base font-normal text-ink/60">{base.address}</span> : null}
                  </span>
                </dd>
                {mapLink ? (
                  <a
                    href={mapLink}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-lake underline-offset-4 hover:underline"
                  >
                    <Navigation aria-hidden="true" className="size-4" /> Abrir no mapa
                  </a>
                ) : !bookable ? (
                  <p className="mt-2 text-sm text-ink/50">O ponto de encontro será divulgado junto com a programação.</p>
                ) : null}
              </div>
              <div className="border-t border-ink/10 pt-6">
                <dt className="text-xs font-semibold uppercase tracking-[0.16em] text-ink/45">Status</dt>
                <dd className="mt-2 font-semibold text-forest">{bookable ? "Em operação, com reservas online" : "Em breve · programação ainda não aberta"}</dd>
              </div>
              <div className="border-t border-ink/10 pt-6">
                <dt className="text-xs font-semibold uppercase tracking-[0.16em] text-ink/45">Experiências</dt>
                <dd className="mt-2 font-semibold text-forest">
                  {experiences.length ? experiences.map((experience) => experience.title).join(" · ") : "Em definição"}
                </dd>
              </div>
            </dl>
          </aside>
        </div>
      </section>

      {content.partnership ? (
        <section className="bg-white py-16 sm:py-24" aria-labelledby="parceria">
          <div className="container">
            <div className="grid items-center gap-10 rounded-4xl bg-mist p-6 sm:p-10 lg:grid-cols-[0.9fr_1.1fr] lg:p-14">
              <p id="parceria" className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-balance text-4xl font-medium tracking-[-0.05em] text-forest sm:text-6xl">
                <span>Alma Azul</span>
                <span aria-hidden="true" className="text-lake">+</span>
                <span className="text-ink/70">{base.partnerName ?? "parceiro"}</span>
              </p>
              <div>
                <h2 className="text-2xl font-medium tracking-[-0.03em]">{content.partnership.title}</h2>
                <p className="mt-4 text-lg leading-8 text-ink/65">{content.partnership.description}</p>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      <Section id="experiencias" eyebrow={`Base ${base.name}`} title={content.experiencesTitle} description={content.experiencesDescription} tone={content.partnership ? "paper" : "white"}>
        {experiences.length ? (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {experiences.map((experience) => (
              <BaseExperienceCard key={experience.id} experience={experience} base={base} />
            ))}
          </div>
        ) : (
          <p className="rounded-4xl border border-dashed border-ink/15 bg-white/60 p-8 text-center text-ink/60">
            As experiências desta base serão apresentadas em breve.
          </p>
        )}
        {bookable ? (
          <Link href="/agenda" className={buttonVariants({ size: "lg", className: "mt-10" })}>
            Ver agenda com todas as datas <ArrowRight className="size-4" />
          </Link>
        ) : null}
      </Section>

      {content.structure ? (
        <Section eyebrow="Estrutura" title={content.structure.title} description={content.structure.description} tone="mist">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {content.structure.items.map((item) => (
              <FeatureCard key={item.title} icon={icons[item.icon] ?? Waves} title={item.title} description={item.description} />
            ))}
          </div>
        </Section>
      ) : null}

      {content.space?.items.length ? (
        <Section id="espaco" eyebrow={`Base ${base.name}`} title={content.space.title} description={content.space.description} tone="white">
          <BaseSpaceMedia items={content.space.items} />
        </Section>
      ) : null}

      {content.gallery ? (
        <Section id="galeria" eyebrow="Galeria" title={content.gallery.title} description={content.gallery.description} tone="paper">
          <Gallery images={content.gallery.images} />
        </Section>
      ) : null}

      <section className="bg-white p-3 sm:p-5">
        <div className="relative isolate overflow-hidden rounded-4xl bg-ink text-white">
          <EditorialImage src={content.heroImage.src} alt="" sizes="100vw" className="absolute inset-0 h-full w-full object-cover" />
          <div className="absolute inset-0 bg-ink/80" />
          <div className="container relative z-10 py-20 sm:py-28">
            <div className="max-w-3xl">
              {bookable ? (
                <>
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-sand">Base {base.name}</p>
                  <h2 className="mt-6 text-balance text-5xl font-medium leading-[0.98] tracking-[-0.055em] sm:text-6xl">Sua próxima remada começa aqui.</h2>
                  <Link href="/agenda" className={buttonVariants({ variant: "light", size: "lg", className: "mt-9" })}>
                    Reservar no {base.name} <ArrowRight className="size-4" />
                  </Link>
                </>
              ) : (
                <>
                  <ComingSoonBadge tone="dark" />
                  <h2 className="mt-6 text-balance text-5xl font-medium leading-[0.98] tracking-[-0.055em] sm:text-6xl">Nossa nova base está chegando.</h2>
                  <p className="mt-6 max-w-xl text-lg leading-8 text-white/70">
                    A programação da Base {base.name} ainda não está aberta.
                    {fallbackBase ? ` Enquanto isso, a Base ${fallbackBase.name} segue com datas abertas.` : ""}
                  </p>
                  {fallbackBase ? (
                    <Link href={`/bases/${fallbackBase.slug}`} className={buttonVariants({ variant: "light", size: "lg", className: "mt-9" })}>
                      Conhecer a Base {fallbackBase.name} <ArrowRight className="size-4" />
                    </Link>
                  ) : null}
                </>
              )}
            </div>
          </div>
        </div>
      </section>

      <Footer />
      <WhatsappFloatButton />
    </main>
  );
}
