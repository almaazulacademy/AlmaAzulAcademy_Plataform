"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { CircleCheck } from "lucide-react";

import { fieldErrorClass, inputClass, labelClass } from "@/components/admin/form-styles";
import { useToast } from "@/components/admin/toast-provider";
import { Button } from "@/components/ui/button";
import { PASSWORD_MIN_LENGTH } from "@/lib/team/invite-rules";

type SignupResponse = { message?: string; code?: string; errors?: Record<string, string>; registered?: boolean };

export function InstructorSignupForm({ token }: { token: string }) {
  const router = useRouter();
  const { notify } = useToast();
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setLoading(true);
    setErrors({});
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/instrutor/cadastro", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          token,
          name: form.get("name"),
          email: form.get("email"),
          password: form.get("password"),
          passwordConfirmation: form.get("passwordConfirmation"),
        }),
      });
      const payload = await response.json().catch(() => ({})) as SignupResponse;
      if (!response.ok) {
        setErrors(payload.errors ?? { form: payload.message ?? "Não foi possível concluir o cadastro." });
        if (payload.code?.startsWith("INVITE_")) router.refresh();
        return;
      }
      setDone(true);
      if (payload.code === "REGISTERED_LOGIN_FAILED") {
        notify({ title: "Conta criada", description: "Entre com seu e-mail e senha." });
        router.replace("/login?next=/instrutor");
        return;
      }
      notify({ title: "Cadastro concluído", description: "Bem-vindo à Lista de Presença." });
      router.replace("/instrutor");
      router.refresh();
    } catch {
      setErrors({ form: "Não foi possível conectar. Verifique a internet e tente novamente." });
    } finally {
      setLoading(false);
    }
  };

  if (done) {
    return (
      <p className="mt-9 flex items-center gap-2 rounded-2xl bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-800" role="status">
        <CircleCheck className="size-4" /> Cadastro concluído. Abrindo a Lista de Presença...
      </p>
    );
  }

  return (
    <form className="mt-9 space-y-5" onSubmit={submit} noValidate>
      <label className="block">
        <span className={labelClass}>Seu nome</span>
        <input name="name" autoComplete="name" className={inputClass} placeholder="Como a equipe te chama" disabled={loading} required autoFocus maxLength={80} />
        {errors.name ? <span className={fieldErrorClass}>{errors.name}</span> : null}
      </label>
      <label className="block">
        <span className={labelClass}>E-mail</span>
        <input name="email" type="email" autoComplete="username" className={inputClass} placeholder="voce@exemplo.com" disabled={loading} required />
        {errors.email ? <span className={fieldErrorClass}>{errors.email}</span> : null}
      </label>
      <label className="block">
        <span className={labelClass}>Senha</span>
        <input name="password" type="password" autoComplete="new-password" className={inputClass} placeholder={`Mínimo de ${PASSWORD_MIN_LENGTH} caracteres, com letras e números`} disabled={loading} required minLength={PASSWORD_MIN_LENGTH} />
        {errors.password ? <span className={fieldErrorClass}>{errors.password}</span> : null}
      </label>
      <label className="block">
        <span className={labelClass}>Confirme a senha</span>
        <input name="passwordConfirmation" type="password" autoComplete="new-password" className={inputClass} placeholder="Repita a senha" disabled={loading} required />
        {errors.passwordConfirmation ? <span className={fieldErrorClass}>{errors.passwordConfirmation}</span> : null}
      </label>
      {errors.form ? <p className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-800" role="alert">{errors.form}</p> : null}
      <Button type="submit" className="w-full" disabled={loading}>{loading ? "Criando conta..." : "Criar conta"}</Button>
    </form>
  );
}
