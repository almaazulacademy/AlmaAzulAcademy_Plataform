"use client";

/**
 * Inscrição gratuita na lista de espera de uma turma esgotada.
 *
 * Valida no navegador para ajudar quem digita, e o servidor valida de novo; quem
 * decide é o banco. O campo `website` é uma isca invisível para pessoas: robô
 * que o preenche recebe "sucesso" e nada é gravado. A resposta de sucesso é a
 * mesma para quem já estava na lista — a tela não revela inscrições alheias.
 */

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { BellRing, Check, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { formatPhone } from "@/lib/reservations/validation";
import { validateWaitlistSignup } from "@/lib/waitlist/signup";

const inputClass = "mt-2 h-12 w-full rounded-2xl border border-ink/15 bg-white px-4 outline-none transition focus:border-lake focus:ring-2 focus:ring-lake/15";

const QUANTITIES = Array.from({ length: 20 }, (_, index) => index + 1);

type Done = { message: string };
type Refusal = { message: string; reserveHref?: string };

/** Lista de espera de um evento especial: textos de evento e o máximo por pedido. */
export type WaitlistEventForm = { slug: string; title: string; maxPerOrder: number };

export function WaitlistSignupForm({ sessionId, experienceSlug, event }: { sessionId: string; experienceSlug: string; event?: WaitlistEventForm }) {
  const quantities = event ? QUANTITIES.slice(0, Math.max(1, Math.min(event.maxPerOrder, 20))) : QUANTITIES;
  const [quantity, setQuantity] = useState(1);
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [refusal, setRefusal] = useState<Refusal | null>(null);
  const [done, setDone] = useState<Done | null>(null);

  async function submit(formEvent: FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    const form = new FormData(formEvent.currentTarget);
    const input = {
      sessionId,
      fullName: form.get("fullName"),
      email: form.get("email"),
      phone: form.get("phone"),
      quantity,
      website: form.get("website"),
    };
    const validation = validateWaitlistSignup(input);
    if (!validation.success) { setErrors(validation.errors); setRefusal(null); return; }
    if (event && quantity > event.maxPerOrder) { setErrors({ quantity: `Cada pedido deste evento aceita até ${event.maxPerOrder} participantes.` }); setRefusal(null); return; }

    setPending(true);
    setErrors({});
    setRefusal(null);
    try {
      const response = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
        cache: "no-store",
      });
      const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      const message = typeof payload.message === "string" ? payload.message : "Não foi possível concluir agora. Tente novamente.";
      if (response.ok && payload.status === "ACCEPTED") { setDone({ message }); return; }
      if (payload.errors && typeof payload.errors === "object") setErrors(payload.errors as Record<string, string>);
      setRefusal({ message, reserveHref: typeof payload.reserveHref === "string" ? payload.reserveHref : undefined });
    } catch {
      setRefusal({ message: "Não foi possível conectar. Verifique sua internet e tente novamente." });
    } finally {
      setPending(false);
    }
  }

  if (done && event) {
    return (
      <div role="status" className="rounded-4xl border border-ink/10 bg-white p-7 sm:p-10">
        <span className="grid size-12 place-items-center rounded-2xl bg-mist text-lake"><Check aria-hidden="true" className="size-6" /></span>
        <h2 className="mt-6 text-3xl font-medium tracking-[-0.05em] sm:text-4xl">Você está na lista de espera</h2>
        <p className="mt-4 leading-7 text-ink/65">{done.message}</p>
        <p className="mt-4 leading-7 text-ink/65">Isto não é um ingresso e não há cobrança. Se surgir uma vaga no {event.title}, avisamos por e-mail — e ela fica com quem concluir a compra primeiro.</p>
        <Link href={`/eventos/${event.slug}`} className="mt-7 inline-flex font-semibold text-forest">Voltar para o evento</Link>
      </div>
    );
  }

  if (done) {
    return (
      <div role="status" className="rounded-4xl border border-ink/10 bg-white p-7 sm:p-10">
        <span className="grid size-12 place-items-center rounded-2xl bg-mist text-lake"><Check aria-hidden="true" className="size-6" /></span>
        <h2 className="mt-6 text-3xl font-medium tracking-[-0.05em] sm:text-4xl">Você está na lista de espera</h2>
        <p className="mt-4 leading-7 text-ink/65">{done.message}</p>
        <p className="mt-4 leading-7 text-ink/65">Isto não é uma reserva e não há cobrança. Se abrir uma vaga, avisamos por e-mail — e ela fica com quem concluir a reserva primeiro.</p>
        <div className="mt-7 flex flex-col gap-4 sm:flex-row">
          <Link href={`/experiencias/${experienceSlug}#reservas`} className="inline-flex font-semibold text-forest">Ver outras turmas</Link>
          <Link href="/agenda" className="inline-flex font-semibold text-forest">Ver a agenda</Link>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="rounded-4xl border border-ink/10 bg-white p-6 sm:p-10">
      <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.2em] text-lake"><BellRing aria-hidden="true" className="size-4" />Lista de espera gratuita</p>
      <h1 className="mt-5 text-4xl font-medium tracking-[-0.05em] sm:text-5xl">Entrar na lista de espera</h1>
      {event ? (
        <p className="mt-4 leading-7 text-ink/60">
          Sem pagamento e sem ingresso. Se surgir uma vaga no {event.title}, você recebe um aviso por e-mail. A vaga continua aberta no site para todos e fica com quem concluir a compra primeiro.
        </p>
      ) : (
        <p className="mt-4 leading-7 text-ink/60">
          Sem pagamento e sem reserva. Se abrir uma vaga nesta turma, você recebe um aviso por e-mail. A vaga continua aberta no site para todos e fica com quem concluir a reserva primeiro.
        </p>
      )}

      <div className="mt-9 grid gap-5 sm:grid-cols-2">
        <label className="sm:col-span-2"><span className="text-sm font-semibold">Nome completo</span><input name="fullName" autoComplete="name" maxLength={120} className={inputClass} aria-invalid={Boolean(errors.fullName)} />{errors.fullName && <span className="mt-1 block text-sm text-red-700">{errors.fullName}</span>}</label>
        <label><span className="text-sm font-semibold">WhatsApp</span><input name="phone" inputMode="tel" autoComplete="tel" className={inputClass} onChange={(event) => { event.currentTarget.value = formatPhone(event.currentTarget.value); }} aria-invalid={Boolean(errors.phone)} />{errors.phone && <span className="mt-1 block text-sm text-red-700">{errors.phone}</span>}</label>
        <label><span className="text-sm font-semibold">{event ? "Participantes" : "Quantidade de pessoas"}</span><select name="quantity" value={quantity} onChange={(change) => setQuantity(Number(change.target.value))} className={inputClass} aria-invalid={Boolean(errors.quantity)}>{quantities.map((value) => <option key={value} value={value}>{value}</option>)}</select>{event ? <span className="mt-1 block text-xs text-ink/50">Até {event.maxPerOrder} por pedido.</span> : null}{errors.quantity && <span className="mt-1 block text-sm text-red-700">{errors.quantity}</span>}</label>
        <label className="sm:col-span-2"><span className="text-sm font-semibold">E-mail</span><input name="email" type="email" autoComplete="email" maxLength={254} className={inputClass} aria-invalid={Boolean(errors.email)} />{errors.email && <span className="mt-1 block text-sm text-red-700">{errors.email}</span>}</label>
        {/* Isca para robôs: fora da tela, fora do teclado e fora do preenchimento automático. */}
        <div aria-hidden="true" className="absolute -left-[9999px] h-px w-px overflow-hidden">
          <label>Site<input name="website" type="text" tabIndex={-1} autoComplete="off" defaultValue="" /></label>
        </div>
      </div>

      {(refusal || errors.form) && (
        <div role="alert" className="mt-5 rounded-2xl bg-red-50 p-4 text-sm text-red-800">
          <p>{errors.form || refusal?.message}</p>
          {refusal?.reserveHref ? <Link href={refusal.reserveHref} className="mt-2 inline-flex font-semibold text-forest">{event ? "Garantir meu ingresso" : "Reservar agora"}</Link> : null}
        </div>
      )}

      <Button type="submit" size="lg" className="mt-7 w-full" disabled={pending}>
        {pending ? <><Loader2 aria-hidden="true" className="size-4 animate-spin" />Enviando...</> : "Entrar na lista de espera"}
      </Button>
      <p className="mt-4 text-center text-xs leading-5 text-ink/45">Você recebe a confirmação por e-mail, com um link para sair da lista quando quiser. Usamos seus dados só para esta lista e os apagamos 90 dias depois {event ? "do evento" : "da turma"}.</p>
    </form>
  );
}
