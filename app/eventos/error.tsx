"use client";

import Link from "next/link";

/** Falha inesperada na seção de eventos: o resto do site segue acessível. */
export default function EventsError({ reset }: { error: Error; reset: () => void }) {
  return (
    <main className="grid min-h-[100svh] place-items-center bg-night px-5 text-center text-white">
      <div className="max-w-md">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-white/60">Eventos Especiais</p>
        <h1 className="mt-4 text-3xl font-semibold">Não foi possível carregar esta página.</h1>
        <p className="mt-4 text-white/70">Tente de novo em instantes.</p>
        <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
          <button type="button" onClick={reset} className="h-12 rounded-full bg-white px-6 font-semibold text-night">Tentar de novo</button>
          <Link href="/" className="h-12 rounded-full border border-white/30 px-6 leading-[3rem] font-semibold">Voltar ao início</Link>
        </div>
      </div>
    </main>
  );
}
