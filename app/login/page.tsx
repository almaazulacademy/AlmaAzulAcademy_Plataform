import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, UserRound } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Login",
  robots: { index: false, follow: false },
};

export default function LoginPage() {
  return (
    <main className="grid min-h-screen lg:grid-cols-2">
      <div className="relative hidden min-h-screen overflow-hidden lg:block">
        <Image
          src="/images/backgrounds/corredor-corrego-do-torto.webp"
          alt="Travessia pelo corredor do Córrego do Torto"
          fill
          priority
          sizes="50vw"
          className="object-cover"
        />
        <div className="absolute inset-0 bg-ink/25" />
      </div>
      <div className="flex min-h-screen items-center justify-center bg-paper p-6 sm:p-12">
        <div className="w-full max-w-md">
          <Image
            src="/images/branding/alma-azul-logo-dark.png"
            alt="Alma Azul"
            width={185}
            height={100}
            className="h-auto w-36"
            priority
          />
          <div className="mt-14 grid size-12 place-items-center rounded-2xl bg-forest text-white">
            <UserRound className="size-5" />
          </div>
          <p className="mt-8 text-xs font-semibold uppercase tracking-[0.2em] text-lake">Conta Alma Azul</p>
          <h1 className="mt-4 text-5xl font-medium tracking-[-0.05em]">Login em breve.</h1>
          <p className="mt-5 max-w-sm leading-7 text-ink/60">
            O acesso de participantes fará parte das próximas etapas. Nenhum dado é coletado nesta versão.
          </p>
          <Link href="/" className={buttonVariants({ variant: "outline", className: "mt-9" })}>
            <ArrowLeft className="size-4" /> Voltar ao início
          </Link>
        </div>
      </div>
    </main>
  );
}
