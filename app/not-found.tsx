import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";

export default function NotFound() {
  return (
    <main className="grid min-h-screen place-items-center bg-paper p-6 text-center">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-lake">Erro 404</p>
        <h1 className="mt-5 text-6xl font-medium tracking-[-0.06em]">Essa rota saiu do percurso.</h1>
        <p className="mx-auto mt-6 max-w-lg text-lg text-ink/60">Volte ao início para continuar explorando a Alma Azul Academy.</p>
        <Link href="/" className={buttonVariants({ className: "mt-9" })}>Voltar ao início</Link>
      </div>
    </main>
  );
}
