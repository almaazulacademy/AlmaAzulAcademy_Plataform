"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { LogIn } from "lucide-react";

import { fieldErrorClass, inputClass, labelClass } from "@/components/admin/form-styles";
import { useToast } from "@/components/admin/toast-provider";
import { Button } from "@/components/ui/button";

type ErrorResponse = { message?: string; errors?: Record<string, string> };

export function LoginForm({ destination }: { destination: string }) {
  const router = useRouter();
  const { notify } = useToast();
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setErrors({});
    const form = new FormData(event.currentTarget);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
      });
      const payload = await response.json().catch(() => ({})) as ErrorResponse;
      const diagnosticId = response.headers.get("x-auth-diagnostic-id");
      console.info("[admin-auth]", { stage: "login_response_received", diagnosticId, status: response.status });
      if (!response.ok) {
        setErrors(payload.errors ?? { form: payload.message ?? "Não foi possível entrar." });
        notify({ title: "Acesso não realizado", description: payload.message ?? "Revise os dados informados.", variant: "error" });
        return;
      }
      notify({ title: "Login realizado", description: "Bem-vinda ao painel Alma Azul." });
      console.info("[admin-auth]", { stage: "admin_redirect_started", diagnosticId, destination });
      router.replace(destination);
      router.refresh();
    } catch {
      setErrors({ form: "Não foi possível conectar ao serviço de autenticação." });
      notify({ title: "Falha de conexão", description: "Tente novamente em instantes.", variant: "error" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <form className="mt-9 space-y-5" onSubmit={submit} noValidate>
      <label className="block">
        <span className={labelClass}>Email</span>
        <input name="email" type="email" autoComplete="username" className={inputClass} placeholder="equipe@almaazul.com.br" disabled={loading} required autoFocus />
        {errors.email ? <span className={fieldErrorClass}>{errors.email}</span> : null}
      </label>
      <label className="block">
        <span className={labelClass}>Senha</span>
        <input name="password" type="password" autoComplete="current-password" className={inputClass} placeholder="Sua senha" disabled={loading} required />
        {errors.password ? <span className={fieldErrorClass}>{errors.password}</span> : null}
      </label>
      {errors.form ? <p className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">{errors.form}</p> : null}
      <Button type="submit" className="w-full" disabled={loading}>
        <LogIn className="size-4" /> {loading ? "Entrando..." : "Entrar no painel"}
      </Button>
    </form>
  );
}
