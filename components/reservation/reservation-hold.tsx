"use client";

import Link from "next/link";
import { CheckCircle2, Clock3, Copy } from "lucide-react";
import { useCallback, useState } from "react";

import { Countdown } from "@/components/reservation/countdown";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type ReservationHoldProps = {
  publicCode: string;
  expiresAt: string;
  checkoutUrl: string | null;
  title?: string;
};

export function ReservationHold({ publicCode, expiresAt, checkoutUrl, title = "Sua vaga está reservada por 2 horas." }: ReservationHoldProps) {
  const [expired, setExpired] = useState(new Date(expiresAt).getTime() <= Date.now());
  const [copied, setCopied] = useState(false);
  const expire = useCallback(() => setExpired(true), []);

  async function copyCode() {
    await navigator.clipboard.writeText(publicCode);
    setCopied(true);
  }

  return (
    <div className="rounded-4xl border border-ink/10 bg-white p-7 shadow-[0_25px_80px_rgba(20,49,44,0.10)] sm:p-10">
      <CheckCircle2 className="size-9 text-lake" />
      <h1 className="mt-6 text-balance text-4xl font-medium leading-tight tracking-[-0.05em] sm:text-5xl">{expired ? "O prazo desta pré-reserva terminou." : title}</h1>
      <p className="mt-5 max-w-xl leading-7 text-ink/60">
        {expired ? "As vagas foram liberadas automaticamente. Escolha uma nova sessão para tentar novamente." : "Finalize o pagamento antes do contador chegar a zero. Guarde o código para acompanhar a reserva depois."}
      </p>
      {!expired && (
        <div className="mt-8 rounded-3xl bg-paper p-6">
          <p className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-ink/45"><Clock3 className="size-4" />Tempo restante</p>
          <Countdown expiresAt={expiresAt} onExpire={expire} />
        </div>
      )}
      <div className="mt-6 flex flex-col gap-3 rounded-3xl border border-ink/10 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div><p className="text-xs font-semibold uppercase tracking-[0.15em] text-ink/40">Código da reserva</p><p className="mt-1 font-mono text-xl font-semibold tracking-wider">{publicCode}</p></div>
        <button type="button" onClick={copyCode} className="inline-flex items-center gap-2 text-sm font-semibold text-forest"><Copy className="size-4" />{copied ? "Copiado" : "Copiar código"}</button>
      </div>
      <div className="mt-7 flex flex-col gap-3 sm:flex-row">
        {!expired && checkoutUrl && <a href={checkoutUrl} className={buttonVariants({ size: "lg" })}>Pagar agora</a>}
        <Link href="/acompanhar-reserva" className={cn(buttonVariants({ variant: "outline", size: "lg" }))}>Acompanhar reserva</Link>
        {expired && <Link href="/imersao-paranoa#reservas" className={buttonVariants({ size: "lg" })}>Ver novas datas</Link>}
      </div>
    </div>
  );
}
