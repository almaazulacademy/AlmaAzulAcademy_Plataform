import Link from "next/link";
import { CalendarDays, Clock3, Ticket, Users } from "lucide-react";

import { HOLIDAY_NOTE, type ExperienceModalities } from "@/lib/editorial/modalities";
import { readPublicSessions } from "@/lib/reservations/session-catalog";
import { formatDurationLabel, summarizeModalities } from "@/lib/sessions/modality";

function formatPrice(cents: number) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 }).format(cents / 100);
}

/**
 * Os dois formatos da experiência, lado a lado: a remada de 1 hora durante a
 * semana e a tradicional de 1h30 no fim de semana.
 *
 * Fica no lugar do quadro de turmas, logo depois do Hero. O texto e a
 * programação aprovada vêm de `lib/editorial/modalities.ts`; `openFormats`
 * diz quais formatos têm turma aberta de verdade (mesma duração e preço da
 * sessão). Um formato sem turma aberta continua explicado e convida a
 * acompanhar a agenda — sem prometer data de abertura nem levar a uma turma
 * inexistente.
 */
export function ExperienceModalitiesBoard({
  modalities,
  openFormats,
}: {
  modalities: ExperienceModalities;
  /** Chaves `duração|preço` com pelo menos uma turma aberta. */
  openFormats: ReadonlySet<string>;
}) {
  return (
    <section aria-label="Formatos da experiência" className="rounded-4xl border border-lake/20 bg-white p-6 shadow-soft sm:p-8">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <p className="flex items-center gap-2.5 text-xs font-semibold uppercase tracking-[0.18em] text-lake">
          <Clock3 aria-hidden="true" className="size-4" />
          Escolha o seu formato
        </p>
        <Link href="#reservas" className="text-sm font-semibold text-forest underline-offset-4 hover:underline">
          Ver datas e horários
        </Link>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {modalities.items.map((item) => {
          const open = openFormats.has(`${item.durationMinutes}|${item.priceCents}`);
          return (
            <article key={item.eyebrow} className="flex flex-col rounded-3xl border border-ink/10 bg-paper p-6 sm:p-7">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-lake">{item.eyebrow}</p>
              <h3 className="mt-3 text-2xl font-medium tracking-[-0.035em] sm:text-3xl">{item.title}</h3>
              <p className="mt-3 leading-7 text-ink/65">{item.text}</p>

              <dl className="mt-6 grid grid-cols-2 gap-x-4 gap-y-4 border-t border-ink/10 pt-5 text-sm">
                <div className="col-span-2">
                  <dt className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-ink/45">
                    <CalendarDays aria-hidden="true" className="size-3.5" /> Dias e horário
                  </dt>
                  <dd className="mt-1 font-semibold text-forest">{item.schedule}</dd>
                </div>
                <div>
                  <dt className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-ink/45">
                    <Clock3 aria-hidden="true" className="size-3.5" /> Duração
                  </dt>
                  <dd className="mt-1 font-semibold">{formatDurationLabel(item.durationMinutes)}</dd>
                </div>
                <div>
                  <dt className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-ink/45">
                    <Ticket aria-hidden="true" className="size-3.5" /> Valor
                  </dt>
                  <dd className="mt-1 font-semibold">{formatPrice(item.priceCents)} por pessoa</dd>
                </div>
                <div className="col-span-2">
                  <dt className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-ink/45">
                    <Users aria-hidden="true" className="size-3.5" /> Vagas
                  </dt>
                  <dd className="mt-1 font-semibold">Até {modalities.capacity} participantes por turma</dd>
                </div>
              </dl>

              {open ? null : (
                <p className="mt-5 rounded-2xl bg-white px-4 py-3 text-sm leading-6 text-ink/60">
                  Confira a{" "}
                  <Link href="/agenda" className="font-semibold text-forest underline underline-offset-4 hover:text-lake">
                    agenda
                  </Link>{" "}
                  para acompanhar a abertura de novas turmas.
                </p>
              )}
            </article>
          );
        })}
      </div>

      <p className="mt-5 text-sm leading-6 text-ink/55">{HOLIDAY_NOTE}</p>
    </section>
  );
}

/** Lê as turmas abertas só para saber quais formatos já têm data. */
export async function ExperienceModalitiesSection({ experienceSlug, modalities }: { experienceSlug: string; modalities: ExperienceModalities }) {
  const result = await readPublicSessions(experienceSlug);
  const sessions = result.status === "READY" ? result.sessions : [];
  const openFormats = new Set(summarizeModalities(sessions).map((group) => `${group.durationMinutes}|${group.priceCents}`));
  return <ExperienceModalitiesBoard modalities={modalities} openFormats={openFormats} />;
}
