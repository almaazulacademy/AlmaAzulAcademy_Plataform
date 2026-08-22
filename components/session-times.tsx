import Link from "next/link";
import { Clock3 } from "lucide-react";

import { readOpenSessions } from "@/lib/reservations/session-catalog";
import { listSessionStartTimes } from "@/lib/sessions/choice";

const COUNT_WORD = ["", "uma", "duas", "três", "quatro", "cinco", "seis"] as const;

function countWord(total: number) {
  return COUNT_WORD[total] ?? String(total);
}

export function SessionTimesLoading() {
  return <div className="h-44 animate-pulse rounded-4xl border border-ink/10 bg-white/60" aria-hidden="true" />;
}

/**
 * Destaque das turmas na página da experiência.
 *
 * A Imersão Paranoá acontece em três horários no mesmo dia. Antes deste bloco a
 * página não dizia isso em lugar nenhum: o horário só aparecia lá embaixo, em
 * letra pequena, dentro de cada cartão de data — e uma divulgação de "sábado e
 * domingo às 9h" bastava para o cliente assumir que 09:00 era *o* horário da
 * experiência.
 *
 * Recebe os horários prontos: nenhum horário fixo mora neste componente e
 * nenhuma consulta acontece aqui.
 */
export function SessionTimesBoard({ times }: { times: string[] }) {
  const multiple = times.length > 1;

  return (
    <section
      aria-label={`Turmas disponíveis: ${times.join(", ")}`}
      className="rounded-4xl border border-lake/20 bg-white p-6 shadow-soft sm:p-8"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <p className="flex items-center gap-2.5 text-xs font-semibold uppercase tracking-[0.18em] text-lake">
          <Clock3 aria-hidden="true" className="size-4" />
          {multiple ? "Turmas disponíveis" : "Turma disponível"}
        </p>
        <Link href="#reservas" className="text-sm font-semibold text-forest underline-offset-4 hover:underline">
          Escolher {multiple ? "minha turma" : "a data"}
        </Link>
      </div>

      <ul className="mt-6 grid gap-3 sm:grid-cols-3 sm:gap-4">
        {times.map((time) => (
          <li
            key={time}
            className="rounded-3xl border border-ink/10 bg-paper px-5 py-6 text-center sm:px-4 sm:py-7"
          >
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-ink/45">Turma</p>
            <p className="mt-2 text-[clamp(2.6rem,9vw,3.4rem)] font-medium leading-none tracking-[-0.05em] text-forest">
              {time}
            </p>
          </li>
        ))}
      </ul>

      <p className="mt-6 leading-7 text-ink/65">
        {multiple
          ? `A experiência acontece em ${countWord(times.length)} turmas no mesmo dia. Escolha o horário na hora de reservar — cada turma tem vagas próprias.`
          : "Todas as datas abertas começam neste horário."}
      </p>
    </section>
  );
}

/**
 * Lê as turmas abertas da experiência e monta o destaque.
 *
 * Os horários saem das sessões de verdade (`sessions.starts_at`), nunca de
 * texto editorial: se a operação abrir uma turma nova, ela aparece aqui
 * sozinha, e uma turma que deixou de existir some. Sem sessão aberta o bloco
 * não aparece — a seção de datas já explica a ausência.
 */
export async function SessionTimes({ experienceSlug }: { experienceSlug: string }) {
  const result = await readOpenSessions(experienceSlug);
  if (result.status !== "READY") return null;

  const times = listSessionStartTimes(result.sessions);
  if (!times.length) return null;

  return <SessionTimesBoard times={times} />;
}
