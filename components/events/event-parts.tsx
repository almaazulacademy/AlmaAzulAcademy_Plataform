import Link from "next/link";
import { ArrowRight, Eye } from "lucide-react";

import { availabilityBadge, type EventAvailability, type EventCta } from "@/lib/events/presentation";
import { cn } from "@/lib/utils";

const badgeTones = {
  open: "border-ember/60 bg-ember/15 text-ember",
  last: "border-ember bg-ember text-night",
  closed: "border-white/25 bg-white/10 text-white/80",
  past: "border-white/15 bg-white/5 text-white/60",
} as const;

/** "Vagas abertas", "Últimas 3 vagas", "Esgotado", "Reservas encerradas", "Evento realizado". */
export function AvailabilityBadge({ availability, remainingSpots, className }: { availability: EventAvailability; remainingSpots: number | null; className?: string }) {
  const badge = availabilityBadge(availability, remainingSpots);
  return (
    <span className={cn("inline-flex items-center rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em]", badgeTones[badge.tone], className)}>
      {badge.label}
    </span>
  );
}

/**
 * Botão de reserva do evento. Na fase 4 o fluxo de reserva ainda não está
 * integrado: com vagas, o botão aparece desativado e diz que as reservas abrem
 * em breve; sem vagas ou depois do evento, diz o porquê. Só com `kind: "BOOK"`
 * (fase 5) ele vira link para `/reservar/[sessionId]`.
 */
export function EventCtaButton({ cta, className, compact = false }: { cta: EventCta; className?: string; compact?: boolean }) {
  const base = cn(
    "inline-flex items-center justify-center gap-2 rounded-full font-event font-bold uppercase tracking-[0.08em] transition-all duration-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember focus-visible:ring-offset-2 focus-visible:ring-offset-night",
    compact ? "h-12 px-5 text-xs" : "h-14 px-8 text-sm",
    className,
  );
  if (cta.kind === "BOOK" || cta.kind === "WAITLIST") {
    return (
      <Link href={cta.href} className={cn(base, "bg-ember text-night hover:-translate-y-0.5 hover:bg-[#eaa962]")}>
        {cta.label}
        <ArrowRight aria-hidden="true" className="size-4" />
      </Link>
    );
  }
  return (
    <button type="button" disabled aria-disabled="true" className={cn(base, cta.kind === "SOON" ? "cursor-not-allowed bg-ember/85 text-night" : "cursor-not-allowed border border-white/25 bg-white/5 text-white/70")}>
      {cta.label}
    </button>
  );
}

/** Aviso da prévia, no topo do Hero: deixa claro que nada ali é um evento publicado. */
export function EventDemoBanner() {
  return (
    <div role="note" className="mb-8 inline-flex rounded-2xl bg-ember px-4 py-2 text-xs font-semibold text-night shadow-lg sm:rounded-full">
      <span><Eye aria-hidden="true" className="mr-2 inline size-4 align-[-3px]" />Prévia com dados de demonstração · não é um evento publicado · sem reservas</span>
    </div>
  );
}

/** Rótulo pequeno em caixa alta com o traço âmbar, como nos slides. */
export function EventEyebrow({ children, className, tone = "light" }: { children: React.ReactNode; className?: string; tone?: "light" | "dark" }) {
  return (
    <p className={cn("flex items-center gap-3 text-xs font-semibold uppercase tracking-[0.22em]", tone === "light" ? "text-white/75" : "text-ink/60", className)}>
      <span aria-hidden="true" className="h-px w-10 bg-ember" />
      {children}
    </p>
  );
}
