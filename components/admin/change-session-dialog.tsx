"use client";

/**
 * "Alterar turma": move uma reserva confirmada para outra sessão.
 *
 * Duas etapas dentro do mesmo modal, na ordem em que a decisão acontece de
 * verdade: primeiro **escolher** a turma, depois **confirmar** a mudança. A
 * segunda tela repete de onde para onde a reserva vai, quantas pessoas vão
 * junto, e diz explicitamente que a reserva continua confirmada e o pagamento
 * não muda — porque é exatamente isso que o admin precisa ter certeza antes de
 * mexer em uma reserva já paga.
 *
 * As turmas são lidas quando o modal abre, nunca junto com a listagem: vagas
 * restantes mudam a cada confirmação, e o número que importa é o do instante da
 * decisão. Mesmo assim, esta tela não é a autoridade — quem recusa uma turma
 * lotada é a RPC, com as duas sessões travadas.
 *
 * O agrupamento por dia vem de `lib/sessions/choice.ts`, o mesmo módulo que o
 * site público usa. É o que deixa as três turmas da Imersão Paranoá do mesmo
 * sábado — 09:00, 12:00 e 15:00 — distinguíveis de bater o olho, em vez de três
 * linhas quase idênticas.
 */

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ArrowRight, CalendarClock, Check, Users, X } from "lucide-react";

import { fieldErrorClass, labelClass, textareaClass } from "@/components/admin/form-styles";
import { StatusBadge } from "@/components/admin/status-badge";
import { useToast } from "@/components/admin/toast-provider";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/admin/format";
import {
  evaluateOption,
  sessionChangeMessage,
  type ReservationSessionOptions,
  type SessionChangeCurrent,
  type SessionChangeOption,
} from "@/lib/admin/session-change";
import { groupSessionsByDay } from "@/lib/sessions/choice";
import { formatSessionDateShort, formatSessionTime } from "@/lib/sessions/date-time";

type Step = "select" | "confirm";
type ApiPayload = { message?: string; errors?: Record<string, string> };

/** `29/08/2026 · 09:00` — o formato que o pedido operacional usa. */
function turmaLabel(startsAt: string) {
  return `${formatSessionDateShort(startsAt)} · ${formatSessionTime(startsAt)}`;
}

function participantsLabel(quantity: number) {
  return `${quantity} ${quantity === 1 ? "participante" : "participantes"}`;
}

function spotsLabel(option: SessionChangeOption) {
  const remaining = Math.max(0, option.remainingSpots);
  return `${remaining} ${remaining === 1 ? "vaga restante" : "vagas restantes"} de ${option.capacity}`;
}

function CurrentTurma({ current, quantity, totalCents }: {
  current: SessionChangeCurrent;
  quantity: number;
  totalCents: number;
}) {
  return (
    <div className="rounded-2xl border border-ink/10 bg-mist/50 p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-ink/45">Turma atual</p>
      <p className="mt-2 text-lg font-semibold tracking-[-0.02em] text-ink">{turmaLabel(current.startsAt)}</p>
      <p className="mt-1 text-sm text-ink/60">{current.experienceTitle}</p>
      <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-ink/60">
        <span className="inline-flex items-center gap-1.5"><Users className="size-4 text-lake" /> {participantsLabel(quantity)}</span>
        <span aria-hidden>·</span>
        <span>{formatCurrency(totalCents)} pagos</span>
      </p>
    </div>
  );
}

