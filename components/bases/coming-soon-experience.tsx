import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { BaseBadge, ComingSoonBadge } from "@/components/bases/badges";
import { TemporaryMediaLabel } from "@/components/bases/base-media";
import { EditorialImage } from "@/components/editorial-image";
import { isTemporaryMedia } from "@/lib/bases/media";
import { Footer } from "@/components/layout/footer";
import { Navbar } from "@/components/layout/navbar";
import { WhatsappFloatButton } from "@/components/layout/whatsapp-float-button";
import { buttonVariants } from "@/components/ui/button";
import type { CatalogExperience, PublicBase } from "@/lib/bases/types";

/**
 * Página de uma experiência que ainda não abriu reservas.
 *
 * Existe para quem chega pela URL (link antigo, digitação, compartilhamento):
 * em vez de um 404, explica que a experiência vem aí e onde vai acontecer.
 * Não há agenda, preço, vagas nem botão de reserva — nada que dependa de uma
 * programação que ainda não existe.
 */
export function ComingSoonExperience({ experience, base }: { experience: CatalogExperience; base: PublicBase }) {
  return (
    <main className="min-h-screen bg-paper pt-24">
      <Navbar />
      <section className="container py-12 sm:py-16 lg:py-24">
        <div className="grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
          <div className="relative aspect-[4/3] max-w-full overflow-hidden rounded-4xl bg-ink">
            <EditorialImage src={experience.image.src} alt={experience.image.alt} sizes="(min-width: 1024px) 50vw, 100vw" className="absolute inset-0 h-full w-full object-cover" priority />
            {isTemporaryMedia(base.slug, experience.image.src) ? <TemporaryMediaLabel /> : null}
          </div>
          <div className="max-w-xl">
            <div className="flex flex-wrap gap-2">
              <ComingSoonBadge />
              <BaseBadge name={base.name} />
            </div>
            <h1 className="mt-6 text-balance text-4xl font-medium leading-[1.02] tracking-[-0.05em] text-forest sm:text-6xl">{experience.title}</h1>
            <p className="mt-6 text-lg leading-8 text-ink/65">{experience.summary}</p>
            <div className="mt-8 rounded-3xl border border-ink/10 bg-white p-5 sm:p-6" role="status">
              <p className="font-semibold text-ink">As reservas desta experiência ainda não estão abertas.</p>
              <p className="mt-2 text-sm leading-6 text-ink/60">
                Ela vai acontecer na Base {base.name}. A programação, os valores e as vagas serão divulgados quando a base abrir.
              </p>
            </div>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link href={`/bases/${base.slug}`} className={buttonVariants({ size: "lg" })}>
                Conhecer a Base {base.name} <ArrowRight className="size-4" />
              </Link>
              <Link href="/experiencias" className={buttonVariants({ variant: "outline", size: "lg" })}>
                Ver experiências disponíveis
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
