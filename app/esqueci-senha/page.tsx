import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { KeyRound } from "lucide-react";

import { AuthCardPage } from "@/components/auth/auth-card-page";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";
import { getStaffContext } from "@/lib/admin/auth";
import { homeForRole } from "@/lib/admin/roles";

export const metadata: Metadata = {
  title: "Esqueci minha senha",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function ForgotPasswordPage() {
  const existing = await getStaffContext().catch(() => null);
  if (existing) redirect(homeForRole(existing.profile.role));
  return (
    <AuthCardPage
      icon={KeyRound}
      eyebrow="Acesso da equipe"
      title="Esqueceu a senha?"
      description="Informe o e-mail da sua conta. Se ele for de alguém da equipe Alma Azul, enviamos um link para você criar uma nova senha."
    >
      <ForgotPasswordForm />
    </AuthCardPage>
  );
}