export function ChangeSessionDialog({ open, reservationId, onClose }: {
  open: boolean;
  reservationId: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const { notify } = useToast();
  const [step, setStep] = useState<Step>("select");
  const [data, setData] = useState<ReservationSessionOptions | null>(null);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const reset = useCallback(() => {
    setStep("select");
    setData(null);
    setSelectedId("");
    setReason("");
    setError("");
    setLoadError("");
    setSaving(false);
  }, []);

  // As turmas são buscadas na abertura, com as vagas do momento da decisão.
  useEffect(() => {
    if (!open) {
      reset();
      return;
    }
    let active = true;
    setLoadingOptions(true);
    setLoadError("");
    fetch(`/api/admin/reservations/${reservationId}/session-options`, { headers: { accept: "application/json" } })
      .then(async (response) => {
        const payload = await response.json().catch(() => null) as ReservationSessionOptions & ApiPayload | null;
        if (!active) return;
        if (!response.ok || !payload || !("current" in payload)) {
          setLoadError(payload?.message ?? "Não foi possível carregar as turmas disponíveis.");
          return;
        }
        setData(payload);
      })
      .catch(() => {
        if (active) setLoadError("Não foi possível carregar as turmas disponíveis.");
      })
      .finally(() => {
        if (active) setLoadingOptions(false);
      });
    return () => { active = false; };
  }, [open, reservationId, reset]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose, open, saving]);

  if (!open) return null;

  const now = new Date();
  const selected = data?.options.find((option) => option.sessionId === selectedId) ?? null;
  const days = data
    ? groupSessionsByDay(data.options.map((option) => ({ ...option, id: option.sessionId })))
    : [];

  const submit = async () => {
    if (!data || !selected) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/reservations/${reservationId}/change-session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetSessionId: selected.sessionId, reason }),
      });
      const payload = await response.json().catch(() => ({})) as ApiPayload;
      if (!response.ok) {
        throw new Error(payload.message ?? payload.errors?.targetSessionId ?? "Não foi possível alterar a turma.");
      }
      notify({
        title: "Turma alterada",
        description: `A reserva passou para ${turmaLabel(selected.startsAt)}. A reserva continua confirmada e o pagamento não foi alterado.`,
      });
      onClose();
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Não foi possível alterar a turma.");
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[90] grid place-items-center bg-ink/55 p-4 backdrop-blur-sm"
      role="presentation"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && !saving) onClose();
      }}
    >
      <div
        className="max-h-[calc(100dvh-2rem)] w-full max-w-2xl overflow-y-auto rounded-3xl bg-white p-6 shadow-soft sm:p-8"
        role="dialog"
        aria-modal="true"
        aria-labelledby="change-session-title"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="grid size-11 place-items-center rounded-2xl bg-lake/10 text-lake">
            <CalendarClock className="size-5" />
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="grid size-9 place-items-center rounded-full text-ink/50 hover:bg-ink/5"
            aria-label="Fechar alteração de turma"
          >
            <X className="size-5" />
          </button>
        </div>

        <h2 id="change-session-title" className="mt-6 text-2xl font-semibold tracking-[-0.03em] text-ink">
          {step === "select" ? "Alterar turma" : "Confirmar alteração de turma?"}
        </h2>

        {loadingOptions ? <p className="mt-4 text-sm text-ink/50">Carregando turmas…</p> : null}
        {loadError ? <p className="mt-4 text-sm text-red-700" role="alert">{loadError}</p> : null}

        {data && data.current ? (
          <>
            {step === "select" ? (
              <div className="mt-5 space-y-5">
                <CurrentTurma current={data.current} quantity={data.quantity} totalCents={data.totalCents} />

                {data.status !== "CONFIRMED" ? (
                  <p className="rounded-2xl bg-red-50 p-4 text-sm text-red-800" role="alert">
                    {sessionChangeMessage("RESERVATION_NOT_CONFIRMED")}
                  </p>
                ) : null}

                <fieldset>
                  <legend className="text-xs font-semibold uppercase tracking-[0.12em] text-ink/45">
                    Nova turma
                  </legend>
                  {days.length === 0 ? (
                    <p className="mt-3 text-sm text-ink/50">
                      Nenhuma outra turma futura e aberta desta experiência está disponível.
                    </p>
                  ) : (
                    <div className="mt-3 space-y-5">
                      {days.map((day) => (
                        <div key={day.dayKey}>
                          <p className="text-sm font-semibold capitalize text-ink">
                            {day.weekday}, {day.dayMonth}
                          </p>
                          <div className="mt-2 grid gap-2 sm:grid-cols-2">
                            {day.turmas.map(({ session }) => {
                              const verdict = evaluateOption(data, session, now);
                              const disabled = !verdict.allowed;
                              const active = selectedId === session.sessionId;
                              return (
                                <label
                                  key={session.sessionId}
                                  className={`flex cursor-pointer items-start gap-3 rounded-2xl border p-4 transition ${
                                    disabled
                                      ? "cursor-not-allowed border-ink/10 bg-mist/40 opacity-60"
                                      : active
                                        ? "border-lake bg-lake/5 ring-2 ring-lake/20"
                                        : "border-ink/15 hover:border-lake/60"
                                  }`}
                                >
                                  <input
                                    type="radio"
                                    name="target-session"
                                    className="mt-1.5 size-4 accent-lake"
                                    value={session.sessionId}
                                    checked={active}
                                    disabled={disabled}
                                    onChange={() => setSelectedId(session.sessionId)}
                                  />
                                  <span className="min-w-0 flex-1">
                                    <span className="block text-xl font-semibold tracking-[-0.02em] text-ink">
                                      {formatSessionTime(session.startsAt)}
                                    </span>
                                    <span className="mt-0.5 block text-sm text-ink/60">
                                      {formatSessionDateShort(session.startsAt)} · {session.experienceTitle}
                                    </span>
                                    <span className="mt-2 flex flex-wrap items-center gap-2">
                                      <StatusBadge status={session.status} />
                                      <span className="text-xs font-medium text-ink/60">{spotsLabel(session)}</span>
                                    </span>
                                    {disabled && !verdict.allowed ? (
                                      <span className="mt-2 block text-xs font-medium text-red-700">
                                        {sessionChangeMessage(verdict.reason)}
                                      </span>
                                    ) : null}
                                  </span>
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </fieldset>

                <label className="block">
                  <span className={labelClass}>Motivo da alteração (opcional)</span>
                  <textarea
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    className={textareaClass}
                    maxLength={500}
                    placeholder="Cliente solicitou mudança de horário"
                  />
                  <span className="mt-1.5 block text-xs text-ink/40">
                    Fica no histórico administrativo. Não aparece no site nem para o cliente.
                  </span>
                </label>
              </div>
            ) : null}

            {step === "confirm" && selected ? (
              <div className="mt-5 space-y-5">
                <div className="grid gap-3 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
                  <div className="rounded-2xl border border-ink/10 bg-mist/50 p-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.12em] text-ink/45">De</p>
                    <p className="mt-2 text-lg font-semibold tracking-[-0.02em] text-ink">{turmaLabel(data.current.startsAt)}</p>
                  </div>
                  <ArrowRight className="mx-auto hidden size-5 text-lake sm:block" aria-hidden />
                  <div className="rounded-2xl border border-lake/40 bg-lake/5 p-4">
                    <p className="text-xs font-semibold uppercase tracking-[0.12em] text-ink/45">Para</p>
                    <p className="mt-2 text-lg font-semibold tracking-[-0.02em] text-ink">{turmaLabel(selected.startsAt)}</p>
                  </div>
                </div>
                <p className="flex items-center gap-2 text-sm font-semibold text-ink">
                  <Users className="size-4 text-lake" /> {participantsLabel(data.quantity)}
                </p>
                <ul className="space-y-2 rounded-2xl bg-mist/50 p-4 text-sm text-ink/70">
                  <li className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-lake" /> A reserva continua confirmada.</li>
                  <li className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-lake" /> O pagamento não será alterado: {formatCurrency(data.totalCents)} permanecem como pagos.</li>
                  <li className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-lake" /> Nenhuma nova cobrança é gerada e o código {data.publicCode} é preservado.</li>
                </ul>
                {reason ? (
                  <p className="text-sm text-ink/60"><span className="font-semibold text-ink">Motivo:</span> {reason}</p>
                ) : null}
              </div>
            ) : null}
          </>
        ) : null}

        {error ? <p className={fieldErrorClass} role="alert">{error}</p> : null}

        <div className="mt-7 flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          {step === "confirm" ? (
            <Button type="button" variant="ghost" onClick={() => setStep("select")} disabled={saving}>Voltar</Button>
          ) : (
            <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>Cancelar</Button>
          )}
          {step === "select" ? (
            <Button
              type="button"
              onClick={() => { setError(""); setStep("confirm"); }}
              disabled={!selected || !data || data.status !== "CONFIRMED"}
            >
              Revisar alteração
            </Button>
          ) : (
            <Button type="button" onClick={submit} disabled={saving}>
              {saving ? "Alterando…" : "Confirmar alteração"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
