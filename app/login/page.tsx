import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft, ShieldCheck } from "lucide-react";

import { LoginForm } from "@/components/admin/login-form";
import { ToastProvider } from "@/components/admin/toast-provider";
import { buttonVariants } from "@/components/ui/button";
import { getAdminContext } from "@/lib/admin/auth";

export const metadata: Metadata = {
  title: "Login",
  robots: { index: false, follow: false },
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const existing = await getAdminContext();
  if (existing) redirect("/admin");
  const params = await searchParams;
  const destination = params.next?.startsWith("/admin") ? params.next : "/admin";

  return (
    <ToastProvider>
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
          <div className="absolute inset-0 bg-gradient-to-t from-ink/65 via-ink/20 to-transparent" />
          <p className="absolute bottom-12 left-12 max-w-md text-3xl font-medium leading-tight tracking-[-0.035em] text-white">
            A operação da Alma Azul, organizada em um só lugar.
          </p>
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
            <div className="mt-12 grid size-12 place-items-center rounded-2xl bg-forest text-white">
              <ShieldCheck className="size-5" />
            </div>
            <p className="mt-7 text-xs font-semibold uppercase tracking-[0.2em] text-lake">Acesso administrativo</p>
            <h1 className="mt-3 text-4xl font-semibold tracking-[-0.05em] sm:text-5xl">Bem-vinda.</h1>
            <p className="mt-4 max-w-sm leading-7 text-ink/60">
              Entre com sua conta autorizada do Supabase para acessar sessões, reservas e experiências.
            </p>
            <LoginForm destination={destination} />
            <Link href="/" className={buttonVariants({ variant: "ghost", className: "mt-5" })}>
              <ArrowLeft className="size-4" /> Voltar ao site
            </Link>
          </div>
        </div>
      </main>
    </ToastProvider>
  );
}
