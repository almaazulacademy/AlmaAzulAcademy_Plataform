"use client";

import type { FormEvent } from "react";
import { useState } from "react";
import Link from "next/link";
import { CheckCircle2, Search, XCircle } from "lucide-react";

import { ReservationHold } from "@/components/reservation/reservation-hold";
import { ReservationSummary } from "@/components/reservation/reservation-summary";
import { Button } from "@/components/ui/button";
import type { ReservationDetails } from "@/lib/reservations/types";
import { formatCpf, validateLookupInput } from "@/lib/reservations/validation";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const inputClass = "mt-2 h-12 w-full rounded-2xl border border-ink/15 bg-white px-4 uppercase outline-none transition focus:border-lake focus:ring-2 focus:ring-lake/15";

function FinalReservation({ reservation }: { reservation: ReservationDetails }) {
  const confirmed = reservation.status === "CONFIRMED";
  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_0.72fr] lg:items-start">
      <div className="rounded-4xl bg-white p-7 sm:p-10">
        {confirmed ? <CheckCircle2 className="size-10 text-lake" /> : <XCircle className="size-10 text-ink/35" />}
        <p className="mt-7 text-xs font-semibold uppercase tracking-[0.18em] text-lake">Reserva {reservation.publicCode}</p>
        <h2 className="mt-4 text-4xl font-medium tracking-[-0.05em]">{confirmed ? "Reserva confirmada." : reservation.status === "EXPIRED" ? "Pré-reserva expirada." : "Reserva cancelada."}</h2>
        <p className="mt-5 leading-7 text-ink/60">{confirmed ? `Tudo certo, ${reservation.fullName.split(" ")[0]}. Sua participação está garantida.` : "Esta reserva não bloqueia mais vagas. Você pode escolher uma nova sessão quando quiser."}</p>
        {!confirmed && <Link href={`/${reservation.session.experienceSlug}#reservas`} className="mt-7 inline-flex font-semibold text-forest">Escolher uma nova data</Link>}
      </div>
      <ReservationSummary session={reservation.session} quantity={reservation.quantity} />
    </div>
  );
}

export function ReservationLookup() {
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [reservation, setReservation] = useState<ReservationDetails | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const validation = validateLookupInput({ cpf: form.get("cpf"), publicCode: form.get("publicCode") });
    if (!validation.success) { setErrors(validation.errors); return; }
    setPending(true); setErrors({}); setMessage("");
    try {
      const response = await fetch("/api/reservations/lookup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(validation.data) });
      const payload: unknown = await response.json();
      if (!response.ok || !isRecord(payload) || !isRecord(payload.reservation)) {
        setMessage(isRecord(payload) && typeof payload.message === "string" ? payload.message : "Não foi possível consultar a reserva.");
        if (isRecord(payload) && isRecord(payload.errors)) setErrors(payload.errors as Record<string, string>);
        return;
      }
      setReservation(payload.reservation as ReservationDetails);
    } catch {
      setMessage("Não foi possível conectar ao sistema de reservas.");
    } finally {
      setPending(false);
    }
  }

  if (reservation?.status === "PRE_RESERVED") return <ReservationHold publicCode={reservation.publicCode} expiresAt={reservation.expiresAt} checkoutUrl={reservation.checkoutUrl} title="Sua vaga continua reservada." />;
  if (reservation) return <FinalReservation reservation={reservation} />;

  return (
    <form onSubmit={submit} noValidate className="mx-auto max-w-2xl rounded-4xl border border-ink/10 bg-white p-6 sm:p-10">
      <Search className="size-8 text-lake" />
      <h1 className="mt-6 text-4xl font-medium tracking-[-0.05em] sm:text-5xl">Acompanhar reserva</h1>
      <p className="mt-4 leading-7 text-ink/55">Para sua segurança, informe o CPF usado na reserva e o código recebido. Nenhuma consulta é feita apenas pelo CPF.</p>
      <div className="mt-9 grid gap-5 sm:grid-cols-2">
        <label><span className="text-sm font-semibold">CPF</span><input name="cpf" inputMode="numeric" autoComplete="off" className={inputClass} aria-invalid={Boolean(errors.cpf)} onChange={(event) => { event.currentTarget.value = formatCpf(event.currentTarget.value); }} />{errors.cpf && <span className="mt-1 block text-sm text-red-700">{errors.cpf}</span>}</label>
        <label><span className="text-sm font-semibold">Código da reserva</span><input name="publicCode" autoComplete="off" maxLength={12} className={inputClass} aria-invalid={Boolean(errors.publicCode)} />{errors.publicCode && <span className="mt-1 block text-sm text-red-700">{errors.publicCode}</span>}</label>
      </div>
      {(message || errors.form) && <p role="alert" className="mt-5 rounded-2xl bg-red-50 p-4 text-sm text-red-800">{message || errors.form}</p>}
      <Button type="submit" size="lg" className="mt-7 w-full" disabled={pending}>{pending ? "Consultando..." : "Buscar reserva"}</Button>
    </form>
  );
}
