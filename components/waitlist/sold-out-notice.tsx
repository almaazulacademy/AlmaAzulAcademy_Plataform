import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import { SOLD_OUT_LABEL, SOLD_OUT_NOTE } from "@/lib/waitlist/public";

/** O selo "Esgotado", igual em todo lugar que mostra uma turma sem vaga. */
export function SoldOutBadge({ tone = "light", className }: { tone?: "light" | "dark"; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-[0.16em]",
        tone === "dark" ? "bg-white/15 text-white" : "bg-ink/[0.07] text-ink/70",
        className,
      )}
    >
      {SOLD_OUT_LABEL}
    </span>
  );
}

/**
 * Aviso de turma esgotada.
 *
 * Nunca é um link de reserva. `action` é o lugar do futuro "Entrar na lista de
 * espera" (fase 3): nesta fase nenhuma tela o preenche, e a inscrição não existe.
 */
export function SoldOutNotice({
  tone = "light",
  note = SOLD_OUT_NOTE,
  action,
  className,
}: {
  tone?: "light" | "dark";
  note?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div role="status" className={cn("flex flex-col gap-3", className)}>
      <SoldOutBadge tone={tone} className="self-start" />
      <p className={cn("text-sm leading-6", tone === "dark" ? "text-white/60" : "text-ink/55")}>{note}</p>
      {action ?? null}
    </div>
  );
}
