"use client";

import Link from "next/link";
import type { FormEvent } from "react";
import { useState } from "react";

import { ReservationHold } from "@/components/reservation/reservation-hold";
import { ReservationSummary } from "@/components/reservation/reservation-summary";
import { Button } from "@/components/ui/button";
import { WaitlistJoinLink } from "@/components/waitlist/join-link";
import { SoldOutNotice } from "@/components/waitlist/sold-out-notice";
import { eventQuantityLimit, type EventBookingContext } from "@/lib/events/booking";
import type { BookingSession } from "@/lib/reservations/types";
import { formatCpf, formatPhone, validateReservationInput } from "@/lib/reservations/validation";
import { fewerSpotsMessage, reservationQuantityOptions, resolveReservationConflict, SOLD_OUT_WHILE_FILLING } from "@/lib/waitlist/public";

type CreatedReservation = { publicCode: string; expiresAt: string; checkoutUrl: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const inputClass = "mt-2 h-12 w-full rounded-2xl border border-ink/15 bg-white px-4 outline-none transition focus:border-lake focus:ring-2 focus:ring-lake/15";

/**
 * `waitlistEnabled` vem do servidor (`WAITLIST_PUBLIC_ENABLED`). Desligado, uma
 * recusa por falta de vaga mostra só a mensagem da API, como sempre foi.
 * Ligado, a tela acompanha a disponibilidade real devolvida na recusa: esgotou,
 * o formulário dá lugar ao aviso; sobrou menos, a quantidade é reduzida.
 *
 * `event` (evento especial) troca os textos de turma por ingresso, limita a
 * quantidade ao máximo por pedido do evento e mostra a política de
 * cancelamento antes do pagamento. Sem ele, o formulário é o de sempre.
 */
export function ReservationForm({ session, waitlistEnabled = false, waitlistSignup = false, event }: { session: BookingSession; waitlistEnabled?: boolean; waitlistSignup?: boolean; event?: EventBookingContext }) {
  const [spots, setSpots] = useState(session.remainingSpots);
  const [soldOut, setSoldOut] = useState(false);
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
        const conflict = response.status === 409 ? resolveReservationConflict(payload, waitlistEnabled) : { kind: "MESSAGE" as const };
        if (conflict.kind === "SOLD_OUT") {
          setSoldOut(true);
          return;
        }
        if (conflict.kind === "FEWER") {
          setSpots(conflict.remainingSpots);
          setQuantity((current) => Math.min(current, conflict.remainingSpots));
          setMessage(fewerSpotsMessage(conflict.remainingSpots));
          return;
        }
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

  if (created) return <ReservationHold {...created} event={event ? { slug: event.slug, title: event.title } : undefined} />;

  // Nunca um formulário sem vaga: nem quando a página chegou assim, nem quando
  // a turma esgotou entre a página e o envio.
  const quantityOptions = reservationQuantityOptions(spots);
  // Evento: até as vagas restantes e até o máximo por pedido do evento.
  const eventOptions = event ? reservationQuantityOptions(eventQuantityLimit(spots, event.maxPerOrder)) : null;
  const options = eventOptions ?? quantityOptions;
  if (event && (soldOut || options.length === 0)) {
    return (
      <div className="rounded-4xl bg-white p-10 text-center sm:p-16" role="status">
        <h1 className="text-4xl font-medium tracking-[-0.05em]">Evento esgotado</h1>
        <p className="mx-auto mt-4 max-w-lg leading-7 text-ink/55">Todas as vagas desta edição foram preenchidas.</p>
        <Link href={`/eventos/${event.slug}`} className="mt-7 inline-flex font-semibold text-forest">Voltar ao evento</Link>
      </div>
    );
  }
  if (soldOut || quantityOptions.length === 0) {
    return (
      <div className="rounded-4xl bg-white p-10 text-center sm:p-16">
        <h1 className="text-4xl font-medium tracking-[-0.05em]">{waitlistEnabled ? "Esgotado" : "Sessão indisponível"}</h1>
        {waitlistEnabled
          ? <SoldOutNotice className="mx-auto mt-5 max-w-lg items-center text-center" note={SOLD_OUT_WHILE_FILLING} action={waitlistSignup ? <WaitlistJoinLink sessionId={session.id} className="mt-2" /> : undefined} />
          : <p className="mx-auto mt-4 max-w-lg leading-7 text-ink/55">A data pode ter esgotado ou não estar mais aberta. Confira as próximas sessões disponíveis.</p>}
        <Link href="/agenda" className="mt-7 inline-flex font-semibold text-forest">Ver próximas datas</Link>
      </div>
    );
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_0.72fr] lg:items-start lg:gap-12">
      <form onSubmit={submit} noValidate className="rounded-4xl border border-ink/10 bg-white p-6 sm:p-10">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-lake">Seus dados</p>
        <h1 className="mt-5 text-4xl font-medium tracking-[-0.05em] sm:text-5xl">{event ? "Garantir meu ingresso" : "Reservar vaga"}</h1>
        <p className="mt-4 leading-7 text-ink/55">
          {event
            ? "Ingresso único com toda a programação. Ao continuar, os ingressos ficam bloqueados por exatamente 2 horas enquanto você realiza o pagamento."
            : "Ao continuar, suas vagas ficam bloqueadas por exatamente 2 horas enquanto você realiza o pagamento."}
        </p>
        <div className="mt-9 grid gap-5 sm:grid-cols-2">
          <label className="sm:col-span-2"><span className="text-sm font-semibold">Nome completo</span><input name="fullName" autoComplete="name" className={inputClass} aria-invalid={Boolean(errors.fullName)} />{errors.fullName && <span className="mt-1 block text-sm text-red-700">{errors.fullName}</span>}</label>
          <label><span className="text-sm font-semibold">CPF</span><input name="cpf" inputMode="numeric" autoComplete="off" className={inputClass} onChange={(event) => { event.currentTarget.value = formatCpf(event.currentTarget.value); }} aria-invalid={Boolean(errors.cpf)} />{errors.cpf && <span className="mt-1 block text-sm text-red-700">{errors.cpf}</span>}</label>
          <label><span className="text-sm font-semibold">Telefone (WhatsApp)</span><input name="phone" inputMode="tel" autoComplete="tel" className={inputClass} onChange={(event) => { event.currentTarget.value = formatPhone(event.currentTarget.value); }} aria-invalid={Boolean(errors.phone)} />{errors.phone && <span className="mt-1 block text-sm text-red-700">{errors.phone}</span>}</label>
          <label className="sm:col-span-2"><span className="text-sm font-semibold">Email</span><input name="email" type="email" autoComplete="email" className={inputClass} aria-invalid={Boolean(errors.email)} />{errors.email && <span className="mt-1 block text-sm text-red-700">{errors.email}</span>}</label>
          <label><span className="text-sm font-semibold">{event ? "Participantes" : "Quantidade de pessoas"}</span><select name="quantity" value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} className={inputClass}>{options.map((value) => <option key={value} value={value}>{value}</option>)}</select>{event ? <span className="mt-1 block text-xs text-ink/45">Até {event.maxPerOrder} por pedido.</span> : null}{errors.quantity && <span className="mt-1 block text-sm text-red-700">{errors.quantity}</span>}</label>
          <label className="sm:col-span-2"><span className="text-sm font-semibold">Observações <span className="font-normal text-ink/40">(opcional)</span></span><textarea name="notes" rows={4} maxLength={500} className="mt-2 w-full resize-none rounded-2xl border border-ink/15 bg-white p-4 outline-none transition focus:border-lake focus:ring-2 focus:ring-lake/15" />{errors.notes && <span className="mt-1 block text-sm text-red-700">{errors.notes}</span>}</label>
        </div>
        {event && event.cancellationParagraphs.length ? (
          <section aria-labelledby="politica-cancelamento" className="mt-8 rounded-3xl border border-ink/10 bg-paper p-5 sm:p-6">
            <h2 id="politica-cancelamento" className="text-sm font-semibold uppercase tracking-[0.14em] text-forest">Política de cancelamento</h2>
            <div className="mt-3 space-y-3 text-sm leading-6 text-ink/70">
              {event.cancellationParagraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
            </div>
          </section>
        ) : null}
        {(message || errors.form) && <p role="alert" className="mt-5 rounded-2xl bg-red-50 p-4 text-sm text-red-800">{message || errors.form}</p>}
        <Button type="submit" size="lg" className="mt-7 w-full" disabled={pending}>{pending ? (event ? "Bloqueando seus ingressos..." : "Bloqueando suas vagas...") : (event ? "Garantir meu ingresso" : "Reservar vaga")}</Button>
        <p className="mt-4 text-center text-xs leading-5 text-ink/40">A reserva só será confirmada após a aprovação do pagamento.</p>
      </form>
      <ReservationSummary session={{ ...session, remainingSpots: spots }} quantity={quantity} event={event} />
    </div>
  );
}
