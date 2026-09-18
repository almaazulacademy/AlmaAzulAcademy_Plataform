"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { MailCheck } from "lucide-react";

import { fieldErrorClass, inputClass, labelClass } from "@/components/admin/form-styles";
import { Button, buttonVariants } from "@/components/ui/button";

export function ForgotPasswordForm() {
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setErrors({});
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/password-reset", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: form.get("email") }),
      });
      const payload = await response.json().catch(() => ({})) as { message?: string; errors?: Record<string, string> };
      if (!response.ok) {
        setErrors(payload.errors ?? { form: payload.message ?? "Não foi possível enviar agora." });
        return;
      }
      setSent(payload.message ?? "Pedido recebido.");
    } catch {
      setErrors({ form: "Não foi possível conectar. Verifique a internet e tente novamente." });
    } finally {
      setLoading(false);
    }
  };

  if (sent) {
    return (
      <div className="mt-9 space-y-5">
        <p className="flex gap-3 rounded-2xl bg-emerald-50 px-4 py-3 text-sm leading-6 text-emerald-900" role="status">
          <MailCheck className="mt-0.5 size-4 shrink-0" /> {sent}
        </p>
        <Link href="/login" className={buttonVariants({ variant: "outline", className: "w-full" })}>Voltar ao login</Link>
      </div>
    );
  }

  return (
    <form className="mt-9 space-y-5" onSubmit={submit} noValidate>
      <label className="block">
        <span className={labelClass}>E-mail da sua conta</span>
        <input name="email" type="email" autoComplete="username" className={inputClass} placeholder="voce@exemplo.com" disabled={loading} required autoFocus />
        {errors.email ? <span className={fieldErrorClass}>{errors.email}</span> : null}
      </label>
      {errors.form ? <p className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">{errors.form}</p> : null}
      <Button type="submit" className="w-full" disabled={loading}>{loading ? "Enviando..." : "Enviar link"}</Button>
      <Link href="/login" className={buttonVariants({ variant: "ghost", className: "w-full" })}>Voltar ao login</Link>
    </form>
  );
}
