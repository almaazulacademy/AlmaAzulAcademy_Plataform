import Link from "next/link";
import { ArrowRight, ArrowUpRight, MapPin } from "lucide-react";
import type { ReactNode } from "react";

import { ComingSoonBadge, ExclusiveBadge } from "@/components/bases/badges";
import { TemporaryMediaLabel } from "@/components/bases/base-media";
import { EditorialImage } from "@/components/editorial-image";
import { isTemporaryMedia } from "@/lib/bases/media";
import { catalogExperienceHref, isExperienceBookable, type ModalityGroup } from "@/lib/bases/availability";
import type { CatalogExperience, PublicBase } from "@/lib/bases/types";

function CardImage({ experience, children }: { experience: CatalogExperience; children?: ReactNode }) {
  return (
    <div className="relative isolate aspect-[4/3] max-w-full overflow-hidden bg-ink">
      <EditorialImage
        src={experience.image.src}
        alt={experience.image.alt}
        sizes="(min-width: 1024px) 30vw, (min-width: 640px) 50vw, 100vw"
        className="absolute inset-0 h-full w-full object-cover transition-transform duration-700 ease-out group-hover:scale-[1.035]"
      />
      <div className="absolute inset-0 bg-gradient-to-t from-ink/55 via-transparent to-transparent" />
      {isTemporaryMedia(experience.baseSlug, experience.image.src) ? <TemporaryMediaLabel /> : null}
      <div className="absolute inset-x-4 top-4 flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

/**
 * Card da vitrine /experiencias: uma modalidade, uma linha por base.
 *
 * O visitante vê "Remada Sunset" uma vez e, logo abaixo, onde ela acontece e
 * em que situação está em cada base. Linhas de bases sem reserva aberta levam
 * para a página da base — nunca para uma agenda.
 */
export function ModalityCard({ group }: { group: ModalityGroup }) {
  const { lead } = group;
  return (
    <article className="group flex h-full flex-col overflow-hidden rounded-4xl border border-ink/10 bg-white shadow-soft">
      <CardImage experience={lead}>
        {group.exclusiveBase ? <ExclusiveBadge baseName={group.exclusiveBase.name} tone="dark" /> : null}
        {group.comingSoon ? <ComingSoonBadge tone="dark" /> : null}
      </CardImage>

      <div className="flex flex-1 flex-col p-5 sm:p-7">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-lake">{lead.eyebrow}</p>
        <h3 className="mt-2 text-3xl font-medium tracking-[-0.045em] text-ink">{lead.title}</h3>
        <p className="mt-3 leading-7 text-ink/65">{lead.summary}</p>

        <div className="mt-auto pt-6">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-ink/45">
            {group.entries.length === 1 ? "Onde acontece" : "Onde acontece · escolha a base"}
          </p>
          <ul className="mt-3 divide-y divide-ink/10 overflow-hidden rounded-3xl border border-ink/10">
            {group.entries.map(({ experience, base }) => {
              const bookable = isExperienceBookable(experience, base);
              return (
                <li key={experience.id}>
                  <Link
                    href={catalogExperienceHref(experience, base)}
                    aria-label={bookable ? `${experience.title} na Base ${base.name}: ver datas` : `${experience.title} na Base ${base.name}: em breve`}
                    className="flex min-h-14 items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-paper focus-visible:bg-paper focus-visible:outline-none"
                  >
                    <span className="flex min-w-0 items-start gap-2 font-semibold leading-snug text-forest">
                      <MapPin aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-lake" />
                      <span>Base {base.name}</span>
                    </span>
                    {bookable ? (
                      <span className="inline-flex shrink-0 items-center gap-1.5 text-sm font-semibold text-ink">
                        Ver datas <ArrowRight aria-hidden="true" className="size-4" />
                      </span>
                    ) : (
                      <ComingSoonBadge className="shrink-0" />
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </article>
  );
}

/**
 * Card de experiência dentro da página de uma base.
 *
 * Publicada: leva direto para a landing e o fluxo atual de reserva.
 * Em breve: não é link, não mostra preço, vagas nem horário — só o status.
 */
export function BaseExperienceCard({ experience, base }: { experience: CatalogExperience; base: PublicBase }) {
  const bookable = isExperienceBookable(experience, base);
  const badges = (
    <>
      {experience.isExclusive ? <ExclusiveBadge baseName={base.name} tone="dark" /> : null}
      {!bookable ? <ComingSoonBadge tone="dark" /> : null}
    </>
  );
  const body = (
    <div className="flex flex-1 flex-col p-5 sm:p-7">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-lake">{bookable ? experience.eyebrow : `Base ${base.name}`}</p>
      <h3 className="mt-2 text-3xl font-medium tracking-[-0.045em] text-ink">{experience.title}</h3>
      <p className="mt-3 leading-7 text-ink/65">{experience.summary}</p>
      {bookable ? (
        <span className="mt-auto flex items-center justify-between gap-4 pt-6 font-semibold text-forest">
          Ver datas e reservar
          <span className="grid size-11 shrink-0 place-items-center rounded-full bg-ink text-white transition-transform duration-300 group-hover:-translate-y-0.5 group-hover:translate-x-0.5">
            <ArrowUpRight aria-hidden="true" className="size-5" />
          </span>
        </span>
      ) : (
        <p className="mt-auto pt-6 text-sm text-ink/50">Programação ainda não aberta.</p>
      )}
    </div>
  );

  if (!bookable) {
    return (
      <article className="group flex h-full flex-col overflow-hidden rounded-4xl border border-ink/10 bg-white">
        <CardImage experience={experience}>{badges}</CardImage>
        {body}
      </article>
    );
  }

  return (
    <Link
      href={`/experiencias/${experience.slug}`}
      className="group flex h-full flex-col overflow-hidden rounded-4xl border border-ink/10 bg-white shadow-soft transition duration-300 hover:-translate-y-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-lake focus-visible:ring-offset-2"
    >
      <CardImage experience={experience}>{badges}</CardImage>
      {body}
    </Link>
  );
}
