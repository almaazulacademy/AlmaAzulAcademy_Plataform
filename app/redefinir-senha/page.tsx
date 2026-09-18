import type { Metadata } from "next";
import Link from "next/link";
import { KeyRound } from "lucide-react";

import { AuthCardPage } from "@/components/auth/auth-card-page";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { buttonVariants } from "@/components/ui/button";
import { isResetToken, RESET_LINK_INVALID_MESSAGE } from "@/lib/auth/password-reset-rules";

export const metadata: Metadata = {
  title: "Criar nova senha",
  robots: { index: false, follow: false },
  // O token está na URL: não pode vazar para outro site pelo Referer.
  referrer: "no-referrer",
};

export const dynamic = "force-dynamic";

/**
 * Abrir a página NÃO consome o link: antivírus e visualizadores de e-mail abrem
 * links sozinhos. O token só é validado quando a pessoa envia a nova senha.
 */
export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <AuthCardPage
      icon={KeyRound}
      eyebrow="Acesso da equipe"
      title="Crie uma nova senha."
      description="Escolha a nova senha da sua conta Alma Azul. Depois de salvar, você entra direto."
    >
      {isResetToken(token) ? (
        <ResetPasswordForm token={token} />
      ) : (
        <div className="mt-9 space-y-5">
          <p className="rounded-2xl bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900" role="alert">{RESET_LINK_INVALID_MESSAGE}</p>
          <Link href="/esqueci-senha" className={buttonVariants({ className: "w-full" })}>Pedir novo link</Link>
        </div>
      )}
    </AuthCardPage>
  );
}
