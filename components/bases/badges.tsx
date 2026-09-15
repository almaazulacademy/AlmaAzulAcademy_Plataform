import { Clock3, Handshake, MapPin, Sparkles } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

type Tone = "light" | "dark";

const tones: Record<Tone, string> = {
  // Sobre fotos e fundos escuros (cards, hero, seção de reservas).
  dark: "border-white/25 bg-ink/35 text-white backdrop-blur-md",
  // Sobre papel e branco.
  light: "border-ink/10 bg-white text-ink",
};

function Pill({ tone = "light", icon, className, children }: { tone?: Tone; icon?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-semibold uppercase leading-none tracking-[0.14em]",
        tones[tone],
        className,
      )}
    >
      {icon}
      <span className="truncate">{children}</span>
    </span>
  );
}

/**
 * Selo "Em breve" — o padrão único para qualquer coisa ainda sem reserva
 * aberta: base, experiência ou, no futuro, um roteiro.
 */
export function ComingSoonBadge({ tone = "light", className, label = "Em breve" }: { tone?: Tone; className?: string; label?: string }) {
  return (
    <Pill
      tone={tone}
      className={cn(tone === "light" ? "border-sand/70 bg-sand/25 text-forest" : "border-sand/50 bg-sand/90 text-ink", className)}
      icon={<Clock3 aria-hidden="true" className="size-3.5 shrink-0" />}
    >
      {label}
    </Pill>
  );
}

/** Onde a experiência acontece. Sempre com o prefixo "Base". */
export function BaseBadge({ name, tone = "light", className }: { name: string; tone?: Tone; className?: string }) {
  return (
    <Pill tone={tone} className={className} icon={<MapPin aria-hidden="true" className="size-3.5 shrink-0 text-lake" />}>
      Base {name}
    </Pill>
  );
}

export function ExclusiveBadge({ baseName, tone = "light", className }: { baseName: string; tone?: Tone; className?: string }) {
  return (
    <Pill
      tone={tone}
      className={cn(tone === "light" ? "border-forest/15 bg-forest text-white" : "border-white/30 bg-white text-forest", className)}
      icon={<Sparkles aria-hidden="true" className="size-3.5 shrink-0" />}
    >
      Exclusiva da Base {baseName}
    </Pill>
  );
}

export function ActiveBaseBadge({ tone = "light", className }: { tone?: Tone; className?: string }) {
  return (
    <Pill tone={tone} className={className} icon={<span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-emerald-500" />}>
      Base em operação
    </Pill>
  );
}

export function PartnerBadge({ partner, tone = "light", className }: { partner: string; tone?: Tone; className?: string }) {
  return (
    <Pill tone={tone} className={className} icon={<Handshake aria-hidden="true" className="size-3.5 shrink-0" />}>
      Em parceria com {partner}
    </Pill>
  );
}
