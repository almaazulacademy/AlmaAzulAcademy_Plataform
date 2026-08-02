"use client";

import { AlertTriangle, RotateCcw } from "lucide-react";

import { Button } from "@/components/ui/button";

export default function AdminError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <section className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center text-center" role="alert">
      <span className="flex size-12 items-center justify-center rounded-2xl bg-sunset/10 text-sunset">
        <AlertTriangle className="size-5" aria-hidden />
      </span>
      <h1 className="mt-5 text-2xl font-semibold tracking-[-0.035em]">Não foi possível carregar esta área</h1>
      <p className="mt-3 max-w-md text-sm leading-6 text-ink/55">
        Verifique a conexão e tente novamente. Se o problema continuar, confirme a configuração do Supabase.
      </p>
      <Button className="mt-6" onClick={reset}>
        <RotateCcw className="size-4" aria-hidden />
        Tentar novamente
      </Button>
    </section>
  );
}
