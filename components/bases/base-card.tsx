import Link from "next/link";
import { ArrowUpRight, MapPin } from "lucide-react";

import { ActiveBaseBadge, ComingSoonBadge, PartnerBadge } from "@/components/bases/badges";
import { EditorialImage } from "@/components/editorial-image";
import { basePageContent } from "@/lib/bases/content";
import { isTemporaryMedia, TEMPORARY_MEDIA_LABEL } from "@/lib/bases/media";
import type { PublicBase } from "@/lib/bases/types";
import { cn } from "@/lib/utils";

/**
 * Card de base (Home e /bases).
 *
 * A diferença entre as bases vem de foto, nome, localização e selo — não de
 * uma identidade visual diferente. O CTA nunca diz "Reservar" para uma base que
 * ainda não tem programação aberta.
 */
export function BaseCard({ base, experienceTitles, className }: { base: PublicBase; experienceTitles: string[]; className?: string }) {
  const comingSoon = base.status !== "ACTIVE";
  const cta = comingSoon ? "Conhecer a nova base" : "Conhecer a base";
  const imageUrl = basePageContent(base).cardImage ?? base.imageUrl;

  return (
    <Link
      href={`/bases/${base.slug}`}
      aria-label={`${cta}: Base ${base.name}`}
      className={cn(
        "group flex h-full flex-col overflow-hidden rounded-4xl border border-ink/10 bg-white shadow-soft transition duration-300 hover:-translate-y-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lake focus-visible:ring-offset-2",
        className,
      )}
    >
      <div className="relative isolate aspect-[4/3] max-w-full overflow-hidden bg-ink sm:aspect-[16/10]">
        <EditorialImage
          src={imageUrl}
          alt={`Base ${base.name} da Alma Azul`}
          sizes="(min-width: 1024px) 45vw, 100vw"
          className="absolute inset-0 h-full w-full object-cover transition-transform duration-700 ease-out group-hover:scale-[1.035]"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-ink/80 via-ink/10 to-transparent" />
        <div className="absolute left-4 top-4 flex flex-wrap gap-2 sm:left-6 sm:top-6">
          {comingSoon ? <ComingSoonBadge tone="dark" /> : <ActiveBaseBadge tone="dark" />}
        </div>
        <div className="absolute inset-x-0 bottom-0 p-5 text-white sm:p-7">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/65">{comingSoon ? "Nova base" : "Base"}</p>
          <h3 className="mt-2 text-4xl font-medium tracking-[-0.045em] sm:text-5xl">{base.name}</h3>
        </div>
      </div>

      <div className="flex flex-1 flex-col p-5 sm:p-7">
        <p className="inline-flex items-center gap-2 text-sm text-ink/55">
          <MapPin aria-hidden="true" className="size-4 shrink-0 text-lake" />
          {base.locationLabel}
        </p>
        {/* Fora da foto, para nunca cobrir o selo "Em breve". */}
        {isTemporaryMedia(base.slug, imageUrl) ? <p className="mt-1 text-xs text-ink/40">{TEMPORARY_MEDIA_LABEL}</p> : null}
        <p className="mt-4 text-base leading-7 text-ink/70">{base.shortDescription}</p>
        {base.partnerName ? <PartnerBadge partner={base.partnerName} className="mt-5 self-start" /> : null}

        {experienceTitles.length ? (
          <div className="mt-6 border-t border-ink/10 pt-5">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-ink/45">
              {comingSoon ? "Experiências planejadas" : "Experiências"}
            </p>
            <ul className="mt-3 flex flex-wrap gap-2">
              {experienceTitles.map((title) => (
                <li key={title} className="rounded-full bg-mist px-3 py-1.5 text-sm font-medium text-forest">
                  {title}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <span className="mt-auto flex items-center justify-between gap-4 pt-7 font-semibold text-forest">
          {cta}
          <span className="grid size-11 shrink-0 place-items-center rounded-full bg-ink text-white transition-transform duration-300 group-hover:-translate-y-0.5 group-hover:translate-x-0.5">
            <ArrowUpRight aria-hidden="true" className="size-5" />
          </span>
        </span>
      </div>
    </Link>
  );
}
