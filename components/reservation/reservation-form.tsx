"use client";

import type { FormEvent } from "react";
import { useState } from "react";

import { ReservationHold } from "@/components/reservation/reservation-hold";
import { ReservationSummary } from "@/components/reservation/reservation-summary";
import { Button } from "@/components/ui/button";
import type { BookingSession } from "@/lib/reservations/types";
import { formatCpf, formatPhone, validateReservationInput } from "@/lib/reservations/validation";

type CreatedReservation = { publicCode: string; expiresAt: string; checkoutUrl: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const inputClass = "mt-2 h-12 w-full rounded-2xl border border-ink/15 bg-white px-4 outline-none transition focus:border-lake focus:ring-2 focus:ring-lake/15";

export function ReservationForm({ session }: { session: BookingSession }) {
  const [quantity, setQuantity] = useState(1);
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [created, setCreated] = useState<CreatedReservation | null>(null);
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const input = {
      sessionId: session.id,
      fullName: form.get("fullName"),
      cpf: form.get("cpf"),
      phone: form.get("phone"),
      email: form.get("email"),
      quantity,
      notes: form.get("notes"),
      idempotencyKey,
    };
    const validation = validateReservationInput(input);
    if (!validation.success) { setErrors(validation.errors); return; }

    setPending(true);
    setErrors({});
    setMessage("");
    try {
      const response = await fetch("/api/reservations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(validation.data) });
      const payload: unknown = await response.json();
      if (!response.ok || !isRecord(payload)) {
        const apiErrors = isRecord(payload) && isRecord(payload.errors) ? payload.errors as Record<string, string> : {};
        setErrors(apiErrors);
        setMessage(isRecord(payload) && typeof payload.message === "string" ? payload.message : "Não foi possível reservar agora.");
        return;
      }
      if (typeof payload.publicCode !== "string" || typeof payload.expiresAt !== "string" || typeof payload.checkoutUrl !== "string") throw new Error("Resposta inválida.");
      setCreated({ publicCode: payload.publicCode, expiresAt: payload.expiresAt, checkoutUrl: payload.checkoutUrl });
    } catch {
      setMessage("Não foi possível conectar ao sistema de reservas. Tente novamente.");
    } finally {
      setPending(false);
    }
  }

  if (created) return <ReservationHold {...created} />;

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_0.72fr] lg:items-start lg:gap-12">
      <form onSubmit={submit} noValidate className="rounded-4xl border border-ink/10 bg-white p-6 sm:p-10">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-lake">Seus dados</p>
        <h1 className="mt-5 text-4xl font-medium tracking-[-0.05em] sm:text-5xl">Reservar vaga</h1>
        <p className="mt-4 leading-7 text-ink/55">Ao continuar, suas vagas ficam bloqueadas por exatamente 2 horas enquanto você realiza o pagamento.</p>
        <div className="mt-9 grid gap-5 sm:grid-cols-2">
          <label className="sm:col-span-2"><span className="text-sm font-semibold">Nome completo</span><input name="fullName" autoComplete="name" className={inputClass} aria-invalid={Boolean(errors.fullName)} />{errors.fullName && <span className="mt-1 block text-sm text-red-700">{errors.fullName}</span>}</label>
          <label><span className="text-sm font-semibold">CPF</span><input name="cpf" inputMode="numeric" autoComplete="off" className={inputClass} onChange={(event) => { event.currentTarget.value = formatCpf(event.currentTarget.value); }} aria-invalid={Boolean(errors.cpf)} />{errors.cpf && <span className="mt-1 block text-sm text-red-700">{errors.cpf}</span>}</label>
          <label><span className="text-sm font-semibold">Telefone (WhatsApp)</span><input name="phone" inputMode="tel" autoComplete="tel" className={inputClass} onChange={(event) => { event.currentTarget.value = formatPhone(event.currentTarget.value); }} aria-invalid={Boolean(errors.phone)} />{errors.phone && <span className="mt-1 block text-sm text-red-700">{errors.phone}</span>}</label>
          <label className="sm:col-span-2"><span className="text-sm font-semibold">Email</span><input name="email" type="email" autoComplete="email" className={inputClass} aria-invalid={Boolean(errors.email)} />{errors.email && <span className="mt-1 block text-sm text-red-700">{errors.email}</span>}</label>
          <label><span className="text-sm font-semibold">Quantidade de pessoas</span><select name="quantity" value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} className={inputClass}>{Array.from({ length: Math.min(session.remainingSpots, 20) }, (_, index) => index + 1).map((value) => <option key={value} value={value}>{value}</option>)}</select>{errors.quantity && <span className="mt-1 block text-sm text-red-700">{errors.quantity}</span>}</label>
          <label className="sm:col-span-2"><span className="text-sm font-semibold">Observações <span className="font-normal text-ink/40">(opcional)</span></span><textarea name="notes" rows={4} maxLength={500} className="mt-2 w-full resize-none rounded-2xl border border-ink/15 bg-white p-4 outline-none transition focus:border-lake focus:ring-2 focus:ring-lake/15" />{errors.notes && <span className="mt-1 block text-sm text-red-700">{errors.notes}</span>}</label>
        </div>
        {(message || errors.form) && <p role="alert" className="mt-5 rounded-2xl bg-red-50 p-4 text-sm text-red-800">{message || errors.form}</p>}
        <Button type="submit" size="lg" className="mt-7 w-full" disabled={pending}>{pending ? "Bloqueando suas vagas..." : "Reservar vaga"}</Button>
        <p className="mt-4 text-center text-xs leading-5 text-ink/40">A reserva só será confirmada após a aprovação do pagamento.</p>
      </form>
      <ReservationSummary session={session} quantity={quantity} />
    </div>
  );
}
