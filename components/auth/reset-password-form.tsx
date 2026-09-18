"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { CircleCheck } from "lucide-react";

import { fieldErrorClass, inputClass, labelClass } from "@/components/admin/form-styles";
import { useToast } from "@/components/admin/toast-provider";
import { Button, buttonVariants } from "@/components/ui/button";
import { loginDestination } from "@/lib/admin/roles";
import type { StaffRole } from "@/lib/admin/types";
import { PASSWORD_MIN_LENGTH } from "@/lib/team/invite-rules";

type ResetResponse = { message?: string; code?: string; errors?: Record<string, string>; profile?: { role?: StaffRole } };

export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter();
  const { notify } = useToast();
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [linkInvalid, setLinkInvalid] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setErrors({});
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/password-reset/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, password: form.get("password"), passwordConfirmation: form.get("passwordConfirmation") }),
      });
      const payload = await response.json().catch(() => ({})) as ResetResponse;
      if (!response.ok) {
        if (payload.code === "LINK_INVALID" || payload.code === "NOT_ALLOWED") {
          setLinkInvalid(payload.message ?? "Link inválido.");
          return;
        }
        setErrors(payload.errors ?? { form: payload.message ?? "Não foi possível trocar a senha." });
        return;
      }
      setDone(true);
      if (payload.code === "RESET_LOGIN_FAILED" || !payload.profile?.role) {
        notify({ title: "Senha alterada", description: "Entre com seu e-mail e a nova senha." });
        router.replace("/login");
        return;
      }
      notify({ title: "Senha alterada", description: "Você já está conectado." });
      router.replace(loginDestination(payload.profile.role, null));
      router.refresh();
    } catch {
      setErrors({ form: "Não foi possível conectar. Verifique a internet e tente novamente." });
    } finally {
      setLoading(false);
    }
  };

  if (linkInvalid) {
    return (
      <div className="mt-9 space-y-5">
        <p className="rounded-2xl bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900" role="alert">{linkInvalid}</p>
        <Link href="/esqueci-senha" className={buttonVariants({ className: "w-full" })}>Pedir novo link</Link>
      </div>
    );
  }

  if (done) {
    return (
      <p className="mt-9 flex items-center gap-2 rounded-2xl bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800" role="status">
        <CircleCheck className="size-4" /> Senha alterada. Entrando...
      </p>
    );
  }

  return (
    <form className="mt-9 space-y-5" onSubmit={submit} noValidate>
      <label className="block">
        <span className={labelClass}>Nova senha</span>
        <input name="password" type="password" autoComplete="new-password" className={inputClass} placeholder={`Mínimo de ${PASSWORD_MIN_LENGTH} caracteres, com letras e números`} disabled={loading} required autoFocus />
        {errors.password ? <span className={fieldErrorClass}>{errors.password}</span> : null}
      </label>
      <label className="block">
        <span className={labelClass}>Confirme a nova senha</span>
        <input name="passwordConfirmation" type="password" autoComplete="new-password" className={inputClass} placeholder="Repita a senha" disabled={loading} required />
        {errors.passwordConfirmation ? <span className={fieldErrorClass}>{errors.passwordConfirmation}</span> : null}
      </label>
      {errors.form ? <p className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">{errors.form}</p> : null}
      <Button type="submit" className="w-full" disabled={loading}>{loading ? "Salvando..." : "Salvar nova senha"}</Button>
    </form>
  );
}
