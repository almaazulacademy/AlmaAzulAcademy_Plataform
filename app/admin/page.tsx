import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, LockKeyhole } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Área reservada",
  robots: { index: false, follow: false },
};

export default function AdminPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-mist p-5">
      <div className="w-full max-w-lg rounded-4xl bg-white p-8 text-center shadow-soft sm:p-12">
        <Image
          src="/images/branding/alma-azul-logo-dark.png"
          alt="Alma Azul"
          width={185}
          height={100}
          className="mx-auto h-auto w-36"
          priority
        />
        <div className="mx-auto mt-12 grid size-14 place-items-center rounded-2xl bg-forest text-white">
          <LockKeyhole className="size-6" />
        </div>
        <p className="mt-8 text-xs font-semibold uppercase tracking-[0.2em] text-lake">Área reservada</p>
        <h1 className="mt-4 text-4xl font-medium tracking-[-0.045em]">Em preparação.</h1>
        <p className="mt-5 leading-7 text-ink/60">
          O painel administrativo será construído em uma próxima etapa da plataforma.
        </p>
        <Link href="/" className={buttonVariants({ variant: "outline", className: "mt-9" })}>
          <ArrowLeft className="size-4" /> Voltar ao início
        </Link>
      </div>
    </main>
  );
}
