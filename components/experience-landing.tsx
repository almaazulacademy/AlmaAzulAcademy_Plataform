import { Compass, Droplets, LifeBuoy, MapPin, ShieldCheck, Sparkles, type LucideIcon } from "lucide-react";
import { Suspense } from "react";

import { EditorialImage } from "@/components/editorial-image";
import { FAQ } from "@/components/faq";
import { FeatureCard } from "@/components/feature-card";
import { Gallery } from "@/components/gallery";
import { Hero } from "@/components/hero";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { Section } from "@/components/section";
import { SessionsLoading, SessionsSection } from "@/components/sessions-section";
import type { PublicExperience } from "@/lib/editorial/experience";

const icons: Record<string, LucideIcon> = { Compass, Droplets, LifeBuoy, ShieldCheck, Sparkles };

export function ExperienceLanding({ experience }: { experience: PublicExperience }) {
  const content = experience.editorial;
  return (
    <main>
      <Navbar overlay />
      <Hero
        eyebrow={content.hero.eyebrow}
        title={content.hero.title}
        description={content.hero.subtitle}
        image={content.hero.image.src}
        imageAlt={content.hero.image.alt}
        imageCredit={content.hero.image.credit}
        primaryLabel={content.hero.primaryCta.label}
        primaryHref={content.hero.primaryCta.href}
        secondaryLabel={content.hero.secondaryCta?.label}
        secondaryHref={content.hero.secondaryCta?.href}
        details={content.hero.details}
        immersive
      />

      <section id="conteudo" className="bg-paper py-8">
        <div className="container grid grid-cols-2 gap-4 sm:grid-cols-4">
          {content.quickFacts.map((fact) => (
            <div key={`${fact.label}-${fact.value}`} className="rounded-2xl border border-ink/10 bg-white/55 p-5 sm:p-6">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-ink/45">{fact.label}</p>
              <p className="mt-2 font-semibold">{fact.value}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="sobre" className="scroll-mt-20 bg-white py-20 sm:py-28 lg:py-36">
        <div className="container grid items-center gap-12 lg:grid-cols-[0.9fr_1.1fr] lg:gap-24">
          <div className="max-w-xl">
            <p className="mb-5 text-xs font-semibold uppercase tracking-[0.2em] text-lake">{content.about.eyebrow}</p>
            <h2 className="text-balance text-4xl font-medium leading-[1.02] tracking-[-0.05em] sm:text-6xl">{content.about.title}</h2>
            {content.about.paragraphs.map((paragraph, index) => <p key={index} className="mt-5 first:mt-8 text-lg leading-8 text-ink/65">{paragraph}</p>)}
          </div>
          <div className="relative min-h-[580px] overflow-hidden rounded-4xl sm:min-h-[720px]">
            <EditorialImage src={content.about.image.src} alt={content.about.image.alt} sizes="(min-width: 1024px) 55vw, 100vw" className="h-full w-full object-cover" />
            {content.about.image.credit ? <p className="absolute bottom-3 right-4 text-xs text-white/70">{content.about.image.credit}</p> : null}
          </div>
        </div>
      </section>

      {content.gallery ? <Section id="galeria" eyebrow={content.gallery.eyebrow} title={content.gallery.title} description={content.gallery.description} tone="paper"><Gallery images={content.gallery.images} /></Section> : null}

      {content.steps ? <Section id="como-funciona" eyebrow={content.steps.eyebrow} title={content.steps.title} description={content.steps.description} tone="ink">
        <div className="grid gap-px overflow-hidden rounded-4xl bg-white/15 lg:grid-cols-3">
          {content.steps.items.map((item, index) => <div key={`${item.title}-${index}`} className="bg-ink p-8 sm:p-10 lg:min-h-[370px] lg:p-12"><span className="text-sm font-semibold text-white/35">{String(index + 1).padStart(2, "0")}</span><h3 className="mt-24 text-3xl font-medium tracking-[-0.04em]">{item.title}</h3><p className="mt-5 max-w-sm leading-7 text-white/60">{item.description}</p></div>)}
        </div>
      </Section> : null}

      {content.included ? <Section id="incluso" eyebrow={content.included.eyebrow} title={content.included.title} description={content.included.description} tone="white"><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{content.included.items.map((item) => <FeatureCard key={item.title} icon={icons[item.icon ?? ""] ?? Sparkles} title={item.title} description={item.description} />)}</div></Section> : null}

      {content.whatToBring || content.restrictions ? <Section tone="mist"><div className="grid gap-8 lg:grid-cols-2">{[content.whatToBring, content.restrictions].filter(Boolean).map((section) => section ? <div key={section.title} className="rounded-3xl bg-white p-7 sm:p-9"><p className="text-xs font-semibold uppercase tracking-[0.2em] text-lake">{section.eyebrow}</p><h2 className="mt-4 text-3xl font-medium">{section.title}</h2><ul className="mt-6 space-y-3 text-ink/65">{section.items.map((item) => <li key={item}>• {item}</li>)}</ul></div> : null)}</div></Section> : null}

      {content.faq ? <section className="bg-paper py-20 sm:py-28 lg:py-36"><div className="container grid gap-12 lg:grid-cols-[0.85fr_1.15fr] lg:gap-24"><div><p className="mb-5 text-xs font-semibold uppercase tracking-[0.2em] text-lake">{content.faq.eyebrow}</p><h2 className="text-balance text-4xl font-medium leading-[1.02] tracking-[-0.05em] sm:text-6xl">{content.faq.title}</h2>{content.faq.locationLabel ? <div className="mt-8 inline-flex items-center gap-2 text-sm text-ink/55"><MapPin className="size-4 text-lake" /> {content.faq.locationLabel}</div> : null}</div><FAQ items={content.faq.items} /></div></section> : null}

      <section id="reservas" className="scroll-mt-20 bg-white p-3 sm:p-5">
        <div className="relative isolate overflow-hidden rounded-4xl bg-ink text-white">
          <EditorialImage src={content.reservations.image.src} alt={content.reservations.image.alt} sizes="100vw" className="absolute inset-0 h-full w-full object-cover" />
          <div className="absolute inset-0 bg-ink/85" />
          <div className="container relative z-10 py-24 sm:py-28 lg:py-36"><div className="mb-12 max-w-3xl sm:mb-16"><p className="text-xs font-semibold uppercase tracking-[0.2em] text-sand">{content.reservations.eyebrow}</p><h2 className="mt-6 text-balance text-5xl font-medium leading-[0.98] tracking-[-0.055em] sm:text-7xl">{content.reservations.title}</h2><p className="mt-7 max-w-xl text-lg leading-8 text-white/65">{content.reservations.description}</p></div><Suspense fallback={<SessionsLoading />}><SessionsSection experienceSlug={experience.slug} /></Suspense></div>
        </div>
      </section>
      <Footer />
    </main>
  );
}
