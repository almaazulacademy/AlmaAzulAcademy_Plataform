import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { redirect } from "next/navigation";
import { CircleAlert, UserPlus } from "lucide-react";

import { ToastProvider } from "@/components/admin/toast-provider";
import { InstructorSignupForm } from "@/components/instructor/signup-form";
import { buttonVariants } from "@/components/ui/button";
import { getStaffContext } from "@/lib/admin/auth";
import { homeForRole } from "@/lib/admin/roles";
import { getInviteState } from "@/lib/team/data";
import { INVITE_STATE_MESSAGES, isInviteToken, type InviteState } from "@/lib/team/invite";

export const metadata: Metadata = {
  title: "Cadastro de instrutor",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function InstructorSignupPage({ searchParams }: { searchParams: Promise<{ invite?: string }> }) {
  const existing = await getStaffContext().catch(() => null);
  if (existing) redirect(homeForRole(existing.profile.role));

  const { invite } = await searchParams;
  let state: InviteState | "UNAVAILABLE" = "INVALID";
  if (isInviteToken(invite)) state = await getInviteState(invite).catch(() => "UNAVAILABLE" as const);

  return (
    <ToastProvider>
      <main className="flex min-h-screen items-center justify-center bg-paper p-6 sm:p-12">
        <div className="w-full max-w-md">
          <Image src="/images/branding/alma-azul-logo-dark.png" alt="Alma Azul" width={185} height={100} className="h-auto w-36" priority />
          {state === "VALID" && invite ? (
            <>
              <div className="mt-12 grid size-12 place-items-center rounded-2xl bg-forest text-white"><UserPlus className="size-5" /></div>
              <p className="mt-7 text-xs font-semibold uppercase tracking-[0.2em] text-lake">Convite de instrutor</p>
              <h1 className="mt-3 text-4xl font-semibold tracking-[-0.05em]">Crie seu acesso.</h1>
              <p className="mt-4 max-w-sm leading-7 text-ink/60">
                Com esta conta você acessa a Lista de Presença e faz o check-in dos participantes das experiências.
              </p>
              <InstructorSignupForm token={invite} />
            </>
          ) : (
            <section className="mt-12 rounded-3xl border border-ink/10 bg-white p-6" role="alert">
              <div className="grid size-12 place-items-center rounded-2xl bg-amber-50 text-amber-800"><CircleAlert className="size-5" /></div>
              <h1 className="mt-5 text-2xl font-semibold tracking-[-0.03em] text-ink">
                {state === "UNAVAILABLE" ? "Cadastro indisponível" : INVITE_STATE_MESSAGES[state === "VALID" ? "INVALID" : state].title}
              </h1>
              <p className="mt-3 leading-7 text-ink/65">
                {state === "UNAVAILABLE"
                  ? "Não foi possível verificar o convite agora. Tente novamente em instantes."
                  : INVITE_STATE_MESSAGES[state === "VALID" ? "INVALID" : state].description}
              </p>
              <Link href="/login" className={buttonVariants({ variant: "outline", className: "mt-6" })}>Ir para o login</Link>
            </section>
          )}
        </div>
      </main>
    </ToastProvider>
  );
}
