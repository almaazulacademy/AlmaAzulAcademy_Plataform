import { CalendarDays } from "lucide-react";

import { describeSessionTime } from "@/lib/sessions/choice";
import { cn } from "@/lib/utils";

type SessionTurmaProps = {
  /** `sessions.starts_at` da sessão realmente reservada. */
  startsAt: string;
  experienceTitle: string;
  /** Rótulo do bloco. `Sua turma` antes do pagamento, `Turma confirmada` depois. */
  label?: string;
  /** Linha de reforço opcional, usada antes do pagamento. */
  note?: string;
  tone?: "light" | "dark";
  className?: string;
};

/**
 * O horário escolhido, em destaque, acompanhando o cliente até o fim do fluxo.
 *
 * A Imersão Paranoá tem três turmas no mesmo dia. Quem escolhe às pressas
 * precisa reencontrar o horário em toda tela seguinte — formulário, espera do
 * pagamento, consulta da reserva e confirmação —, não só no e-mail que chega
 * depois. Por isso a hora é o maior elemento do bloco.
 *
 * O conteúdo vem inteiro de `describeSessionTime`, ou seja, do `starts_at` da
 * sessão vinculada à reserva. Nada aqui é digitado à mão.
 */
export function SessionTurma({
  startsAt,
  experienceTitle,
  label = "Sua turma",
  note,
  tone = "light",
  className,
}: SessionTurmaProps) {
  const turma = describeSessionTime(startsAt);
  const dark = tone === "dark";

  return (
    <section
      aria-label={`${label}: ${turma.ariaLabel}`}
      className={cn(
        "rounded-4xl border p-6 sm:p-8",
        dark ? "border-white/15 bg-white/[0.07] text-white" : "border-lake/25 bg-mist text-ink",
        className,
      )}
    >
      <p
        className={cn(
          "text-xs font-semibold uppercase tracking-[0.2em]",
          dark ? "text-sand" : "text-lake",
        )}
      >
        {label}
      </p>

      <div className="mt-5 flex flex-col gap-5 sm:flex-row sm:items-center sm:gap-8">
        <p
          className={cn(
            "text-[clamp(3.4rem,12vw,4.5rem)] font-medium leading-[0.85] tracking-[-0.06em]",
            dark ? "text-white" : "text-forest",
          )}
        >
          <span className="sr-only">Horário de início: </span>
          {turma.time}
        </p>

        <div
          className={cn(
            "border-t pt-5 sm:border-l sm:border-t-0 sm:pl-8 sm:pt-0",
            dark ? "border-white/15" : "border-ink/10",
          )}
        >
          <p className="text-lg font-semibold leading-tight sm:text-xl">{experienceTitle}</p>
          <p className={cn("mt-2 flex items-start gap-2.5 leading-7", dark ? "text-white/70" : "text-ink/65")}>
            <CalendarDays
              aria-hidden="true"
              className={cn("mt-1.5 size-4 shrink-0", dark ? "text-sand" : "text-lake")}
            />
            {/* O first-letter fica no span porque o ícone vem antes do texto. */}
            <span className="first-letter:uppercase">{turma.fullDate}</span>
          </p>
        </div>
      </div>

      {note ? (
        <p className={cn("mt-6 text-sm leading-6", dark ? "text-white/55" : "text-ink/55")}>{note}</p>
      ) : null}
    </section>
  );
}
